// The timed items of one calendar day (blocked time, personal events and
// bookings), shared by the Day view and each Week column. Items that
// overlap sit side by side so every title stays visible, short items
// collapse to one line, and each tile carries its color as a solid bar
// down the left edge so color coding reads at a glance.
import React from 'react';
import { minToHM, layoutOverlaps, tileX, hex6 } from './utils.js';

export default function DayTiles({ dateISO, cal, gridStartMin, rowH, totalH, dense = false, onOpenEvent }) {
  const blocks = (cal.blocks || []).filter((b) => b.date === dateISO && !b.allDay);
  const bookings = (cal.bookings || []).filter((b) => b.date === dateISO);
  const minTileH = dense ? 20 : 24;
  const pos = layoutOverlaps([...blocks, ...bookings], Math.ceil((minTileH / rowH) * 60));
  const pad = dense ? 2 : 6;

  const place = (ev) => {
    const rawTop = ((ev.startMin - gridStartMin) / 60) * rowH;
    const top = Math.max(0, rawTop);
    const h = Math.max(minTileH, Math.min(totalH - top, ((ev.endMin - ev.startMin) / 60) * rowH - (top - rawTop)));
    const p = pos.get(ev);
    return { top, h, ...tileX(p, pad, dense ? 2 : 4), cols: p?.cols || 1 };
  };
  // Narrow tiles (several side by side) and short ones show one line.
  const oneLine = (h, cols) => h < (dense ? 34 : 42) || (dense && cols > 1 && h < 48);
  const textCut = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  const fs = dense ? 11 : 12;
  const fsSmall = dense ? 10 : 11;

  return (
    <>
      {blocks.map((b) => {
        const { top, h, left, width, cols } = place(b);
        const isBlocking = b.blocksBookings !== false;
        const color = hex6(b.color) || null;
        const bg = isBlocking
          ? (color
              ? `repeating-linear-gradient(-45deg, ${color}1f 0 6px, ${color}52 6px 12px)`
              : 'repeating-linear-gradient(-45deg, var(--surface-2) 0 6px, color-mix(in srgb, var(--border-strong) 70%, var(--surface-2)) 6px 12px)')
          : (color ? `${color}33` : 'var(--accent-soft)');
        const edge = color || (isBlocking ? 'var(--border-strong)' : 'var(--accent)');
        const title = b.label || (isBlocking ? 'Blocked' : 'Event');
        const when = `${minToHM(b.startMin)} to ${minToHM(b.endMin)}`;
        const single = oneLine(h, cols);
        return (
          <div key={'b' + b.id}
            onClick={(e) => { e.stopPropagation(); onOpenEvent({ kind: 'block', ...b }); }}
            title={`${title}, ${when}. ${isBlocking ? 'Blocks bookings' : 'Reminder only (clients can still book)'}`}
            style={{
              position: 'absolute', top, height: h, left, width, boxSizing: 'border-box',
              background: bg, border: `1px solid ${edge}`, borderLeft: `4px solid ${edge}`,
              borderRadius: dense ? 6 : 8,
              padding: single ? (dense ? '2px 5px' : '3px 8px') : (dense ? '4px 6px' : '7px 10px'),
              fontSize: fs, color: 'var(--fg-2)', cursor: 'pointer', overflow: 'hidden',
              display: single ? 'flex' : 'block', alignItems: 'center', gap: 6,
            }}>
            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: '0 1 auto' }}>
              {!isBlocking && <span aria-hidden="true" style={{ fontSize: fsSmall - 1, opacity: 0.7 }}>◌</span>}
              <span style={textCut}>{title}</span>
            </div>
            <div style={{ color: 'var(--muted)', fontSize: fsSmall, marginTop: single ? 0 : 2, minWidth: 0, flex: '0 1000 auto', ...textCut }}>
              {single ? minToHM(b.startMin) : when}
            </div>
          </div>
        );
      })}
      {bookings.map((b) => {
        const { top, h, left, width, cols } = place(b);
        const svc = (cal.services || []).find((s) => s.id === b.serviceId);
        const tile = hex6(svc?.color) || 'var(--accent)';
        const ink = svc?.color ? '#fff' : 'var(--accent-ink)';
        // A booking request: dashed outline, not filled, "Requested".
        const req = !!b.isRequest;
        const name = `${req ? 'Requested: ' : ''}${b.clientName || 'Client'}`;
        const single = oneLine(h, cols);
        const detail = dense
          ? `${svc?.name || 'Session'} · ${minToHM(b.startMin)}`
          : `${svc?.name || 'Session'} · ${minToHM(b.startMin)} to ${minToHM(b.endMin)}`;
        return (
          <div key={'k' + b.id}
            onClick={(e) => { e.stopPropagation(); onOpenEvent({ kind: 'booking', ...b }); }}
            title={req ? `${name}. Booking request: waiting for your approval` : `${b.clientName || 'Client'}, ${svc?.name || 'Session'}, ${minToHM(b.startMin)} to ${minToHM(b.endMin)}`}
            style={{
              position: 'absolute', top, height: h, left, width, boxSizing: 'border-box',
              background: req ? 'var(--surface)' : tile, color: req ? 'var(--fg)' : ink,
              border: req ? `1.5px dashed ${tile}` : `1px solid ${tile}`,
              borderLeft: req ? `4px solid ${tile}` : `1px solid ${tile}`,
              borderRadius: dense ? 6 : 8,
              padding: single ? (dense ? '2px 5px' : '3px 8px') : (dense ? '4px 6px' : '7px 10px'),
              fontSize: fs, cursor: 'pointer', overflow: 'hidden',
              display: single ? 'flex' : 'block', alignItems: 'center', gap: 6,
              zIndex: 1,
            }}>
            <div style={{ fontWeight: 600, minWidth: 0, flex: '0 1 auto', ...textCut }}>{name}</div>
            <div style={{ fontSize: fsSmall, opacity: 0.85, marginTop: single ? 0 : 2, minWidth: 0, flex: '0 1000 auto', ...textCut }}>
              {single ? minToHM(b.startMin) : detail}
            </div>
          </div>
        );
      })}
    </>
  );
}

// All-day items as a strip of chips above the hours, so they no longer
// sit on top of the whole day and hide everything under them.
export function AllDayChips({ dateISO, cal, onOpenEvent, dense = false }) {
  const items = (cal.blocks || []).filter((b) => b.date === dateISO && b.allDay);
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.map((b) => {
        const isBlocking = b.blocksBookings !== false;
        const color = hex6(b.color) || null;
        const edge = color || (isBlocking ? 'var(--border-strong)' : 'var(--accent)');
        const title = b.label || (isBlocking ? 'Blocked' : 'Event');
        return (
          <button key={b.id} type="button"
            onClick={(e) => { e.stopPropagation(); onOpenEvent({ kind: 'block', ...b }); }}
            title={`${title}, all day. ${isBlocking ? 'Blocks bookings' : 'Reminder only (clients can still book)'}`}
            style={{
              maxWidth: '100%', minWidth: 0, textAlign: 'left', cursor: 'pointer',
              font: 'inherit', fontSize: dense ? 10.5 : 12, fontWeight: 600, color: 'var(--fg-2)',
              padding: dense ? '2px 5px' : '4px 10px', borderRadius: 6,
              background: color ? `${color}2e` : (isBlocking ? 'var(--surface-2)' : 'var(--accent-soft)'),
              border: `1px solid ${edge}`, borderLeft: `4px solid ${edge}`,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
            {title}{dense ? '' : <span style={{ fontWeight: 400, color: 'var(--muted)' }}> · All day</span>}
          </button>
        );
      })}
    </div>
  );
}
