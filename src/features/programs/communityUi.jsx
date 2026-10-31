// Small shared pieces for the program community, live sessions and the
// member directory: avatar, relative time, a bottom sheet and a photo
// lightbox. Sheets and the lightbox render through a portal, so their roots
// stop click propagation (React bubbles portal events to the parent tree).
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../components/Icons.jsx';
import { uploadFile } from '../../lib/blobUpload.js';

export const ago = (iso) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

export function Avatar({ name, url, size = 34 }) {
  const [broken, setBroken] = useState(false);
  const src = !broken ? httpsOnly(url) : null;
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, overflow: 'hidden', background: 'var(--accent-soft)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.38), fontWeight: 700 }}>
      {src ? <img src={src} alt="" onError={() => setBroken(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }}/> : initials(name)}
    </span>
  );
}

export function Sheet({ title, onClose, children, width = 520 }) {
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: width, maxHeight: '92vh', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, fontSize: 18, fontWeight: 600 }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ padding: 6, color: 'var(--muted)', display: 'inline-flex' }}><Icons.X size={18}/></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, children, hint }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-2)' }}>{label}</span>{children}{hint && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>}</label>;
}

export function Lightbox({ images, index, onClose }) {
  const [i, setI] = useState(index || 0);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') setI((x) => Math.min(images.length - 1, x + 1)); if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1)); };
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k);
  }, [images.length, onClose]);
  const src = httpsOnly(images[i]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Photo" onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 140, background: 'rgba(0,0,0,.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(16px, env(safe-area-inset-top)) 12px max(16px, env(safe-area-inset-bottom))' }}>
      {src && <img src={src} alt="" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }}/>}
      <button type="button" aria-label="Close" onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: 'absolute', top: 'max(12px, env(safe-area-inset-top))', right: 12, padding: 10, color: '#fff', display: 'inline-flex' }}><Icons.X size={22}/></button>
      {images.length > 1 && (
        <>
          <button type="button" aria-label="Previous photo" disabled={i === 0} onClick={(e) => { e.stopPropagation(); setI(i - 1); }} style={{ position: 'absolute', left: 6, top: '50%', padding: 12, color: '#fff', opacity: i === 0 ? 0.3 : 1 }}><Icons.ArrowLeft size={22}/></button>
          <button type="button" aria-label="Next photo" disabled={i === images.length - 1} onClick={(e) => { e.stopPropagation(); setI(i + 1); }} style={{ position: 'absolute', right: 6, top: '50%', padding: 12, color: '#fff', opacity: i === images.length - 1 ? 0.3 : 1 }}><Icons.Arrow size={22}/></button>
          <div style={{ position: 'absolute', bottom: 'max(14px, env(safe-area-inset-bottom))', left: 0, right: 0, textAlign: 'center', color: '#fff', fontSize: 13 }}>{i + 1} / {images.length}</div>
        </>
      )}
    </div>,
    document.body,
  );
}

// Grid of up to 6 photos; tap one to enlarge.
export function ImageGrid({ images }) {
  const [open, setOpen] = useState(null);
  const list = (images || []).map(httpsOnly).filter(Boolean);
  if (!list.length) return null;
  const single = list.length === 1;
  const cols = list.length === 2 || list.length === 4 ? 2 : 3;
  return (
    <>
      <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: single ? '1fr' : `repeat(${cols}, 1fr)`, gap: 4, borderRadius: 12, overflow: 'hidden' }}>
        {list.map((u, i) => (
          <button key={u} type="button" onClick={() => setOpen(i)} aria-label={`Open photo ${i + 1}`} style={{ padding: 0, display: 'block', background: 'var(--surface-2)', aspectRatio: single ? 'auto' : '1 / 1', overflow: 'hidden' }}>
            <img src={u} alt="" loading="lazy" style={{ width: '100%', height: single ? 'auto' : '100%', maxHeight: single ? 380 : undefined, objectFit: 'cover', display: 'block' }}/>
          </button>
        ))}
      </div>
      {open != null && <Lightbox images={list} index={open} onClose={() => setOpen(null)}/>}
    </>
  );
}

export const IMAGE_TYPES = 'image/jpeg,image/png,image/webp';

// Uploads one picked photo through the program upload route. Returns the
// stored https URL; the server re-checks it before saving anything.
export async function uploadProgramImage(file) {
  if (!file) throw new Error('No file picked.');
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a JPG, PNG or WebP photo.');
  if (file.size > 25 * 1024 * 1024) throw new Error('That photo is over 25 MB.');
  const safeName = String(file.name || 'photo').replace(/[^A-Za-z0-9._-]+/g, '-').slice(-60);
  const blob = await uploadFile(`programs/community/${Date.now()}-${safeName}`, file, { access: 'public', handleUploadUrl: '/api/programs/upload-token', contentType: file.type });
  return blob.url;
}

export function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }}/>
      <span><span style={{ display: 'block' }}>{label}</span>{hint && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{hint}</span>}</span>
    </label>
  );
}
