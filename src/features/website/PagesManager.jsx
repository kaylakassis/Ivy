// Pages sheet: put the site's pages in order (drag the handle with a mouse
// or finger, or use the arrows), rename them, show or hide them in the
// menu, and delete them. The order here is the order of the site menu.
// Dragging uses the same pointer-event hook as sections, so it works the
// same on desktop, iPhone and iPad.
import React, { useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { usePointerReorder, gripKeyDown } from './usePointerReorder.js';

export default function PagesManager({ pages, currentPageId, onSelect, onMove, onMoveTo, onRename, onRemove, onClose, mobile }) {
  const listRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const { drag, start } = usePointerReorder({
    getScroller: () => listRef.current,
    getItems: () => Array.from(listRef.current?.querySelectorAll('[data-page-row]') || [])
      .map((el) => ({ el, index: Number(el.getAttribute('data-index')) })),
    onDrop: (id, gap) => {
      const from = pages.findIndex((p) => p.id === id);
      if (from < 0) return;
      // gap is the insertion point in the full list; removing the page
      // first shifts later gaps down by one.
      const to = gap > from ? gap - 1 : gap;
      if (to !== from) onMoveTo(id, to);
    },
  });

  const commitRename = (p) => {
    const title = draft.trim();
    if (title && title !== p.title) onRename(p.id, { title });
    setEditingId(null);
  };
  const tap = mobile ? 44 : 34;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: mobile ? 'flex-end' : 'center', justifyContent: 'center',
      padding: mobile ? 0 : 24,
    }}>
      <div role="dialog" aria-label="Pages" onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxWidth: 520, maxHeight: mobile ? '85vh' : '80vh',
        background: 'var(--surface)', border: '1px solid var(--border-strong)',
        borderRadius: mobile ? '16px 16px 0 0' : 12, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        paddingBottom: mobile ? 'env(safe-area-inset-bottom)' : 0,
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Pages</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Drag or use the arrows to change the order. Your site menu follows this order.</div>
          </div>
          <div style={{ flex: 1 }}/>
          <button type="button" onClick={onClose} className="btn btn-primary" style={{ minHeight: tap }}>Done</button>
        </div>
        <div ref={listRef} style={{ overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {pages.map((p, i) => {
            const isHome = p.slug === '';
            const dragging = drag?.id === p.id;
            const gapBefore = drag && drag.gap === i && drag.id !== p.id;
            const gapAfter = drag && i === pages.length - 1 && drag.gap === pages.length && drag.id !== p.id;
            const extras = (
              <>
                <IconBtn label={`Rename ${p.title}`} text={mobile ? 'Rename' : null} onClick={() => { setEditingId(p.id); setDraft(p.title); }} size={tap}><Icons.Edit size={13}/></IconBtn>
                {!isHome && (
                  <IconBtn label={p.inNav === false ? `Show ${p.title} in the menu` : `Hide ${p.title} from the menu`}
                    text={mobile ? (p.inNav === false ? 'Show in menu' : 'Hide from menu') : null}
                    onClick={() => onRename(p.id, { inNav: p.inNav === false })} size={tap}>
                    {p.inNav === false ? <Icons.EyeOff size={14}/> : <Icons.Eye size={14}/>}
                  </IconBtn>
                )}
                {!isHome && (
                  <IconBtn label={`Delete ${p.title}`} text={mobile ? 'Delete' : null} danger size={tap}
                    onClick={() => { if (window.confirm(`Delete page "${p.title}"? The sections on it will be removed.`)) onRemove(p.id); }}>
                    <Icons.Trash size={13}/>
                  </IconBtn>
                )}
              </>
            );
            return (
              <div key={p.id} data-page-row data-index={i}>
                {gapBefore && <DropLine/>}
                <div style={{
                  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '6px 8px',
                  border: '1px solid ' + (p.id === currentPageId ? 'var(--accent)' : 'var(--border)'),
                  borderRadius: 10, background: dragging ? 'var(--accent-soft)' : 'var(--surface-2)',
                  opacity: dragging ? 0.75 : 1,
                }}>
                  <button type="button"
                    onPointerDown={(e) => start(e, p.id)}
                    onKeyDown={(e) => gripKeyDown(e, onMove, p.id)}
                    aria-label={`Reorder ${p.title}. Drag, or press Alt plus Up or Down arrow.`}
                    title="Drag to reorder"
                    style={{
                      width: tap, height: tap, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: 0, background: 'transparent', color: 'var(--muted)', cursor: 'grab', touchAction: 'none',
                    }}>
                    <Grip/>
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingId === p.id ? (
                      <input value={draft} autoFocus aria-label="Page name"
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitRename(p)}
                        onKeyDown={(e) => { if (e.key === 'Enter') commitRename(p); if (e.key === 'Escape') setEditingId(null); }}
                        className="input" style={{ width: '100%', fontSize: 14 }}/>
                    ) : (
                      <button type="button" onClick={() => { onSelect(p.id); }}
                        style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, color: 'var(--fg)', maxWidth: '100%' }}>
                        {isHome && <Icons.Home size={12} sw={1.7}/>}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
                      </button>
                    )}
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                      {isHome ? 'Home page' : (p.inNav === false ? 'Hidden from the menu' : 'In the menu')}
                    </div>
                  </div>
                  <IconBtn label={`Move ${p.title} up`} disabled={i === 0} onClick={() => onMove(p.id, 'up')} size={tap}><Icons.ArrowUp size={14}/></IconBtn>
                  <IconBtn label={`Move ${p.title} down`} disabled={i === pages.length - 1} onClick={() => onMove(p.id, 'down')} size={tap}><Icons.ArrowDown size={14}/></IconBtn>
                  {mobile
                    ? <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: 2, paddingLeft: 4, marginTop: -4 }}>{extras}</div>
                    : extras}
                </div>
                {gapAfter && <DropLine/>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function IconBtn({ label, text, onClick, disabled, danger, size, children }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      style={{
        width: text ? 'auto' : size, height: text ? 36 : size, padding: text ? '0 7px' : 0, gap: 5, fontSize: 12.5, fontWeight: 600,
        flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 0, borderRadius: 8, background: 'transparent',
        color: danger ? 'var(--danger)' : 'var(--fg-2)', opacity: disabled ? 0.3 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}>{children}{text}</button>
  );
}

function DropLine() {
  return <div aria-hidden="true" style={{ height: 3, borderRadius: 2, background: 'var(--accent)', margin: '2px 4px 4px' }}/>;
}

function Grip() {
  return (
    <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" fill="currentColor">
      {[3, 8, 13].flatMap((y) => [<circle key={`a${y}`} cx="3.5" cy={y} r="1.4"/>, <circle key={`b${y}`} cx="8.5" cy={y} r="1.4"/>])}
    </svg>
  );
}
