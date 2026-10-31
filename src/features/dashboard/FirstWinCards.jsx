// First-win surfaces on the dashboard.
//
//   <FirstWinReadyCard/>   The "Your business is ready" cards for an owner who
//                          finished onboarding but has not seen them yet (the
//                          server says so via /api/dashboard firstWin.showReady).
//                          "Done" marks them seen; they never come back.
//
//   <FirstWinMoment/>      The one-time celebration for the first real client
//                          booking and the first real payment. A short glow on
//                          the card (.glow-once, 600ms) plus a light confetti
//                          burst, both skipped under prefers-reduced-motion by
//                          global.css / fireConfetti. Marked shown on the
//                          server the moment it renders, so a refresh or a
//                          second device never replays it. Copy is only what
//                          happened: the client's first name and the time.
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { fireConfetti } from '../../lib/celebrate.js';
import ReadyStep from '../onboarding/ReadyStep.jsx';

export function FirstWinReadyCard({ show, onDone }) {
  const [hidden, setHidden] = useState(false);
  if (!show || hidden) return null;
  return (
    <div className="card" style={{ padding: 22 }}>
      <ReadyStep embedded continueLabel="Done" onContinue={() => { setHidden(true); onDone?.(); }}/>
    </div>
  );
}

function headlineFor(c) {
  if (c.kind === 'payment') return 'Your first payment is in.';
  return 'Your first booking is in.';
}
function detailFor(c) {
  const who = c.clientFirstName || 'A client';
  if (c.kind === 'payment') {
    return `${who} paid ${c.amountLabel || ''}${c.number ? ` on invoice ${c.number}` : ''}.`;
  }
  const what = c.serviceName ? ` for ${c.serviceName}` : '';
  const when = [c.dateLabel, c.timeLabel].filter(Boolean).join(' at ');
  return `${who} booked${what}${when ? ` on ${when}` : ''}.`;
}

export function FirstWinMoment({ celebrations }) {
  // Kept locally once received: the dashboard re-polls every 30s and the
  // server stops returning a moment as soon as it is marked shown, but the
  // card should stay until the owner closes it (this visit only).
  const [shown, setShown] = useState([]);
  const fired = useRef(new Set());

  useEffect(() => {
    const fresh = (celebrations || []).filter((c) => !fired.current.has(c.kind));
    if (fresh.length === 0) return;
    for (const c of fresh) {
      fired.current.add(c.kind);
      api.post('/onboarding/first-win', { action: 'celebration_seen', kind: c.kind }).catch(() => {});
    }
    fireConfetti({ count: 40 });
    setShown((xs) => [...xs, ...fresh]);
  }, [celebrations]);

  const list = shown;
  if (list.length === 0) return null;
  return (
    <>
      {list.map((c) => (
        <div key={c.kind} className="card glow-once" role="status" style={{
          padding: 20, borderColor: 'var(--accent)',
          background: 'color-mix(in srgb, var(--accent-soft) 55%, var(--surface))',
          display: 'flex', gap: 14, alignItems: 'flex-start',
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12, flexShrink: 0,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {c.kind === 'payment' ? <Icons.Dollar size={19} sw={2}/> : <Icons.Calendar size={19} sw={2}/>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600 }}>{headlineFor(c)}</h3>
            <p style={{ margin: '6px 0 12px', fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5 }}>{detailFor(c)}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link to={c.kind === 'payment' ? '/finance' : '/calendar'} className="btn btn-primary" style={{ padding: '7px 14px', fontSize: 12.5, gap: 6 }}>
                {c.kind === 'payment' ? 'Open Finance' : 'Open calendar'} <Icons.Arrow size={11} sw={2}/>
              </Link>
              <button type="button" className="btn btn-ghost" style={{ padding: '7px 12px', fontSize: 12.5, color: 'var(--muted)' }}
                onClick={() => setShown((xs) => xs.filter((x) => x.kind !== c.kind))}>
                Close
              </button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
