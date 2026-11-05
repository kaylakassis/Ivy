// Client portal: automatic payments for recurring invoices.
//   AutopaySection  the "Automatic payments" list on Payments (/me/invoices):
//                   open requests ("Authorize"), active ones ("Turn off"),
//                   and ones that ended lately.
//   AutopaySheet    the approval itself: what will be charged, how often,
//                   from when, with which card, how to stop it, and an
//                   explicit "I agree". Adding a card goes through Stripe
//                   and comes back here (?autopay=<id>&setup=<session>).
// The terms text comes from the server, built from the series and the card
// on file; what is shown here is exactly what gets stored.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { SectionTitle, BusinessAvatar, ErrorNote, Sheet, actionBtn, fmtDate } from './portalUi.jsx';
import { CADENCE_WORDS, cardLong, cardShort, fmtAmount, fmtDay } from '../../lib/autopayRules.js';

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function AutopaySection({ agreements, busy, onAuthorize, onTurnOff }) {
  if (!agreements?.length) return null;
  return (
    <section aria-label="Automatic payments">
      <SectionTitle id="autopay">Automatic payments</SectionTitle>
      <div style={{ fontSize: 13, color: 'var(--muted)', margin: '-2px 2px 10px', lineHeight: 1.5 }}>
        Recurring invoices paid with the card you keep with that business. You can turn it off any time.
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {agreements.map((a, i) => (
          <AgreementRow key={a.id} a={a} first={i === 0} busy={busy}
            onAuthorize={() => onAuthorize(a)} onTurnOff={() => onTurnOff(a)}/>
        ))}
      </div>
    </section>
  );
}

function AgreementRow({ a, first, busy, onAuthorize, onTurnOff }) {
  const how = CADENCE_WORDS[a.cadence] || '';
  let status;
  let tone = 'var(--fg-2)';
  if (a.status === 'requested') { status = 'Waiting for you to authorize'; tone = 'var(--warn)'; }
  else if (a.status === 'active' && a.cardChanged) { status = `Your saved card changed. Approve ${a.savedCard ? cardShort(a.savedCard.brand, a.savedCard.last4) : 'a card'} to keep paying automatically.`; tone = 'var(--warn)'; }
  else if (a.status === 'active') { status = `Autopay on (${cardShort(a.card?.brand, a.card?.last4)})`; tone = 'var(--ok)'; }
  else status = `Turned off${a.endedAt ? ` on ${fmtDate(a.endedAt)}` : ''}`;
  return (
    <div data-testid="autopay-agreement" style={{
      padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      borderTop: first ? 'none' : '1px solid var(--border)', opacity: a.status === 'ended' ? 0.7 : 1,
    }}>
      <BusinessAvatar name={a.businessName} size={36}/>
      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{a.businessName}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2, overflowWrap: 'anywhere' }}>
          {a.seriesName} · up to {fmtAmount(a.amountCents, a.currency)} {how}
        </div>
        <div style={{ fontSize: 13, color: tone, marginTop: 2, fontWeight: a.status === 'ended' ? 400 : 600 }}>{status}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(a.status === 'requested' || (a.status === 'active' && a.cardChanged)) && (
          <button className="btn btn-primary" disabled={busy} onClick={onAuthorize} style={actionBtn}>
            {a.status === 'requested' ? 'Authorize' : 'Approve new card'}
          </button>
        )}
        {a.status === 'active' && (
          <button className="btn btn-ghost" disabled={busy} onClick={onTurnOff} style={{ ...actionBtn, color: 'var(--danger)' }}>Turn off</button>
        )}
      </div>
    </div>
  );
}

// The prompt at the top of Payments while a business is waiting on an answer.
export function AutopayPrompt({ agreements, onOpen }) {
  const waiting = (agreements || []).filter((a) => a.status === 'requested');
  if (waiting.length === 0) return null;
  const a = waiting[0];
  return (
    <div className="card" data-testid="autopay-prompt" style={{
      padding: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border))',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Repeat size={18}/></div>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 650 }}>Authorize automatic payments</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
          {a.businessName} asked if you'd like {a.seriesName} paid automatically{waiting.length > 1 ? ` (and ${waiting.length - 1} more)` : ''}.
        </div>
      </div>
      <button className="btn btn-primary" onClick={() => onOpen(a)} style={actionBtn}>Review</button>
    </div>
  );
}

export function AutopaySheet({ agreement: a, onClose, onDone, note }) {
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const card = a.savedCard;
  const reapprove = a.status === 'active' && a.cardChanged;
  const how = CADENCE_WORDS[a.cadence] || '';

  const run = async (fn) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e.message || 'Something went wrong. Please try again.'); setBusy(false); }
  };
  const addCard = () => run(async () => {
    const r = await api.post('/me/autopay', { action: 'add-card', agreementId: a.id });
    window.location.href = r.url;
  });
  const authorize = () => run(async () => {
    const r = await api.post('/me/autopay', { action: 'authorize', agreementId: a.id, agree: true });
    onDone(r.agreements, 'on');
  });
  const decline = () => run(async () => {
    const r = await api.post('/me/autopay', { action: 'turn-off', agreementId: a.id });
    onDone(r.agreements, 'declined');
  });

  return (
    <Sheet onClose={onClose} busy={busy} labelledBy="autopay-title" maxWidth={480}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <BusinessAvatar name={a.businessName} size={40}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div id="autopay-title" style={{ fontSize: 17, fontWeight: 650 }}>
              {reapprove ? 'Approve your new card' : 'Authorize automatic payments'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2, overflowWrap: 'anywhere' }}>{a.businessName}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy} aria-label="Close" style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {note && <div role="status" style={{ fontSize: 13, color: 'var(--fg-2)' }}>{note}</div>}

        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', fontSize: 13.5 }}>
          <dt style={dt}>For</dt><dd style={dd}>{a.seriesName}</dd>
          <dt style={dt}>Amount</dt><dd style={dd}>The amount due on each invoice, up to {fmtAmount(a.amountCents, a.currency)}</dd>
          <dt style={dt}>How often</dt><dd style={dd}>{cap(how)}</dd>
          {a.nextInvoiceDate && (<><dt style={dt}>Starts</dt><dd style={dd}>{fmtDay(a.nextInvoiceDate)}</dd></>)}
          <dt style={dt}>Card</dt>
          <dd style={dd}>
            {card ? cardLong(card.brand, card.last4) : 'No card saved with this business yet'}
            {card && a.canAddCard && (
              <button type="button" onClick={addCard} disabled={busy}
                style={{ marginLeft: 8, background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                Use a different card
              </button>
            )}
          </dd>
          <dt style={dt}>To stop</dt><dd style={dd}>Turn it off here any time. Invoices are then emailed for you to pay.</dd>
        </dl>

        {card ? (
          <>
            <div data-testid="autopay-terms" style={{
              padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 13, lineHeight: 1.55, color: 'var(--fg-2)',
            }}>{a.terms}</div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13.5, lineHeight: 1.45, cursor: 'pointer' }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }}/>
              <span>I agree to these automatic payments.</span>
            </label>
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
            Add a card to continue. It's kept securely by our payment partner with {a.businessName} only, and you'll confirm the details before anything is set up.
          </div>
        )}

        <ErrorNote>{err}</ErrorNote>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {card ? (
            <button className="btn btn-primary" disabled={!agree || busy} onClick={authorize} style={{ ...actionBtn, flex: '1 1 200px' }}>
              {busy ? 'Saving…' : 'Authorize automatic payments'}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy || !a.canAddCard} onClick={addCard} style={{ ...actionBtn, flex: '1 1 200px' }}>
              <Icons.Plus size={13} sw={2}/> Add a card
            </button>
          )}
          {a.status === 'requested' && (
            <button className="btn btn-ghost" disabled={busy} onClick={decline} style={actionBtn}>No thanks, I'll pay myself</button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

const dt = { color: 'var(--muted)', fontWeight: 500 };
const dd = { margin: 0, color: 'var(--fg)', overflowWrap: 'anywhere' };
