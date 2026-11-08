// The plain message a screen shows when there is no signal and nothing
// saved on this phone for it. Never a spinner.
import React from 'react';
import { Icons } from '../Icons.jsx';
import { OFFLINE_MESSAGE } from '../../lib/offline.js';

export default function OfflineNotice({ hint = 'Ivy has nothing saved on this phone for this screen yet. It will load as soon as you have signal.', style }) {
  return (
    <div className="card" role="status" style={{ padding: 28, textAlign: 'center', ...style }}>
      <div style={{
        width: 40, height: 40, borderRadius: 12, margin: '0 auto 10px',
        background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)',
      }}><Icons.Clock size={18}/></div>
      <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 6 }}>{OFFLINE_MESSAGE}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, maxWidth: 320, margin: '0 auto' }}>{hint}</div>
    </div>
  );
}
