// PDF signing surface for the recipient. Renders the source PDF and the
// fields the owner placed on it. Only the CURRENT signer's fields are
// active; other signers' fields are shown dimmed (with their values once
// filled) for context.
//
// Tapping one of your fields:
//   signature / initials → applies the signature (or initials) you adopted
//                          once; the first time, asks you to adopt one
//   checkbox             → ticks / unticks
//   date / email         → filled in for you (shown, not editable)
//   dropdown             → pick one of the choices
//   anything else        → type the answer
// The parent (SignPage) owns the values, the adopted signature and the
// guided "Next" navigation; `focusId` is the field it is pointing at.
import React, { useState } from 'react';
import PdfViewer from './PdfViewer.jsx';
import { fieldLabel, signerColor, hexToRgba } from './fieldTypes.js';

export default function PdfFieldSigner({
  pdfUrl,
  fields,
  values,
  currentSignerIndex = 0,
  focusId = null,
  onActivate,
}) {
  return (
    <PdfViewer
      url={pdfUrl}
      renderOverlay={({ pageIndex, pageWidth, pageHeight }) => (
        <div style={{ position: 'absolute', inset: 0 }}>
          {fields.filter((f) => (f.page || 0) === pageIndex).map((f) => (
            <SignerBox key={f.id} f={f}
              pageWidth={pageWidth} pageHeight={pageHeight}
              isMine={(f.signerIndex || 0) === currentSignerIndex}
              value={values[f.id] ?? f.value ?? ''}
              focused={focusId === f.id}
              onActivate={onActivate}/>
          ))}
        </div>
      )}
    />
  );
}

function SignerBox({ f, pageWidth, pageHeight, isMine, value, focused, onActivate }) {
  const [pressed, setPressed] = useState(false);
  const left = (f.x ?? 0) * pageWidth;
  const top = (f.y ?? 0) * pageHeight;
  const width = (f.w ?? 0.2) * pageWidth;
  const height = (f.h ?? 0.04) * pageHeight;
  const color = signerColor(f.signerIndex);
  const filled = !!value;
  const required = f.required !== false;
  const auto = f.type === 'date' || f.type === 'email';
  // Small boxes get a bigger invisible tap target on phones.
  const padX = Math.max(0, (36 - width) / 2);
  const padY = Math.max(0, (36 - height) / 2);
  return (
    <button type="button"
      data-sign-field={f.id}
      disabled={!isMine}
      aria-label={`${fieldLabel(f)}${required ? ' (required)' : ''}${filled ? ', filled' : ''}`}
      onClick={() => isMine && onActivate?.(f)}
      onPointerDown={() => setPressed(true)} onPointerUp={() => setPressed(false)} onPointerLeave={() => setPressed(false)}
      style={{
        position: 'absolute',
        left: left - padX, top: top - padY, width: width + padX * 2, height: height + padY * 2,
        padding: `${padY}px ${padX}px`, margin: 0, border: 0, background: 'transparent',
        cursor: isMine && !auto ? 'pointer' : 'default',
      }}>
      <span style={{
        display: 'flex', alignItems: 'center',
        justifyContent: f.type === 'checkbox' || f.type === 'initial' ? 'center' : 'flex-start',
        width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden',
        borderRadius: 3,
        border: isMine
          ? `${focused ? 2.5 : 1.5}px solid ${filled ? hexToRgba(color, 0.55) : color}`
          : '1px dashed #bbb',
        background: isMine
          ? hexToRgba(color, filled ? 0.05 : (pressed ? 0.3 : 0.16))
          : (filled ? 'transparent' : 'rgba(220,220,220,0.18)'),
        boxShadow: focused ? `0 0 0 4px ${hexToRgba(color, 0.25)}` : 'none',
        transition: 'box-shadow .15s, background .15s',
        color: '#1a1a1a',
      }}>
        {filled ? <Filled f={f} value={value} boxH={height} boxW={width}/> : (
          <span style={{
            fontSize: Math.max(8, Math.min(11, height * 0.5)), fontWeight: 700, letterSpacing: '0.03em',
            textTransform: 'uppercase', color: isMine ? color : '#999',
            padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {f.type === 'checkbox' ? '' : fieldLabel(f)}{isMine && required && f.type !== 'checkbox' ? ' *' : ''}
          </span>
        )}
      </span>
    </button>
  );
}

function Filled({ f, value, boxH, boxW }) {
  if (f.type === 'checkbox') {
    return value === 'true'
      ? <svg viewBox="0 0 24 24" width="80%" height="80%" aria-hidden="true"><path d="M4 12.5l5 5L20 6" fill="none" stroke="#141820" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
      : null;
  }
  if ((f.type === 'signature' || f.type === 'initial') && typeof value === 'string' && value.startsWith('data:image/png')) {
    return <img src={value} alt="" style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain', margin: '0 auto' }}/>;
  }
  return (
    <span style={{
      width: '100%', padding: '0 4px',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      // Shrink long values to the box width (like the stamped PDF does).
      fontSize: Math.max(7, Math.min(boxH * 0.62, 20, (boxW - 8) / Math.max(1, String(value).length * 0.55))),
      fontWeight: f.type === 'signature' ? 600 : 500,
      textAlign: f.type === 'initial' ? 'center' : 'left',
      fontFamily: f.type === 'signature' ? '"Snell Roundhand", "Brush Script MT", cursive' : 'inherit',
    }}>{value}</span>
  );
}
