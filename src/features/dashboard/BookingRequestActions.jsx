// Inline Approve / Decline for the "Needs your attention" row about booking
// requests (api/_lib/accountability.js bookingRequests). Each request is one
// line with its two buttons; Decline asks for an optional note first. Calls
// the same PATCH the calendar drawer uses, so there is one approve path.
import React, { useState } from 'react';
import { api } from '../../lib/api.js';

export default function BookingRequestActions({ requests, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState({}); // id -> 'approve' | 'decline'
  const [err, setErr] = useState(null);
  const list = (requests || []).filter((r) => !done[r.id]);
  if (list.length === 0 && !Object.keys(done).length) return null;

  const decide = async (r, decision) => {
    setBusyId(r.id); setErr(null);
    try {
      await api.patch('/calendar/bookings/' + r.id, { decideRequest: decision, ...(decision === 'decline' && note.trim() ? { message: note.trim() } : {}) });
      setDone((d) => ({ ...d, [r.id]: decision }));
      setDeclining(null); setNote('');
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'That did not work. Try again from the calendar.');
    } finally { setBusyId(null); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
      {err && <div role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
      {list.map((r) => {
        const busy = busyId === r.id;
        const open = declining === r.id;
        return (
          <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 8, border: '1.5px dashed var(--border-strong)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 160, fontSize: 12.5, lineHeight: 1.4 }}>
                <b>{r.firstName}</b>: {r.service}, {r.when}
                {r.holdsUntil && <span style={{ color: 'var(--muted)' }}> · held until {r.holdsUntil}</span>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="btn btn-outline" disabled={busy} style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={() => { setDeclining(open ? null : r.id); setNote(''); }}>Decline</button>
                <button type="button" className="btn btn-primary" disabled={busy} style={{ padding: '4px 11px', fontSize: 12 }}
                  onClick={() => decide(r, 'approve')}>{busy && !open ? 'Approving…' : 'Approve'}</button>
              </div>
            </div>
            {open && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                  placeholder="Optional note to the client" style={{ flex: '1 1 160px', fontSize: 12.5 }}/>
                <button type="button" className="btn btn-primary" disabled={busy}
                  style={{ padding: '4px 10px', fontSize: 12, background: 'var(--danger)', color: '#fff' }}
                  onClick={() => decide(r, 'decline')}>{busy ? 'Declining…' : 'Decline and tell them'}</button>
              </div>
            )}
          </div>
        );
      })}
      {Object.entries(done).map(([id, d]) => (
        <div key={id} style={{ fontSize: 12, color: 'var(--ok)' }}>
          {d === 'approve' ? 'Approved. The client got their confirmation.' : 'Declined. The client was told to pick another time.'}
        </div>
      ))}
    </div>
  );
}
