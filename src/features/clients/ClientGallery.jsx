// Per-client photo gallery — only rendered for active clients (lead
// stage doesn't get one per the product spec). Owners upload via file
// picker or camera capture, see thumbnails in a grid, and can click
// any thumbnail to open a full-screen lightbox with prev / next nav,
// captions, and per-photo delete.
//
// Storage: each photo lives in Vercel Blob (uploaded via
// /api/clients/photo-token) and a metadata row lands in
// clients.gallery_photos JSONB on PATCH /api/clients/<id>.
//
// Why a separate gallery instead of folding photos into the existing
// `attachments` array:
//   1. Different visual treatment — gallery wants thumbnails + lightbox,
//      attachments are utility (signed PDFs, intake scans).
//   2. Different metadata — captions + takenAt are gallery-specific.
//   3. Per-stage gating — leads see attachments but not the gallery.
//   4. Clean separation makes future moves (timeline view, before/after
//      pairs, client-portal share toggles) straightforward to layer on.
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { upload } from '@vercel/blob/client';
import { processImageForUpload } from '../../lib/imagePipeline.js';
import { Icons } from '../../components/Icons.jsx';

export default function ClientGallery({ client, onSave }) {
  const photos = Array.isArray(client.galleryPhotos) ? client.galleryPhotos : [];
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const [lightboxIdx, setLightboxIdx] = useState(null);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  // Same UA detection the service photo uploader uses — Take Photo only
  // makes sense on a device with a real camera.
  const isMobile = typeof navigator !== 'undefined'
    && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);

  const startUpload = async (files) => {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    setErr(null);
    setUploading(true);
    try {
      const additions = [];
      for (const rawFile of list) {
        if (!rawFile.type.startsWith('image/')) {
          throw new Error(`${rawFile.name || 'File'} is not an image`);
        }
        if (rawFile.size > 16 * 1024 * 1024) {
          // Raise the raw cap to 16 MB — modern phones routinely
          // produce 8-12 MB photos. processImageForUpload below
          // resizes + strips EXIF so the actual upload is far smaller.
          throw new Error(`${rawFile.name || 'File'} is over 16 MB`);
        }
        // eslint-disable-next-line no-await-in-loop
        const file = await processImageForUpload(rawFile);
        const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
        const path = `clients/gallery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        // eslint-disable-next-line no-await-in-loop
        const blob = await upload(path, file, {
          access: 'public',
          handleUploadUrl: '/api/clients/photo-token',
          contentType: file.type || 'image/jpeg',
        });
        additions.push({
          id: crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random()}`,
          url: blob.url,
          blobPathname: blob.pathname || null,
          caption: null,
          // EXIF parsing is heavy + spotty across browsers; we use the
          // file's lastModified as a coarse "when was this taken"
          // proxy. Owners can edit the caption to add a date if
          // they care about the exact moment.
          takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
          uploadedAt: new Date().toISOString(),
        });
      }
      // Single PATCH with the appended array — never send a partial.
      await onSave({ galleryPhotos: [...photos, ...additions] });
    } catch (e) {
      setErr(e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = useCallback(async (id) => {
    if (!confirm('Remove this photo?')) return;
    const next = photos.filter((p) => p.id !== id);
    await onSave({ galleryPhotos: next });
    setLightboxIdx(null);
  }, [photos, onSave]);

  const updateCaption = useCallback(async (id, caption) => {
    const next = photos.map((p) => p.id === id ? { ...p, caption } : p);
    await onSave({ galleryPhotos: next });
  }, [photos, onSave]);

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <Section label={`Photos${photos.length > 0 ? ` · ${photos.length}` : ''}`}/>
        <div style={{ display: 'flex', gap: 6 }}>
          <input ref={fileRef} type="file" accept="image/*" multiple
            onChange={(e) => { startUpload(e.target.files); e.target.value = ''; }}
            style={{ display: 'none' }}/>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment"
            onChange={(e) => { startUpload(e.target.files); e.target.value = ''; }}
            style={{ display: 'none' }}/>
          <button type="button" disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="btn btn-outline" style={{ fontSize: 11.5, padding: '5px 10px' }}>
            <Icons.Image size={12}/> Add
          </button>
          {isMobile && (
            <button type="button" disabled={uploading}
              onClick={() => cameraRef.current?.click()}
              className="btn btn-outline" style={{ fontSize: 11.5, padding: '5px 10px' }}>
              <Icons.Camera size={12}/> Take
            </button>
          )}
        </div>
      </div>

      {err && (
        <div style={{
          marginBottom: 8, padding: '6px 10px', borderRadius: 8, fontSize: 11.5,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)',
        }}>{err}</div>
      )}

      {photos.length === 0 ? (
        <div style={{
          padding: '20px 12px', textAlign: 'center',
          border: '1px dashed var(--border-strong)', borderRadius: 12,
          background: 'var(--surface-2)',
          fontSize: 12, color: 'var(--muted)', lineHeight: 1.55,
        }}>
          {uploading ? 'Uploading…' : (
            <>No photos yet. Great for before / after, transformations,<br/>or anything you want to track over time.</>
          )}
        </div>
      ) : (
        <div style={{
          display: 'grid', gap: 6,
          gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
        }}>
          {photos.map((p, i) => (
            <button key={p.id || p.url} type="button"
              onClick={() => setLightboxIdx(i)}
              aria-label={`Photo ${i + 1} of ${photos.length}`}
              style={{
                position: 'relative',
                aspectRatio: '1 / 1',
                border: '1px solid var(--border)',
                borderRadius: 10, overflow: 'hidden',
                background: `url(${p.url}) center/cover, var(--surface-2)`,
                cursor: 'zoom-in', padding: 0,
              }}/>
          ))}
          {uploading && (
            <div style={{
              aspectRatio: '1 / 1',
              borderRadius: 10,
              background: 'var(--surface-2)',
              border: '1px dashed var(--border-strong)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, color: 'var(--muted)',
            }}>Uploading…</div>
          )}
        </div>
      )}

      {lightboxIdx != null && photos[lightboxIdx] && (
        <Lightbox
          photos={photos}
          startIdx={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onCaption={updateCaption}
          onDelete={removePhoto}
        />
      )}
    </div>
  );
}

// Full-screen lightbox with keyboard nav, inline-editable caption,
// and a delete affordance. Renders into document.body via portal so
// it escapes the drawer's transform stacking context.
function Lightbox({ photos, startIdx, onClose, onCaption, onDelete }) {
  const [idx, setIdx] = useState(startIdx);
  const photo = photos[idx];
  const [captionDraft, setCaptionDraft] = useState(photo?.caption || '');
  const [editingCaption, setEditingCaption] = useState(false);

  useEffect(() => { setCaptionDraft(photo?.caption || ''); setEditingCaption(false); }, [photo]);
  useEffect(() => {
    const onKey = (e) => {
      if (editingCaption) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setIdx((n) => (n + 1) % photos.length);
      else if (e.key === 'ArrowLeft')  setIdx((n) => (n - 1 + photos.length) % photos.length);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [photos.length, onClose, editingCaption]);

  if (!photo) return null;

  const saveCaption = async () => {
    const next = captionDraft.trim() || null;
    if (next !== (photo.caption || null)) await onCaption(photo.id, next);
    setEditingCaption(false);
  };

  return createPortal(
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 250,
      background: 'rgba(0,0,0,0.92)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Top bar */}
      <div onClick={(e) => e.stopPropagation()} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px', color: '#fff', fontSize: 12.5,
      }}>
        <div style={{ opacity: 0.8 }}>
          {idx + 1} / {photos.length}
          {photo.takenAt && (
            <span style={{ marginLeft: 12, opacity: 0.7 }}>
              {new Date(photo.takenAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <a href={photo.url} target="_blank" rel="noreferrer"
            style={{
              padding: '6px 10px', borderRadius: 8,
              background: 'rgba(255,255,255,0.1)', color: '#fff',
              fontSize: 12, textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
            <Icons.Arrow size={12}/> Open
          </a>
          <button onClick={() => onDelete(photo.id)}
            style={{
              padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: 'rgba(255,255,255,0.1)', color: '#FF8B8B',
              fontSize: 12,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
            <Icons.Trash size={12}/> Delete
          </button>
          <button onClick={onClose} aria-label="Close"
            style={{
              width: 32, height: 32, borderRadius: 999, border: 'none', cursor: 'pointer',
              background: 'rgba(255,255,255,0.1)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <Icons.X size={14}/>
          </button>
        </div>
      </div>

      {/* Photo + nav arrows */}
      <div onClick={(e) => e.stopPropagation()} style={{
        flex: 1, position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
      }}>
        {photos.length > 1 && (
          <button onClick={() => setIdx((n) => (n - 1 + photos.length) % photos.length)}
            aria-label="Previous"
            style={{
              position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
              width: 40, height: 40, borderRadius: 999, border: 'none', cursor: 'pointer',
              background: 'rgba(255,255,255,0.12)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            ‹
          </button>
        )}
        <img src={photo.url} alt={photo.caption || ''}
          style={{
            maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
            borderRadius: 8,
          }}/>
        {photos.length > 1 && (
          <button onClick={() => setIdx((n) => (n + 1) % photos.length)}
            aria-label="Next"
            style={{
              position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
              width: 40, height: 40, borderRadius: 999, border: 'none', cursor: 'pointer',
              background: 'rgba(255,255,255,0.12)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            ›
          </button>
        )}
      </div>

      {/* Caption — click to edit. */}
      <div onClick={(e) => e.stopPropagation()} style={{
        padding: '14px 18px', color: '#fff', fontSize: 13.5,
        textAlign: 'center', minHeight: 50,
      }}>
        {editingCaption ? (
          <input
            value={captionDraft}
            autoFocus
            onChange={(e) => setCaptionDraft(e.target.value)}
            onBlur={saveCaption}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveCaption();
              if (e.key === 'Escape') { setCaptionDraft(photo.caption || ''); setEditingCaption(false); }
            }}
            placeholder="Add a caption…"
            maxLength={280}
            style={{
              width: '100%', maxWidth: 600,
              padding: '8px 12px', borderRadius: 10,
              background: 'rgba(255,255,255,0.1)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.2)',
              fontSize: 13.5, fontFamily: 'inherit', outline: 'none',
            }}/>
        ) : (
          <button onClick={() => setEditingCaption(true)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: photo.caption ? '#fff' : 'rgba(255,255,255,0.6)',
              fontSize: 13.5, fontFamily: 'inherit', textAlign: 'center',
              padding: '4px 8px', borderRadius: 6,
            }}>
            {photo.caption || 'Add a caption…'}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

// Local mirror of the drawer's section heading style — keeps this
// component self-contained so it can move later without dragging
// styles from ClientDrawer.
function Section({ label }) {
  return (
    <div className="metric-label" style={{ marginBottom: 0 }}>
      {label}
    </div>
  );
}
