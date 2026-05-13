import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './lib/auth.jsx';
import { initMonitoring, ErrorBoundary } from './lib/monitoring.js';
import App from './App.jsx';
import './styles/tokens.css';
import './styles/global.css';

initMonitoring();

// Global capture for everything that escapes a React error boundary:
//   • Promise rejections that no .catch() handled
//   • Synchronous errors thrown outside React (timers, listeners)
// Both go to the console so users + we can see them in browser logs and
// they get reported via initMonitoring's Sentry hookup. Without these,
// a thrown async error in a click handler vanishes into the void.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    // eslint-disable-next-line no-console
    console.error('[unhandledrejection]', e?.reason);
  });
  window.addEventListener('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[window error]', e?.error || e?.message || e);
  });
}

function FatalFallback({ resetError }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, background: 'var(--page, #F6F5F1)', color: 'var(--fg, #141414)',
      fontFamily: '-apple-system, system-ui, "Inter", sans-serif',
    }}>
      <div style={{
        maxWidth: 480, padding: 32, borderRadius: 14,
        background: 'var(--surface, #FFFFFF)', border: '1px solid var(--border, #E8E4DC)',
        textAlign: 'center',
      }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 500, fontFamily: '"Fraunces", Georgia, serif' }}>
          Something broke.
        </h1>
        <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--muted, #85827B)', lineHeight: 1.55 }}>
          Sorry about that. We've logged it and will take a look.
          You can try again, or refresh the page.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={resetError}
            style={{
              padding: '10px 18px', borderRadius: 10, border: 0, cursor: 'pointer',
              background: 'var(--accent, #2E3168)', color: 'var(--accent-ink, #FFFFFF)',
              fontWeight: 550, fontSize: 14,
            }}>
            Try again
          </button>
          <button onClick={() => window.location.reload()}
            style={{
              padding: '10px 18px', borderRadius: 10, cursor: 'pointer',
              background: 'transparent', color: 'var(--fg-2, #3F3D38)',
              border: '1px solid var(--border-strong, #D9D3C6)', fontSize: 14,
            }}>
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary fallback={({ resetError }) => <FatalFallback resetError={resetError}/>}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
