// QR code generator - owners pop this open to grab a printable QR for
// any URL (booking link, website, etc.). Renders an SVG via the
// existing `qrcode` dependency we already bundle, with three export
// options:
//
//   • Download SVG  - vector, scales to billboard size
//   • Download PNG  - 1024×1024 raster for print/social
//   • Copy link     - plain URL to clipboard, no QR involved
//
// Lazy-imports qrcode so the lib only ships to the browser when an
// owner actually opens the modal.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './Icons.jsx';

export default function QRCodeModal({ url, label, sublabel, onClose }) {
  const [svg, setSvg] = useState(null);
  const [pngUrl, setPngUrl] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);

  // Render the QR. SVG is the source of truth; we rasterize it to PNG
  // off-screen via a canvas the first time the user wants the PNG.
  useEffect(() => {
    let live = true;
    setSvg(null);
    setPngUrl(null);
    setErr(null);
    if (!url) return;
    (async () => {
      try {
        const { default: QRCode } = await import('qrcode');
        const svgString = await QRCode.toString(url, {
          type: 'svg',
          margin: 1,
          width: 320,
          color: { dark: '#0D0E0C', light: '#FFFFFF' },
          errorCorrectionLevel: 'M',
        });
        if (!live) return;
        setSvg(svgString);
      } catch (e) {
        if (live) setErr(e.message || 'Could not generate QR');
      }
    })();
    return () => { live = false; };
  }, [url]);

  // Lock body scroll while open + close on Esc.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const downloadSvg = () => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${slugify(label || 'ivy-qr')}.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  // Off-screen SVG → canvas → PNG. We re-render the QR at 1024px for
  // print quality. Only fires the first time the user clicks Download
  // PNG; subsequent clicks reuse the cached blob URL.
  const downloadPng = async () => {
    try {
      let data = pngUrl;
      if (!data) {
        const { default: QRCode } = await import('qrcode');
        const canvas = document.createElement('canvas');
        await QRCode.toCanvas(canvas, url, {
          width: 1024,
          margin: 2,
          color: { dark: '#0D0E0C', light: '#FFFFFF' },
          errorCorrectionLevel: 'M',
        });
        data = canvas.toDataURL('image/png');
        setPngUrl(data);
      }
      const link = document.createElement('a');
      link.href = data;
      link.download = `${slugify(label || 'ivy-qr')}.png`;
      link.click();
    } catch (e) {
      setErr(e.message || 'Could not export PNG');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked - owner can long-press to copy manually */
    }
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(0,0,0,.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, overflowY: 'auto',
      }}
    >
      <div onClick={(e) => e.stopPropagation()} className="card scroll" style={{
        width: '100%', maxWidth: 460,
        maxHeight: '90vh', overflowY: 'auto',
        padding: 22, position: 'relative',
      }}>
        <button onClick={onClose} aria-label="Close"
          style={{
            position: 'absolute', top: 14, right: 14,
            width: 28, height: 28, borderRadius: 999,
            border: 'none', cursor: 'pointer',
            background: 'var(--surface-2)', color: 'var(--muted)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <Icons.X size={14}/>
        </button>

        <div style={{ marginBottom: 12 }}>
          <h3 style={{
            margin: 0, fontSize: 16, fontWeight: 600,
          }}>{label || 'QR code'}</h3>
          {sublabel && (
            <div style={{
              fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5,
            }}>{sublabel}</div>
          )}
        </div>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
            border: '1px solid var(--danger)',
            color: 'var(--danger)', fontSize: 12, marginBottom: 12,
          }}>{err}</div>
        )}

        {/* QR - white background regardless of theme so cameras read
            cleanly when downloaded/printed. */}
        <div style={{
          display: 'flex', justifyContent: 'center',
          padding: 16, marginBottom: 14,
          background: '#FFFFFF', borderRadius: 14,
          border: '1px solid var(--border)',
        }}>
          {svg ? (
            <div style={{ width: 280, height: 280 }}
              dangerouslySetInnerHTML={{ __html: svg }}/>
          ) : (
            <div style={{
              width: 280, height: 280,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#999', fontSize: 12,
            }}>Generating…</div>
          )}
        </div>

        {url && (
          <div style={{
            padding: '8px 12px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            fontSize: 11.5, color: 'var(--fg-2)',
            wordBreak: 'break-all',
            fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            marginBottom: 12,
          }}>{url}</div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button className="btn btn-outline" onClick={downloadPng} disabled={!svg}>
            <Icons.Image size={13}/> Download PNG
          </button>
          <button className="btn btn-outline" onClick={downloadSvg} disabled={!svg}>
            <Icons.Doc size={13}/> Download SVG
          </button>
        </div>
        <button className="btn btn-ghost" onClick={copy}
          style={{
            display: 'flex', justifyContent: 'center', width: '100%',
            marginTop: 8,
          }}>
          <Icons.Copy size={13}/> {copied ? 'Copied!' : 'Copy link'}
        </button>

        <div style={{
          marginTop: 14, fontSize: 11, color: 'var(--muted)', lineHeight: 1.55,
        }}>
          Print the SVG on a sign, slip the PNG into a story, or screenshot
          this screen. Anyone who scans lands on the URL above.
        </div>
      </div>
    </div>,
    document.body,
  );
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'ivy-qr';
}
