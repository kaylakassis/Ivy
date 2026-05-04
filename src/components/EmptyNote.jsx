import React from 'react';
import { Icons } from './Icons.jsx';

export default function EmptyNote({ icon = 'Check', title, hint, action }) {
  const I = Icons[icon] || Icons.Check;
  return (
    <div style={{
      padding: '24px 12px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)', marginBottom: 4,
      }}><I size={18} /></div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 260, lineHeight: 1.45 }}>{hint}</div>
      )}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}
