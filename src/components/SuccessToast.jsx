// A small, non-blocking "it worked" toast that slides up from the bottom and
// auto-dismisses. For quick wins where a full modal would be too heavy —
// "Marked paid", "Goal reached". Pair with fireConfetti() for the big moments.
//
// Controlled: render it when you have a message, clear the message on onDone.
import React, { useEffect } from 'react';
import { Icons } from './Icons.jsx';

export default function SuccessToast({ text, icon = 'Check', duration = 3200, onDone }) {
  useEffect(() => {
    if (!text) return undefined;
    const t = setTimeout(() => onDone && onDone(), duration);
    return () => clearTimeout(t);
  }, [text, duration, onDone]);

  if (!text) return null;
  const Icon = Icons[icon] || Icons.Check;

  return (
    <div role="status" aria-live="polite" style={{
      position: 'fixed', left: '50%', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)',
      transform: 'translateX(-50%)', zIndex: 90, maxWidth: '90vw',
      animation: 'toast-rise 0.24s cubic-bezier(0.2,0.8,0.3,1)',
    }}>
      <div className="card" style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px',
        boxShadow: 'var(--shadow)', whiteSpace: 'nowrap',
      }}>
        <span style={{
          width: 22, height: 22, borderRadius: 99, flexShrink: 0, background: 'var(--ok)', color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={13} sw={2.6}/>
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{text}</span>
      </div>
    </div>
  );
}
