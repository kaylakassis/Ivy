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
//   • Outline rows reorder by dragging the grip (pointer events, so mouse,
//     touch and pen all work; see usePointerReorder.js), by the up/down
//     buttons (44px tap targets on phones, so no drag is needed), or with
//     Alt+Up / Alt+Down on a focused grip. Each row's "..." menu moves or
//     copies the section to another page.
import React, { useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { SECTION_LIST, SECTION_TYPES, SECTION_CATEGORIES } from './sections.js';
import { usePointerReorder, gripKeyDown } from './usePointerReorder.js';
import { dropGapToIndex } from './pageTransforms.js';
import { ActionMenu } from './EditorOverlays.jsx';

export default function SectionLibrary({
  site, sections, selectedId, onSelect, onAdd, onMove, onMoveTo, onPagePicker, onDropOnPage, mobile = false,
}) {
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

  // Outline drag-reorder. `drag.gap` is the insertion gap (0..n).
  const outlineRef = useRef(null);
  const { drag, start: startDrag } = usePointerReorder({
    getScroller: () => outlineRef.current,
    getItems: () => Array.from(outlineRef.current?.querySelectorAll('[data-outline-id]') || [])
      .map((el, index) => ({ el, index })),
    onDrop: (id, gap) => {
      const idx = dropGapToIndex(gap, list.findIndex((s) => s.id === id));
      if (idx != null && onMoveTo) onMoveTo(id, idx);
    },
    onDropOnPage,
  });
  const dragId = drag?.id || null;
  const dropIndex = drag && dropGapToIndex(drag.gap, list.findIndex((s) => s.id === dragId)) != null ? drag.gap : null;

  const tap = mobile ? 44 : 28; // tap target for row buttons

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
        // Shares the column with the page outline below (the editor now
        // fits the screen), so neither gets squeezed to a sliver.
        flex: '1 1 0', minHeight: 132,
        alignContent: 'start',
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
          {mobile ? 'Use the arrows or drag the handle to reorder.' : 'Drag the handle to reorder, or use the arrows.'}
        </div>
      </div>

      {/* Outline - takes whatever vertical space is left after the
          catalog. flex: 1 means it grows to fill but can also shrink
          if needed; minHeight: 0 prevents children from forcing the
          parent to overflow. */}
      <div className="scroll"
        ref={outlineRef}
        style={{
          padding: '4px 10px 14px',
          flex: '1 1 0',
          minHeight: 150,
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
          // The drop line is drawn over the gap (absolutely positioned), so
          // showing it never shifts the rows the pointer is measured against.
          const showDropAbove = dropIndex === i && dragId && dragId !== sec.id;
          const showDropBelow = dragId && dropIndex === list.length && i === list.length - 1;
          const label = cfg?.label || sec.type;
          const rowBtn = {
            width: tap, height: tap, padding: 0, flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          };
          return (
            <React.Fragment key={sec.id}>
              <div
                data-outline-id={sec.id}
                onClick={() => onSelect(sec.id)}
                style={{
                  position: 'relative',
                  display: 'flex', alignItems: 'center', gap: mobile ? 2 : 4,
                  minHeight: mobile ? 52 : 38,
                  padding: mobile ? '4px 4px 4px 0' : '3px 4px 3px 0', borderRadius: 8, cursor: 'pointer',
                  background: active ? 'var(--accent-soft)' : 'transparent',
                  border: `1px solid ${active ? 'var(--accent-tint)' : 'transparent'}`,
                  opacity: sec.visible ? (isDragging ? 0.4 : 1) : 0.5,
                }}
              >
                {showDropAbove && <DropGap/>}
                {showDropBelow && <DropGap below/>}
                <button
                  type="button"
                  data-outline-grip={sec.id}
                  onPointerDown={(e) => startDrag(e, sec.id)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => gripKeyDown(e, onMove, sec.id)}
                  className="btn btn-ghost"
                  title="Drag to reorder (or Alt+Up / Alt+Down)"
                  aria-label={`Reorder ${label}. Drag, or press Alt plus Up or Down arrow.`}
                  style={{ ...rowBtn, width: mobile ? 36 : 24, cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none', color: 'var(--muted)' }}
                >
                  <Icons.Drag size={14} />
                </button>
                <Icon size={15} stroke={active ? 'var(--accent)' : 'var(--muted)'} sw={1.6} />
                <div style={{ flex: 1, minWidth: 0, paddingLeft: 4 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 500, color: active ? 'var(--accent)' : 'var(--fg)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {label}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onMove(sec.id, 'up'); }}
                  disabled={i === 0}
                  className="btn btn-ghost"
                  style={{ ...rowBtn, opacity: i === 0 ? 0.25 : 0.7 }}
                  title="Move up"
                  aria-label={`Move ${label} up`}
                >
                  <Icons.ArrowUp size={mobile ? 16 : 12} />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onMove(sec.id, 'down'); }}
                  disabled={i === list.length - 1}
                  className="btn btn-ghost"
                  style={{ ...rowBtn, opacity: i === list.length - 1 ? 0.25 : 0.7 }}
                  title="Move down"
                  aria-label={`Move ${label} down`}
                >
                  <Icons.ArrowDown size={mobile ? 16 : 12} />
                </button>
                {onPagePicker && (
                  <ActionMenu label={`More actions for ${label}`} buttonClassName="btn btn-ghost"
                    buttonStyle={{ ...rowBtn, opacity: 0.8 }}
                    items={[
                      { label: 'Move up', icon: 'ArrowUp', disabled: i === 0, onClick: () => onMove(sec.id, 'up') },
                      { label: 'Move down', icon: 'ArrowDown', disabled: i === list.length - 1, onClick: () => onMove(sec.id, 'down') },
                      { label: 'Move to page…', icon: 'MoveTo', onClick: () => onPagePicker(sec.id, 'move') },
                      { label: 'Copy to page…', icon: 'Copy', onClick: () => onPagePicker(sec.id, 'copy') },
                    ]}>
                    <Icons.More size={mobile ? 18 : 14}/>
                  </ActionMenu>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </aside>
  );
}

function DropGap({ below }) {
  return (
    <div aria-hidden="true" style={{
      position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2,
      background: 'var(--accent)', pointerEvents: 'none', zIndex: 2,
      ...(below ? { bottom: -4 } : { top: -4 }),
    }}/>
  );
}
