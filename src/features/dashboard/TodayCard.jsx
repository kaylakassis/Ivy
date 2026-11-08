// "Today": the next appointment front and centre with Message / Start /
// Complete, the rest of the day underneath, and money in today / this week.
// Complete is the same call the calendar's Complete button makes and can be
// undone right here (it sends nothing to the client).
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { hapticTap } from '../../lib/haptics.js';
import { useRatingWin } from '../../lib/ratingPrompt.js';
import { fmtMoney, fmtTime } from './format.js';

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// The appointment to put first: the one in progress, else the next one,
// else (day is over) none.
export function pickNext(today) {
  const open = (today || []).filter((b) => !b.completed && !b.noShow);
  const m = nowMinutes();
  return open.find((b) => b.endMin > m) || null;
}

function MoneyPill({ label, value, currency }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 0 }}>
      <span style={{ fontSize: 10.5, letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--muted)' }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 650 }}>{value == null ? '-' : fmtMoney(value, currency)}</span>
    </span>
  );
}

export default function TodayCard({ today = [], money, currency, onChanged }) {
  const [done, setDone] = useState({}); // bookingId -> true (optimistic)
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const list = today.map((b) => (done[b.id] !== undefined ? { ...b, completed: done[b.id] } : b));
  const next = pickNext(list);
  const rest = list.filter((b) => !next || b.id !== next.id);
  const m = nowMinutes();
  const live = next && next.startMin <= m && next.endMin > m;

  const ratingWin = useRatingWin();
  const complete = async (b, on) => {
    setBusy(b.id); setErr(null);
    setDone((d) => ({ ...d, [b.id]: on }));
    if (on) hapticTap();
    try {
      if (on) await api.post('/calendar/bookings/complete', { id: b.id, occurrenceDate: b.date });
      else await api.del('/calendar/bookings/complete', { id: b.id, occurrenceDate: b.date });
      if (on) ratingWin('booking_completed'); // 10th completed booking may ask for a rating
      onChanged?.();
    } catch (e) {
      setDone((d) => ({ ...d, [b.id]: !on }));
      setErr(e.message || 'Could not update the appointment');
    } finally { setBusy(null); }
  };
  const justDone = list.find((b) => done[b.id] === true);

  return (
    <section className="card" aria-labelledby="today-h" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 id="today-h" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Today</h3>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            {list.length === 0 ? 'Nothing booked' : `${list.length} ${list.length === 1 ? 'appointment' : 'appointments'}`}
          </div>
        </div>
        <MoneyPill label="In today" value={money?.today} currency={currency}/>
        <MoneyPill label="This week" value={money?.week} currency={currency}/>
      </div>

      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}

      {next ? (
        <div style={{
          padding: 14, borderRadius: 12,
          background: 'color-mix(in srgb, var(--accent-soft) 55%, var(--surface))',
          border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
        }}>
          <div style={{ fontSize: 11, fontWeight: 650, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>
            {live ? 'Happening now' : 'Up next'}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 22, fontWeight: 700 }}>{fmtTime(next.startMin)}</span>
            <Link to={`/calendar?booking=${next.id}`} style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)', textDecoration: 'none', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {next.clientName || 'Client'}
            </Link>
          </div>
          {next.serviceName && <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 2 }}>{next.serviceName} · until {fmtTime(next.endMin)}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {(next.threadId || next.clientId) && (
              <Link to={next.threadId ? `/messages?threadId=${next.threadId}` : `/clients?id=${next.clientId}`}
                className="btn btn-outline" style={{ padding: '7px 12px', fontSize: 12.5, textDecoration: 'none' }}>
                <Icons.Chat size={13}/> Message
              </Link>
            )}
            {next.videoUrl && /^https:\/\//.test(next.videoUrl) && (
              <a href={next.videoUrl} target="_blank" rel="noopener noreferrer" className="btn btn-outline" style={{ padding: '7px 12px', fontSize: 12.5, textDecoration: 'none' }}>
                <Icons.Arrow size={13}/> Start
              </a>
            )}
            <button type="button" className="btn btn-primary" disabled={busy === next.id}
              onClick={() => complete(next, true)} style={{ padding: '7px 12px', fontSize: 12.5 }}>
              <Icons.Check size={13} sw={2.4}/> Complete
            </button>
          </div>
        </div>
      ) : list.length === 0 ? (
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          A free day. <Link to="/calendar" style={{ color: 'var(--accent)', fontWeight: 600 }}>Share your booking link</Link> or add an appointment.
        </div>
      ) : (
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)' }}>That's everything for today. Nice work.</div>
      )}

      {justDone && (
        <div style={{ fontSize: 12.5, color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icons.Check size={13} sw={2.4}/> {justDone.clientName || 'Appointment'} marked complete.
          <button type="button" className="btn btn-ghost" disabled={busy === justDone.id}
            onClick={() => complete(justDone, false)} style={{ padding: '2px 8px', fontSize: 12 }}>Undo</button>
        </div>
      )}

      {rest.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rest.map((b) => (
            <Link key={b.id} to={`/calendar?booking=${b.id}`} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
              borderRadius: 8, border: '1px solid var(--border)', textDecoration: 'none', color: 'inherit',
              opacity: b.completed || b.noShow || b.endMin <= m ? 0.7 : 1,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', minWidth: 62 }}>{fmtTime(b.startMin)}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {b.clientName || 'Client'}{b.serviceName ? ` · ${b.serviceName}` : ''}
              </span>
              {b.noShow && <span style={{ fontSize: 10.5, color: 'var(--danger)' }}>no-show</span>}
              {b.completed && <Icons.Check size={13} sw={2.4} stroke="var(--ok)"/>}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
