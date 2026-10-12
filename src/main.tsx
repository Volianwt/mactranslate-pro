import {StrictMode, Suspense, lazy} from 'react';
import {createRoot} from 'react-dom/client';
import './index.css';

// The sample route never mounts microphone or live recognition hooks.
const App = lazy(() => window.location.pathname.replace(/\/$/, '') === '/demo'
  ? import('./demo/DemoApp')
  : import('./App'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="loading-workspace">Opening workspace…</div>}><App /></Suspense>
  </StrictMode>,
);
