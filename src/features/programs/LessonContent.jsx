// The body of one lesson, shared by the member lesson view, the owner's
// preview and the sales page's free previews: video (YouTube / Vimeo /
// Loom embed or an uploaded file), audio, PDF, the written part, an image
// gallery with a tap-to-enlarge viewer, and downloadable attachments.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../components/Icons.jsx';
import { MiniMarkdown } from '../../lib/miniMarkdown.jsx';
import { safeHref } from '../../lib/safeHref.js';
import { fmtSize } from './courseUi.jsx';

// Only embed players from the three hosts the API builds URLs for.
const EMBED_RE = /^https:\/\/(www\.youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/|www\.loom\.com\/embed\/)/;
const embedFor = (item) => {
  if (item.videoEmbedUrl && EMBED_RE.test(item.videoEmbedUrl)) return item.videoEmbedUrl;
  if (item.youtubeId && /^[A-Za-z0-9_-]{11}$/.test(item.youtubeId)) return `https://www.youtube-nocookie.com/embed/${item.youtubeId}?rel=0&modestbranding=1&playsinline=1`;
  return null;
};
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

export default function LessonContent({ item, onWatched }) {
  const embed = item.type === 'video' ? embedFor(item) : null;
  const media = httpsOnly(item.mediaUrl);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {item.type === 'video' && embed && (
        <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
          <iframe title={item.title} src={embed} referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}/>
        </div>
      )}
      {item.type === 'video' && !embed && media && <UploadedVideo src={media} onWatched={onWatched}/>}
      {item.type === 'audio' && media && (
        <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {item.mediaName && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{item.mediaName}</div>}
          <audio controls preload="metadata" src={media} style={{ width: '100%' }}/>
        </div>
      )}
      {item.type === 'pdf' && httpsOnly(item.fileUrl) && (
        <div>
          <iframe title={item.title} src={item.fileUrl} style={{ width: '100%', height: '70vh', border: '1px solid var(--border)', borderRadius: 12, background: 'white' }}/>
          <a href={safeHref(item.fileUrl)} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ marginTop: 10 }}><Icons.Doc size={13}/> Open PDF</a>
        </div>
      )}
      {item.body && (
        <div style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--fg)', overflowWrap: 'anywhere' }}><MiniMarkdown text={item.body}/></div>
      )}
      {item.images?.length > 0 && <Gallery images={item.images}/>}
      {item.attachments?.length > 0 && (
        <div className="card" style={{ padding: 4 }}>
          <div style={{ padding: '10px 14px 4px', fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Downloads</div>
          {item.attachments.map((a) => (
            <a key={a.url} href={safeHref(httpsOnly(a.url) || '#')} target="_blank" rel="noreferrer" download={a.name}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--border)', color: 'var(--fg)', textDecoration: 'none' }}>
              <Icons.Paperclip size={15} stroke="var(--accent)"/>
              <span style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              {a.size ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtSize(a.size)}</span> : null}
              <Icons.ArrowDown size={14} stroke="var(--muted)"/>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// Native player. Reports once when 90% has played (best effort; used to
// mark the lesson complete).
function UploadedVideo({ src, onWatched }) {
  const fired = useRef(false);
  useEffect(() => { fired.current = false; }, [src]);
  const onTime = (e) => {
    const v = e.currentTarget;
    if (!fired.current && onWatched && v.duration && v.currentTime / v.duration >= 0.9) { fired.current = true; onWatched(); }
  };
  return (
    <video controls playsInline preload="metadata" src={src} onTimeUpdate={onTime}
      style={{ width: '100%', borderRadius: 12, background: '#000', maxHeight: '70vh' }}/>
  );
}

function Gallery({ images }) {
  const [open, setOpen] = useState(null);
  const safe = images.filter((i) => httpsOnly(i.url));
  const cols = safe.length === 1 ? '1fr' : 'repeat(auto-fill, minmax(140px, 1fr))';
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8 }}>
        {safe.map((img, i) => (
          <button key={img.url} type="button" onClick={() => setOpen(i)} aria-label={`Enlarge ${img.name || 'image'}`}
            style={{ padding: 0, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--surface-2)', aspectRatio: safe.length === 1 ? 'auto' : '1 / 1' }}>
            <img src={img.url} alt={img.name || ''} loading="lazy" style={{ width: '100%', height: '100%', objectFit: safe.length === 1 ? 'contain' : 'cover', display: 'block', maxHeight: safe.length === 1 ? 480 : undefined }}/>
          </button>
        ))}
      </div>
      {open != null && <Lightbox images={safe} index={open} onIndex={setOpen} onClose={() => setOpen(null)}/>}
    </>
  );
}

function Lightbox({ images, index, onIndex, onClose }) {
  const go = (d) => onIndex((index + d + images.length) % images.length);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k);
  });
  const img = images[index];
  const btn = { position: 'absolute', top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: 999, background: 'rgba(0,0,0,.55)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
  return createPortal(
    // The viewer renders through a portal: stop clicks here so they never
    // reach a sheet or card underneath in the React tree.
    <div role="dialog" aria-modal="true" aria-label="Image viewer" onClick={(e) => { e.stopPropagation(); onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))' }}>
      <img src={img.url} alt={img.name || ''} onClick={(e) => e.stopPropagation()} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }}/>
      <button type="button" aria-label="Close" onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ ...btn, top: 'max(16px, env(safe-area-inset-top))', right: 16, transform: 'none' }}><Icons.X size={20} stroke="#fff"/></button>
      {images.length > 1 && <>
        <button type="button" aria-label="Previous image" onClick={(e) => { e.stopPropagation(); go(-1); }} style={{ ...btn, left: 12 }}><Icons.ArrowLeft size={20} stroke="#fff"/></button>
        <button type="button" aria-label="Next image" onClick={(e) => { e.stopPropagation(); go(1); }} style={{ ...btn, right: 12 }}><Icons.Arrow size={20} stroke="#fff"/></button>
        <div style={{ position: 'absolute', bottom: 'max(16px, env(safe-area-inset-bottom))', left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,.8)', fontSize: 13 }}>{index + 1} / {images.length}</div>
      </>}
    </div>,
    document.body,
  );
}
