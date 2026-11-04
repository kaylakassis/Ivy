// Small overlays used by the website editor: a section action menu, the
// "Move / Copy to page" picker, a confirm dialog, and a toast with an
// action button. All render through a portal so they are never clipped or
// scaled by the canvas.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../components/Icons.jsx';

const portal = (node) => (typeof document === 'undefined' ? null : createPortal(node, document.body));

// ── Action menu ("⋯" button + popover) ──────────────────────────────
// items: [{ label, icon, onClick, disabled, danger }]
export function ActionMenu({ items, label = 'More actions', buttonStyle, buttonClassName, children, title }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  // Pin the menu to its button: below it when there is room, else above.
  const place = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const h = menuRef.current ? menuRef.current.offsetHeight : items.length * 44 + 12;
    const w = menuRef.current ? menuRef.current.offsetWidth : 220;
    const below = r.bottom + 4 + h <= vh - 8;
    const left = Math.max(8, Math.min(vw - w - 8, r.right - w));
    setPos({ left, top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - h) });
  }, [items.length]);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return (
    <>
      <button ref={btnRef} type="button" aria-label={label} title={title || label} aria-haspopup="menu" aria-expanded={open}
        className={buttonClassName}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        style={buttonStyle}>
        {children || <Icons.More size={14}/>}
      </button>
      {open && portal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 290 }}/>
          <div ref={menuRef} role="menu" className="card" style={{
            position: 'fixed', zIndex: 291, minWidth: 200, padding: 6,
            left: pos?.left ?? -9999, top: pos?.top ?? -9999,
            boxShadow: 'var(--shadow)',
          }}>
            {items.map((it) => {
              const Icon = it.icon ? (Icons[it.icon] || Icons.More) : null;
              return (
                <button key={it.label} type="button" role="menuitem" disabled={it.disabled}
                  onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick?.(); }}
                  style={{
                    width: '100%', minHeight: 40, display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px', borderRadius: 8, textAlign: 'left',
                    background: 'transparent', border: 'none', fontSize: 13.5,
                    color: it.danger ? 'var(--danger)' : 'var(--fg)',
                    opacity: it.disabled ? 0.4 : 1,
                    cursor: it.disabled ? 'not-allowed' : 'pointer',
                  }}
                  onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--surface-2)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  {Icon && <Icon size={15} sw={1.7}/>}
                  {it.label}
                </button>
              );
            })}
          </div>
        </>,
      )}
    </>
  );
}

// ── Modal shell ─────────────────────────────────────────────────────
function Modal({ onClose, mobile, labelledBy, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return portal(
    <div onClick={onClose} className="motion-backdrop" style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: mobile ? 'flex-end' : 'center', justifyContent: 'center',
      padding: mobile ? 0 : 24,
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()} className="motion-modal"
        style={{
          width: '100%', maxWidth: mobile ? '100%' : 420, maxHeight: mobile ? '85vh' : '80vh',
          overflowY: 'auto',
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: mobile ? '16px 16px 0 0' : 14,
          padding: mobile ? '18px 16px calc(18px + env(safe-area-inset-bottom, 0px))' : 20,
          boxShadow: 'var(--shadow)',
        }}>
        {children}
      </div>
    </div>,
  );
}

function Segmented({ value, options, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} style={{
      display: 'flex', gap: 2, padding: 3, borderRadius: 10,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    }}>
      {options.map(([id, text]) => {
        const on = value === id;
        return (
          <button key={id} type="button" role="radio" aria-checked={on} onClick={() => onChange(id)}
            style={{
              flex: 1, minHeight: 36, padding: '6px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: on ? 'var(--surface)' : 'transparent',
              color: on ? 'var(--fg)' : 'var(--muted)',
              border: on ? '1px solid var(--border)' : '1px solid transparent',
              boxShadow: on ? 'var(--shadow-sm)' : 'none', cursor: 'pointer',
            }}>{text}</button>
        );
      })}
    </div>
  );
}

// ── Move / Copy to page picker ──────────────────────────────────────
// onSubmit({ mode, target, position }) where target is a page id or
// { title } for a new page.
export function PagePicker({ initialMode = 'move', sectionLabel, pages, fromPageId, onSubmit, onClose, mobile }) {
  const others = (pages || []).filter((p) => p.id !== fromPageId);
  const [mode, setMode] = useState(initialMode);
  const [position, setPosition] = useState('bottom');
  const [creating, setCreating] = useState(others.length === 0);
  const [title, setTitle] = useState('');
  const verb = mode === 'copy' ? 'Copy' : 'Move';

  const rowSt = {
    width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 12px', borderRadius: 10, textAlign: 'left',
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    color: 'var(--fg)', fontSize: 14, cursor: 'pointer',
  };

  return (
    <Modal onClose={onClose} mobile={mobile} labelledBy="page-picker-title">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id="page-picker-title" style={{ fontSize: 16, fontWeight: 600 }}>
            {verb} to another page
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            {mode === 'copy'
              ? `A copy of ${sectionLabel} goes on the page you pick. This one stays here.`
              : `${sectionLabel} leaves this page and goes on the page you pick.`}
          </div>
        </div>
        <button type="button" className="btn btn-ghost" aria-label="Close" onClick={onClose} style={{ padding: 8 }}>
          <Icons.X size={15}/>
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
        <Segmented label="Move or copy" value={mode} onChange={setMode}
          options={[['move', 'Move'], ['copy', 'Copy']]}/>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>Put it at the</span>
          <div style={{ flex: 1 }}>
            <Segmented label="Where on the page" value={position} onChange={setPosition}
              options={[['top', 'Top'], ['bottom', 'Bottom']]}/>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {others.map((p) => (
          <button key={p.id} type="button" style={rowSt}
            onClick={() => onSubmit({ mode, target: p.id, position })}>
            {p.slug === '' ? <Icons.Home size={15}/> : <Icons.FileIcon size={15}/>}
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
              {p.title || 'Untitled'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>/{p.slug}</span>
          </button>
        ))}
        {!creating ? (
          <button type="button" style={{ ...rowSt, background: 'transparent', borderStyle: 'dashed', color: 'var(--fg-2)' }}
            onClick={() => setCreating(true)}>
            <Icons.Plus size={15}/> New page…
          </button>
        ) : (
          <form onSubmit={(e) => {
            e.preventDefault();
            onSubmit({ mode, target: { title: title.trim() || 'New page' }, position });
          }} style={{
            display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10,
            border: '1px dashed var(--border-strong)',
          }}>
            <label htmlFor="new-page-title" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-2)' }}>
              New page name
            </label>
            <input id="new-page-title" className="input" autoFocus={!mobile} value={title} maxLength={120}
              placeholder="e.g. About" onChange={(e) => setTitle(e.target.value)}
              style={{ minHeight: 44 }}/>
            <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', minHeight: 44 }}>
              Create page and {verb.toLowerCase()}
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}

// ── Confirm dialog ──────────────────────────────────────────────────
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel = 'Cancel', danger, busy, error, onConfirm, onCancel, mobile }) {
  return (
    <Modal onClose={busy ? undefined : onCancel} mobile={mobile} labelledBy="confirm-title">
      <div id="confirm-title" style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>{title}</div>
      {body && <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginTop: 8, lineHeight: 1.5 }}>{body}</div>}
      {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 10 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}
          style={{ minHeight: 44, flex: mobile ? 1 : '0 0 auto', justifyContent: 'center' }}>{cancelLabel}</button>
        <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}
          style={{
            minHeight: 44, flex: mobile ? 1 : '0 0 auto', justifyContent: 'center',
            ...(danger ? { background: 'var(--danger)', color: '#fff' } : {}),
            opacity: busy ? 0.7 : 1,
          }}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </Modal>
  );
}

// ── Toast with an action ("Moved to About. View") ───────────────────
export function ActionToast({ toast, onClose, duration = 6000 }) {
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => onClose?.(), duration);
    return () => clearTimeout(t);
  }, [toast, duration, onClose]);
  if (!toast) return null;
  return portal(
    <div role="status" aria-live="polite" style={{
      position: 'fixed', left: '50%', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)',
      transform: 'translateX(-50%)', zIndex: 250, width: 'max-content', maxWidth: 'calc(100vw - 24px)',
      animation: 'toast-rise 0.24s cubic-bezier(0.2,0.8,0.3,1)',
    }}>
      <div className="card" style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 10px 10px 16px',
        boxShadow: 'var(--shadow)',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{toast.text}</div>
          {toast.sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{toast.sub}</div>}
        </div>
        {toast.actionLabel && (
          <button type="button" className="btn btn-outline"
            onClick={() => { toast.onAction?.(); onClose?.(); }}
            style={{ minHeight: 36, padding: '6px 12px', fontSize: 13, fontWeight: 600 }}>
            {toast.actionLabel}
          </button>
        )}
        <button type="button" className="btn btn-ghost" aria-label="Dismiss" onClick={onClose}
          style={{ padding: 8 }}><Icons.X size={13}/></button>
      </div>
    </div>,
  );
}
