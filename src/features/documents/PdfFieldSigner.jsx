// PDF signing surface for the recipient. Renders the source PDF + the
// fields the owner placed on it, with only the CURRENT signer's fields
// active. The signer clicks an active box to enter the value
// (signature pad pop-up, or inline input for date/text/initial).
//
// Fields belonging to other signers are shown dimmed + read-only -
// gives the current signer context for who else has touched the doc
// without letting them fill anything that isn't theirs.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import PdfViewer from './PdfViewer.jsx';
import SignaturePad from './SignaturePad.jsx';

const SIGNER_COLORS = [
  '#2C7BE5', '#9B2C2C', '#1F8A4C', '#B97A07', '#6E3FB6',
  '#0D6E6E', '#A02E63', '#3B5998', '#7A6B22', '#5C5C5C',
];

export default function PdfFieldSigner({
  pdfUrl,
  fields,
  values,
  onChange,
  currentSignerIndex = 0,
}) {
  const [editing, setEditing] = useState(null); // field id

  const setVal = (id, v) => onChange({ ...values, [id]: v });

  const editField = (f) => {
    if (f.signerIndex !== currentSignerIndex) return;
    setEditing(f.id);
  };

  const closeEdit = () => setEditing(null);

  return (
    <>
      <PdfViewer
        url={pdfUrl}
        renderOverlay={({ pageIndex, pageWidth, pageHeight }) => (
          <div style={{ position: 'absolute', inset: 0 }}>
            {fields.filter((f) => (f.page || 0) === pageIndex).map((f) => {
              const left = (f.x ?? 0) * pageWidth;
              const top  = (f.y ?? 0) * pageHeight;
              const width  = (f.w ?? 0.2) * pageWidth;
              const height = (f.h ?? 0.04) * pageHeight;
              const isMine = f.signerIndex === currentSignerIndex;
              const color = SIGNER_COLORS[(f.signerIndex || 0) % SIGNER_COLORS.length];
              const v = values[f.id] ?? f.value ?? '';
              const filled = !!v;
              return (
                <div key={f.id}
                  onClick={() => editField(f)}
                  style={{
                    position: 'absolute',
                    left, top, width, height,
                    boxSizing: 'border-box',
                    border: `1.5px ${isMine ? 'solid' : 'dashed'} ${isMine ? color : '#bbb'}`,
                    background: isMine
                      ? hexToRgba(color, filled ? 0.04 : 0.14)
                      : 'rgba(220,220,220,0.18)',
                    borderRadius: 3,
                    cursor: isMine ? 'pointer' : 'not-allowed',
                    overflow: 'hidden',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: Math.max(10, Math.min(height * 0.6, 18)),
                    color: isMine ? '#1a1a1a' : '#888',
                    userSelect: 'none',
                  }}>
                  {filled ? renderFilled(f, v, height) : (
                    <span style={{
                      fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      color: isMine ? color : '#999',
                    }}>{labelFor(f)}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      />

      {editing && (() => {
        const f = fields.find((x) => x.id === editing);
        if (!f) return null;
        return (
          <FieldEditModal
            field={f}
            value={values[f.id] ?? ''}
            onCancel={closeEdit}
            onSave={(v) => { setVal(f.id, v); closeEdit(); }}
          />
        );
      })()}
    </>
  );
}

function renderFilled(field, value, boxH) {
  if (field.type === 'signature' && typeof value === 'string' && value.startsWith('data:')) {
    return <img src={value} alt="" style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }}/>;
  }
  // Text-like (typed signature, date, initials, plain text). Squeeze into the box.
  return (
    <span style={{
      width: '100%', padding: '0 4px',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      fontSize: Math.max(10, Math.min(boxH * 0.62, 22)),
      fontWeight: field.type === 'signature' ? 700 : 500,
      textAlign: field.type === 'initial' ? 'center' : 'left',
      letterSpacing: field.type === 'initial' ? '0.1em' : 'normal',
      fontFamily: field.type === 'signature'
        ? '"Snell Roundhand", "Brush Script MT", cursive'
        : 'inherit',
    }}>{value}</span>
  );
}

function FieldEditModal({ field, value, onCancel, onSave }) {
  const [v, setV] = useState(value);
  const isSig = field.type === 'signature';
  const label = labelFor(field);
  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, zIndex: 230,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: '100%', maxWidth: 460, padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>
            {label}{field.required !== false && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>}
          </h3>
          <button type="button" className="btn btn-ghost" onClick={onCancel} style={{ padding: 6 }}>
            <Icons.X size={14}/>
          </button>
        </div>

        {isSig && <SignaturePad value={v} onChange={setV} height={140}/>}
        {field.type === 'initial' && (
          <input value={v} maxLength={4}
            onChange={(e) => setV(e.target.value.toUpperCase())}
            placeholder="AB"
            autoFocus
            style={{ ...inputS, textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, fontSize: 20, padding: '14px 12px' }}/>
        )}
        {field.type === 'date' && (
          <input type="date" value={v || new Date().toISOString().slice(0, 10)}
            onChange={(e) => setV(e.target.value)}
            autoFocus style={inputS}/>
        )}
        {field.type === 'text' && (
          <input value={v} onChange={(e) => setV(e.target.value)}
            placeholder={field.label || 'Your answer'}
            autoFocus style={inputS}/>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-outline" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onSave(v)}
            disabled={!v && field.required !== false}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function labelFor(f) {
  if (f.label) return f.label;
  return ({
    signature: 'Signature',
    initial:   'Initials',
    date:      'Date',
    text:      'Text',
  })[f.type] || 'Field';
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const inputS = {
  width: '100%', padding: '12px 14px', borderRadius: 10,
  background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 15, outline: 'none',
};
