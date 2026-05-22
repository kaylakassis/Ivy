// Edit weekly availability windows.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { TimeInput } from './Drawer.jsx';
import { WEEKDAYS_LONG, minToHM } from './utils.js';

const NOTICE_OPTIONS = [
  { v: 0,   label: 'No minimum — same-day OK' },
  { v: 1,   label: '1 hour' },
  { v: 2,   label: '2 hours' },
  { v: 4,   label: '4 hours' },
  { v: 12,  label: '12 hours' },
  { v: 24,  label: '1 day' },
  { v: 48,  label: '2 days' },
  { v: 72,  label: '3 days' },
  { v: 168, label: '1 week' },
];

// Start-time spacing. A fixed grid (value = minutes) or 'service' to step
// by each service's own length (back-to-back).
const START_OPTIONS = [
  { v: '60',      label: 'Top of the hour (1:00, 2:00, 3:00…)' },
  { v: '45',      label: 'Every 45 minutes' },
  { v: '30',      label: 'Every 30 minutes (on the hour & half hour)' },
  { v: '20',      label: 'Every 20 minutes' },
  { v: '15',      label: 'Every 15 minutes' },
  { v: '10',      label: 'Every 10 minutes' },
  { v: '5',       label: 'Every 5 minutes' },
  { v: 'service', label: 'Back-to-back — fit each service’s length' },
];

// Minimum gap forced between appointments (e.g. clean-up / reset time).
const BUFFER_OPTIONS = [
  { v: 0,  label: 'No buffer — back-to-back OK' },
  { v: 5,  label: '5 minutes' },
  { v: 10, label: '10 minutes' },
  { v: 15, label: '15 minutes' },
  { v: 20, label: '20 minutes' },
  { v: 30, label: '30 minutes' },
  { v: 45, label: '45 minutes' },
  { v: 60, label: '60 minutes' },
];

const cardStyle = {
  padding: 14, borderRadius: 10, border: '1px solid var(--border)',
  background: 'var(--surface)', marginBottom: 14,
};
const selectStyle = {
  width: '100%', padding: '9px 10px', borderRadius: 8,
  border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
  color: 'var(--fg)', fontSize: 14,
};

export default function AvailabilityDrawer({ initial, noticeHours, slotMinutes, slotFitService, bufferMinutes, onSave, onClose }) {
  const [avail, setAvail] = useState(initial || {});
  const [notice, setNotice] = useState(noticeHours == null ? 24 : Number(noticeHours));
  const [startMode, setStartMode] = useState(slotFitService ? 'service' : String(slotMinutes || 30));
  const [buffer, setBuffer] = useState(bufferMinutes == null ? 0 : Number(bufferMinutes));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const setDay = (day, windows) => setAvail({ ...avail, [day]: windows });

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const fit = startMode === 'service';
      await onSave({
        availability: avail,
        minNoticeHours: notice,
        slotFitService: fit,
        bufferMinutes: buffer,
        ...(fit ? {} : { slotMinutes: Number(startMode) }),
      });
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="Weekly availability" subtitle="Clients can only book inside these hours" onClose={onClose}>
      <div style={cardStyle}>
        <label style={{ fontWeight: 600, fontSize: 14, display: 'block' }} htmlFor="start-times">
          Appointment start times
        </label>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 8px' }}>
          When new appointments can begin. “Top of the hour” means the next
          client can only start at 2:00, 3:00, etc. “Back-to-back” starts the
          next appointment right when each service’s length allows.
        </div>
        <select id="start-times" value={startMode} onChange={(e) => setStartMode(e.target.value)} style={selectStyle}>
          {START_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </div>

      <div style={cardStyle}>
        <label style={{ fontWeight: 600, fontSize: 14, display: 'block' }} htmlFor="min-notice">
          Minimum booking notice
        </label>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 8px' }}>
          How far ahead clients must book. Past times are always hidden.
        </div>
        <select id="min-notice" value={notice} onChange={(e) => setNotice(Number(e.target.value))} style={selectStyle}>
          {NOTICE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </div>

      <div style={cardStyle}>
        <label style={{ fontWeight: 600, fontSize: 14, display: 'block' }} htmlFor="buffer">
          Buffer between appointments
        </label>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 8px' }}>
          A required gap around each appointment (clean-up, reset, travel).
          Clients can’t book within this many minutes of another booking.
        </div>
        <select id="buffer" value={buffer} onChange={(e) => setBuffer(Number(e.target.value))} style={selectStyle}>
          {BUFFER_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <DayRow key={d} dayIdx={d} windows={avail[d] || []} onChange={(w) => setDay(d, w)}/>
        ))}
      </div>

      {err && (
        <div style={{
          marginTop: 14, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
        <button className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}
          style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save availability'}
        </button>
      </div>
    </Drawer>
  );
}

function DayRow({ dayIdx, windows, onChange }) {
  const on = windows.length > 0;
  return (
    <div style={{
      padding: 14, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 14, minWidth: 90 }}>{WEEKDAYS_LONG[dayIdx]}</div>
        <button onClick={() => (on ? onChange([]) : onChange([{ start: 9 * 60, end: 17 * 60 }]))} style={{
          width: 38, height: 22, borderRadius: 99,
          background: on ? 'var(--accent)' : 'var(--surface-2)',
          border: `1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
          position: 'relative', cursor: 'pointer',
        }}>
          <span style={{
            position: 'absolute', top: 2, left: on ? 18 : 2,
            width: 16, height: 16, borderRadius: 99, background: on ? 'var(--accent-ink)' : '#fff',
            transition: 'left .12s',
          }}/>
        </button>
        <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>
          {on ? windows.map((w) => `${minToHM(w.start)}–${minToHM(w.end)}`).join(', ') : 'Unavailable'}
        </span>
        {on && (
          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={() => onChange([...windows, { start: 14 * 60, end: 17 * 60 }])}>+ Add window</button>
        )}
      </div>
      {on && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {windows.map((w, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <TimeInput minutes={w.start} onChange={(v) => onChange(windows.map((x, j) => j === i ? { ...x, start: v } : x))}/>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
              <TimeInput minutes={w.end} onChange={(v) => onChange(windows.map((x, j) => j === i ? { ...x, end: v } : x))}/>
              {windows.length > 1 && (
                <button className="btn btn-ghost" style={{ padding: 4, color: 'var(--danger)' }}
                  onClick={() => onChange(windows.filter((_, j) => j !== i))}>
                  <Icons.X size={14}/>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
