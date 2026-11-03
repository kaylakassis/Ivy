// Small shared pieces for the import hub, the review lists and the
// "Let your clients know" sheet. Everything from a file is rendered as React
// text, never as HTML.
import React, { useMemo, useState } from 'react';
import { Icons } from '../../../components/Icons.jsx';
import { useViewport } from '../../../lib/viewport.js';

// Centered card on desktop, bottom sheet on a phone.
export function Sheet({ title, icon = 'Users', onClose, onBack, children, maxWidth = 640, z = 130 }) {
  const { isMobile } = useViewport();
  const I = Icons[icon] || Icons.Users;
  return (
    <div onClick={onClose} role="dialog" aria-label={title} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: z,
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center',
      padding: isMobile ? 0 : 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{
        width: '100%', maxWidth: isMobile ? '100%' : maxWidth,
        padding: isMobile ? '16px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)' : 24,
        maxHeight: isMobile ? '94vh' : '90vh', overflow: 'auto',
        borderRadius: isMobile ? '18px 18px 0 0' : undefined,
        overscrollBehavior: 'contain',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          {onBack ? (
            <button type="button" onClick={onBack} className="btn btn-ghost" aria-label="Back" style={{ padding: 6 }}>
              <Icons.ArrowLeft size={15}/>
            </button>
          ) : (
            <div style={{
              width: 34, height: 34, borderRadius: 10, flexShrink: 0,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><I size={16} sw={1.8}/></div>
          )}
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1, minWidth: 0 }}>{title}</h3>
          <button type="button" onClick={onClose} className="btn btn-ghost" aria-label="Close" style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Note({ tone = 'muted', children, style }) {
  const tones = {
    muted: { background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--fg-2)' },
    ok:    { background: 'color-mix(in srgb, var(--ok) 8%, var(--surface))', border: '1px solid color-mix(in srgb, var(--ok) 30%, var(--border))', color: 'var(--fg-2)' },
    warn:  { background: 'color-mix(in srgb, var(--warn) 8%, var(--surface))', border: '1px solid color-mix(in srgb, var(--warn) 35%, var(--border))', color: 'var(--fg-2)' },
    err:   { background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)', color: 'var(--danger)' },
  };
  return (
    <div style={{ padding: '9px 12px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5, ...tones[tone], ...style }}>
      {children}
    </div>
  );
}

export function QuietNote({ style }) {
  return (
    <Note style={style}>
      <strong>Nobody gets an email or text from this.</strong> Your clients will not notice
      anything until you choose to tell them you moved.
    </Note>
  );
}

// Searchable checklist with select all / none. items: [{ id, primary,
// secondary, disabled, tag }]. Renders at most RENDER_CAP rows at a time
// (search narrows the rest) so a 5,000 contact file stays responsive.
const RENDER_CAP = 300;
export function PeopleChecklist({ items, selected, onChange, placeholder = 'Search people', maxHeight = 340 }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((it) => `${it.primary || ''} ${it.secondary || ''}`.toLowerCase().includes(s));
  }, [items, q]);
  const selectable = filtered.filter((it) => !it.disabled);
  const shown = filtered.slice(0, RENDER_CAP);
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };
  const all = () => { const next = new Set(selected); selectable.forEach((it) => next.add(it.id)); onChange(next); };
  const none = () => { const next = new Set(selected); filtered.forEach((it) => next.delete(it.id)); onChange(next); };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 0 }}>
          <Icons.Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }}/>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder}
            aria-label="Search" style={{ width: '100%', paddingLeft: 32, fontSize: 14 }}/>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="btn btn-ghost" onClick={all} style={{ padding: '6px 10px', fontSize: 12.5 }}>Select all</button>
          <button type="button" className="btn btn-ghost" onClick={none} style={{ padding: '6px 10px', fontSize: 12.5 }}>None</button>
        </div>
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, maxHeight, overflow: 'auto' }}>
        {shown.map((it, i) => {
          const on = selected.has(it.id);
          return (
            <label key={it.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
              borderTop: i ? '1px solid var(--border)' : 'none',
              cursor: it.disabled ? 'default' : 'pointer', opacity: it.disabled ? 0.5 : 1,
              background: on ? 'color-mix(in srgb, var(--accent-soft) 45%, transparent)' : 'transparent',
            }}>
              <input type="checkbox" checked={on} disabled={it.disabled} onChange={() => toggle(it.id)}
                style={{ width: 18, height: 18, flexShrink: 0, accentColor: 'var(--accent)' }}/>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.primary || 'No name'}
                </span>
                {it.secondary && (
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.secondary}
                  </span>
                )}
              </span>
              {it.tag && <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{it.tag}</span>}
            </label>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: 14, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>Nobody matches that search.</div>
        )}
        {filtered.length > shown.length && (
          <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)', textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            Showing {shown.length} of {filtered.length}. Search to find the rest; Select all includes everyone listed.
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{selected.size} selected</div>
    </div>
  );
}

// Plain checkbox row used for the automations opt-in.
export function CheckRow({ checked, onChange, title, children }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 9,
      fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, cursor: 'pointer',
      padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)',
      border: '1px solid var(--border)',
    }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2, width: 16, height: 16, flexShrink: 0, accentColor: 'var(--accent)' }}/>
      <span><strong>{title}</strong>{children ? <> {children}</> : null}</span>
    </label>
  );
}

export function AutomationsOptIn({ checked, onChange }) {
  return (
    <CheckRow checked={checked} onChange={onChange} title="Run my new client automations for these people">
      {checked
        ? 'Any automation you set up for new clients will run for each person, and some may send them an email or text.'
        : 'Off: they are added quietly. No automations run and nobody is emailed.'}
    </CheckRow>
  );
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
