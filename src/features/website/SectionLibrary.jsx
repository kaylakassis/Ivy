// Left panel: catalog of addable sections + ordered list of sections in the site.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';
import { SECTION_LIST, SECTION_TYPES } from './sections.js';

export default function SectionLibrary({ site, selectedId, onSelect, onAdd, onMove }) {
  return (
    <aside style={{
      width: 260, minWidth: 260,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      height: '100%',
    }}>
      {/* Page outline */}
      <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
        <div className="metric-label">Page outline</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          Click to edit. Drag handles reorder.
        </div>
      </div>

      <div className="scroll" style={{ padding: '10px 10px 14px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {site.sections.length === 0 && (
          <div style={{
            margin: 8, padding: 16, borderRadius: 10,
            background: 'var(--surface-2)', border: '1px dashed var(--border)',
            fontSize: 12, color: 'var(--muted)', textAlign: 'center',
          }}>
            No sections yet. Add one below.
          </div>
        )}
        {site.sections.map((sec, i) => {
          const cfg = SECTION_TYPES[sec.type];
          const Icon = Icons[cfg?.icon] || Icons.FileIcon;
          const active = sec.id === selectedId;
          return (
            <div
              key={sec.id}
              onClick={() => onSelect(sec.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                background: active ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${active ? 'var(--accent-tint)' : 'transparent'}`,
                opacity: sec.visible ? 1 : 0.5,
              }}
            >
              <Icon size={15} stroke={active ? 'var(--accent)' : 'var(--muted)'} sw={1.6} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: active ? 'var(--accent)' : 'var(--fg)' }}>
                  {cfg?.label || sec.type}
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onMove(sec.id, 'up'); }}
                disabled={i === 0}
                className="btn btn-ghost"
                style={{ padding: 3, opacity: i === 0 ? 0.25 : 0.6 }}
                title="Move up"
              >
                <Icons.ArrowUp size={12} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onMove(sec.id, 'down'); }}
                disabled={i === site.sections.length - 1}
                className="btn btn-ghost"
                style={{ padding: 3, opacity: i === site.sections.length - 1 ? 0.25 : 0.6 }}
                title="Move down"
              >
                <Icons.ArrowDown size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Section library */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px 4px' }}>
        <div className="metric-label">Add section</div>
      </div>
      <div className="scroll" style={{ padding: '6px 10px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, overflowY: 'auto', maxHeight: 280 }}>
        {SECTION_LIST.map((s) => {
          const Icon = Icons[s.icon] || Icons.FileIcon;
          return (
            <button
              key={s.type}
              onClick={() => onAdd(s.type)}
              title={s.desc}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                padding: '10px 6px',
                borderRadius: 8,
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                transition: 'border-color .12s, transform .05s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border)'}
            >
              <Icon size={16} stroke="var(--fg-2)" sw={1.6} />
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg)' }}>{s.label}</div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
