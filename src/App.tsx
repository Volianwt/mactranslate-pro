/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { AlertCircle, LoaderCircle, Mic, MicOff, RefreshCw, ChevronDown, Settings, Volume2 } from 'lucide-react';
import { Waveform } from './components/Waveform';
import { TranslationPanel } from './components/TranslationPanel';
import { useMicrophone } from './hooks/useMicrophone';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { SettingsModal, loadSettings, saveSettings } from './components/SettingsModal';
import type { AppSettings } from './components/SettingsModal';
import type { Message, MessageSide } from './types';
import { getAsrProviderMeta } from './services/asrProviders';
import { setPronunciationAudioOutputDeviceId, setPronunciationAudioVolume } from './services/phonetics';

type ServerStatus = 'checking' | 'ready' | 'needs-config' | 'offline';
type TranslationSide = MessageSide;

const MAX_MESSAGES = 200;
const UI_UPDATE_THROTTLE_MS = 150;

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function getTodayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `mtp_daily_${year}-${month}-${day}`;
}

function loadDailySeconds(key = getTodayKey()): number {
  try {
    const val = localStorage.getItem(key);
    return val ? parseInt(val, 10) || 0 : 0;
  } catch { return 0; }
}

export default function App() {
  const { devices, selectedDeviceId, setSelectedDeviceId, stream, requestMicrophone } = useMicrophone();

  const [leftMessages, setLeftMessages] = useState<Message[]>([]);
  const [rightMessages, setRightMessages] = useState<Message[]>([]);
  const [liveLeft, setLiveLeft] = useState('');
  const [liveRight, setLiveRight] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
  const [missingEnv, setMissingEnv] = useState<string[]>([]);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const dailyKeyRef = useRef(getTodayKey());
  const [dailySeconds, setDailySeconds] = useState(() => loadDailySeconds(dailyKeyRef.current));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(loadSettings);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState(() => {
    try {
      return localStorage.getItem('mtp_pronunciation_output_device') || '';
    } catch {
      return '';
    }
  });
  const [pronunciationVolume, setPronunciationVolume] = useState(0.01);

  const liveClearTimerLeft = useRef<number | null>(null);
  const liveClearTimerRight = useRef<number | null>(null);
  const liveThrottleLeft = useRef<{ text: string; timer: number | null }>({ text: '', timer: null });
  const liveThrottleRight = useRef<{ text: string; timer: number | null }>({ text: '', timer: null });
  const partialTranslationQueue = useRef<Record<string, { id: string; partialTranslation: string; side: TranslationSide }>>({});
  const partialTranslationTimers = useRef<Record<string, number>>({});

  const syncDailySeconds = useCallback(() => {
    const todayKey = getTodayKey();
    dailyKeyRef.current = todayKey;
    setDailySeconds(loadDailySeconds(todayKey));
  }, []);

  const updateMessagesForSide = useCallback(
    (
      targetSide: TranslationSide,
      updater: (messages: Message[]) => Message[]
    ) => {
      const setMessages = targetSide === 'left' ? setLeftMessages : setRightMessages;
      setMessages(updater);
    },
    []
  );

  const getQueuedPartialKey = useCallback((id: string, side: TranslationSide) => `${side}:${id}`, []);

  const clearQueuedPartialTranslation = useCallback((id: string, side: TranslationSide) => {
    const key = getQueuedPartialKey(id, side);
    const timer = partialTranslationTimers.current[key];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete partialTranslationTimers.current[key];
    }
    delete partialTranslationQueue.current[key];
  }, [getQueuedPartialKey]);

  const flushQueuedPartialTranslation = useCallback((key: string) => {
    const queued = partialTranslationQueue.current[key];
    delete partialTranslationQueue.current[key];
    delete partialTranslationTimers.current[key];

    if (!queued) return;

    const updatedAt = Date.now();
    updateMessagesForSide(queued.side, (prev) => prev.map(msg =>
      msg.id === queued.id
        ? { ...msg, translated: queued.partialTranslation, isTranslating: true, updatedAt }
        : msg
    ));
  }, [updateMessagesForSide]);

  const flushLiveText = useCallback((targetSide: TranslationSide) => {
    const throttleRef = targetSide === 'left' ? liveThrottleLeft : liveThrottleRight;
    const setLive = targetSide === 'left' ? setLiveLeft : setLiveRight;
    throttleRef.current.timer = null;
    setLive(throttleRef.current.text);
  }, []);

  const scheduleLiveText = useCallback((targetSide: TranslationSide, text: string) => {
    const throttleRef = targetSide === 'left' ? liveThrottleLeft : liveThrottleRight;
    throttleRef.current.text = text;

    if (throttleRef.current.timer !== null) return;

    throttleRef.current.timer = window.setTimeout(() => {
      flushLiveText(targetSide);
    }, UI_UPDATE_THROTTLE_MS);
  }, [flushLiveText]);

  const checkServerHealth = useCallback(async () => {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('Health check failed');
      const data = await response.json();
      const missing = Array.isArray(data.missingEnv) ? data.missingEnv : [];
      setMissingEnv(missing);
      setServerStatus(missing.length > 0 ? 'needs-config' : 'ready');
    } catch (error) {
      console.error('Health check failed:', error);
      setMissingEnv([]);
      setServerStatus('offline');
    }
  }, []);

  const refreshAudioOutputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      setAudioOutputs(devs.filter((device) => device.kind === 'audiooutput'));
    } catch (error) {
      console.error('Error enumerating audio outputs:', error);
    }
  }, []);

  React.useEffect(() => {
    void checkServerHealth();
  }, [checkServerHealth]);

  React.useEffect(() => {
    if (stream) {
      void refreshAudioOutputs();
    }
  }, [refreshAudioOutputs, stream]);

  React.useEffect(() => {
    setPronunciationAudioOutputDeviceId(selectedAudioOutputId);
  }, [selectedAudioOutputId]);

  React.useEffect(() => {
    setPronunciationAudioVolume(pronunciationVolume);
  }, [pronunciationVolume]);

  React.useEffect(() => {
    void refreshAudioOutputs();

    const handleDeviceChange = () => {
      void refreshAudioOutputs();
    };

    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
    };
  }, [refreshAudioOutputs]);

  const handleTranscript = useCallback((text: string, isFinal: boolean, id?: string, side?: string) => {
    if (!text.trim()) return;

    const targetSide = (side || 'right') as TranslationSide;
    const now = Date.now();
    const setLive = targetSide === 'left' ? setLiveLeft : setLiveRight;
    const clearTimerRef = targetSide === 'left' ? liveClearTimerLeft : liveClearTimerRight;
    const throttleRef = targetSide === 'left' ? liveThrottleLeft : liveThrottleRight;

    if (!isFinal) {
      if (clearTimerRef.current) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
      scheduleLiveText(targetSide, text);
    } else {
      if (throttleRef.current.timer !== null) {
        window.clearTimeout(throttleRef.current.timer);
        throttleRef.current.timer = null;
      }
      throttleRef.current.text = '';

      const messageId = id || Math.random().toString();
      const setMessages = targetSide === 'left' ? setLeftMessages : setRightMessages;

      setMessages(prev => {
        const existingIndex = prev.findIndex(m => m.id === messageId);
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            ...prev[existingIndex],
            original: text,
            isTranslating: true,
            updatedAt: now,
          };
          return updated;
        }
        return [...prev, {
          id: messageId,
          side: targetSide,
          original: text,
          corrected: undefined,
          translated: '',
          isTranslating: true,
          createdAt: now,
          updatedAt: now,
        }].slice(-MAX_MESSAGES);
      });

      if (clearTimerRef.current) {
        window.clearTimeout(clearTimerRef.current);
      }
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = null;
        setLive('');
      }, 200);
    }
  }, [scheduleLiveText]);

  const handleTranslation = useCallback((id: string, translation: string, correctedText?: string, isCommitted = true, side?: string) => {
    const targetSide = (side || 'right') as TranslationSide;
    const updatedAt = Date.now();
    clearQueuedPartialTranslation(id, targetSide);
    updateMessagesForSide(targetSide, (prev) => prev.map(msg =>
      msg.id === id
        ? {
            ...msg,
            corrected: correctedText?.trim() || undefined,
            translated: translation,
            isTranslating: !isCommitted,
            updatedAt,
          }
        : msg
    ));
  }, [clearQueuedPartialTranslation, updateMessagesForSide]);

  const handlePartialTranslation = useCallback((id: string, partialTranslation: string, side?: string) => {
    const targetSide = (side || 'right') as TranslationSide;
    const key = getQueuedPartialKey(id, targetSide);
    partialTranslationQueue.current[key] = { id, partialTranslation, side: targetSide };

    if (partialTranslationTimers.current[key] !== undefined) return;

    partialTranslationTimers.current[key] = window.setTimeout(() => {
      flushQueuedPartialTranslation(key);
    }, UI_UPDATE_THROTTLE_MS);
  }, [flushQueuedPartialTranslation, getQueuedPartialKey]);

  const handlePartialTranslationReset = useCallback((id: string, side?: string) => {
    const targetSide = (side || 'right') as TranslationSide;
    clearQueuedPartialTranslation(id, targetSide);
    updateMessagesForSide(targetSide, (prev) => prev.map(msg =>
      msg.id === id
        ? { ...msg, isTranslating: true, updatedAt: Date.now() }
        : msg
    ));
  }, [clearQueuedPartialTranslation, updateMessagesForSide]);

  useEffect(() => {
    return () => {
      for (const ref of [liveClearTimerLeft, liveClearTimerRight]) {
        if (ref.current !== null) window.clearTimeout(ref.current);
      }
      for (const ref of [liveThrottleLeft, liveThrottleRight]) {
        if (ref.current.timer !== null) window.clearTimeout(ref.current.timer);
      }
      for (const key of Object.keys(partialTranslationTimers.current)) {
        window.clearTimeout(partialTranslationTimers.current[key]);
      }
    };
  }, []);

  const handleError = useCallback((msg: string) => {
    if (msg) {
      console.error('Speech Recognition Error:', msg);
    }
    setErrorMessage(msg);
  }, []);

  const resetConversationState = useCallback(() => {
    setLeftMessages([]);
    setRightMessages([]);
    setLiveLeft('');
    setLiveRight('');
    setErrorMessage('');
  }, []);

  const { isListening, isConnecting, connectionState, start, stop, sendMessage } = useSpeechRecognition(
    stream,
    'auto',
    handleTranscript,
    handleTranslation,
    handleError,
    handlePartialTranslation,
    handlePartialTranslationReset,
    appSettings.asrProvider,
    appSettings.translationModel
  );

  // Send current model + provider to server whenever connection starts
  useEffect(() => {
    if (isListening) {
      sendMessage({
        type: 'update_settings',
        translationModel: appSettings.translationModel,
        asrProvider: appSettings.asrProvider,
      });
    }
  }, [isListening, appSettings.translationModel, appSettings.asrProvider, sendMessage]);

  const handleSettingsSave = useCallback((newSettings: AppSettings) => {
    const asrProviderChanged = newSettings.asrProvider !== appSettings.asrProvider;
    setAppSettings(newSettings);
    saveSettings(newSettings);
    // translationModel can be hot-swapped; asrProvider cannot — stop the
    // session so the next Start picks up the new engine cleanly.
    sendMessage({
      type: 'update_settings',
      translationModel: newSettings.translationModel,
      asrProvider: newSettings.asrProvider,
    });
    if (asrProviderChanged && (isListening || isConnecting)) {
      stop();
      setErrorMessage('语音识别引擎已切换，请点击"开始"以应用新设置。');
    }
  }, [appSettings.asrProvider, isListening, isConnecting, sendMessage, stop]);

  const handleStartStop = async () => {
    setErrorMessage('');

    if (isListening) {
      stop();
      return;
    }

    if (serverStatus === 'needs-config') {
      setErrorMessage(`Server is missing ${missingEnv.join(', ')}. Update your .env file and restart the app.`);
      return;
    }

    if (serverStatus === 'offline') {
      setErrorMessage('Server is offline. Start the local server and refresh the page.');
      return;
    }

    if (!stream) {
      const newStream = await requestMicrophone();
      if (!newStream) {
        setErrorMessage('Microphone access is required before live interpretation can start.');
        return;
      }
      start(newStream);
    } else {
      // If existing stream tracks have ended (e.g. device disconnected), re-acquire
      const activeTracks = stream.getAudioTracks().filter(t => t.readyState === 'live');
      if (activeTracks.length === 0) {
        const newStream = await requestMicrophone();
        if (!newStream) {
          setErrorMessage('Microphone access is required before live interpretation can start.');
          return;
        }
        start(newStream);
      } else {
        start();
      }
    }
  };

  const handleResetSession = useCallback(() => {
    resetConversationState();
    sendMessage({ type: 'reset' });
    setSessionSeconds(0);

    if (isListening || isConnecting) {
      stop();
    }
  }, [isConnecting, isListening, resetConversationState, sendMessage, stop]);

  useEffect(() => {
    syncDailySeconds();
  }, [syncDailySeconds]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncDailySeconds();
      }
    };

    window.addEventListener('focus', syncDailySeconds);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', syncDailySeconds);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [syncDailySeconds]);

  useEffect(() => {
    let timeoutId: number;

    const scheduleMidnightSync = () => {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const delay = Math.max(nextMidnight.getTime() - now.getTime(), 0) + 50;
      timeoutId = window.setTimeout(() => {
        syncDailySeconds();
        scheduleMidnightSync();
      }, delay);
    };

    scheduleMidnightSync();
    return () => window.clearTimeout(timeoutId);
  }, [syncDailySeconds]);

  // Timer: increment every second while listening
  useEffect(() => {
    if (!isListening) return;
    const interval = setInterval(() => {
      setSessionSeconds(s => s + 1);
      setDailySeconds(prev => {
        const todayKey = getTodayKey();
        const base = dailyKeyRef.current === todayKey ? prev : loadDailySeconds(todayKey);
        const next = base + 1;
        dailyKeyRef.current = todayKey;
        try { localStorage.setItem(todayKey, String(next)); } catch {}
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isListening]);

  React.useEffect(() => {
    if (isListening) {
      stop();
    }
  }, [selectedDeviceId, stop]);

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-[#050506] text-zinc-100"
      style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}
    >
      {/* Compact toolbar */}
      <header className="flex items-center justify-between border-b border-white/[0.06] bg-[#070708] px-3 py-1.5">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-zinc-500 tracking-tight">MacTranslate Pro</span>
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500" title="当前语音识别引擎">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            {getAsrProviderMeta(appSettings.asrProvider).shortName}
          </div>
          <div className="hidden sm:flex items-center gap-3 ml-2 text-[11px] text-zinc-500 tabular-nums">
            <span title="当前会话时长">会话 {formatTime(sessionSeconds)}</span>
            <span className="text-zinc-700">|</span>
            <span title="今日累计时长">今日 {formatTime(dailySeconds)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Waveform stream={stream} />

          {/* Mic selector — compact */}
          <div className="relative flex items-center text-[11px] text-zinc-400">
            <select
              className="appearance-none bg-transparent pr-4 pl-1.5 py-1 outline-none cursor-pointer max-w-[140px] truncate"
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              disabled={devices.length === 0}
            >
              {devices.length === 0 && (
                <option value="">No mic</option>
              )}
              {devices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Mic ${d.deviceId.slice(0, 5)}`}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-0 w-3 h-3 text-zinc-600 pointer-events-none" />
          </div>

          <div className="relative hidden min-[900px]:flex items-center text-[11px] text-zinc-400" title="单词发音输出设备">
            <Volume2 className="w-3 h-3 text-zinc-600 mr-1" />
            <select
              className="appearance-none bg-transparent pr-4 pl-1 py-1 outline-none cursor-pointer max-w-[150px] truncate"
              value={selectedAudioOutputId}
              onChange={(e) => setSelectedAudioOutputId(e.target.value)}
            >
              <option value="">Default output</option>
              {audioOutputs
                .filter((device) => device.deviceId && device.deviceId !== 'default')
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Output ${device.deviceId.slice(0, 5)}`}
                  </option>
                ))}
            </select>
            <ChevronDown className="absolute right-0 w-3 h-3 text-zinc-600 pointer-events-none" />
          </div>

          <div className="hidden min-[900px]:flex items-center gap-1.5 text-[11px] text-zinc-500" title="单词发音音量">
            <Volume2 className="w-3 h-3 text-zinc-600" />
            <input
              type="range"
              min="0.01"
              max="0.05"
              step="0.01"
              value={pronunciationVolume}
              onChange={(e) => setPronunciationVolume(Number(e.target.value))}
              className="w-16 accent-blue-500"
              aria-label="单词发音音量"
            />
            <span className="w-7 text-right tabular-nums">{Math.round(pronunciationVolume * 100)}%</span>
          </div>

          <div className="w-px h-4 bg-white/10"></div>

          {/* Settings button */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
            title="设置"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>

          {/* Reset button */}
          <button
            type="button"
            onClick={() => void handleResetSession()}
            disabled={serverStatus === 'checking'}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
            title="新对话"
          >
            <RefreshCw className="h-3 w-3" />
            重置
          </button>

          {/* Start/Stop button */}
          <button
            onClick={handleStartStop}
            disabled={(!isListening && isConnecting) || serverStatus === 'checking'}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
              isListening
                ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
                : 'bg-blue-500 text-white hover:bg-blue-600'
            }`}
          >
            {isConnecting ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            {connectionState === 'reconnecting' ? '重连中...' : isConnecting ? '连接中...' : isListening ? '停止' : '开始'}
          </button>
        </div>
      </header>

      {/* Error banner */}
      {errorMessage && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-red-300 bg-red-500/10 border-b border-red-500/20">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {errorMessage}
        </div>
      )}

      {connectionState === 'reconnecting' && !errorMessage && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-amber-200 bg-amber-500/10 border-b border-amber-500/20">
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
          连接短暂中断，正在尝试 1 秒内自动恢复；当前对话上下文会继续保留。
        </div>
      )}

      {/* Panels — maximized space */}
      <main className="flex-1 min-h-0 overflow-hidden grid grid-cols-1 min-[800px]:grid-cols-2 p-1 gap-1">
        <TranslationPanel
          title="English → 中文"
          messages={leftMessages}
          liveText={liveLeft}
          isListening={isListening}
          compact
          autoPronounce
          showIpa
        />

        <TranslationPanel
          title="中文 → English"
          messages={rightMessages}
          liveText={liveRight}
          isListening={isListening}
          compact
          autoPronounce
          showIpa
        />
      </main>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        currentSettings={appSettings}
        onSave={handleSettingsSave}
      />
    </div>
  );
}
