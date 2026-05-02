// /me/bookings — every appointment across all the user's businesses,
// grouped Upcoming / Past / Cancelled with a tab picker.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

function fmtDay(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

const TABS = [
  { id: 'upcoming',  label: 'Upcoming' },
  { id: 'past',      label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
];

export default function ClientBookings() {
  const [data, setData]       = useState({ upcoming: [], past: [], cancelled: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState('upcoming');

  useEffect(() => {
    let live = true;
    api.get('/me/bookings')
      .then((r) => live && setData(r))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  if (loading) return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading bookings…</div>;
  if (error) return (
    <div style={{ padding: 48 }}>
      <div className="card" style={{ padding: 40 }}>
        <EmptyNote icon="Calendar" title="Couldn't load bookings" hint={error.message || 'Try refreshing.'}/>
      </div>
    </div>
  );

  const rows = data[tab] || [];
  const counts = { upcoming: data.upcoming.length, past: data.past.length, cancelled: data.cancelled.length };

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface-2)', borderRadius: 10, alignSelf: 'flex-start' }}>
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
              background: on ? 'var(--surface)' : 'transparent',
              color: on ? 'var(--fg)' : 'var(--muted)',
              boxShadow: on ? 'var(--shadow-sm)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              {t.label}
              <span style={{
                fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
                background: on ? 'var(--surface-2)' : 'var(--surface)',
                color: 'var(--muted)', fontWeight: 600,
              }}>{counts[t.id]}</span>
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Calendar"
            title={tab === 'upcoming' ? 'No upcoming bookings' : tab === 'past' ? 'No past bookings yet' : 'Nothing cancelled'}
            hint={tab === 'upcoming' ? 'When you book a session, it\'ll show up here.' : ''}/>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {rows.map((b, i) => <BookingRow key={b.id} booking={b} first={i === 0}/>)}
        </div>
      )}
    </div>
  );
}

function BookingRow({ booking, first }) {
  const d = new Date(booking.date + 'T00:00:00');
  return (
    <div style={{
      padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
      borderTop: first ? 'none' : '1px solid var(--border)',
    }}>
      <div style={{
        width: 48, height: 52, borderRadius: 10,
        background: booking.cancelledAt ? 'var(--surface-2)' : 'var(--accent-soft)',
        color: booking.cancelledAt ? 'var(--muted)' : 'var(--accent)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        lineHeight: 1.1, fontWeight: 600, flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {d.toLocaleDateString('en-US', { month: 'short' })}
        </span>
        <span style={{ fontSize: 18, fontFamily: 'var(--font-display)' }}>{d.getDate()}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {booking.serviceName || 'Session'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>·</span>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{booking.businessName}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
          {fmtDay(booking.date)} · {fmtTime(booking.startMin)} – {fmtTime(booking.endMin)}
          {booking.price != null && <> · ${Number(booking.price).toFixed(0)}</>}
        </div>
        {booking.notes && (
          <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 4 }}>{booking.notes}</div>
        )}
      </div>
      {booking.cancelledAt && (
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Cancelled
        </div>
      )}
    </div>
  );
}
