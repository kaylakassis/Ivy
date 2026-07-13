// "Ivy noticed" — the proactive agent's pending suggestions (overdue invoices,
// a quiet calendar, a new review, leads waiting on a reply). Each row either
// opens Ivy with a pre-filled prompt (she runs it through her normal tools +
// confirm-gate, so nothing sends without approval) or is dismissed. Fed by
// GET /api/ivy/suggestions; renders NOTHING when there's nothing to surface, so
// it never adds noise to a calm day.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function IvyNoticedCard() {
  const [items, setItems] = useState(null); // null=loading · []=none

  useEffect(() => {
    let live = true;
    api.get('/ivy/suggestions')
      .then((r) => { if (live) setItems(r.suggestions || []); })
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, []);

  const dismiss = async (id) => {
    setItems((xs) => (xs || []).filter((s) => s.id !== id));
    try { await api.post('/ivy/suggestions', { id, action: 'dismiss' }); } catch { /* best-effort */ }
  };

  if (!items || items.length === 0) return null;

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 7, flexShrink: 0,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Spark size={15} sw={1.9}/>
        </div>
        <div style={{ fontSize: 14.5, fontWeight: 700 }}>Ivy noticed</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((s) => {
          const Icon = Icons[s.icon] || Icons.Spark;
          return (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 11, padding: '11px 12px',
              borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)',
            }}>
              <span style={{
                width: 26, height: 26, borderRadius: 7, flexShrink: 0, marginTop: 1,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon size={15} sw={1.9}/>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{s.title}</div>
                {s.detail && (
                  <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginTop: 2, lineHeight: 1.4 }}>{s.detail}</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
                  <Link to={`/ivy?prompt=${encodeURIComponent(s.prompt)}&send=1`}
                    className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12.5, gap: 6 }}>
                    Do it <Icons.Arrow size={12} sw={2}/>
                  </Link>
                  <button type="button" onClick={() => dismiss(s.id)}
                    className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
