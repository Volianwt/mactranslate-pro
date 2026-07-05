export type AsrProviderId = 'azure' | 'qwen' | 'soniox';

export type AsrProviderMeta = {
  id: AsrProviderId;
  name: string;
  shortName: string;
  desc: string;
  testEndpoint: string;
  formatTestSuccess: (data: any) => string;
};

export const ASR_PROVIDERS: AsrProviderMeta[] = [
  {
    id: 'azure',
    name: 'Azure Speech',
    shortName: 'Azure',
    desc: '实时语音识别，中英自动检测（默认，稳定）',
    testEndpoint: '/api/test-azure',
    formatTestSuccess: (data) => `连接成功 (${data?.region || 'default'})`,
  },
  {
    id: 'qwen',
    name: 'Qwen3-ASR (DashScope)',
    shortName: 'Qwen3-ASR',
    desc: '阿里云实时，实验中 — 需配置 DASHSCOPE_API_KEY',
    testEndpoint: '/api/test-qwen',
    formatTestSuccess: (data) => {
      const endpointLabel =
        data?.endpoint === 'mainland'
          ? '中国内地'
          : data?.endpoint === 'international'
            ? '国际区'
            : data?.endpoint || '已连接';
      return `连接成功 (${endpointLabel})`;
    },
  },
  {
    id: 'soniox',
    name: 'Soniox Realtime',
    shortName: 'Soniox',
    desc: '实时流式，支持 endpoint detection — 需配置 SONIOX_API_KEY',
    testEndpoint: '/api/test-soniox',
    formatTestSuccess: (data) =>
      data?.endpoint && data.endpoint !== 'default'
        ? `连接成功 (自定义端点)`
        : '连接成功 (默认实时端点)',
  },
];

export function isAsrProviderId(value: unknown): value is AsrProviderId {
  return ASR_PROVIDERS.some((provider) => provider.id === value);
}

export function normalizeAsrProvider(value: unknown): AsrProviderId {
  return isAsrProviderId(value) ? value : 'azure';
}

export function getAsrProviderMeta(value: unknown): AsrProviderMeta {
  const providerId = normalizeAsrProvider(value);
  return ASR_PROVIDERS.find((provider) => provider.id === providerId) || ASR_PROVIDERS[0];
}
