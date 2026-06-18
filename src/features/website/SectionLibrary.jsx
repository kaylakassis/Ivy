// Left panel: ordered list of the current page's sections + a catalog
// of addable section types.
//
// Layout: "Add section" sits at the TOP (close to the eye-line, since
// it's the action most owners come here to do) and the page outline
// sits below it. Both panels are independently scrollable; the Add
// catalog is capped so a 20-type list doesn't push the outline out of
// view on short viewports.
//
// Interactions:
//   • Catalog has a search filter + category pills (`All`, `Header`,
//     `Social proof`, etc.) so 20+ types stay scannable.
//   • Outline supports HTML5 drag-and-drop in addition to the arrow
//     buttons. Drag a row to reorder; arrow buttons still work for
//     keyboard / non-pointer users.
import React, { useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { SECTION_LIST, SECTION_TYPES, SECTION_CATEGORIES } from './sections.js';

export default function SectionLibrary({ site, sections, selectedId, onSelect, onAdd, onMove, onMoveTo, mobile = false }) {
  // Editor passes the current page's sections in; fall back to legacy
  // site.sections for callers that haven't migrated.
  const list = Array.isArray(sections) ? sections : (site?.sections || []);

  // Catalog filters. Search trumps category - typing narrows the
  // visible tile set regardless of which category pill is active.
  const [q, setQ]             = useState('');
  const [category, setCategory] = useState('all');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return SECTION_LIST.filter((s) => {
      if (category !== 'all' && (s.category || 'content') !== category) return false;
      if (!needle) return true;
      return (
        s.label.toLowerCase().includes(needle) ||
        (s.desc || '').toLowerCase().includes(needle) ||
        s.type.toLowerCase().includes(needle)
      );
    });
  }, [q, category]);

  // Drag state for outline reorder. `dragId` is the section being
  // dragged; `dropIndex` is the gap-marker position we'll drop it at.
  const [dragId, setDragId]       = useState(null);
  const [dropIndex, setDropIndex] = useState(null);

  const handleDragStart = (e, id) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch (_) { /* noop */ }
  };
  const handleDragOver = (e, idx) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropIndex !== idx) setDropIndex(idx);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    if (dragId && dropIndex != null && onMoveTo) {
      // Adjust target index when the dragged item is earlier in the list:
      // splicing it out first shifts everything after down by one.
      const srcIdx = list.findIndex((s) => s.id === dragId);
      const adj = srcIdx >= 0 && srcIdx < dropIndex ? dropIndex - 1 : dropIndex;
      onMoveTo(dragId, adj);
    }
    setDragId(null);
    setDropIndex(null);
  };
  const handleDragEnd = () => {
    setDragId(null);
    setDropIndex(null);
  };

  return (
    <aside style={{
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

      {/* Search + category pills */}
      <div style={{ padding: '6px 10px 4px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search sections…"
          style={{
            padding: '7px 10px', fontSize: 12,
            border: '1px solid var(--border)',
            background: 'var(--surface-2)',
            color: 'var(--fg)', borderRadius: 8, outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[['all', 'All'], ...Object.entries(SECTION_CATEGORIES).map(([id, c]) => [id, c.label])].map(([id, label]) => (
            <button key={id} type="button"
              onClick={() => setCategory(id)}
              style={{
                padding: '3px 8px', fontSize: 10.5, fontWeight: 600,
                borderRadius: 99,
                border: '1px solid var(--border)',
                background: category === id ? 'var(--accent)' : 'var(--surface-2)',
                color: category === id ? 'var(--accent-ink)' : 'var(--fg-2)',
                cursor: 'pointer',
              }}>{label}</button>
          ))}
        </div>
      </div>

      {/* Section catalog - 2-column grid, scrollable when the list of
          types is long. Now 20+ section types, so we let it grow but
          cap it so the page outline below stays visible. */}
      <div className="scroll" style={{
        padding: '6px 10px 12px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
        overflowY: 'auto',
        flex: '0 0 auto',
        maxHeight: 320,
      }}>
        {filtered.length === 0 && (
          <div style={{
            gridColumn: '1 / -1',
            padding: 12, fontSize: 11.5, color: 'var(--muted)',
            textAlign: 'center', lineHeight: 1.5,
          }}>
            No section types match.
          </div>
        )}
        {filtered.map((s) => {
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
          Drag to reorder, or use the arrows.
        </div>
      </div>

      {/* Outline - takes whatever vertical space is left after the
          catalog. flex: 1 means it grows to fill but can also shrink
          if needed; minHeight: 0 prevents children from forcing the
          parent to overflow. */}
      <div className="scroll"
        onDragOver={(e) => {
          if (dragId) {
            e.preventDefault();
            if (dropIndex == null) setDropIndex(list.length);
          }
        }}
        onDrop={handleDrop}
        style={{
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
          const isDragging = dragId === sec.id;
          const showDropAbove = dropIndex === i && dragId && dragId !== sec.id;
          return (
            <React.Fragment key={sec.id}>
              {showDropAbove && <DropGap/>}
              <div
                draggable
                onDragStart={(e) => handleDragStart(e, sec.id)}
                onDragOver={(e) => handleDragOver(e, i)}
                onDragEnd={handleDragEnd}
                onClick={() => onSelect(sec.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 8, cursor: 'grab',
                  background: active ? 'var(--accent-soft)' : 'transparent',
                  border: `1px solid ${active ? 'var(--accent-tint)' : 'transparent'}`,
                  opacity: sec.visible ? (isDragging ? 0.4 : 1) : 0.5,
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
            </React.Fragment>
          );
        })}
        {dragId && dropIndex === list.length && <DropGap/>}
      </div>
    </aside>
  );
}

function DropGap() {
  return (
    <div style={{
      height: 4, borderRadius: 2,
      background: 'var(--accent)',
      margin: '2px 0',
    }}/>
  );
}
