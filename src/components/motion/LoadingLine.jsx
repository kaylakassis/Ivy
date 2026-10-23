// LoadingLine - a playful one-liner under a spinner or skeleton while
// something loads. Renders nothing for the first `delay` ms so fast loads
// never flash text; then shows a random line (never the same as the last
// one shown anywhere this session) and, if the load keeps going, swaps to a
// new one every 2.5s with the shared fade/rise enter animation (a plain
// opacity fade under prefers-reduced-motion, via global.css).
//
//   <LoadingLine/>                       owner set, 300ms delay
//   <LoadingLine delay={1200}/>          Ivy "thinking": only on slow replies
//   <LoadingLine set="client"/>          client portal + public pages
import React, { useEffect, useState } from 'react';
import { LOADING_LINES, CLIENT_LOADING_LINES, SETS, pickNext, nextLine } from './loadingLines.js';

export { LOADING_LINES, CLIENT_LOADING_LINES, pickNext };

export const ROTATE_MS = 2500;

export default function LoadingLine({ delay = 300, set = 'owner', style, align = 'center' }) {
  const which = SETS[set] ? set : 'owner';
  const [line, setLine] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let rotate = null;
    const first = setTimeout(() => {
      setLine(nextLine(which));
      rotate = setInterval(() => { setLine(nextLine(which)); setTick((t) => t + 1); }, ROTATE_MS);
    }, delay);
    return () => { clearTimeout(first); if (rotate) clearInterval(rotate); };
  }, [delay, which]);

  if (!line) return null;
  return (
    <div className="loading-line" aria-live="polite" style={{
      fontSize: 12.5, color: 'var(--muted)', textAlign: align, lineHeight: 1.4,
      marginTop: 12, padding: '0 16px', ...style,
    }}>
      {/* Keyed on the rotation so each new line replays the enter animation. */}
      <span key={tick} className="page-enter" style={{ display: 'inline-block' }}>{line}</span>
    </div>
  );
}
