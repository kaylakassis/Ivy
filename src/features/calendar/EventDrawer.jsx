// Event drawer — for both blocks (editable) and bookings (view-only + cancel).
import React, { useState } from 'react';
import Drawer, { TimeInput, inputSty } from './Drawer.jsx';
import { minToHM, parseISO } from './utils.js';

export default function EventDrawer({ event, services, onSaveBlock, onDelete, onClose }) {
  if (event.kind === 'booking') {
    return <BookingView event={event} services={services} onCancel={onDelete} onClose={onClose}/>;
  }
  return <BlockEdit event={event} onSave={onSaveBlock} onDelete={onDelete} onClose={onClose}/>;
}

function BookingView({ event, services, onCancel, onClose }) {
  const svc = services.find((s) => s.id === event.serviceId);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const cancel = async () => {
    setBusy(true);
    try { await onCancel(event); onClose(); } finally { setBusy(false); }
  };

  return (
    <Drawer title="Booking details" onClose={onClose}>
      <InfoRow label="Client"  value={event.clientName}/>
      <InfoRow label="Email"   value={event.clientEmail}/>
      <InfoRow label="Service" value={svc?.name || '—'}/>
      <InfoRow label="Date"    value={parseISO(event.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}/>
      <InfoRow label="Time"    value={`${minToHM(event.startMin)} – ${minToHM(event.endMin)}`}/>
      <InfoRow label="Price"   value={svc ? `$${Number(svc.price).toLocaleString()}` : '—'}/>
      {event.notes && <InfoRow label="Notes" value={event.notes}/>}

      <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
        {confirm ? (
          <>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--danger)' }}>
              Cancel this booking? This can't be undone.
            </span>
            <button className="btn btn-outline" onClick={() => setConfirm(false)} disabled={busy}>Keep it</button>
            <button className="btn btn-primary" disabled={busy} onClick={cancel}
              style={{ background: 'var(--danger)', color: '#fff', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Cancelling…' : 'Cancel booking'}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Close</button>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center', background: 'var(--danger)', color: '#fff' }}
              onClick={() => setConfirm(true)}>Cancel booking</button>
          </>
        )}
      </div>
    </Drawer>
  );
}

function BlockEdit({ event, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState({
    date: event.date,
    startMin: event.startMin,
    endMin: event.endMin,
    label: event.label || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave({ ...event, ...draft });
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!event.id) { onClose(); return; }
    setBusy(true);
    try { await onDelete(event); onClose(); } finally { setBusy(false); }
  };

  return (
    <Drawer
      title={event.id ? 'Edit blocked time' : 'Block time'}
      subtitle="Clients can't book during blocked periods."
      onClose={onClose}
    >
      <Field label="Reason (optional)">
        <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Lunch, vacation, personal…" style={inputSty}/>
      </Field>
      <Field label="Date">
        <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })}
          style={inputSty}/>
      </Field>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Start</div>
          <TimeInput minutes={draft.startMin} onChange={(v) => setDraft({ ...draft, startMin: v })}/>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>End</div>
          <TimeInput minutes={draft.endMin} onChange={(v) => setDraft({ ...draft, endMin: v })}/>
        </div>
      </div>

      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5, marginBottom: 12,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
        {event.id && (
          <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={remove} disabled={busy}>
            Delete
          </button>
        )}
        <div style={{ flex: 1 }}/>
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy} style={{ opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Drawer>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12 }}>
      <div style={{ width: 100, fontSize: 12, color: 'var(--muted)' }}>{label}</div>
      <div style={{ flex: 1, fontSize: 14, fontWeight: 500, wordBreak: 'break-word' }}>{value}</div>
    </div>
  );
}
