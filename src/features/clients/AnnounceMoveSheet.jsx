// "Let your clients know": the ready-to-send "I've moved my booking to Ivy,
// here is my new link" email, sent only to the clients the owner ticks.
//
// Opened after any import (preselects the people just imported who have an
// email) and from /clients?announce=1 (preselects every client with an
// email who has not been told yet).
//
//   GET  /api/clients/announce-move → { subject, body, bookingUrl, eligibleCount, alreadyAnnouncedCount }
//   POST /api/clients/announce-move { clientIds, subject, body } → { sent, skipped: { noEmail, optedOut, alreadySent, overCap } }
//   GET  /api/clients (existing, paged) for the checklist; moveAnnouncedAt
//   marks who was already told.
//
// Plain text only: the subject and body are plain inputs, and the server
// escapes what it renders.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { Sheet, Note, PeopleChecklist, plural } from './import/parts.jsx';

const SUBJECT_MAX = 150;
const BODY_MAX = 3000;
const SEND_MAX = 1000;      // per request (server cap)
const DAILY_CAP = 500;      // per workspace per day (server cap)
const PAGE_LIMIT = 6;       // up to 6,000 clients listed

async function loadAllClients() {
  const out = [];
  let offset = 0;
  for (let i = 0; i < PAGE_LIMIT; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await api.get(offset ? `/clients?offset=${offset}` : '/clients');
    out.push(...(r.clients || []));
    if (!r.hasMore || r.nextOffset == null) break;
    offset = r.nextOffset;
  }
  return out;
}

export function AnnounceMove({ clientIds, onClose }) {
  const [draft, setDraft] = useState(null);
  const [clients, setClients] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.get('/clients/announce-move'), loadAllClients()])
      .then(([d, list]) => {
        if (!live) return;
        setDraft(d);
        setSubject(String(d.subject || '').slice(0, SUBJECT_MAX));
        setBody(String(d.body || '').slice(0, BODY_MAX));
        setClients(list);
        const pick = Array.isArray(clientIds) && clientIds.length
          ? new Set(clientIds.map(String))
          : null;
        setSelected(new Set(list
          .filter((c) => (c.email || '').trim() && !c.moveAnnouncedAt && c.source !== 'demo')
          .filter((c) => !pick || pick.has(String(c.id)))
          .map((c) => c.id)));
      })
      .catch((e) => live && setErr(e.message || 'Could not load your clients.'));
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scope = useMemo(() => {
    if (!clients) return [];
    const pick = Array.isArray(clientIds) && clientIds.length ? new Set(clientIds.map(String)) : null;
    return clients.filter((c) => c.source !== 'demo' && (!pick || pick.has(String(c.id))));
  }, [clients, clientIds]);

  const items = useMemo(() => scope.map((c) => {
    const email = (c.email || '').trim();
    return {
      id: c.id,
      primary: c.name,
      secondary: email || 'No email',
      disabled: !email || !!c.moveAnnouncedAt,
      tag: !email ? '' : c.moveAnnouncedAt ? 'Already told' : '',
    };
  }), [scope]);

  const noEmail = scope.filter((c) => !(c.email || '').trim()).length;
  const alreadyTold = scope.filter((c) => (c.email || '').trim() && c.moveAnnouncedAt).length;
  const count = Math.min(selected.size, SEND_MAX);

  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/clients/announce-move', {
        clientIds: Array.from(selected).slice(0, SEND_MAX),
        subject: subject.trim().slice(0, SUBJECT_MAX),
        body: body.slice(0, BODY_MAX),
      });
      setResult(r);
    } catch (e) {
      setErr(e.message || 'Could not send. Nothing went out.');
      setConfirming(false);
    } finally { setBusy(false); }
  };

  if (result) {
    const s = result.skipped || {};
    const skippedBits = [
      s.noEmail ? `${s.noEmail} with no email` : null,
      s.optedOut ? `${s.optedOut} who unsubscribed` : null,
      s.alreadySent ? `${s.alreadySent} already told` : null,
      s.overCap ? `${s.overCap} over today's limit of ${DAILY_CAP} (send to them tomorrow)` : null,
    ].filter(Boolean);
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 52, height: 52, borderRadius: 99, margin: '4px auto 14px',
          background: 'var(--ok)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 24, fontWeight: 700,
        }}>✓</div>
        <h3 className="page-title" style={{ margin: 0, fontSize: 22 }}>
          {result.sent ? `Sent to ${plural(result.sent, 'client')}` : 'Nothing was sent'}
        </h3>
        {skippedBits.length > 0 && (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
            Skipped: {skippedBits.join(', ')}.
          </p>
        )}
        <button type="button" onClick={onClose} className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', padding: '12px 14px', marginTop: 18 }}>Done</button>
      </div>
    );
  }

  if (!draft || !clients) {
    return err
      ? <Note tone="err">{err}</Note>
      : <div style={{ fontSize: 13, color: 'var(--muted)', padding: 12 }}>Getting your email ready…</div>;
  }

  return (
    <>
      <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        A short note so your clients know where to book now. Change anything you like.
        It only goes to the people you tick.
      </p>

      <label style={labelStyle} htmlFor="announce-subject">Subject</label>
      <input id="announce-subject" className="input" value={subject} maxLength={SUBJECT_MAX}
        onChange={(e) => setSubject(e.target.value)} style={{ width: '100%', marginBottom: 12 }}/>

      <label style={labelStyle} htmlFor="announce-body">Message</label>
      <textarea id="announce-body" className="input" value={body} maxLength={BODY_MAX} rows={8}
        onChange={(e) => setBody(e.target.value)}
        style={{ width: '100%', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}/>
      {draft.bookingUrl && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
          Your booking link: <span style={{ color: 'var(--fg-2)' }}>{draft.bookingUrl}</span>. Keep it in the message so they can book.
        </div>
      )}

      <div style={{ ...labelStyle, marginTop: 16 }}>Who gets it</div>
      <PeopleChecklist items={items} selected={selected} onChange={setSelected} maxHeight={260}/>

      {(noEmail > 0 || alreadyTold > 0) && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
          Left out: {[noEmail ? `${noEmail} with no email` : null, alreadyTold ? `${alreadyTold} you already told` : null].filter(Boolean).join(', ')}.
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
        Anyone who unsubscribed from your emails is skipped too. Each email has an unsubscribe link.
      </div>
      {selected.size > DAILY_CAP && (
        <Note tone="warn" style={{ marginTop: 10 }}>
          Ivy sends up to {DAILY_CAP} of these a day. Anyone over that is skipped today, and you can send to them tomorrow.
        </Note>
      )}
      {err && <Note tone="err" style={{ marginTop: 12 }}>{err}</Note>}

      <div style={{ marginTop: 16 }}>
        {!confirming ? (
          <button type="button" className="btn btn-primary" disabled={count === 0 || !subject.trim() || !body.trim()}
            onClick={() => setConfirming(true)}
            style={{ width: '100%', justifyContent: 'center', padding: '12px 14px', opacity: count === 0 ? 0.6 : 1 }}>
            {count === 0 ? 'Pick who gets it' : `Send to ${plural(count, 'client')}`}
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Note tone="warn">This emails {plural(count, 'client')} now. It cannot be unsent.</Note>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-outline" onClick={() => setConfirming(false)} disabled={busy}
                style={{ flex: 1, justifyContent: 'center' }}>Not yet</button>
              <button type="button" className="btn btn-primary" onClick={send} disabled={busy}
                style={{ flex: 2, justifyContent: 'center' }}>{busy ? 'Sending…' : `Yes, send ${count}`}</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default function AnnounceMoveSheet({ clientIds, onClose }) {
  return (
    <Sheet title="Let your clients know" icon="Mail" onClose={onClose} maxWidth={600}>
      <AnnounceMove clientIds={clientIds} onClose={onClose}/>
    </Sheet>
  );
}

const labelStyle = {
  display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)',
  letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 6,
};
