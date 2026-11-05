// Cancellation policy acceptances, for the owner.
//
//   <PolicyAcceptances clientId/>   client profile + the client's folder
//   <BookingPolicyStatus event/>    booking details (EventDrawer)
//
// Each record reads "Cancellation policy accepted on Nov 5, 2026 at
// 3:14 PM (version 2)" with "View what they agreed to" (the exact text
// snapshot) and "Download record", a printable page meant to be saved as
// a PDF and attached to a payment dispute. Records cannot be edited.
import React, { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api, apiFetch } from '../../lib/api.js';

export function acceptedLine(a) {
  const d = new Date(a.acceptedAt);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const v = a.policyVersion != null ? ` (version ${a.policyVersion})` : '';
  if (a.status === 'accepted') return `Cancellation policy accepted on ${date} at ${time}${v}`;
  return `Booked on ${date} at ${time} from an older app version: policy not accepted${v}`;
}

const SOURCE = {
  booking_page: 'on the booking page',
  package_booking: 'when booking with package sessions',
  waitlist: 'when joining the waitlist',
  emailed_link: 'from the link you emailed',
};

async function fetchRecordHtml(id) {
  const res = await apiFetch('GET', `/cancellation-policy/record?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Could not load the record');
  return res.text();
}

function RecordModal({ id, onClose }) {
  const [html, setHtml] = useState(null);
  const [err, setErr] = useState(null);
  const frame = useRef(null);
  useEffect(() => {
    let alive = true;
    fetchRecordHtml(id).then((h) => { if (alive) setHtml(h); }).catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [id]);
  const download = () => {
    if (!html) return;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `cancellation-policy-record-${id.slice(0, 8)}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const print = () => {
    try { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); } catch { download(); }
  };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" role="dialog" aria-modal="true" aria-label="Cancellation policy record"
        style={{ width: '100%', maxWidth: 820, height: 'min(92vh, 900px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, fontWeight: 650, fontSize: 14, minWidth: 140 }}>Cancellation policy record</div>
          <button type="button" className="btn btn-outline" onClick={print} disabled={!html} style={{ fontSize: 12.5 }}>
            <Icons.Doc size={13}/> Print or save as PDF
          </button>
          <button type="button" className="btn btn-outline" onClick={download} disabled={!html} style={{ fontSize: 12.5 }}>
            <Icons.ArrowDown size={13}/> Download
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: 8 }}><Icons.X size={15}/></button>
        </div>
        {err && <div style={{ padding: 16, color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
        {!html && !err && <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}
        {html && (
          <iframe ref={frame} title="Cancellation policy record" srcDoc={html} sandbox="allow-same-origin allow-modals"
            style={{ flex: 1, border: 0, width: '100%', background: '#fff' }}/>
        )}
      </div>
    </div>
  );
}

function AcceptanceRow({ a, onOpenRecord }) {
  const [open, setOpen] = useState(false);
  const ok = a.status === 'accepted';
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ marginTop: 2, color: ok ? 'var(--ok)' : 'var(--warn, #b7791f)', flexShrink: 0 }}>
          {ok ? <Icons.Check size={14} sw={2.4}/> : <Icons.Clock size={14}/>}
        </span>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600 }}>{acceptedLine(a)}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {SOURCE[a.source] || ''}{a.terms?.serviceName ? ` · ${a.terms.serviceName}` : ''}{a.terms?.appointment?.date ? ` on ${a.terms.appointment.date}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', minHeight: 28 }}>
              {open ? 'Hide' : ok ? 'View what they agreed to' : 'View the policy in effect'}
            </button>
            <button type="button" onClick={() => onOpenRecord(a.id)}
              style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', minHeight: 28 }}>
              Download record
            </button>
          </div>
          {open && (
            <div style={{ marginTop: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12.5, color: 'var(--fg-2)', padding: '8px 10px', borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)', maxHeight: 240, overflowY: 'auto' }}>
              {a.policyText}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function List({ items, onOpenRecord }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((a) => <AcceptanceRow key={a.id} a={a} onOpenRecord={onOpenRecord}/>)}
    </div>
  );
}

// Client profile / folder. Renders nothing when the client has no records
// and the policy switch is off (keeps the drawer quiet for owners who
// don't use it).
export default function PolicyAcceptances({ clientId, label = 'Cancellation policy' }) {
  const [data, setData] = useState(null);
  const [recordId, setRecordId] = useState(null);
  useEffect(() => {
    if (!clientId) return undefined;
    let alive = true;
    api.get(`/cancellation-policy/acceptances?clientId=${encodeURIComponent(clientId)}`)
      .then((r) => { if (alive) setData(r); })
      .catch(() => { if (alive) setData({ acceptances: [], settings: {} }); });
    return () => { alive = false; };
  }, [clientId]);
  if (!clientId || !data) return null;
  const items = data.acceptances || [];
  if (items.length === 0 && !data.settings?.requireAcceptance) return null;
  return (
    <div data-testid="policy-acceptances">
      <div className="metric-label" style={{ marginBottom: 8 }}>{label}</div>
      {items.length === 0
        ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No acceptance on record yet. It appears here when this client books.</div>
        : <List items={items} onOpenRecord={setRecordId}/>}
      {recordId && <RecordModal id={recordId} onClose={() => setRecordId(null)}/>}
    </div>
  );
}

// Booking details. Shows the acceptance for this booking, or "Booked by
// you" for bookings the business made, with "Send my policy" so the
// client can accept it by email.
export function BookingPolicyStatus({ bookingId, hasEmail = true }) {
  const [data, setData] = useState(null);
  const [recordId, setRecordId] = useState(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState(null);
  const load = () => api.get(`/cancellation-policy/acceptances?bookingId=${encodeURIComponent(bookingId)}`)
    .then(setData).catch(() => setData(null));
  useEffect(() => { if (bookingId) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [bookingId]);
  if (!bookingId || !data) return null;
  const items = data.acceptances || [];
  if (items.length === 0 && !data.settings?.requireAcceptance) return null;
  const send = async () => {
    setSending(true); setNote(null);
    try {
      const r = await api.post('/cancellation-policy/request', { bookingId });
      setNote(r.sent ? `Sent to ${r.sentTo}.` : 'The email could not be sent (the client may have turned off these emails).');
      load();
    } catch (e) { setNote(e.message || 'Could not send'); } finally { setSending(false); }
  };
  const lastReq = (data.requests || [])[0];
  return (
    <div style={{ marginTop: 14 }} data-testid="booking-policy-status">
      <div className="metric-label" style={{ marginBottom: 8 }}>Cancellation policy</div>
      {items.length > 0 ? (
        <List items={items} onOpenRecord={setRecordId}/>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          {data.bookedByBusiness ? 'Booked by you, so the client has not accepted your policy for this booking.' : 'No acceptance on record for this booking.'}
          {lastReq && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Policy sent {new Date(lastReq.sentAt).toLocaleDateString()}{lastReq.acceptedAt ? ', accepted' : ', not accepted yet'}.</div>}
          {hasEmail && (
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-outline" onClick={send} disabled={sending} style={{ fontSize: 12.5 }}>
                <Icons.Mail size={13}/> {sending ? 'Sending…' : 'Send my policy to accept'}
              </button>
            </div>
          )}
          {note && <div role="status" style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>{note}</div>}
        </div>
      )}
      {recordId && <RecordModal id={recordId} onClose={() => setRecordId(null)}/>}
    </div>
  );
}
