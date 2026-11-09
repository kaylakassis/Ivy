// Single-day timeline view. Shows the full day at a higher zoom level than
// the week grid: 7am to 9pm by default (stretched to fit anything earlier
// or later that day), click empty space to add a block, click a
// block/booking to edit. Overlapping items sit side by side (DayTiles).
import React from 'react';
import { fmtDateISO, minToHM } from './utils.js';
import DayTiles, { AllDayChips } from './DayTiles.jsx';

const HOURS_START = 7;   // 7am
const HOURS_END   = 21;  // 9pm
const ROW_H       = 64;

export default function DayView({ date, cal, onPickBlock, onOpenEvent }) {
  const dateISO = fmtDateISO(date);
  const dayIdx  = date.getDay();
  const todayISO = fmtDateISO(new Date());
  const isToday = dateISO === todayISO;
  const avail   = (cal.settings.availability && cal.settings.availability[String(dayIdx)]) || [];
  // A 6am or 10pm appointment used to be drawn off the grid; stretch the
  // hours to include everything timed on this day.
  let startH = HOURS_START, endH = HOURS_END;
  for (const ev of [...(cal.bookings || []), ...(cal.blocks || [])]) {
    if (ev.date !== dateISO || ev.allDay) continue;
    if (Number.isFinite(ev.startMin)) startH = Math.min(startH, Math.max(0, Math.floor(ev.startMin / 60)));
    if (Number.isFinite(ev.endMin))   endH   = Math.max(endH, Math.min(23, Math.ceil(ev.endMin / 60) - 1));
  }
  const hours   = Array.from({ length: endH - startH + 1 }, (_, i) => i + startH);

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid var(--border)',
        background: isToday ? 'var(--accent-soft)' : 'transparent',
        display: 'flex', alignItems: 'baseline', gap: 12,
      }}>
        <div>
          <div className="metric-label" style={{ fontSize: 11 }}>
            {date.toLocaleDateString('en-US', { weekday: 'long' })}
          </div>
          <div className="page-title" style={{ fontSize: 22, marginTop: 2, color: isToday ? 'var(--accent)' : 'var(--fg)' }}>
            {date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
          </div>
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {plural((cal.bookings || []).filter((b) => b.date === dateISO && !b.isRequest).length, 'booking')}
          {' · '}
          {plural((cal.blocks || []).filter((b) => b.date === dateISO).length, 'event')}
        </div>
      </div>

      {(cal.blocks || []).some((b) => b.date === dateISO && b.allDay) && (
        <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', borderBottom: '1px solid var(--border)' }}>
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>All day</div>
          <div style={{ padding: 6, borderLeft: '1px solid var(--border)' }}>
            <AllDayChips dateISO={dateISO} cal={cal} onOpenEvent={onOpenEvent}/>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr' }}>
        <div>
          {hours.map((h) => (
            <div key={h} style={{ height: ROW_H, padding: '4px 12px', fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
              {minToHM(h * 60)}
            </div>
          ))}
        </div>
        <div style={{
          borderLeft: '1px solid var(--border)', position: 'relative',
          height: ROW_H * hours.length, cursor: 'pointer',
        }}
          onClick={(e) => {
            if (e.currentTarget !== e.target) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const startMin = startH * 60 + Math.floor(y / (ROW_H / 2)) * 30;
            onPickBlock(dateISO, startMin, startMin + 60);
          }}
        >
          {hours.map((_, i) => (
            <div key={i} style={{ height: ROW_H, borderTop: i ? '1px solid var(--border)' : 'none', pointerEvents: 'none' }}/>
          ))}
          {/* availability bands */}
          {avail.map((w, wi) => {
            const top = ((w.start - startH * 60) / 60) * ROW_H;
            const h   = ((w.end - w.start) / 60) * ROW_H;
            if (h <= 0) return null;
            return (
              <div key={'av' + wi} style={{
                position: 'absolute', top: Math.max(0, top),
                height: Math.min(hours.length * ROW_H - Math.max(0, top), h),
                left: 4, right: 4, pointerEvents: 'none',
                background: 'color-mix(in srgb, var(--ok) 7%, transparent)',
                borderLeft: '2px solid color-mix(in srgb, var(--ok) 55%, transparent)',
              }}/>
            );
          })}
          <DayTiles dateISO={dateISO} cal={cal} gridStartMin={startH * 60} rowH={ROW_H}
            totalH={ROW_H * hours.length} onOpenEvent={onOpenEvent}/>
        </div>
      </div>
    </div>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
