// Left panel: ordered list of the current page's sections + a catalog
// of addable section types.
//
// Layout: "Add section" sits at the TOP (close to the eye-line, since
// it's the action most owners come here to do) and the page outline
// sits below it. Both panels are independently scrollable; the Add
// catalog is capped so a 20-type list doesn't push the outline out of
// view on short viewports.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';
import { SECTION_LIST, SECTION_TYPES } from './sections.js';

export default function SectionLibrary({ site, sections, selectedId, onSelect, onAdd, onMove, mobile = false }) {
  // Editor passes the current page's sections in; fall back to legacy
  // site.sections for callers that haven't migrated.
  const list = Array.isArray(sections) ? sections : (site?.sections || []);
  return (
    <aside style={{
      // On mobile the library takes the full width since it's the only
      // pane visible (we tab between Sections / Canvas / Edit). On
      // desktop/tablet it stays as a fixed left rail.
      width: mobile ? '100%' : 260,
      minWidth: mobile ? 0 : 260,
      flex: mobile ? 1 : '0 0 auto',
      background: 'var(--surface)',
      borderRight: mobile ? 'none' : '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      height: '100%',
      minHeight: 0,
    }}>
      {/* Section catalog header */}
      <div style={{ padding: '16px 18px 6px' }}>
        <div className="metric-label">Add section</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          Click any tile to drop it on the page.
        </div>
      </div>

      {/* Section catalog — 2-column grid, scrollable when the list of
          types is long. Now 20+ section types, so we let it grow but
          cap it so the page outline below stays visible. */}
      <div className="scroll" style={{
        padding: '6px 10px 12px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
        overflowY: 'auto',
        // Cap so the outline below always has room to render.
        // The flex sibling below will fill whatever's left.
        flex: '0 0 auto',
        maxHeight: 360,
      }}>
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
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg)', textAlign: 'center' }}>{s.label}</div>
            </button>
          );
        })}
      </div>

      {/* Divider between catalog and outline */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 18px 6px' }}>
        <div className="metric-label">Page outline</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          Click to edit. Arrows reorder.
        </div>
      </div>

      {/* Outline — takes whatever vertical space is left after the
          catalog. flex: 1 means it grows to fill but can also shrink
          if needed; minHeight: 0 prevents children from forcing the
          parent to overflow. */}
      <div className="scroll" style={{
        padding: '4px 10px 14px',
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {list.length === 0 && (
          <div style={{
            margin: 8, padding: 16, borderRadius: 10,
            background: 'var(--surface-2)', border: '1px dashed var(--border)',
            fontSize: 12, color: 'var(--muted)', textAlign: 'center',
          }}>
            No sections yet. Tap one above to add it.
          </div>
        )}
        {list.map((sec, i) => {
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
                disabled={i === list.length - 1}
                className="btn btn-ghost"
                style={{ padding: 3, opacity: i === list.length - 1 ? 0.25 : 0.6 }}
                title="Move down"
              >
                <Icons.ArrowDown size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
