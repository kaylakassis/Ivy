// 7×6 month grid. Each cell shows day number + booking dots/labels (max 3,
// then "+N more"). Click a day to drill into Day view.
import React from 'react';
import { addDays, fmtDateISO, minToHM, parseISO, WEEKDAYS_SHORT } from './utils.js';

export default function MonthView({ anchor, cal, onPickDay, onOpenEvent }) {
  // Anchor is any date in the target month; compute the first day to render
  // (Monday on or before the 1st of the month).
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  monthStart.setHours(0, 0, 0, 0);
  // Walk back to Monday
  const offset = (monthStart.getDay() + 6) % 7;
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - offset);

  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const monthIdx = anchor.getMonth();
  const todayISO = fmtDateISO(new Date());

  // Index bookings + blocks by date for quick lookup.
  const byDate = new Map();
  for (const b of (cal.bookings || [])) {
    const arr = byDate.get(b.date) || [];
    arr.push({ kind: 'booking', ...b });
    byDate.set(b.date, arr);
  }
  for (const b of (cal.blocks || [])) {
    const arr = byDate.get(b.date) || [];
    arr.push({ kind: 'block', ...b });
    byDate.set(b.date, arr);
  }
  // Sort each day's events by start.
  for (const arr of byDate.values()) {
    arr.sort((a, b) => a.startMin - b.startMin);
  }

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {/* Header row — weekday labels */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
        background: 'var(--surface-2)', borderBottom: '1px solid var(--border)',
      }}>
        {[1, 2, 3, 4, 5, 6, 0].map((d, i) => (
          <div key={i} style={{
            padding: '10px 12px', fontSize: 10.5, fontWeight: 600, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            borderLeft: i ? '1px solid var(--border)' : 'none',
          }}>{WEEKDAYS_SHORT[d]}</div>
        ))}
      </div>

      {/* 6 weeks × 7 days */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: 'minmax(108px, 1fr)' }}>
        {cells.map((d, i) => {
          const dateISO = fmtDateISO(d);
          const inMonth = d.getMonth() === monthIdx;
          const isToday = dateISO === todayISO;
          const events = byDate.get(dateISO) || [];
          const visible = events.slice(0, 3);
          const overflow = events.length - visible.length;

          return (
            <div key={i}
              onClick={() => onPickDay(d)}
              style={{
                position: 'relative',
                padding: 8,
                borderTop: i >= 7 ? '1px solid var(--border)' : 'none',
                borderLeft: (i % 7) > 0 ? '1px solid var(--border)' : 'none',
                background: isToday ? 'var(--accent-soft)' : 'transparent',
                opacity: inMonth ? 1 : 0.45,
                cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: 4,
                minHeight: 108, overflow: 'hidden',
              }}
              onMouseEnter={(e) => !isToday && (e.currentTarget.style.background = 'var(--surface-2)')}
              onMouseLeave={(e) => !isToday && (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 500,
                color: isToday ? 'var(--accent)' : 'var(--fg)',
              }}>
                {d.getDate()}
              </div>
              {visible.map((ev, j) => {
                // Resolve per-tile color: bookings use the service's
                // color, blocks use their own color (or hatch pattern
                // for hard blocks without a custom color).
                let tileBg, tileColor;
                if (ev.kind === 'booking') {
                  const svc = (cal.services || []).find((s) => s.id === ev.serviceId);
                  tileBg    = svc?.color || 'var(--accent)';
                  tileColor = svc?.color ? '#fff' : 'var(--accent-ink)';
                } else {
                  const isBlocking = ev.blocksBookings !== false;
                  const baseColor  = ev.color || (isBlocking ? null : 'var(--accent)');
                  tileBg = isBlocking
                    ? (baseColor
                        ? `repeating-linear-gradient(-45deg, ${baseColor}22 0 4px, ${baseColor}66 4px 8px)`
                        : 'repeating-linear-gradient(-45deg, var(--surface-2) 0 4px, var(--border-strong) 4px 8px)')
                    : (baseColor ? `${baseColor}33` : 'var(--accent-soft)');
                  tileColor = 'var(--fg-2)';
                }
                return (
                  <button key={j}
                    onClick={(e) => { e.stopPropagation(); onOpenEvent(ev); }}
                    title={ev.kind === 'block' && ev.blocksBookings === false ? 'Reminder only — slot still bookable' : undefined}
                    style={{
                      width: '100%', textAlign: 'left',
                      padding: '3px 6px', borderRadius: 4, border: 0,
                      fontSize: 10.5, fontWeight: 500,
                      background: tileBg,
                      color: tileColor,
                      cursor: 'pointer', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                    }}>
                    {minToHM(ev.startMin)} {ev.kind === 'booking' ? (ev.clientName || 'Booking') : (ev.label || (ev.blocksBookings === false ? 'Event' : 'Block'))}
                  </button>
                );
              })}
              {overflow > 0 && (
                <div style={{ fontSize: 10, color: 'var(--muted)', padding: '0 6px' }}>
                  +{overflow} more
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
