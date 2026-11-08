// Booking requests waiting for Approve / Decline, at the top of the calendar.
// One row per request: who, what, when, how long the time is held, and the
// two buttons. Decline opens a small optional note first. "Details" opens
// the usual booking drawer (same Approve / Decline there).
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { minToHM, parseISO } from './utils.js';

export function holdLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return 'hold ended';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `held ${h} more hour${h === 1 ? '' : 's'}`;
  const m = Math.max(1, Math.floor(ms / 60_000));
  return `held ${m} more minute${m === 1 ? '' : 's'}`;
}

export default function BookingRequestsCard({ requests, services, onOpen, onDecide }) {
  const [busyId, setBusyId] = useState(null);
  const [declining, setDeclining] = useState(null); // request id with the note box open
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  const list = (requests || []).slice().sort((a, b) => String(a.requestExpiresAt || '').localeCompare(String(b.requestExpiresAt || '')));
  if (list.length === 0) return null;

  const decide = async (b, decision) => {
    setBusyId(b.id); setErr(null);
    try {
      await onDecide(b.id, decision, decision === 'decline' ? note.trim() : '');
      setDeclining(null); setNote('');
    } catch (e) {
      setErr(e.message || 'That did not work. Try again.');
    } finally { setBusyId(null); }
  };

  return (
    <section className="card" aria-labelledby="req-h" style={{ padding: 16, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 26, height: 26, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: '1.5px dashed var(--accent)', color: 'var(--accent)', flexShrink: 0,
        }}><Icons.Clock size={14} sw={2}/></span>
        <h3 id="req-h" style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>
          {list.length === 1 ? 'Booking request' : `${list.length} booking requests`}
        </h3>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Each one holds its time until you answer</span>
      </div>
      {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((b) => {
          const svc = (services || []).find((s) => s.id === b.serviceId);
          const busy = busyId === b.id;
          const open = declining === b.id;
          return (
            <li key={b.id} style={{
              border: '1.5px dashed var(--border-strong)', borderRadius: 10, padding: '10px 12px',
              display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--surface)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => onOpen(b)} style={{ flex: 1, minWidth: 180, textAlign: 'left', padding: 0, background: 'none', border: 0, cursor: 'pointer', color: 'var(--fg)' }}>
                  <div style={{ fontSize: 14, fontWeight: 650 }}>{b.clientName || 'Client'}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                    {svc?.name || 'Session'} · {parseISO(b.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at {minToHM(b.startMin)}
                    {Number(b.depositRequired) > 0 && <> · ${Number(b.depositRequired).toFixed(2)} deposit charged on approval</>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{holdLabel(b.requestExpiresAt)}{b.notes ? ` · "${b.notes.slice(0, 80)}"` : ''}</div>
                </button>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button type="button" className="btn btn-outline" disabled={busy} style={{ padding: '6px 11px', fontSize: 12.5 }}
                    onClick={() => { setDeclining(open ? null : b.id); setNote(''); }}>
                    Decline
                  </button>
                  <button type="button" className="btn btn-primary" disabled={busy} style={{ padding: '6px 12px', fontSize: 12.5 }}
                    onClick={() => decide(b, 'approve')}>
                    {busy && !open ? 'Approving…' : 'Approve'}
                  </button>
                </div>
              </div>
              {open && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                    placeholder="Optional note to the client, for example: that day is full, Thursday afternoons are open" style={{ fontSize: 13 }}/>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-ghost" disabled={busy} style={{ padding: '6px 10px', fontSize: 12.5 }} onClick={() => setDeclining(null)}>Keep waiting</button>
                    <button type="button" className="btn btn-primary" disabled={busy}
                      style={{ padding: '6px 12px', fontSize: 12.5, background: 'var(--danger)', color: '#fff' }}
                      onClick={() => decide(b, 'decline')}>
                      {busy ? 'Declining…' : 'Decline and tell them'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
