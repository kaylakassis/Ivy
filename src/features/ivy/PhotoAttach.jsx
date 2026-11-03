// The photo button in Ivy's message box, plus the row of thumbnails that
// will go with the next message. On a phone the system sheet offers "Take
// Photo" and the photo library; "Take a photo" also opens the camera
// straight away. Photos are shrunk on the device (src/lib/ivyImage.js).
import React, { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { preparePhotosForIvy, MAX_PHOTOS } from '../../lib/ivyImage.js';

// usePhotoAttach() → { photos, pieces, busy, errors, add, remove, clear }
export function usePhotoAttach() {
  const [items, setItems] = useState([]); // { id, name, url, pieces }
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);

  const add = async (fileList) => {
    const files = Array.from(fileList || []).slice(0, Math.max(0, MAX_PHOTOS - items.length) || 0);
    const over = Array.from(fileList || []).length > files.length;
    if (!files.length) { setErrors([`Up to ${MAX_PHOTOS} photos per message.`]); return; }
    setBusy(true); setErrors([]);
    try {
      const prepared = [];
      const errs = over ? [`Up to ${MAX_PHOTOS} photos per message.`] : [];
      for (const f of files) {
        // eslint-disable-next-line no-await-in-loop
        const r = await preparePhotosForIvy([f]);
        errs.push(...r.errors);
        // Thumbnail from the small shrunk copy: instant, light on phone memory.
        if (r.pieces.length) prepared.push({ id: `${Date.now()}-${Math.random()}`, name: f.name || 'photo', url: `data:${r.pieces[0].mediaType};base64,${r.pieces[0].base64}`, pieces: r.pieces });
      }
      setItems((xs) => [...xs, ...prepared]);
      setErrors(errs);
    } finally { setBusy(false); }
  };
  const remove = (id) => setItems((xs) => xs.filter((x) => x.id !== id));
  const clear = () => { setItems([]); setErrors([]); };
  return { photos: items, pieces: items.flatMap((i) => i.pieces), busy, errors, add, remove, clear };
}

// openSignal: bump it (any new truthy value) to open the menu from outside,
// e.g. when Ivy is opened from "Send Ivy a screenshot" on the import hub.
// The file pickers still open from the owner's own tap on a menu item, which
// is what phone browsers require.
export function PhotoButton({ attach, disabled, size = 34, openSignal }) {
  const pickRef = useRef(null);
  const camRef = useRef(null);
  const [menu, setMenu] = useState(false);
  useEffect(() => { if (openSignal) setMenu(true); }, [openSignal]);
  useEffect(() => {
    if (!menu) return undefined;
    const k = (e) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [menu]);
  const full = attach.photos.length >= MAX_PHOTOS;
  return (
    <div style={{ position: 'relative', flex: '0 0 auto' }}>
      <button type="button" aria-label="Add photos" title="Add photos or take a photo"
        disabled={disabled || attach.busy || full}
        onClick={() => setMenu((m) => !m)}
        style={{
          width: size, height: size, borderRadius: 999, border: 'none',
          background: 'transparent', color: 'var(--muted)', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', cursor: disabled || full ? 'default' : 'pointer',
          opacity: disabled || full ? 0.5 : 1,
        }}>
        {attach.busy ? <span style={{ fontSize: 11 }}>…</span> : <Icons.Camera size={18}/>}
      </button>
      {menu && (
        <>
          <div onClick={() => setMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }}/>
          <div role="menu" className="card" onClick={(e) => e.stopPropagation()}
            style={{ position: 'absolute', bottom: size + 8, right: 0, zIndex: 41, padding: 6, minWidth: 190, display: 'flex', flexDirection: 'column', gap: 2, boxShadow: '0 12px 30px rgba(0,0,0,.25)' }}>
            <MenuItem icon="Camera" label="Take a photo" onClick={() => { setMenu(false); camRef.current?.click(); }}/>
            <MenuItem icon="Image" label="Choose photos" onClick={() => { setMenu(false); pickRef.current?.click(); }}/>
          </div>
        </>
      )}
      <input ref={pickRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) attach.add(f); }}/>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) attach.add(f); }}/>
    </div>
  );
}

function MenuItem({ icon, label, onClick }) {
  const I = Icons[icon] || Icons.Image;
  return (
    <button type="button" role="menuitem" onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, fontSize: 14, textAlign: 'left', color: 'var(--fg)', background: 'transparent' }}>
      <I size={16}/> {label}
    </button>
  );
}

export function PhotoTray({ attach }) {
  if (!attach.photos.length && !attach.errors.length && !attach.busy) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
      {attach.photos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {attach.photos.map((p) => (
            <div key={p.id} style={{ position: 'relative', width: 58, height: 58, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border-strong)' }}>
              <img src={p.url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top', background: '#fff' }}/>
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => attach.remove(p.id)}
                style={{ position: 'absolute', top: 3, right: 3, width: 20, height: 20, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.6)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icons.X size={11} sw={2.4}/>
              </button>
            </div>
          ))}
        </div>
      )}
      {attach.busy && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Getting your photo ready…</div>}
      {attach.errors.map((e) => <div key={e} style={{ fontSize: 12, color: 'var(--danger)' }}>{e}</div>)}
    </div>
  );
}
