// Signature capture: draw with a finger, mouse or pen, or type it.
//
// Drawing uses pointer events and `touch-action: none` on the canvas, so
// on an iPhone the page doesn't scroll while you sign. A typed signature
// is turned into an image in a handwriting-style font (typedToPng), so it
// looks like a signature on the signed PDF too.
import React, { useRef, useState, useEffect } from 'react';

export default function SignaturePad({ value, onChange, height = 100, typedDefault = '', placeholder = 'Type your full name', mode: modeProp }) {
  const [mode, setMode] = useState(modeProp || (value && !value.startsWith('data:') ? 'type' : 'draw'));
  const [typed, setTyped] = useState(value && !value.startsWith('data:') ? value : typedDefault);

  useEffect(() => {
    if (mode === 'type' && typed) onChange(typed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <div style={{
      border: '1px solid var(--border-strong)', borderRadius: 10,
      background: 'var(--surface-2)', overflow: 'hidden',
    }}>
      <div role="tablist" style={{
        display: 'flex', gap: 4, padding: 4, background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
      }}>
        {[
          { id: 'draw', label: 'Draw' },
          { id: 'type', label: 'Type' },
        ].map((m) => (
          <button key={m.id} onClick={() => setMode(m.id)} type="button" role="tab" aria-selected={mode === m.id}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 0, fontSize: 12.5, fontWeight: 600,
              cursor: 'pointer', minHeight: 32,
              background: mode === m.id ? 'var(--accent-soft)' : 'transparent',
              color: mode === m.id ? 'var(--accent)' : 'var(--muted)',
            }}>{m.label}</button>
        ))}
      </div>
      {mode === 'draw'
        ? <DrawPad value={value} onChange={onChange} height={height}/>
        : <TypePad value={typed} placeholder={placeholder} onChange={(v) => { setTyped(v); onChange(v); }} height={height}/>}
    </div>
  );
}

function DrawPad({ value, onChange, height }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  const inkRef = useRef(false);
  const [empty, setEmpty] = useState(!value || !value.startsWith('data:'));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#141414';
    if (value && value.startsWith('data:')) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = value;
      setEmpty(false);
      inkRef.current = true;
    } else {
      setEmpty(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const at = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const start = (e) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    drawingRef.current = true;
    lastRef.current = at(e);
    const ctx = canvasRef.current.getContext('2d');
    ctx.beginPath();
    ctx.arc(lastRef.current.x, lastRef.current.y, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = '#141414';
    ctx.fill();
  };
  const move = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = at(e);
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    inkRef.current = true;
    setEmpty(false);
  };
  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (inkRef.current) onChange(trimmedPng(canvasRef.current));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
    inkRef.current = false;
    setEmpty(true);
    onChange('');
  };

  return (
    <div style={{ position: 'relative' }}>
      <canvas
        ref={canvasRef}
        data-signature-canvas
        aria-label="Draw your signature"
        style={{ width: '100%', height, display: 'block', cursor: 'crosshair', background: '#fff', touchAction: 'none' }}
        onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      />
      <div style={{ position: 'absolute', left: 16, right: 16, bottom: height * 0.22, borderBottom: '1px solid #D8D8D8', pointerEvents: 'none' }}/>
      {empty && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#A0A0A0', fontSize: 13, pointerEvents: 'none',
        }}>Sign here with your finger or mouse</div>
      )}
      <button type="button" onClick={clear} style={{
        position: 'absolute', right: 8, top: 8, fontSize: 11.5, color: '#555',
        background: 'rgba(255,255,255,0.9)', border: '1px solid var(--border)',
        borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
      }}>Clear</button>
    </div>
  );
}

function TypePad({ value, onChange, height, placeholder }) {
  return (
    <div style={{ position: 'relative', background: '#fff' }}>
      <input value={value} onChange={(e) => onChange(e.target.value.slice(0, 80))}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{
          width: '100%', height, padding: '0 16px',
          border: 0, outline: 'none', background: 'transparent',
          fontFamily: SIGNATURE_FONT,
          fontSize: 32, color: '#141414',
        }}/>
    </div>
  );
}

export const SIGNATURE_FONT = '"Snell Roundhand", "Segoe Script", "Brush Script MT", "Apple Chancery", cursive';

// Crop the drawing to its ink (plus a margin) so it fills the box on the
// PDF instead of sitting small in a wide empty canvas.
function trimmedPng(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (data[(y * width + x) * 4 + 3] > 16) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return canvas.toDataURL('image/png');
    const pad = Math.round(Math.max(width, height) * 0.02) + 4;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(width, maxX + pad); maxY = Math.min(height, maxY + pad);
    const out = document.createElement('canvas');
    out.width = maxX - minX; out.height = maxY - minY;
    out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  } catch {
    return canvas.toDataURL('image/png');
  }
}

// Typed name → PNG in a handwriting-style font, trimmed to the text.
export function typedToPng(text, { initials = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return '';
  try {
    const size = 96;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = `${initials ? '600 ' : ''}${size}px ${SIGNATURE_FONT}`;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(t).width) + size * 0.6;
    c.width = Math.min(2400, Math.max(64, w));
    c.height = Math.round(size * 1.6);
    ctx.font = font;
    ctx.fillStyle = '#141414';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, size * 0.3, c.height / 2);
    return trimmedPng(c);
  } catch {
    return '';
  }
}
