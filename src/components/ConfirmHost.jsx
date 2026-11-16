// The one pop-up behind confirmAction(), showNotice() and askText()
// (src/lib/confirm.js). Mounted once at the app root.
//
// - Cancel is always the safe choice: Esc, a tap outside, and the Cancel
//   button all answer "no". For a risky action the keyboard starts on
//   Cancel, so Enter cannot delete something by accident.
// - Each request is answered exactly once, so a double tap cannot confirm
//   twice. Requests that arrive while one is open wait their turn.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { registerConfirmHost } from '../lib/confirm.js';

export default function ConfirmHost() {
  const [queue, setQueue] = useState([]);
  const current = queue[0] || null;
  const [value, setValue] = useState('');
  const cancelRef = useRef(null);
  const okRef = useRef(null);
  const inputRef = useRef(null);
  const returnFocus = useRef(null);

  useEffect(() => registerConfirmHost((options) => new Promise((resolve) => {
    setQueue((q) => [...q, { ...options, resolve, id: `${Date.now()}-${Math.random()}` }]);
  })), []);

  // Answer the open request once. A second tap before the pop-up has
  // closed is ignored, so it can never answer the next request in line.
  const answered = useRef(null);
  const answer = useCallback((result) => {
    if (!current || answered.current === current.id) return;
    answered.current = current.id;
    current.resolve(result);
    setQueue((q) => q.filter((x) => x.id !== current.id));
  }, [current]);
  const cancel = useCallback(() => {
    if (!current) return;
    answer(current.kind === 'confirm' ? false : current.kind === 'text' ? null : true);
  }, [current, answer]);
  const accept = useCallback(() => {
    if (!current) return;
    answer(current.kind === 'text' ? value : true);
  }, [current, answer, value]);

  // Focus: remember where the keyboard was, start on the safe button (or
  // the text box), and put focus back afterwards.
  useEffect(() => {
    if (!current) return undefined;
    returnFocus.current = document.activeElement;
    setValue(current.kind === 'text' ? String(current.defaultValue ?? '') : '');
    const t = setTimeout(() => {
      if (current.kind === 'text') { inputRef.current?.focus(); inputRef.current?.select?.(); }
      else if (current.kind === 'confirm' && current.danger) cancelRef.current?.focus();
      else okRef.current?.focus();
    }, 30);
    return () => {
      clearTimeout(t);
      const el = returnFocus.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus({ preventScroll: true });
    };
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keys. Captured before anything underneath hears them, so Esc closes
  // this pop-up only (not the drawer or sheet behind it).
  useEffect(() => {
    if (!current) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        cancel();
      } else if (e.key === 'Tab') {
        const order = [inputRef.current, cancelRef.current, okRef.current].filter(Boolean);
        if (order.length === 0) return;
        const i = order.indexOf(document.activeElement);
        const next = order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length];
        e.preventDefault(); e.stopPropagation();
        next.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current, cancel]);

  if (!current) return null;
  const { kind, title, body, danger } = current;
  const confirmLabel = current.confirmLabel || (kind === 'notice' ? 'OK' : kind === 'text' ? 'Continue' : 'Confirm');
  const cancelLabel = current.cancelLabel || 'Cancel';

  return createPortal((
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(10,12,8,0.6)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'max(16px, env(safe-area-inset-top, 0px)) 16px max(16px, env(safe-area-inset-bottom, 0px))',
      }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="ivy-confirm-title"
        aria-describedby={body ? 'ivy-confirm-body' : undefined}
        className="card"
        style={{
          width: '100%', maxWidth: 420, padding: 20,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.4)',
          maxHeight: '100%', overflowY: 'auto',
        }}>
        <div id="ivy-confirm-title" style={{ fontSize: 16.5, fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere' }}>{title}</div>
        {body && (
          <div id="ivy-confirm-body" style={{ fontSize: 14, color: 'var(--fg-2)', marginTop: 8, lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{body}</div>
        )}
        {kind === 'text' && (
          <form onSubmit={(e) => { e.preventDefault(); accept(); }} style={{ marginTop: 14 }}>
            <input ref={inputRef} className="input" value={value} onChange={(e) => setValue(e.target.value)}
              aria-label={current.inputLabel || (typeof title === 'string' ? title : 'Your answer')}
              placeholder={current.placeholder || ''} inputMode={current.inputMode}
              maxLength={current.maxLength || 500}
              style={{ width: '100%', fontSize: 16 }}/>
          </form>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {kind !== 'notice' && (
            <button ref={cancelRef} type="button" className="btn btn-outline" onClick={cancel}
              style={{ minHeight: 44, flex: '1 1 120px', justifyContent: 'center' }}>{cancelLabel}</button>
          )}
          <button ref={okRef} type="button" className="btn btn-primary" onClick={accept}
            style={{
              minHeight: 44, flex: kind === 'notice' ? '0 1 160px' : '1 1 120px', justifyContent: 'center',
              ...(danger ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' } : {}),
            }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  ), document.body);
}
