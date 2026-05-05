// Shared right-side drawer used by the calendar views.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';

export default function Drawer({ title, subtitle, onClose, children, width = 460 }) {
  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 95,
      }}/>
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        // Cap width to viewport on phones so the drawer never extends
        // past the screen edge. On desktop (>460px wide) it stays
        // exactly `width` pixels; on phones it goes full-width.
        width: `min(100vw, ${width}px)`,
        maxWidth: '100vw',
        background: 'var(--surface)', borderLeft: '1px solid var(--border)',
        zIndex: 100, display: 'flex', flexDirection: 'column',
        boxShadow: '-20px 0 40px -12px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          padding: '18px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 500, letterSpacing: '-0.015em' }}>
              {title}
            </div>
            {subtitle && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>
        <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {children}
        </div>
      </div>
    </>
  );
}

export function TimeInput({ minutes, onChange }) {
  const val = `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`;
  const handle = (e) => {
    const [h, m] = e.target.value.split(':').map(Number);
    onChange(h * 60 + (m || 0));
  };
  return (
    <input type="time" value={val} onChange={handle} style={{
      padding: '6px 10px', borderRadius: 8, background: 'var(--surface-2)',
      border: '1px solid var(--border)', color: 'var(--fg)', fontSize: 13, outline: 'none',
    }}/>
  );
}

export const inputSty = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};
