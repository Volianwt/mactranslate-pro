import { useEffect, useState } from 'react';
import { ArrowUpRight, Download, FlaskConical, Pause, Play, RotateCcw } from 'lucide-react';
import { Brand } from '../components/Brand';
import { TranslationPanel } from '../components/TranslationPanel';
import { downloadTranscript } from '../services/transcriptExport';
import { sampleConversation } from './sampleConversation';

export default function DemoApp() {
  const [visibleCount, setVisibleCount] = useState(sampleConversation.length);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    if (visibleCount >= sampleConversation.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setVisibleCount(count => count + 1), 1600);
    return () => window.clearTimeout(timer);
  }, [playing, visibleCount]);

  const messages = sampleConversation.slice(0, visibleCount);
  const play = () => {
    if (visibleCount >= sampleConversation.length) setVisibleCount(0);
    setPlaying(true);
  };

  return (
    <div className="workspace demo-workspace">
      <header className="workspace-header">
        <Brand demo />
        <div className="header-actions">
          <span className="status-pill sample-status"><FlaskConical size={13} /> Offline sample</span>
          <a href="/" className="control-button">Open live workspace <ArrowUpRight size={14} /></a>
        </div>
      </header>

      <div className="demo-notice">
        <FlaskConical size={17} />
        <div><strong>A conversation, in two languages.</strong><p>This fictional handover meeting demonstrates the interface. No microphone, API keys, or speech services are used.</p></div>
      </div>

      <div className="session-toolbar">
        <div className="session-context">
          <span className="eyebrow">SAMPLE SESSION</span>
          <span className="session-title">Project handover</span>
          <span className="muted-detail">English ↔ 中文</span>
        </div>
        <div className="toolbar-actions">
          <button className="control-button" onClick={() => { setPlaying(false); setVisibleCount(sampleConversation.length); }}><RotateCcw size={14} /> Show all</button>
          <button className="control-button" disabled={messages.length === 0} onClick={() => downloadTranscript(messages, { demo: true })}><Download size={14} /> Export sample</button>
          <button className="primary-button" onClick={playing ? () => setPlaying(false) : play}>
            {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? 'Pause' : visibleCount >= sampleConversation.length ? 'Replay sample' : 'Continue'}
          </button>
        </div>
      </div>

      <main className="transcript-grid">
        <TranslationPanel title="English → 中文" messages={messages.filter(message => message.side === 'left')} liveText="" isListening={false} pronunciationEnabled={false} />
        <TranslationPanel title="中文 → English" messages={messages.filter(message => message.side === 'right')} liveText="" isListening={false} pronunciationEnabled={false} />
      </main>

      <footer className="workspace-footer">
        <span><span className="status-dot sample" /> {playing ? 'Playing sample' : visibleCount === sampleConversation.length ? 'Sample complete' : 'Sample paused'} · {visibleCount} of {sampleConversation.length} entries</span>
        <span>Fictional sample · Pronunciation disabled · Exported locally</span>
      </footer>
    </div>
  );
}
