import React from 'react';
import { Icons } from '../Icons.jsx';

export default function Topbar({ title, subtitle, children }) {
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '22px 32px 18px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--page)',
      position: 'sticky', top: 0, zIndex: 40,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>
          <span>Workspace</span>
          <span>·</span>
          <span style={{ color: 'var(--fg-2)' }}>{title}</span>
        </div>
        <h1 className="page-title" style={{ margin: 0, fontSize: 28 }}>{subtitle || title}</h1>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 11px', borderRadius: 10,
        background: 'var(--surface)', border: '1px solid var(--border)',
        minWidth: 280,
      }}>
        <Icons.Search size={15} stroke="var(--muted)" sw={1.6} />
        <input
          type="text" placeholder="Search clients, invoices, notes…"
          style={{
            background: 'none', border: 0, outline: 'none',
            fontSize: 13, color: 'var(--fg)',
            flex: 1,
          }}
        />
        <kbd style={{
          fontSize: 10, fontFamily: 'var(--font-sans)', fontWeight: 500,
          padding: '2px 5px', borderRadius: 4,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          color: 'var(--muted)',
        }}>⌘K</kbd>
      </div>

      <button className="btn btn-outline" style={{ position: 'relative' }}>
        <Icons.Bell size={15} />
        <span style={{
          position: 'absolute', top: 5, right: 5,
          width: 7, height: 7, borderRadius: 99,
          background: 'var(--accent)',
          border: '2px solid var(--surface)',
        }} />
      </button>

      {children}
    </header>
  );
}
