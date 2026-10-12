import type { Message } from '../types';

export function createTranscriptText(messages: readonly Message[], options: { demo?: boolean } = {}): string {
  const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  const heading = options.demo
    ? 'MacTranslate Pro — fictional sample transcript'
    : 'MacTranslate Pro — session transcript';

  if (ordered.length === 0) return `${heading}\n\nNo transcript entries.\n`;

  const entries = ordered.map((message, index) => {
    const direction = message.side === 'left' ? 'English → 中文' : '中文 → English';
    const lines = [
      `${index + 1}. ${direction} · ${new Date(message.createdAt).toISOString()}`,
      `Original: ${message.original}`,
    ];
    if (message.corrected && message.corrected !== message.original) {
      lines.push(`Corrected: ${message.corrected}`);
    }
    lines.push(`Translation${message.isTranslating ? ' (in progress)' : ''}: ${message.translated || '—'}`);
    return lines.join('\n');
  });

  return `${heading}\n\n${entries.join('\n\n')}\n`;
}

export function downloadTranscript(messages: readonly Message[], options: { demo?: boolean } = {}) {
  const blob = new Blob([createTranscriptText(messages, options)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = options.demo ? 'mactranslate-sample.txt' : `mactranslate-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
