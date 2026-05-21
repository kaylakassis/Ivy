// Drag-drop field placement on a PDF preview. The owner picks a field
// type, drops it onto a page, then can drag to reposition or use the
// SE corner to resize. Coordinates are stored as 0..1 fractions of the
// page so the server can stamp them onto the original PDF without
// caring about render scale.
//
// Field shape (matches api/_lib/documents.cleanFields):
//   { id, type, label?, required, page, x, y, w, h, signerIndex }
//
// signerIndex defaults to 0 (the first signer). The owner can change
// it inline so a 4-page agreement can mix "client signs page 1" and
// "owner signs page 4" in one document.
import React, { useRef, useState, useCallback } from 'react';
import { Icons } from '../../components/Icons.jsx';
import PdfViewer from './PdfViewer.jsx';

const FIELD_TYPES = [
  { id: 'signature', label: 'Signature', defaultW: 0.28, defaultH: 0.06 },
  { id: 'initial',   label: 'Initial',   defaultW: 0.08, defaultH: 0.05 },
  { id: 'date',      label: 'Date',      defaultW: 0.16, defaultH: 0.04 },
  { id: 'text',      label: 'Text',      defaultW: 0.30, defaultH: 0.04 },
];

// Color the per-signer field outlines so the editor can see at a glance
// who's filling what. Wraps after 5 — enough for the 10-signer cap.
const SIGNER_COLORS = [
  '#2C7BE5', '#9B2C2C', '#1F8A4C', '#B97A07', '#6E3FB6',
  '#0D6E6E', '#A02E63', '#3B5998', '#7A6B22', '#5C5C5C',
];

export default function PdfFieldEditor({
  pdfUrl,
  fields,
  onChange,
  signers = [],
  disabled = false,
}) {
  const [activeType, setActiveType] = useState('signature');
  const [activeSigner, setActiveSigner] = useState(0);
  const [drag, setDrag] = useState(null); // { id, mode: 'move' | 'resize', startX, startY, origField }
  const [pageDims, setPageDims] = useState({}); // pageIndex → { w, h }
  const [selectedId, setSelectedId] = useState(null);
  const containerRef = useRef(null);

  const setDim = useCallback((idx, w, h) => {
    setPageDims((prev) => prev[idx] ? prev : { ...prev, [idx]: { w, h } });
  }, []);

  const update = (id, patch) => {
    onChange(fields.map((f) => f.id === id ? { ...f, ...patch } : f));
  };
  const remove = (id) => onChange(fields.filter((f) => f.id !== id));

  // Click on empty page → drop a new field of the active type.
  const handlePageClick = (e, pageIdx) => {
    if (disabled) return;
    if (e.target.dataset?.fieldHandle) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const yFrac = (e.clientY - rect.top) / rect.height;
    const t = FIELD_TYPES.find((x) => x.id === activeType) || FIELD_TYPES[0];
    const id = `f_${Math.random().toString(36).slice(2, 8)}`;
    const newField = {
      id, type: t.id, label: '', required: true, value: '',
      page: pageIdx,
      signerIndex: activeSigner,
      x: clamp01(xFrac - t.defaultW / 2),
      y: clamp01(yFrac - t.defaultH / 2),
      w: t.defaultW,
      h: t.defaultH,
    };
    onChange([...fields, newField]);
    setSelectedId(id);
  };

  const onMouseDownField = (e, field, mode) => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    // Capture the pointer so move/up keep tracking even if the finger
    // drifts off the field — essential for touch dragging.
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    setSelectedId(field.id);
    const pageEl = e.currentTarget.closest('[data-page-idx]');
    if (!pageEl) return;
    const rect = pageEl.getBoundingClientRect();
    setDrag({
      id: field.id, mode,
      startX: e.clientX, startY: e.clientY,
      pageRect: rect,
      origField: { ...field },
    });
  };

  const onMouseMove = (e) => {
    if (!drag) return;
    const dxF = (e.clientX - drag.startX) / drag.pageRect.width;
    const dyF = (e.clientY - drag.startY) / drag.pageRect.height;
    if (drag.mode === 'move') {
      const nx = clamp01(drag.origField.x + dxF);
      const ny = clamp01(drag.origField.y + dyF);
      const x = Math.min(nx, 1 - drag.origField.w);
      const y = Math.min(ny, 1 - drag.origField.h);
      update(drag.id, { x, y });
    } else if (drag.mode === 'resize') {
      const nw = clamp01(drag.origField.w + dxF);
      const nh = clamp01(drag.origField.h + dyF);
      const w = Math.max(0.04, Math.min(nw, 1 - drag.origField.x));
      const h = Math.max(0.02, Math.min(nh, 1 - drag.origField.y));
      update(drag.id, { w, h });
    }
  };
  const onMouseUp = () => setDrag(null);

  // Number of signer "slots" the dropdown exposes. Before send, signers
  // is empty — so we infer from the highest signerIndex already used,
  // plus one extra so the owner can always pre-target the next signer.
  // After send, the actual signers list pins the count to who's
  // attached.
  const fromFields = fields.reduce((m, f) => Math.max(m, (f.signerIndex || 0) + 1), 1);
  const baseTotal = signers.length || fromFields;
  const total = Math.min(10, Math.max(baseTotal, signers.length ? signers.length : baseTotal + 1));

  return (
    <div ref={containerRef}
      onPointerMove={onMouseMove} onPointerUp={onMouseUp} onPointerCancel={onMouseUp}
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)',
        border: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 5,
      }}>
        <span className="metric-label">Place</span>
        {FIELD_TYPES.map((t) => (
          <button key={t.id} type="button" onClick={() => setActiveType(t.id)}
            disabled={disabled}
            style={{
              padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: '1px solid var(--border-strong)',
              background: activeType === t.id ? 'var(--accent)' : 'var(--surface)',
              color: activeType === t.id ? 'var(--accent-ink)' : 'var(--fg-2)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}>{t.label}</button>
        ))}
        {total > 1 && (
          <>
            <span style={{ width: 1, height: 20, background: 'var(--border)' }}/>
            <span className="metric-label">For signer</span>
            <select value={activeSigner} onChange={(e) => setActiveSigner(Number(e.target.value))}
              disabled={disabled}
              style={{
                padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                border: '1px solid var(--border-strong)',
                background: 'var(--surface)', color: 'var(--fg-2)',
                outline: 'none',
              }}>
              {Array.from({ length: total }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}. {signers[i]?.name || `Signer ${i + 1}`}
                </option>
              ))}
            </select>
            <span style={{
              width: 12, height: 12, borderRadius: 99,
              background: SIGNER_COLORS[activeSigner % SIGNER_COLORS.length],
            }}/>
          </>
        )}
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Click on the page to drop a field. Drag to move. Bottom-right corner to resize.
        </span>
      </div>

      <PdfViewer
        url={pdfUrl}
        onPageDimensions={setDim}
        renderOverlay={({ pageIndex, pageWidth, pageHeight }) => (
          <div data-page-idx={pageIndex}
            onClick={(e) => handlePageClick(e, pageIndex)}
            style={{
              position: 'absolute', inset: 0,
              cursor: disabled ? 'default' : 'crosshair',
            }}>
            {fields.filter((f) => (f.page || 0) === pageIndex).map((f) => {
              const left = (f.x ?? 0) * pageWidth;
              const top  = (f.y ?? 0) * pageHeight;
              const width  = (f.w ?? 0.2) * pageWidth;
              const height = (f.h ?? 0.04) * pageHeight;
              const color = SIGNER_COLORS[(f.signerIndex || 0) % SIGNER_COLORS.length];
              const selected = selectedId === f.id;
              return (
                <div key={f.id}
                  onPointerDown={(e) => onMouseDownField(e, f, 'move')}
                  onClick={(e) => { e.stopPropagation(); setSelectedId(f.id); }}
                  data-field-handle="1"
                  style={{
                    position: 'absolute',
                    left, top, width, height,
                    border: `1.5px solid ${color}`,
                    background: hexToRgba(color, selected ? 0.18 : 0.08),
                    borderRadius: 3,
                    cursor: 'move',
                    boxSizing: 'border-box',
                    userSelect: 'none',
                    touchAction: 'none',
                  }}>
                  <div style={{
                    position: 'absolute', top: -18, left: 0,
                    fontSize: 10, fontWeight: 600, color,
                    background: '#fff',
                    padding: '1px 5px', borderRadius: 3,
                    whiteSpace: 'nowrap',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                  }}>
                    {labelFor(f)}{total > 1 ? ` · ${(f.signerIndex || 0) + 1}` : ''}
                  </div>
                  {selected && !disabled && (
                    <button type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); remove(f.id); }}
                      data-field-handle="1"
                      title="Remove"
                      style={{
                        position: 'absolute', top: -14, right: -14,
                        width: 28, height: 28, borderRadius: 99,
                        border: 'none', cursor: 'pointer',
                        background: 'var(--danger)', color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                        touchAction: 'none',
                      }}>
                      <Icons.X size={14} sw={2.5}/>
                    </button>
                  )}
                  {!disabled && (
                    <div
                      onPointerDown={(e) => onMouseDownField(e, f, 'resize')}
                      data-field-handle="1"
                      style={{
                        position: 'absolute',
                        right: -7, bottom: -7,
                        width: 18, height: 18,
                        background: color,
                        borderRadius: 3,
                        cursor: 'nwse-resize',
                        touchAction: 'none',
                      }}/>
                  )}
                </div>
              );
            })}
          </div>
        )}
      />

      {/* Inline field details panel for the selected field */}
      {selectedId && fields.find((f) => f.id === selectedId) && (
        <SelectedFieldPanel
          field={fields.find((f) => f.id === selectedId)}
          onChange={(patch) => update(selectedId, patch)}
          onRemove={() => { remove(selectedId); setSelectedId(null); }}
          totalSigners={total}
          signers={signers}
          disabled={disabled}
        />
      )}
    </div>
  );
}

function SelectedFieldPanel({ field, onChange, onRemove, totalSigners, signers, disabled }) {
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
      display: 'grid', gridTemplateColumns: '120px 1fr 130px 90px 30px',
      gap: 10, alignItems: 'center',
    }}>
      <select value={field.type} onChange={(e) => onChange({ type: e.target.value })}
        disabled={disabled}
        style={selectS}>
        {FIELD_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <input value={field.label || ''} onChange={(e) => onChange({ label: e.target.value })}
        disabled={disabled}
        placeholder={`Label (e.g., ${defaultLabelFor(field.type)})`}
        style={inputS}/>
      {totalSigners > 1 ? (
        <select value={field.signerIndex || 0}
          onChange={(e) => onChange({ signerIndex: Number(e.target.value) })}
          disabled={disabled}
          style={selectS}>
          {Array.from({ length: totalSigners }, (_, i) => (
            <option key={i} value={i}>{i + 1}. {signers[i]?.name || `Signer ${i + 1}`}</option>
          ))}
        </select>
      ) : <div/>}
      <label style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={field.required !== false}
          onChange={(e) => onChange({ required: e.target.checked })}
          disabled={disabled}/>
        Required
      </label>
      {!disabled && (
        <button type="button" onClick={onRemove}
          className="btn btn-ghost"
          style={{ padding: 4, color: 'var(--danger)' }}>
          <Icons.X size={13}/>
        </button>
      )}
    </div>
  );
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function labelFor(f) {
  if (f.label) return f.label;
  return defaultLabelFor(f.type);
}

function defaultLabelFor(type) {
  return ({
    signature: 'Signature',
    initial:   'Initials',
    date:      'Date',
    text:      'Text',
  })[type] || 'Field';
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const inputS = {
  padding: '7px 10px', borderRadius: 8,
  border: '1px solid var(--border-strong)', background: 'var(--surface)',
  color: 'var(--fg)', fontSize: 13, outline: 'none',
};
const selectS = { ...inputS };
