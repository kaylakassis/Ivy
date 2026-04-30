// Signature capture: simple canvas drawing or typed name with cursive font.
import React, { useRef, useState, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';

export default function SignaturePad({ value, onChange, height = 100 }) {
  const [mode, setMode] = useState(value?.startsWith('data:') ? 'draw' : (value ? 'type' : 'draw'));
  const [typed, setTyped] = useState(mode === 'type' ? (value || '') : '');

  return (
    <div style={{
      border: '1px solid var(--border-strong)', borderRadius: 10,
      background: 'var(--surface-2)', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', gap: 4, padding: 4, background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
      }}>
        {[
          { id: 'draw', label: 'Draw' },
          { id: 'type', label: 'Type' },
        ].map((m) => (
          <button key={m.id} onClick={() => setMode(m.id)} type="button"
            style={{
              padding: '4px 12px', borderRadius: 6, border: 0, fontSize: 12, fontWeight: 550,
              cursor: 'pointer',
              background: mode === m.id ? 'var(--accent-soft)' : 'transparent',
              color: mode === m.id ? 'var(--accent)' : 'var(--muted)',
            }}>{m.label}</button>
        ))}
      </div>
      {mode === 'draw'
        ? <DrawPad value={value} onChange={onChange} height={height}/>
        : <TypePad value={typed} onChange={(v) => { setTyped(v); onChange(v); }} height={height}/>}
    </div>
  );
}

function DrawPad({ value, onChange, height }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  const [empty, setEmpty] = useState(!value || !value.startsWith('data:'));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Set canvas size from CSS dimensions and a high-DPR resolution.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#141414';

    // If we already have a saved data URL, draw it back in.
    if (value && value.startsWith('data:')) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = value;
      setEmpty(false);
    } else {
      setEmpty(true);
    }
  }, []);  // run once

  const at = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const t = e.touches?.[0];
    return {
      x: (t ? t.clientX : e.clientX) - rect.left,
      y: (t ? t.clientY : e.clientY) - rect.top,
    };
  };

  const start = (e) => {
    e.preventDefault();
    drawingRef.current = true;
    lastRef.current = at(e);
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
    setEmpty(false);
  };
  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onChange(canvasRef.current.toDataURL('image/png'));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
    onChange('');
  };

  return (
    <div style={{ position: 'relative' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height, display: 'block', cursor: 'crosshair', background: '#fff' }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      {empty && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#A0A0A0', fontSize: 13, pointerEvents: 'none',
        }}>Sign here</div>
      )}
      <button type="button" onClick={clear} style={{
        position: 'absolute', right: 8, top: 8, fontSize: 11, color: 'var(--muted)',
        background: 'rgba(255,255,255,0.85)', border: '1px solid var(--border)',
        borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
      }}>Clear</button>
    </div>
  );
}

function TypePad({ value, onChange, height }) {
  return (
    <div style={{ position: 'relative', background: '#fff' }}>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="Type your full name"
        style={{
          width: '100%', height, padding: '0 16px',
          border: 0, outline: 'none', background: 'transparent',
          fontFamily: '"Snell Roundhand", "Brush Script MT", cursive',
          fontSize: 32, color: '#141414',
        }}/>
    </div>
  );
}
