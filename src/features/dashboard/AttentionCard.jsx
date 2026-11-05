// "Needs your attention": the accountability partner's list (the same
// signals its daily message uses, api/_lib/accountability.js). Each row has
// one button that opens the exact place to act (the thread to reply in, the
// document to send, the deposits to review). Nothing is sent from here.
// "Not today" snoozes the partner for the rest of the day and folds the card.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const SHOW = 5;

export default function AttentionCard({ attention, hideKeys = [], onChanged }) {
  const [all, setAll] = useState(false);
  const [snoozed, setSnoozed] = useState(null); // null = follow the server
  const [busy, setBusy] = useState(false);
  if (!attention) return null;
  const items = (attention.items || []).filter((i) => !hideKeys.includes(i.key));
  const isSnoozed = snoozed ?? !!attention.snoozedToday;

  const snooze = async (on) => {
    setBusy(true); setSnoozed(on);
    try { await api.post('/me/accountability', { action: on ? 'snooze' : 'unsnooze' }); onChanged?.(); }
    catch { setSnoozed(!on); }
    finally { setBusy(false); }
  };

  const header = (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <span style={{
        width: 28, height: 28, borderRadius: 8, flexShrink: 0, background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Spark size={15} sw={1.9}/></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3 id="attn-h" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
          Needs your attention{items.length > 0 && !isSnoozed ? <span style={{ color: 'var(--muted)', fontWeight: 600 }}> · {items.length}</span> : null}
        </h3>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>From Ivy, your accountability partner</div>
      </div>
    </div>
  );

  if (isSnoozed) {
    return (
      <section className="card" aria-labelledby="attn-h" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {header}
        <div style={{ fontSize: 13, color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          Snoozed for today. Ivy will check in again tomorrow.
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => snooze(false)} style={{ padding: '4px 10px', fontSize: 12 }}>
            Show it anyway
          </button>
        </div>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section className="card" aria-labelledby="attn-h" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {header}
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icons.Check size={14} sw={2.4} stroke="var(--ok)"/> You're all caught up. Ivy will let you know when something needs you.
        </div>
      </section>
    );
  }

  const shown = all ? items : items.slice(0, SHOW);
  return (
    <section className="card" aria-labelledby="attn-h" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {header}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shown.map((it) => (
          <li key={it.key} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px',
            borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)',
          }}>
            <span aria-hidden style={{
              width: 8, height: 8, borderRadius: 99, flexShrink: 0,
              background: it.important ? 'var(--warn)' : 'var(--border-strong)',
            }}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{it.title}</div>
              {it.detail && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.detail}</div>}
            </div>
            <Link to={it.href || '/dashboard'} className={it.important ? 'btn btn-primary' : 'btn btn-outline'}
              style={{ padding: '6px 11px', fontSize: 12.5, flexShrink: 0, textDecoration: 'none' }}
              aria-label={`${it.action}: ${it.title}`}>
              {it.action}
            </Link>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {items.length > SHOW && (
          <button type="button" className="btn btn-ghost" onClick={() => setAll((a) => !a)}
            style={{ padding: '5px 10px', fontSize: 12.5, color: 'var(--accent)' }}>
            {all ? 'Show less' : `See all ${items.length}`}
          </button>
        )}
        <div style={{ flex: 1 }}/>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => snooze(true)}
          title="No reminder from Ivy today, and this list folds until tomorrow"
          style={{ padding: '5px 10px', fontSize: 12.5, color: 'var(--muted)' }}>
          Not today
        </button>
      </div>
    </section>
  );
}
