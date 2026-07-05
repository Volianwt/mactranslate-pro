import React, { useState, useEffect, memo } from 'react';
import { X, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import {
  ASR_PROVIDERS,
  getAsrProviderMeta,
  normalizeAsrProvider,
  type AsrProviderId,
} from '../services/asrProviders';

export type AppSettings = {
  asrProvider: string;
  translationModel: string;
};

const STORAGE_KEY = 'mtp_settings';

const TRANSLATION_MODELS = [
  { id: 'gpt-5.4', name: 'GPT-5.4', desc: '最强精度，医疗推荐', price: 'Input $2.50 / Output $15.00' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', desc: '速度更快，性价比高', price: 'Input $0.75 / Output $4.50' },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', desc: '最便宜，简单任务', price: 'Input $0.20 / Output $1.25' },
  { id: 'gpt-4o', name: 'GPT-4o', desc: '上一代旗舰', price: 'Input $2.50 / Output $10.00' },
];

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        asrProvider: normalizeAsrProvider(parsed.asrProvider),
        translationModel: parsed.translationModel || 'gpt-5.4-mini',
      };
    }
  } catch {}
  return { asrProvider: 'azure', translationModel: 'gpt-5.4-mini' };
}

export function saveSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentSettings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

export const SettingsModal = memo(function SettingsModal({ isOpen, onClose, currentSettings, onSave }: Props) {
  const [asrProvider, setAsrProvider] = useState(currentSettings.asrProvider);
  const [translationModel, setTranslationModel] = useState(currentSettings.translationModel);
  const [asrTests, setAsrTests] = useState<Record<AsrProviderId, TestStatus>>({
    azure: 'idle',
    qwen: 'idle',
    soniox: 'idle',
  });
  const [asrMessages, setAsrMessages] = useState<Record<AsrProviderId, string>>({
    azure: '',
    qwen: '',
    soniox: '',
  });
  const [openaiTest, setOpenaiTest] = useState<TestStatus>('idle');
  const [openaiMsg, setOpenaiMsg] = useState('');

  useEffect(() => {
    if (isOpen) {
      setAsrProvider(normalizeAsrProvider(currentSettings.asrProvider));
      setTranslationModel(currentSettings.translationModel);
      setAsrTests({ azure: 'idle', qwen: 'idle', soniox: 'idle' });
      setAsrMessages({ azure: '', qwen: '', soniox: '' });
      setOpenaiTest('idle');
      setOpenaiMsg('');
    }
  }, [isOpen, currentSettings]);

  if (!isOpen) return null;

  const testAsr = async (providerId: AsrProviderId) => {
    const provider = getAsrProviderMeta(providerId);
    setAsrTests((prev) => ({ ...prev, [providerId]: 'testing' }));
    setAsrMessages((prev) => ({ ...prev, [providerId]: '' }));
    try {
      const resp = await fetch(provider.testEndpoint, { method: 'POST' });
      const data = await resp.json();
      if (data.success) {
        setAsrTests((prev) => ({ ...prev, [providerId]: 'success' }));
        setAsrMessages((prev) => ({
          ...prev,
          [providerId]: provider.formatTestSuccess(data),
        }));
      } else {
        setAsrTests((prev) => ({ ...prev, [providerId]: 'error' }));
        setAsrMessages((prev) => ({
          ...prev,
          [providerId]: data.error || '连接失败',
        }));
      }
    } catch {
      setAsrTests((prev) => ({ ...prev, [providerId]: 'error' }));
      setAsrMessages((prev) => ({ ...prev, [providerId]: '网络错误' }));
    }
  };

  const currentProvider = normalizeAsrProvider(asrProvider);
  const currentAsrTest = asrTests[currentProvider];
  const currentAsrMsg = asrMessages[currentProvider];
  const testCurrentAsr = () => testAsr(currentProvider);

  const testOpenai = async () => {
    setOpenaiTest('testing');
    setOpenaiMsg('');
    try {
      const resp = await fetch('/api/test-openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: translationModel }),
      });
      const data = await resp.json();
      if (data.success) {
        setOpenaiTest('success');
        setOpenaiMsg(`${data.model} 连接成功`);
      } else {
        setOpenaiTest('error');
        setOpenaiMsg(data.error);
      }
    } catch (err: any) {
      setOpenaiTest('error');
      setOpenaiMsg('网络错误');
    }
  };

  const handleSave = () => {
    const newSettings: AppSettings = { asrProvider, translationModel };
    saveSettings(newSettings);
    onSave(newSettings);
    onClose();
  };

  const hasChanges =
    asrProvider !== currentSettings.asrProvider ||
    translationModel !== currentSettings.translationModel;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[#14141e] border border-white/[0.08] rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-[15px] font-semibold text-zinc-100">设置</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-6">
          {/* ASR Layer */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-[13px] font-medium text-zinc-200">语音识别 (ASR)</h3>
                <p className="text-[11px] text-zinc-500 mt-0.5">语音转文字引擎</p>
              </div>
              <button
                onClick={testCurrentAsr}
                disabled={currentAsrTest === 'testing'}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-md bg-white/[0.05] border border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08] transition-all disabled:opacity-50"
              >
                {currentAsrTest === 'testing' ? <Loader2 className="w-3 h-3 animate-spin" /> :
                 currentAsrTest === 'success' ? <CheckCircle className="w-3 h-3 text-emerald-400" /> :
                 currentAsrTest === 'error' ? <XCircle className="w-3 h-3 text-red-400" /> : null}
                测试
              </button>
            </div>

            {currentAsrMsg && (
              <p className={`text-[11px] mb-2 ${currentAsrTest === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
                {currentAsrMsg}
              </p>
            )}

            <div className="space-y-1.5">
              {ASR_PROVIDERS.map((p) => (
                <label
                  key={p.id}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${
                    asrProvider === p.id
                      ? 'border-blue-500/40 bg-blue-500/10'
                      : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                  }`}
                >
                  <input
                    type="radio"
                    name="asr"
                    value={p.id}
                    checked={asrProvider === p.id}
                    onChange={() => {
                      setAsrProvider(p.id);
                    }}
                    className="sr-only"
                  />
                  <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                    asrProvider === p.id ? 'border-blue-500' : 'border-zinc-600'
                  }`}>
                    {asrProvider === p.id && <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
                  </div>
                  <div>
                    <div className="text-[13px] text-zinc-200">{p.name}</div>
                    <div className="text-[11px] text-zinc-500">{p.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-white/[0.06]" />

          {/* Translation Layer */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-[13px] font-medium text-zinc-200">翻译模型</h3>
                <p className="text-[11px] text-zinc-500 mt-0.5">GPT 模型选择 · 价格为每百万 tokens</p>
              </div>
              <button
                onClick={testOpenai}
                disabled={openaiTest === 'testing'}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-md bg-white/[0.05] border border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08] transition-all disabled:opacity-50"
              >
                {openaiTest === 'testing' ? <Loader2 className="w-3 h-3 animate-spin" /> :
                 openaiTest === 'success' ? <CheckCircle className="w-3 h-3 text-emerald-400" /> :
                 openaiTest === 'error' ? <XCircle className="w-3 h-3 text-red-400" /> : null}
                测试
              </button>
            </div>

            {openaiMsg && (
              <p className={`text-[11px] mb-2 ${openaiTest === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
                {openaiMsg}
              </p>
            )}

            <div className="space-y-1.5">
              {TRANSLATION_MODELS.map((m) => (
                <label
                  key={m.id}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${
                    translationModel === m.id
                      ? 'border-blue-500/40 bg-blue-500/10'
                      : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                  }`}
                >
                  <input
                    type="radio"
                    name="translation"
                    value={m.id}
                    checked={translationModel === m.id}
                    onChange={() => { setTranslationModel(m.id); setOpenaiTest('idle'); setOpenaiMsg(''); }}
                    className="sr-only"
                  />
                  <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    translationModel === m.id ? 'border-blue-500' : 'border-zinc-600'
                  }`}>
                    {translationModel === m.id && <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-zinc-200">{m.name}</span>
                      <span className="text-[10px] text-zinc-600 tabular-nums">{m.price}</span>
                    </div>
                    <div className="text-[11px] text-zinc-500">{m.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/[0.06]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors rounded-md"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className={`px-4 py-2 text-[12px] font-medium rounded-md transition-all ${
              hasChanges
                ? 'bg-blue-500 text-white hover:bg-blue-600'
                : 'bg-white/[0.06] text-zinc-400'
            }`}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
});
