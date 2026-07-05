import { useState, useEffect, useCallback, useRef } from 'react';

const PCM_CAPTURE_PROCESSOR_URL = new URL('../worklets/pcmCaptureProcessor.js', import.meta.url);
const TARGET_AUDIO_SAMPLE_RATE = 16000;
const RECONNECT_FAST_DELAYS_MS = [0, 250, 750, 1000, 1000, 1000, 1000, 1000];
const RECONNECT_ALERT_AFTER_MS = 1000;
const KEEPALIVE_INTERVAL_MS = 5000;
const MAX_BUFFERED_AUDIO_BYTES = TARGET_AUDIO_SAMPLE_RATE * 2 * 10;

type RecognitionMode = 'auto' | 'zh' | 'en';
type ConnectionState = 'idle' | 'connecting' | 'listening' | 'reconnecting';

type BrowserAudioContext = AudioContext & {
  audioWorklet: AudioWorklet;
};

type BrowserAudioContextConstructor = {
  new(options?: AudioContextOptions): BrowserAudioContext;
};

type ExtendedWindow = Window & {
  webkitAudioContext?: BrowserAudioContextConstructor;
};

function createCaptureAudioContext(AudioContextClass: BrowserAudioContextConstructor) {
  try {
    return new AudioContextClass({
      latencyHint: 'interactive',
      sampleRate: TARGET_AUDIO_SAMPLE_RATE,
    });
  } catch (error) {
    console.warn('Falling back to browser default AudioContext sample rate:', error);
    return new AudioContextClass({
      latencyHint: 'interactive',
    });
  }
}

export function useSpeechRecognition(
  stream: MediaStream | null,
  recognitionMode: RecognitionMode,
  onTranscript: (text: string, isFinal: boolean, id?: string, side?: string) => void,
  onTranslation: (id: string, translation: string, correctedText?: string, isCommitted?: boolean, side?: string) => void,
  onError: (msg: string) => void,
  onPartialTranslation?: (id: string, partialTranslation: string, side?: string) => void,
  onPartialTranslationReset?: (id: string, side?: string) => void,
  asrProvider: string = 'azure',
  translationModel: string = 'gpt-5.4-mini'
) {
  const [isListening, setIsListening] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<BrowserAudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const muteNodeRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(stream);
  const manuallyClosingRef = useRef(false);
  const shouldReconnectRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAlertTimerRef = useRef<number | null>(null);
  const keepaliveTimerRef = useRef<number | null>(null);
  const bufferedAudioChunksRef = useRef<ArrayBuffer[]>([]);
  const bufferedAudioBytesRef = useRef(0);
  const savedContextRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  const resetState = useCallback(() => {
    setIsListening(false);
    setIsConnecting(false);
    setConnectionState('idle');
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearReconnectAlertTimer = useCallback(() => {
    if (reconnectAlertTimerRef.current !== null) {
      window.clearTimeout(reconnectAlertTimerRef.current);
      reconnectAlertTimerRef.current = null;
    }
  }, []);

  const clearKeepaliveTimer = useCallback(() => {
    if (keepaliveTimerRef.current !== null) {
      window.clearInterval(keepaliveTimerRef.current);
      keepaliveTimerRef.current = null;
    }
  }, []);

  const startKeepalive = useCallback((socket: WebSocket) => {
    clearKeepaliveTimer();
    keepaliveTimerRef.current = window.setInterval(() => {
      if (wsRef.current !== socket || socket.readyState !== WebSocket.OPEN) {
        clearKeepaliveTimer();
        return;
      }
      socket.send(JSON.stringify({ type: 'keepalive', at: Date.now() }));
    }, KEEPALIVE_INTERVAL_MS);
  }, [clearKeepaliveTimer]);

  const getReconnectDelayMs = (attempt: number) => (
    RECONNECT_FAST_DELAYS_MS[Math.min(attempt - 1, RECONNECT_FAST_DELAYS_MS.length - 1)]
  );

  const hasLiveAudioTrack = (candidateStream: MediaStream | null) => (
    !!candidateStream && candidateStream.getAudioTracks().some((track) => track.readyState === 'live')
  );

  const clearBufferedAudio = useCallback(() => {
    bufferedAudioChunksRef.current = [];
    bufferedAudioBytesRef.current = 0;
  }, []);

  const bufferAudioChunk = useCallback((chunk: ArrayBuffer) => {
    bufferedAudioChunksRef.current.push(chunk);
    bufferedAudioBytesRef.current += chunk.byteLength;

    while (bufferedAudioBytesRef.current > MAX_BUFFERED_AUDIO_BYTES && bufferedAudioChunksRef.current.length > 0) {
      const dropped = bufferedAudioChunksRef.current.shift();
      bufferedAudioBytesRef.current -= dropped?.byteLength ?? 0;
    }
  }, []);

  const flushBufferedAudio = useCallback((socket: WebSocket) => {
    if (socket.readyState !== WebSocket.OPEN || bufferedAudioChunksRef.current.length === 0) {
      return;
    }

    const chunks = bufferedAudioChunksRef.current;
    bufferedAudioChunksRef.current = [];
    bufferedAudioBytesRef.current = 0;

    for (const chunk of chunks) {
      if (socket.readyState !== WebSocket.OPEN) {
        bufferAudioChunk(chunk);
        continue;
      }
      socket.send(chunk);
    }
  }, [bufferAudioChunk]);

  const stopAudioPipeline = useCallback(() => {
    const workletNode = workletNodeRef.current;
    workletNodeRef.current = null;
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }

    const sourceNode = sourceNodeRef.current;
    sourceNodeRef.current = null;
    if (sourceNode) {
      sourceNode.disconnect();
    }

    const muteNode = muteNodeRef.current;
    muteNodeRef.current = null;
    if (muteNode) {
      muteNode.disconnect();
    }

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch((error) => {
        console.error('Error closing audio context:', error);
      });
    }
  }, []);

  const closeSocket = useCallback((socket?: WebSocket | null) => {
    const targetSocket = socket ?? wsRef.current;
    if (!targetSocket) {
      return;
    }

    if (!socket || wsRef.current === socket) {
      wsRef.current = null;
    }

    if (targetSocket.readyState < WebSocket.CLOSING) {
      targetSocket.close();
    }
  }, []);

  const asrProviderRef = useRef(asrProvider);
  useEffect(() => {
    asrProviderRef.current = asrProvider;
  }, [asrProvider]);

  const translationModelRef = useRef(translationModel);
  useEffect(() => {
    translationModelRef.current = translationModel;
  }, [translationModel]);

  const sendConfig = useCallback((socket: WebSocket | null, sampleRate: number) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'config',
        asrProvider: asrProviderRef.current,
        translationModel: translationModelRef.current,
        audioFormat: {
          encoding: 'linear16',
          sampleRate,
          channels: 1,
        },
      }));
    }
  }, []);

  const configureSocket = useCallback((socket: WebSocket, sampleRate: number) => {
    sendConfig(socket, sampleRate);

    if (savedContextRef.current) {
      socket.send(JSON.stringify({ type: 'restore_context', contexts: savedContextRef.current }));
    }

    window.setTimeout(() => {
      if (wsRef.current === socket && socket.readyState === WebSocket.OPEN) {
        flushBufferedAudio(socket);
      }
    }, 300);
  }, [flushBufferedAudio, sendConfig]);

  const stop = useCallback(() => {
    manuallyClosingRef.current = true;
    shouldReconnectRef.current = false;
    clearReconnectTimer();
    clearReconnectAlertTimer();
    clearKeepaliveTimer();
    clearBufferedAudio();
    const socket = wsRef.current;
    stopAudioPipeline();
    closeSocket(socket);
    resetState();
    reconnectAttemptsRef.current = 0;

    window.setTimeout(() => {
      if (!wsRef.current) {
        manuallyClosingRef.current = false;
      }
    }, 0);
  }, [clearBufferedAudio, clearKeepaliveTimer, clearReconnectAlertTimer, clearReconnectTimer, closeSocket, resetState, stopAudioPipeline]);

  const sendMessage = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
    // Clear saved context on reset
    if (payload.type === 'reset') {
      savedContextRef.current = null;
    }
  }, []);

  const start = useCallback((streamOverride?: MediaStream) => {
    const isReconnectAttempt = shouldReconnectRef.current && reconnectAttemptsRef.current > 0 && !wsRef.current;
    if (!isReconnectAttempt && (isListening || isConnecting)) {
      return;
    }

    const currentStream = streamOverride ?? streamRef.current;
    if (!currentStream) {
      onError('Microphone stream not available');
      return;
    }

    try {
      manuallyClosingRef.current = false;
      shouldReconnectRef.current = true;
      clearReconnectTimer();
      clearKeepaliveTimer();
      setIsConnecting(true);
      setConnectionState(reconnectAttemptsRef.current > 0 ? 'reconnecting' : 'connecting');

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
          if (wsRef.current !== ws) {
            closeSocket(ws);
            return;
        }

        console.log('WebSocket connected');
        clearReconnectAlertTimer();
        startKeepalive(ws);
        if (reconnectAttemptsRef.current > 0) {
          onError('');
        }
        setIsConnecting(false);
        setIsListening(true);
        setConnectionState('listening');

        window.setTimeout(() => {
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            reconnectAttemptsRef.current = 0;
          }
        }, 10000);

        try {
          const existingAudioContext = audioContextRef.current;
          if (existingAudioContext && workletNodeRef.current) {
            if (existingAudioContext.state === 'suspended') {
              await existingAudioContext.resume();
            }
            configureSocket(ws, existingAudioContext.sampleRate);
            return;
          }

          const AudioContextClass = window.AudioContext || (window as ExtendedWindow).webkitAudioContext;
          if (!AudioContextClass) {
            throw new Error('AudioContext is not supported in this browser');
          }

          const audioContext = createCaptureAudioContext(AudioContextClass);
          audioContextRef.current = audioContext;

          await audioContext.audioWorklet.addModule(PCM_CAPTURE_PROCESSOR_URL.href);

          if (wsRef.current !== ws) {
            stopAudioPipeline();
            closeSocket(ws);
            return;
          }

          if (audioContext.state === 'suspended') {
            await audioContext.resume();
          }

          const sourceNode = audioContext.createMediaStreamSource(currentStream);
          const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor');
          const muteNode = audioContext.createGain();
          muteNode.gain.value = 0;

          workletNode.port.onmessage = (event) => {
            if (!(event.data instanceof ArrayBuffer)) {
              return;
            }

            const activeSocket = wsRef.current;
            if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
              flushBufferedAudio(activeSocket);
              activeSocket.send(event.data);
              return;
            }

            if (shouldReconnectRef.current) {
              bufferAudioChunk(event.data);
            }
          };

          sourceNodeRef.current = sourceNode;
          workletNodeRef.current = workletNode;
          muteNodeRef.current = muteNode;

          if (audioContext.sampleRate !== TARGET_AUDIO_SAMPLE_RATE) {
            console.warn(
              `AudioContext is running at ${audioContext.sampleRate} Hz instead of ${TARGET_AUDIO_SAMPLE_RATE} Hz`
            );
          }

          configureSocket(ws, audioContext.sampleRate);

          sourceNode.connect(workletNode);
          workletNode.connect(muteNode);
          muteNode.connect(audioContext.destination);
        } catch (err) {
          console.error('PCM capture error:', err);
          onError('Failed to start raw PCM audio capture. Use a Chromium-based browser and try again.');
          stop();
        }
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) {
          return;
        }

        try {
          const data = JSON.parse(event.data);
          if (data.type === 'transcript') {
            onTranscript(data.text, data.isFinal, data.id, data.side);
          } else if (data.type === 'translation') {
            onTranslation(data.id, data.translation, data.correctedText, data.isCommitted, data.side);
          } else if (data.type === 'translation_streaming') {
            onPartialTranslation?.(data.id, data.partialTranslation, data.side);
          } else if (data.type === 'translation_streaming_reset') {
            onPartialTranslationReset?.(data.id, data.side);
          } else if (data.type === 'context_snapshot') {
            // Save context for session persistence
            savedContextRef.current = data.contexts;
            console.log('Translation context saved for session persistence');
          } else if (data.type === 'error') {
            onError(data.message);
            if (!manuallyClosingRef.current && shouldReconnectRef.current && ws.readyState < WebSocket.CLOSING) {
              ws.close();
            } else {
              stop();
            }
          }
        } catch (error) {
          console.error('Error parsing WebSocket message', error);
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) {
          return;
        }

        wsRef.current = null;
        clearKeepaliveTimer();

        const shouldAttemptReconnect = !manuallyClosingRef.current && shouldReconnectRef.current;

        if (!shouldAttemptReconnect) {
          clearReconnectAlertTimer();
          stopAudioPipeline();
          resetState();
          reconnectAttemptsRef.current = 0;
          manuallyClosingRef.current = false;
          return;
        }

        const reconnectStream = currentStream && hasLiveAudioTrack(currentStream)
          ? currentStream
          : streamRef.current;

        if (!hasLiveAudioTrack(reconnectStream)) {
          shouldReconnectRef.current = false;
          clearReconnectAlertTimer();
          stopAudioPipeline();
          resetState();
          reconnectAttemptsRef.current = 0;
          manuallyClosingRef.current = false;
          onError('麦克风音频流已中断，请重新选择麦克风后点击开始。');
          return;
        }

        const nextAttempt = reconnectAttemptsRef.current + 1;
        reconnectAttemptsRef.current = nextAttempt;

        const delayMs = getReconnectDelayMs(nextAttempt);
        console.warn(`WebSocket closed unexpectedly. Reconnecting in ${delayMs}ms (attempt ${nextAttempt}).`);
        setIsListening(true);
        setIsConnecting(true);
        setConnectionState('reconnecting');

        if (nextAttempt === 1) {
          clearReconnectAlertTimer();
          reconnectAlertTimerRef.current = window.setTimeout(() => {
            reconnectAlertTimerRef.current = null;
            if (shouldReconnectRef.current && !wsRef.current) {
              onError('连接中断，未能在 1 秒内自动恢复。建议立刻刷新页面；后台仍会继续尝试重连。');
            }
          }, RECONNECT_ALERT_AFTER_MS);
        }

        clearReconnectTimer();
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (!shouldReconnectRef.current) {
            return;
          }
          start(reconnectStream ?? undefined);
        }, delayMs);

        manuallyClosingRef.current = false;
      };

      ws.onerror = (error) => {
        if (wsRef.current !== ws) {
          return;
        }

        console.error('WebSocket error:', error);
        if (!manuallyClosingRef.current) {
          console.warn('WebSocket error; waiting for close event to trigger reconnect.');
        }
        if (ws.readyState < WebSocket.CLOSING) {
          ws.close();
        }
      };
    } catch (error) {
      console.error('Error accessing microphone:', error);
      setIsConnecting(false);
      onError('Microphone access denied or not available');
    }
  }, [bufferAudioChunk, clearKeepaliveTimer, clearReconnectAlertTimer, clearReconnectTimer, closeSocket, configureSocket, flushBufferedAudio, isConnecting, isListening, onError, onTranscript, onTranslation, onPartialTranslation, onPartialTranslationReset, resetState, startKeepalive, stop, stopAudioPipeline]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { isListening, isConnecting, connectionState, start, stop, sendMessage };
}
