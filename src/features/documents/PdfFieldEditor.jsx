// DocuSign-style field placement on an uploaded PDF.
//
//   • Drag a field from the palette onto any page (mouse, finger or pen:
//     pointer events, like src/features/website/usePointerReorder.js), or
//     tap a field type and then tap the page where it goes.
//   • Drag a box to move it, drag its corner to resize. Boxes snap to the
//     edges of other boxes on the same page (a guide line shows).
//   • The selected box gets a settings bar: label, who fills it in,
//     required or optional, dropdown choices, duplicate, delete.
//     Keyboard: Delete removes, arrows nudge (Shift for bigger steps),
//     Ctrl/Cmd+D duplicates, Escape deselects.
//
// Positions are stored as 0..1 fractions of the page as displayed, so
// they don't depend on zoom or screen size; the server maps them back to
// PDF points when it stamps the signed copy (api/_lib/pdfStamp.js).
//
// Field shape (matches api/_lib/documents.cleanFields):
//   { id, type, label, required, page, x, y, w, h, signerIndex, options? }
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import PdfViewer from './PdfViewer.jsx';
import { useViewport } from '../../lib/viewport.js';
import { FIELD_TYPES, FIELD_META, fieldLabel, signerColor, hexToRgba } from './fieldTypes.js';

const DRAG_START_PX = 5;
const SNAP_PX = 6;
const MIN_W = 0.02;
const MIN_H = 0.012;

const newId = () => `f_${Math.random().toString(36).slice(2, 10)}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default function PdfFieldEditor({
  pdfUrl,
  fields,
  onChange,
  signers = [],
  disabled = false,
}) {
  const [armed, setArmed] = useState(null);           // field type waiting for a tap on the page
  const [activeSigner, setActiveSigner] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [ghost, setGhost] = useState(null);           // { type, x, y } palette drag preview (viewport px)
  const [guides, setGuides] = useState(null);         // { page, x?, y? } fractions while snapping
  const [extraSigners, setExtraSigners] = useState(0);
  // Phones: short chip labels, and the selected box's settings open as a
  // compact sheet at the bottom instead of growing the sticky toolbar.
  const { isMobile } = useViewport();
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const op = useRef(null);                            // current pointer operation

  const commit = useCallback((next) => onChange(next), [onChange]);
  const update = useCallback((id, patch) => {
    commit(fieldsRef.current.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, [commit]);
  const remove = useCallback((id) => {
    commit(fieldsRef.current.filter((f) => f.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  }, [commit]);
  const duplicate = useCallback((id) => {
    const f = fieldsRef.current.find((x) => x.id === id);
    if (!f) return;
    const copy = {
      ...f, id: newId(), value: '',
      x: clamp(f.x + 0.02, 0, 1 - f.w),
      y: clamp(f.y + 0.03, 0, 1 - f.h),
    };
    commit([...fieldsRef.current, copy]);
    setSelectedId(copy.id);
  }, [commit]);

  // How many signer slots to offer: everyone already used, plus one so
  // the owner can always start fields for the next signer.
  const used = fields.reduce((m, f) => Math.max(m, (f.signerIndex || 0) + 1), 1);
  const slotCount = Math.min(10, signers.length || Math.max(used, 1 + extraSigners, activeSigner + 1));
  const signerName = (i) => signers[i]?.name || `Signer ${i + 1}`;

  const place = (type, pageIdx, fx, fy) => {
    const t = FIELD_META[type] || FIELD_TYPES[0];
    const f = {
      id: newId(), type, label: '', required: true, value: '',
      page: pageIdx, signerIndex: activeSigner,
      w: t.w, h: t.h,
      x: clamp(fx - t.w / 2, 0, 1 - t.w),
      y: clamp(fy - t.h / 2, 0, 1 - t.h),
    };
    if (type === 'dropdown') f.options = ['Option 1', 'Option 2'];
    if (type === 'checkbox') f.required = false;
    commit([...fieldsRef.current, f]);
    setSelectedId(f.id);
  };

  // Which page (and where on it) is under a viewport point.
  const pageAt = (clientX, clientY) => {
    const el = document.elementFromPoint(clientX, clientY)?.closest?.('[data-page-idx]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { page: Number(el.getAttribute('data-page-idx')), fx: (clientX - r.left) / r.width, fy: (clientY - r.top) / r.height };
  };

  // ── Palette: drag a new field onto a page, or tap to arm ────────────
  const onPalettePointerDown = (e, type) => {
    if (disabled || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    op.current = { kind: 'palette', type, sx: e.clientX, sy: e.clientY, moved: false };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  };

  // ── Boxes: move or resize ──────────────────────────────────────────
  const onBoxPointerDown = (e, f, mode) => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(f.id);
    setArmed(null);
    const pageEl = e.currentTarget.closest('[data-page-idx]');
    if (!pageEl) return;
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    op.current = {
      kind: mode, id: f.id, sx: e.clientX, sy: e.clientY, moved: false,
      rect: pageEl.getBoundingClientRect(), orig: { ...f },
    };
  };

  const snap = (f, x, y) => {
    const others = fieldsRef.current.filter((o) => o.id !== f.id && (o.page || 0) === (f.page || 0));
    const r = op.current.rect;
    const tx = SNAP_PX / r.width, ty = SNAP_PX / r.height;
    let gx = null, gy = null;
    for (const o of others) {
      for (const cand of [o.x, o.x + o.w - f.w, o.x + o.w]) {
        if (gx === null && Math.abs(cand - x) < tx) { x = cand; gx = cand; }
      }
      for (const cand of [o.y, o.y + o.h - f.h, o.y + o.h]) {
        if (gy === null && Math.abs(cand - y) < ty) { y = cand; gy = cand; }
      }
    }
    return { x, y, gx, gy };
  };

  const onPointerMove = useCallback((e) => {
    const o = op.current;
    if (!o) return;
    const dxPx = e.clientX - o.sx, dyPx = e.clientY - o.sy;
    if (!o.moved && Math.hypot(dxPx, dyPx) < DRAG_START_PX) return;
    o.moved = true;
    if (o.kind === 'palette') {
      setGhost({ type: o.type, x: e.clientX, y: e.clientY });
      return;
    }
    const f = o.orig;
    if (o.kind === 'move') {
      let x = clamp(f.x + dxPx / o.rect.width, 0, 1 - f.w);
      let y = clamp(f.y + dyPx / o.rect.height, 0, 1 - f.h);
      const s = snap(f, x, y);
      x = clamp(s.x, 0, 1 - f.w); y = clamp(s.y, 0, 1 - f.h);
      setGuides(s.gx !== null || s.gy !== null ? { page: f.page || 0, x: s.gx, y: s.gy } : null);
      update(o.id, { x, y });
    } else if (o.kind === 'resize') {
      const w = clamp(f.w + dxPx / o.rect.width, MIN_W, 1 - f.x);
      const h = clamp(f.h + dyPx / o.rect.height, MIN_H, 1 - f.y);
      update(o.id, { w, h });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update]);

  const onPointerUp = useCallback((e) => {
    const o = op.current;
    op.current = null;
    setGuides(null);
    if (!o) return;
    if (o.kind === 'palette') {
      setGhost(null);
      if (!o.moved) {
        // A tap: arm this type; the next tap on a page places it.
        setArmed((a) => (a === o.type ? null : o.type));
        return;
      }
      const hit = pageAt(e.clientX, e.clientY);
      if (hit) place(o.type, hit.page, hit.fx, hit.fy);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSigner]);

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  // Keyboard shortcuts for the selected box (desktop).
  useEffect(() => {
    if (disabled) return undefined;
    const onKey = (e) => {
      if (!selectedId) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      const f = fieldsRef.current.find((x) => x.id === selectedId);
      if (!f) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(f.id); return; }
      if (e.key === 'Escape') { setSelectedId(null); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(f.id); return; }
      const step = e.shiftKey ? 0.01 : 0.002;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        e.preventDefault();
        update(f.id, { x: clamp(f.x + moves[e.key][0], 0, 1 - f.w), y: clamp(f.y + moves[e.key][1], 0, 1 - f.h) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, disabled, remove, duplicate, update]);

  const onPageClick = (e, pageIdx) => {
    if (disabled) return;
    if (e.target.closest?.('[data-field-box]')) return;
    if (!armed) { setSelectedId(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    place(armed, pageIdx, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    setArmed(null);
  };

  const selected = fields.find((f) => f.id === selectedId) || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Toolbar: palette + who fills it in, or the selected box's settings */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 6,
        padding: 10, borderRadius: 12, background: 'var(--surface-2)',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {!disabled && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className="metric-label" style={{ marginRight: 2 }}>For</span>
              {Array.from({ length: slotCount }, (_, i) => (
                <button key={i} type="button" onClick={() => setActiveSigner(i)}
                  aria-pressed={activeSigner === i}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '5px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600,
                    border: `1.5px solid ${activeSigner === i ? signerColor(i) : 'var(--border-strong)'}`,
                    background: activeSigner === i ? hexToRgba(signerColor(i), 0.12) : 'var(--surface)',
                    color: 'var(--fg-2)', cursor: 'pointer', minHeight: 32,
                  }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: signerColor(i) }}/>
                  {signerName(i)}
                </button>
              ))}
              {!signers.length && slotCount < 10 && (
                <button type="button" className="btn btn-ghost"
                  onClick={() => { setExtraSigners((n) => n + 1); setActiveSigner(slotCount); }}
                  style={{ fontSize: 12, padding: '5px 8px' }}>
                  <Icons.Plus size={11} sw={2}/> Signer
                </button>
              )}
            </div>
            <div data-field-palette style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {FIELD_TYPES.map((t) => {
                const Icon = Icons[t.icon] || Icons.Plus;
                const on = armed === t.id;
                return (
                  <button key={t.id} type="button" data-palette-type={t.id}
                    title={`${t.label}: ${t.hint}. Drag it onto the page, or tap it and then tap the page.`}
                    onPointerDown={(e) => onPalettePointerDown(e, t.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setArmed(on ? null : t.id); } }}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: isMobile ? '6px 8px' : '7px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
                      background: on ? 'var(--accent)' : 'var(--surface)',
                      color: on ? 'var(--accent-ink)' : 'var(--fg-2)',
                      cursor: 'grab', touchAction: 'none', userSelect: 'none', minHeight: 34,
                    }}>
                    <Icon size={12} sw={1.8}/> {isMobile ? t.short : t.label}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {selected && !disabled && !isMobile ? (
          <FieldSettings
            field={selected}
            slotCount={slotCount}
            signerName={signerName}
            onChange={(patch) => update(selected.id, patch)}
            onDuplicate={() => duplicate(selected.id)}
            onRemove={() => remove(selected.id)}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <div style={{ fontSize: 12, color: armed ? 'var(--accent)' : 'var(--muted)', fontWeight: armed ? 600 : 400, lineHeight: 1.45 }}>
            {disabled
              ? 'Fields are locked while the document is out for signing.'
              : armed
                ? `Now tap the page where the ${FIELD_META[armed]?.label} goes.`
                : 'Drag a field onto the page, or tap one and then tap the page. Tap a box to change or remove it.'}
          </div>
        )}
      </div>

      <PdfViewer
        url={pdfUrl}
        renderOverlay={({ pageIndex, pageWidth, pageHeight }) => (
          <div data-page-idx={pageIndex}
            onClick={(e) => onPageClick(e, pageIndex)}
            style={{ position: 'absolute', inset: 0, cursor: disabled ? 'default' : armed ? 'copy' : 'default' }}>
            {guides && guides.page === pageIndex && (
              <>
                {guides.x !== null && guides.x !== undefined && (
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: guides.x * pageWidth, width: 0, borderLeft: '1px dashed var(--accent)', pointerEvents: 'none' }}/>
                )}
                {guides.y !== null && guides.y !== undefined && (
                  <div style={{ position: 'absolute', left: 0, right: 0, top: guides.y * pageHeight, height: 0, borderTop: '1px dashed var(--accent)', pointerEvents: 'none' }}/>
                )}
              </>
            )}
            {fields.filter((f) => (f.page || 0) === pageIndex).map((f) => (
              <FieldBox key={f.id} f={f}
                pageWidth={pageWidth} pageHeight={pageHeight}
                selected={selectedId === f.id}
                disabled={disabled}
                showSigner={slotCount > 1}
                onPointerDown={onBoxPointerDown}/>
            ))}
          </div>
        )}
      />

      {selected && !disabled && isMobile && (
        <div data-field-sheet style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 140,
          padding: '4px 14px calc(12px + env(safe-area-inset-bottom, 0px))',
          background: 'var(--surface)', borderTop: '1px solid var(--border)',
          boxShadow: '0 -8px 24px rgba(0,0,0,0.18)', maxHeight: '45vh', overflowY: 'auto',
        }}>
          <FieldSettings
            field={selected}
            slotCount={slotCount}
            signerName={signerName}
            onChange={(patch) => update(selected.id, patch)}
            onDuplicate={() => duplicate(selected.id)}
            onRemove={() => remove(selected.id)}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}

      {ghost && (
        <div style={{
          position: 'fixed', left: ghost.x, top: ghost.y, transform: 'translate(-50%, -50%)',
          zIndex: 400, pointerEvents: 'none',
          padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
          border: `1.5px solid ${signerColor(activeSigner)}`,
          background: hexToRgba(signerColor(activeSigner), 0.18), color: 'var(--fg)',
          boxShadow: 'var(--shadow-sm)',
        }}>{FIELD_META[ghost.type]?.label}</div>
      )}
    </div>
  );
}

function FieldBox({ f, pageWidth, pageHeight, selected, disabled, showSigner, onPointerDown }) {
  const color = signerColor(f.signerIndex);
  const width = (f.w ?? 0.2) * pageWidth;
  const height = (f.h ?? 0.04) * pageHeight;
  return (
    <div data-field-box={f.id}
      onPointerDown={(e) => onPointerDown(e, f, 'move')}
      role="button" aria-label={`${fieldLabel(f)} field`}
      style={{
        position: 'absolute',
        left: (f.x ?? 0) * pageWidth, top: (f.y ?? 0) * pageHeight, width, height,
        border: `${selected ? 2 : 1.5}px solid ${color}`,
        background: hexToRgba(color, selected ? 0.22 : 0.12),
        borderRadius: 3, boxSizing: 'border-box',
        cursor: disabled ? 'default' : 'move', userSelect: 'none', touchAction: 'none',
        display: 'flex', alignItems: 'center', justifyContent: f.type === 'checkbox' ? 'center' : 'flex-start',
        overflow: 'visible',
      }}>
      <span style={{
        fontSize: Math.max(8, Math.min(12, height * 0.55)), fontWeight: 650, color,
        padding: f.type === 'checkbox' ? 0 : '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        pointerEvents: 'none',
      }}>
        {f.type === 'checkbox' ? <Icons.Check size={Math.max(8, Math.min(14, height * 0.8))} sw={2.4}/> : fieldLabel(f)}
        {f.type !== 'checkbox' && f.required !== false && <span style={{ color: 'var(--danger)' }}> *</span>}
      </span>
      {showSigner && (
        <span style={{
          position: 'absolute', top: -9, left: -9, width: 16, height: 16, borderRadius: 99,
          background: color, color: '#fff', fontSize: 9.5, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
        }}>{(f.signerIndex || 0) + 1}</span>
      )}
      {selected && !disabled && (
        <div
          onPointerDown={(e) => onPointerDown(e, f, 'resize')}
          aria-label="Resize"
          style={{
            position: 'absolute', right: -11, bottom: -11, width: 22, height: 22,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'nwse-resize', touchAction: 'none',
          }}>
          <span style={{ width: 11, height: 11, borderRadius: 3, background: color, border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.15)' }}/>
        </div>
      )}
    </div>
  );
}

function FieldSettings({ field, slotCount, signerName, onChange, onDuplicate, onRemove, onClose }) {
  const meta = FIELD_META[field.type] || FIELD_TYPES[0];
  const [choices, setChoices] = useState((field.options || []).join('\n'));
  useEffect(() => { setChoices((field.options || []).join('\n')); }, [field.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-field-settings style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: signerColor(field.signerIndex) }}>{meta.label}</span>
        <input value={field.label || ''} onChange={(e) => onChange({ label: e.target.value.slice(0, 120) })}
          placeholder={`Label (optional), e.g. ${meta.label}`}
          aria-label="Field label"
          className="input"
          style={{ ...inputS, flex: '1 1 160px', minWidth: 0 }}/>
        {slotCount > 1 && (
          <select value={field.signerIndex || 0} onChange={(e) => onChange({ signerIndex: Number(e.target.value) })}
            aria-label="Who fills this in" style={{ ...inputS, flex: '0 1 auto' }}>
            {Array.from({ length: slotCount }, (_, i) => <option key={i} value={i}>{signerName(i)}</option>)}
          </select>
        )}
        {field.type !== 'date' && field.type !== 'email' && (
          <label style={{ fontSize: 12, color: 'var(--fg-2)', display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 32 }}>
            <input type="checkbox" checked={field.required !== false} onChange={(e) => onChange({ required: e.target.checked })}/>
            Required
          </label>
        )}
      </div>
      {field.type === 'dropdown' && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--muted)' }}>
          Choices (one per line)
          <textarea value={choices} rows={3}
            onChange={(e) => {
              setChoices(e.target.value);
              onChange({ options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50) });
            }}
            style={{ ...inputS, fontFamily: 'inherit', resize: 'vertical' }}/>
        </label>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: '1 1 140px' }}>{meta.hint}.</span>
        <button type="button" className="btn btn-outline" onClick={onDuplicate} style={{ fontSize: 12, padding: '5px 10px' }}>
          <Icons.Copy size={12}/> Duplicate
        </button>
        <button type="button" className="btn btn-ghost" onClick={onRemove} style={{ fontSize: 12, padding: '5px 10px', color: 'var(--danger)' }}>
          <Icons.Trash size={12}/> Remove
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} style={{ fontSize: 12, padding: '5px 10px' }}>
          Done
        </button>
      </div>
    </div>
  );
}

const inputS = {
  padding: '7px 10px', borderRadius: 8,
  border: '1px solid var(--border-strong)', background: 'var(--surface)',
  color: 'var(--fg)', fontSize: 13, outline: 'none',
};
