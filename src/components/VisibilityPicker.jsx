// Shared 3-state visibility selector — used by Services, Packages,
// and Website. Three radio cards, current state highlighted.
//
//   public   — listed on Discover + the public booking page
//   private  — bookable by direct link only; not listed
//   only_me  — fully hidden from clients (effectively a draft)
//
// The hint copy stays at the call site so each surface can phrase
// the consequences in its own words ("hidden from your booking page",
// "hidden from your client portal", etc.).
import React from 'react';
import { Icons } from './Icons.jsx';

const OPTIONS = [
  { id: 'public',  label: 'Public',     icon: 'Globe', sub: 'Listed everywhere' },
  { id: 'private', label: 'Link only',  icon: 'Lock',  sub: 'Hidden from lists' },
  { id: 'only_me', label: 'Only me',    icon: 'EyeOff', sub: 'Fully hidden' },
];

export default function VisibilityPicker({ value, onChange }) {
  const current = value || 'public';
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      gap: 8,
    }}>
      {OPTIONS.map((opt) => {
        const Icon = Icons[opt.icon] || Icons.Globe;
        const active = current === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            style={{
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border-strong)'),
              background: active ? 'var(--accent-soft)' : 'var(--surface)',
              color: active ? 'var(--accent)' : 'var(--fg)',
              cursor: 'pointer',
              transition: 'border-color .12s ease, background .12s ease',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon size={14} sw={1.7}/>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{opt.label}</span>
            </div>
            <span style={{
              fontSize: 11,
              color: active ? 'var(--accent)' : 'var(--muted)',
              opacity: active ? 0.85 : 1,
            }}>
              {opt.sub}
            </span>
          </button>
        );
      })}
    </div>
  );
}
