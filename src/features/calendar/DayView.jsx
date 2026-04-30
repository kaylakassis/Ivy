// Single-day timeline view. Shows the full day at a higher zoom level than
// the week grid: 7am – 9pm by default, click empty space to add a block,
// click a block/booking to edit.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';
import { fmtDateISO, minToHM } from './utils.js';

const HOURS_START = 7;   // 7am
const HOURS_END   = 21;  // 9pm
const ROW_H       = 64;

export default function DayView({ date, cal, onPickBlock, onOpenEvent }) {
  const dateISO = fmtDateISO(date);
  const dayIdx  = date.getDay();
  const todayISO = fmtDateISO(new Date());
  const isToday = dateISO === todayISO;
  const avail   = (cal.settings.availability && cal.settings.availability[String(dayIdx)]) || [];
  const hours   = Array.from({ length: HOURS_END - HOURS_START + 1 }, (_, i) => i + HOURS_START);

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
          {(cal.bookings || []).filter((b) => b.date === dateISO).length} bookings
          {' · '}
          {(cal.blocks || []).filter((b) => b.date === dateISO).length} blocks
        </div>
      </div>

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
            const startMin = HOURS_START * 60 + Math.floor(y / (ROW_H / 2)) * 30;
            onPickBlock(dateISO, startMin, startMin + 60);
          }}
        >
          {hours.map((_, i) => (
            <div key={i} style={{ height: ROW_H, borderTop: i ? '1px solid var(--border)' : 'none', pointerEvents: 'none' }}/>
          ))}
          {/* availability bands */}
          {avail.map((w, wi) => {
            const top = ((w.start - HOURS_START * 60) / 60) * ROW_H;
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
          {/* blocks */}
          {(cal.blocks || []).filter((b) => b.date === dateISO).map((b) => {
            const top = ((b.startMin - HOURS_START * 60) / 60) * ROW_H;
            const h   = ((b.endMin - b.startMin) / 60) * ROW_H;
            return (
              <div key={b.id} onClick={(e) => { e.stopPropagation(); onOpenEvent({ kind: 'block', ...b }); }}
                style={{
                  position: 'absolute', top, height: h, left: 8, right: 8,
                  background: 'repeating-linear-gradient(-45deg, var(--surface-2) 0 6px, var(--border-strong) 6px 12px)',
                  border: '1px solid var(--border-strong)', borderRadius: 8,
                  padding: '8px 12px', fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer', overflow: 'hidden',
                }}>
                <div style={{ fontWeight: 600 }}>{b.label || 'Blocked'}</div>
                <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>
                  {minToHM(b.startMin)} – {minToHM(b.endMin)}
                </div>
              </div>
            );
          })}
          {/* bookings */}
          {(cal.bookings || []).filter((b) => b.date === dateISO).map((b) => {
            const top = ((b.startMin - HOURS_START * 60) / 60) * ROW_H;
            const h   = ((b.endMin - b.startMin) / 60) * ROW_H;
            const svc = cal.services.find((s) => s.id === b.serviceId);
            return (
              <div key={b.id} onClick={(e) => { e.stopPropagation(); onOpenEvent({ kind: 'booking', ...b }); }}
                style={{
                  position: 'absolute', top, height: h, left: 8, right: 8,
                  background: 'var(--accent)', color: 'var(--accent-ink)',
                  border: '1px solid var(--accent)', borderRadius: 8,
                  padding: '8px 12px', fontSize: 12, cursor: 'pointer', overflow: 'hidden',
                }}>
                <div style={{ fontWeight: 600 }}>{b.clientName || 'Client'}</div>
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                  {svc?.name || 'Session'} · {minToHM(b.startMin)} – {minToHM(b.endMin)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
