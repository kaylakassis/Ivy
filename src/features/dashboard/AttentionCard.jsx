// "Needs your attention": the accountability partner's list (the same
// signals its daily message uses, api/_lib/accountability.js). Each row has
// one button that opens the exact place to act (the thread to reply in, the
// document to send, the deposits to review). Nothing is sent from here.
// "Not today" snoozes the partner for the rest of the day and folds the card.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import BookingRequestActions from './BookingRequestActions.jsx';

// Three at a time: enough to act on, short enough to finish.
const SHOW = 3;

export default function AttentionCard({ attention, hideKeys = [], onChanged }) {
  const [all, setAll] = useState(false);
  const [snoozed, setSnoozed] = useState(null); // null = follow the server
  const [busy, setBusy] = useState(false);
  // One-tap chase: the owner taps Chase, confirms once, and the same
  // reminder email as "Resend" on the invoice goes to each client. Nothing
  // is sent without that second tap.
  const [chasing, setChasing] = useState(false);
  const [chaseBusy, setChaseBusy] = useState(false);
  const [chaseDone, setChaseDone] = useState(null); // { sent, failed }
  const sendChase = async (ids) => {
    setChaseBusy(true);
    // One key per tap: a network retry of this tap cannot send twice, and a
    // later tap (after a send that failed) is a fresh attempt, not a replay.
    const tap = Date.now().toString(36);
    let sent = 0; let failed = 0;
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await api.post('/invoices/resend', { id }, { headers: { 'Idempotency-Key': `chase-${id}-${tap}` } });
        if (r?.warning) failed += 1; else sent += 1;
      } catch { failed += 1; }
    }
    setChaseBusy(false); setChasing(false); setChaseDone({ sent, failed });
    onChanged?.();
  };
  // Said at the top of the card, not on the row: once the reminders are out
  // the row itself goes away (those invoices are no longer waiting on you).
  const chaseNote = chaseDone && (
    <div role="status" data-chase-done style={{ fontSize: 13, color: chaseDone.failed ? 'var(--warn)' : 'var(--ok)', display: 'flex', alignItems: 'center', gap: 8 }}>
      {chaseDone.failed === 0 && <Icons.Check size={14} sw={2.4}/>}
      <span>
        {chaseDone.sent > 0 ? `${chaseDone.sent} ${chaseDone.sent === 1 ? 'reminder' : 'reminders'} sent.` : 'No reminder went out.'}
        {chaseDone.failed > 0 ? ` ${chaseDone.failed} could not be sent. ` : ''}
        {chaseDone.failed > 0 && <Link to="/finance?filter=overdue" style={{ color: 'inherit', fontWeight: 600 }}>Open the list to check</Link>}
      </span>
    </div>
  );
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
        {chaseNote}
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
      {chaseNote}
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
              {it.chase?.invoiceIds?.length > 0 && chasing && chaseDone == null && (
                <div data-chase-confirm style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-2)', flex: '1 1 160px' }}>
                    Email a reminder with a link to pay to {it.chase.to}?
                  </span>
                  <button type="button" className="btn btn-primary" disabled={chaseBusy} onClick={() => sendChase(it.chase.invoiceIds)}
                    style={{ padding: '6px 11px', fontSize: 12.5 }}>
                    {chaseBusy ? 'Sending…' : `Send ${it.chase.invoiceIds.length === 1 ? 'reminder' : `${it.chase.invoiceIds.length} reminders`}`}
                  </button>
                  <Link to={it.href || '/finance?filter=overdue'} className="btn btn-ghost" style={{ padding: '6px 9px', fontSize: 12.5, textDecoration: 'none', color: 'var(--muted)' }}>
                    See them first
                  </Link>
                </div>
              )}
              {/* 1.0.6: booking requests get Approve / Decline right here. */}
              {Array.isArray(it.requests) && it.requests.length > 0 && (
                <BookingRequestActions requests={it.requests} onChanged={onChanged}/>
              )}
            </div>
            {it.chase?.invoiceIds?.length > 0 && chaseDone == null ? (
              // Overdue invoices: "Chase" asks once, right here, then sends.
              <button type="button" className="btn btn-primary" data-chase onClick={() => setChasing((c) => !c)} aria-expanded={chasing}
                style={{ padding: '6px 11px', fontSize: 12.5, flexShrink: 0 }} aria-label={`${it.action}: ${it.title}`}>
                {it.action}
              </button>
            ) : (
              <Link to={it.href || '/dashboard'} className={it.important ? 'btn btn-primary' : 'btn btn-outline'}
                style={{ padding: '6px 11px', fontSize: 12.5, flexShrink: 0, textDecoration: 'none' }}
                aria-label={`${it.action}: ${it.title}`}>
                {chaseDone != null && it.chase ? 'Open' : it.action}
              </Link>
            )}
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
