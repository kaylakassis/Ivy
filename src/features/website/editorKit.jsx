// Shared building blocks for the website Inspector's section editors:
// labelled fields, text inputs, toggles, pill pickers, a list editor with
// Add / Remove / up / down, image upload, and a link picker that offers
// the site's own pages, the booking page and "a web address" so owners
// never type an address by hand unless they want to.
//
// Everything here is plain language. No section editor should ever show
// raw data, code, or jargon like "slug" or "embed".
import React, { createContext, useContext, useState } from 'react';
import { uploadFile as upload } from '../../lib/blobUpload.js';
import { Icons } from '../../components/Icons.jsx';
import { SECTION_TYPES } from './sections.js';
import { sectionAnchors, resolveSiteLink } from '../../lib/siteLinks.js';

// What the editors need to know about the site around them: the pages
// (for the link picker), the sections on the page being edited (for
// "scroll to" links), whether we are on a phone, and how to open the
// section library (the legacy-code panel's second button).
export const EditorContext = createContext({ pages: [], sections: [], mobile: false, onOpenLibrary: null });
export const useEditorCtx = () => useContext(EditorContext);

export const inputS = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid var(--border-strong)',
  background: 'var(--surface-2)',
  outline: 'none',
  fontSize: 13,
  color: 'var(--fg)',
  minWidth: 0,
  boxSizing: 'border-box',
};

const labelS = {
  display: 'block', fontSize: 11, fontWeight: 600,
  color: 'var(--muted)', letterSpacing: '0.04em',
  textTransform: 'uppercase', marginBottom: 6,
};

export function FieldBlock({ label, hint, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      {label && <label style={labelS}>{label}</label>}
      {children}
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

// Label + control stacked. `as="div"` when the control is not a single
// input (a label wrapping several inputs confuses screen readers).
export function Row({ label, hint, children, as = 'label' }) {
  const Tag = as;
  return (
    <Tag style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      {children}
      {hint && <Hint>{hint}</Hint>}
    </Tag>
  );
}

export function Hint({ children }) {
  return <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>{children}</div>;
}

export function Note({ children }) {
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 8, border: '1px dashed var(--border)' }}>
      {children}
    </div>
  );
}

export function TextInput(props) { return <input type="text" {...props} style={{ ...inputS, ...(props.style || {}) }} />; }
export function TextArea({ rows = 4, ...props }) { return <textarea rows={rows} {...props} style={{ ...inputS, resize: 'vertical', lineHeight: 1.5, ...(props.style || {}) }} />; }

// A labelled on/off switch with a tap-friendly row.
export function Toggle({ checked, onChange, label, hint }) {
  const { mobile } = useEditorCtx();
  return (
    <label onClick={(e) => { e.preventDefault(); onChange(!checked); }}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, color: 'var(--fg-2)', minHeight: mobile ? 44 : undefined, cursor: 'pointer' }}>
      <span role="switch" aria-checked={!!checked} tabIndex={0}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onChange(!checked); } }}
        style={{
          flexShrink: 0, width: 38, height: 22, padding: 2, borderRadius: 99, marginTop: 1,
          background: checked ? 'var(--accent)' : 'var(--surface-2)',
          border: '1px solid var(--border-strong)', position: 'relative', display: 'inline-block',
        }}>
        <span style={{
          display: 'block', width: 16, height: 16, borderRadius: 99, background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
          transform: `translateX(${checked ? 16 : 0}px)`, transition: 'transform 0.15s',
        }}/>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--fg)' }}>{label}</span>
        {hint && <span style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>{hint}</span>}
      </span>
    </label>
  );
}

// Pill picker: options [{ id, label }], one selected.
export function Segmented({ value, onChange, options }) {
  const { mobile } = useEditorCtx();
  return (
    <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const on = (value ?? '') === (o.id ?? '');
        return (
          <button key={o.id || 'none'} type="button" onClick={() => onChange(o.id)}
            style={{
              flex: '1 1 auto', padding: mobile ? '9px 8px' : '6px 8px', fontSize: 12, fontWeight: 500,
              borderRadius: 6, border: 'none', cursor: 'pointer',
              background: on ? 'var(--accent)' : 'transparent',
              color: on ? 'var(--accent-ink)' : 'var(--fg-2)',
            }}>{o.label}</button>
        );
      })}
    </div>
  );
}

export function Select({ value, onChange, children, ...rest }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} {...rest} style={{ ...inputS, ...(rest.style || {}) }}>
      {children}
    </select>
  );
}

let idCounter = 0;
export function newItemId(prefix = 'i') {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter}`;
}

// List editor. `items` are objects with an `id`; `onChange(nextItems)`
// receives the whole list. `make()` builds a new item for the Add button.
// Children render one item's fields: (item, setItem, index).
export function Repeater({ items = [], onChange, make, addLabel = 'Add', itemLabel, max = 60, children }) {
  const { mobile } = useEditorCtx();
  const tap = mobile ? 44 : 30;
  const list = Array.isArray(items) ? items : [];
  const withIds = list.map((it, i) => (it && it.id ? it : { ...(it || {}), id: `fix${i}` }));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= withIds.length) return;
    const next = withIds.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i) => onChange(withIds.filter((_, x) => x !== i));
  const add = () => { if (withIds.length < max) onChange([...withIds, make()]); };
  const btn = {
    width: tap, height: tap, padding: 0, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {withIds.map((item, idx) => {
        const setItem = (patch) => onChange(withIds.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
        const title = typeof itemLabel === 'function' ? itemLabel(item, idx) : `${itemLabel || 'Item'} ${idx + 1}`;
        return (
          <div key={item.id} style={{
            padding: 12, borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 2 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {title}
              </span>
              <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0} className="btn btn-ghost" title="Move up" aria-label={`Move ${title} up`}
                style={{ ...btn, opacity: idx === 0 ? 0.3 : 0.8 }}><Icons.ArrowUp size={13}/></button>
              <button type="button" onClick={() => move(idx, 1)} disabled={idx === withIds.length - 1} className="btn btn-ghost" title="Move down" aria-label={`Move ${title} down`}
                style={{ ...btn, opacity: idx === withIds.length - 1 ? 0.3 : 0.8 }}><Icons.ArrowDown size={13}/></button>
              <button type="button" onClick={() => remove(idx)} className="btn btn-ghost" title="Remove" aria-label={`Remove ${title}`}
                style={{ ...btn, color: 'var(--danger)' }}><Icons.Trash size={13}/></button>
            </div>
            {children(item, setItem, idx)}
          </div>
        );
      })}
      {withIds.length < max && (
        <button type="button" onClick={add} className="btn btn-outline" style={{ justifyContent: 'center', fontSize: 12.5, minHeight: mobile ? 44 : undefined }}>
          <Icons.Plus size={13}/>{addLabel}
        </button>
      )}
    </div>
  );
}

// Image field. The owner sees a picture, never a web address: upload a
// photo and it shows as a thumbnail with Change / Remove. "Use a photo from
// the web" is tucked behind a small link for the rare owner who has one;
// once added it is a thumbnail like any other. (Uploads go to Vercel Blob
// via the existing upload-token endpoint, image-only allowlist enforced
// server-side.)
export function ImageInput({ value, onChange, placeholder = "Paste the photo's web address" }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [linking, setLinking] = useState(false);
  const [draft, setDraft] = useState('');
  const { mobile } = useEditorCtx();
  const [inputId] = useState(() => `img-up-${Math.random().toString(36).slice(2, 8)}`);

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const result = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/clients/upload-token',
        contentType: file.type,
      });
      onChange(result.url);
      setLinking(false); setDraft('');
    } catch (e2) {
      setErr(e2.message || 'Upload failed');
    } finally {
      setBusy(false);
      e.target.value = '';  // allow re-picking the same file
    }
  };
  const addLink = () => {
    const u = draft.trim();
    if (!u) return;
    onChange(u);
    setLinking(false); setDraft('');
  };
  const pickBtn = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '8px 12px', fontSize: 12.5, fontWeight: 600, minHeight: mobile ? 44 : undefined,
    border: '1px solid var(--border-strong)', background: 'var(--surface-2)', color: 'var(--fg)',
    borderRadius: 'var(--radius-sm, 10px)', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {value ? (
        <div style={{ position: 'relative' }}>
          <div role="img" aria-label="Current photo" style={{
            aspectRatio: '16 / 9', borderRadius: 6,
            background: `center/cover no-repeat url("${value}"), var(--surface-2)`,
            border: '1px solid var(--border)',
          }}/>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <label htmlFor={inputId} style={{ ...pickBtn, flex: 1 }}>
          <Icons.Image size={13}/>{busy ? 'Uploading…' : (value ? 'Change photo' : 'Upload a photo')}
        </label>
        {value ? (
          <button type="button" onClick={() => onChange('')} style={{ ...pickBtn, color: 'var(--danger)' }}>
            Remove
          </button>
        ) : null}
        <input id={inputId} type="file" accept="image/*"
          onChange={onPick} disabled={busy}
          style={{ display: 'none' }}/>
      </div>
      {!value && !linking && (
        <button type="button" onClick={() => setLinking(true)}
          style={{ all: 'unset', cursor: 'pointer', fontSize: 11.5, color: 'var(--muted)', textDecoration: 'underline', alignSelf: 'flex-start', padding: mobile ? '8px 0' : '2px 0' }}>
          Use a photo from the web instead
        </button>
      )}
      {!value && linking && (
        <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
          <input type="url" inputMode="url" value={draft} autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }}
            placeholder={placeholder} aria-label="Photo web address" style={{ ...inputS, flex: 1 }}/>
          <button type="button" onClick={addLink} disabled={!draft.trim()} style={{ ...pickBtn, opacity: draft.trim() ? 1 : 0.5 }}>Add</button>
        </div>
      )}
      {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

// Multi-photo manager for gallery-style sections: thumbnail grid with
// reorder + remove, multi-file upload (same endpoint as ImageInput), and
// a paste-a-link fallback for photos hosted elsewhere.
export function GalleryPhotos({ photos = [], onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [inputId] = useState(() => `gal-up-${Math.random().toString(36).slice(2, 8)}`);
  const { mobile } = useEditorCtx();

  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= photos.length) return;
    const next = photos.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i) => onChange(photos.filter((_, x) => x !== i));
  const addUrl = () => {
    const u = urlDraft.trim();
    if (!u) return;
    onChange([...photos, u]);
    setUrlDraft('');
  };
  const onPick = async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    setBusy(true); setErr(null);
    try {
      const urls = [];
      for (const file of files) {
        const result = await upload(file.name, file, {
          access: 'public',
          handleUploadUrl: '/api/clients/upload-token',
          contentType: file.type,
        });
        urls.push(result.url);
      }
      onChange([...photos, ...urls]);
    } catch (e2) {
      setErr(e2.message || 'Upload failed');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };
  const galBtn = {
    background: 'rgba(17,18,16,0.7)', border: 'none', color: '#fff',
    width: mobile ? 32 : 22, height: mobile ? 28 : 20, borderRadius: 5, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, lineHeight: 1, padding: 0,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {photos.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {photos.map((url, i) => (
            <div key={`${url}-${i}`} style={{
              position: 'relative', aspectRatio: '4 / 3', borderRadius: 8,
              background: `center/cover no-repeat url("${url}"), var(--surface-2)`,
              border: '1px solid var(--border)', overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute', inset: 'auto 0 0 0', display: 'flex',
                justifyContent: 'space-between', padding: 4,
                background: 'linear-gradient(transparent, rgba(0,0,0,0.55))',
              }}>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                    title="Move earlier" aria-label="Move photo earlier" style={{ ...galBtn, opacity: i === 0 ? 0.35 : 1 }}>←</button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === photos.length - 1}
                    title="Move later" aria-label="Move photo later" style={{ ...galBtn, opacity: i === photos.length - 1 ? 0.35 : 1 }}>→</button>
                </div>
                <button type="button" onClick={() => remove(i)} title="Remove photo" aria-label="Remove photo"
                  style={{ ...galBtn, color: '#ff8a80' }}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <label htmlFor={inputId} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: '10px 12px', fontSize: 12.5, fontWeight: 550,
        border: '1px dashed var(--border-strong)', borderRadius: 8,
        background: 'var(--surface-2)', color: 'var(--fg-2)',
        cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
        minHeight: mobile ? 44 : undefined,
      }}>
        {busy ? 'Uploading…' : '+ Upload photos (one or several)'}
      </label>
      <input id={inputId} type="file" accept="image/*" multiple
        onChange={onPick} disabled={busy} style={{ display: 'none' }}/>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="url" value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } }}
          placeholder="…or paste a link to a photo" style={{ ...inputS, flex: 1 }}/>
        <button type="button" onClick={addUrl} disabled={!urlDraft.trim()} style={{
          padding: '8px 12px', fontSize: 12, borderRadius: 'var(--radius-sm, 10px)', flexShrink: 0,
          border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
          color: 'var(--fg)', cursor: 'pointer', opacity: urlDraft.trim() ? 1 : 0.5,
        }}>Add</button>
      </div>
      {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

// ---------- Link picker ----------
//
// Stores the same values the renderers already understand: '' (the
// default for that button), '#book' (the booking page), '#<page>' (one of
// the site's pages), '#<anchor>' (a section on this page), 'https://…',
// 'mailto:…' or 'tel:…'. The owner only ever sees names.
const BOOK = '#book';
const CUSTOM = '__custom';
const EMAIL = '__email';
const PHONE = '__phone';
const NONE = '';
const DEAD = '__dead';

// Where a leftover "#name" link lands on the live site, as one of the
// picker's own options (same rules as resolveSiteLink), or null.
function namedTarget(v, pages, sections, known) {
  const anchors = sectionAnchors(sections || []);
  const to = resolveSiteLink(v, {
    anchors, sections: sections || [], linkBase: '',
    pages: (pages || []).map((p) => ({ slug: p.slug || '' })),
  });
  if (to === '/') return known.has('#home') ? '#home' : null;
  if (typeof to !== 'string') return null;
  if (to.startsWith('/') && known.has(`#${to.slice(1)}`)) return `#${to.slice(1)}`;
  if (to.startsWith('#') && to !== v && known.has(to)) return to;
  return null;
}

function sectionOptions(sections) {
  const anchors = sectionAnchors(sections || []);
  return (sections || []).filter((s) => s && s.visible !== false && anchors[s.id]).map((s) => {
    const cfg = SECTION_TYPES[s.type];
    const h = s.data && typeof s.data.headline === 'string' && s.data.headline.trim() ? ` ("${s.data.headline.trim().slice(0, 28)}${s.data.headline.trim().length > 28 ? '…' : ''}")` : '';
    return { value: `#${anchors[s.id]}`, label: `Scroll to ${cfg?.label || s.type}${h}` };
  });
}

function pageOptions(pages) {
  return (pages || []).map((p) => ({
    value: (p.slug || '') === '' ? '#home' : `#${p.slug}`,
    label: `Page: ${p.title || (p.slug ? p.slug : 'Home')}`,
  }));
}

export function LinkField({ value, onChange, emptyMeans = 'booking', label = 'Button link', hint = null }) {
  const { pages, sections } = useEditorCtx();
  const [pick, setPick] = useState(null);
  const v = String(value ?? '').trim();
  const pageOpts = pageOptions(pages);
  const secOpts = sectionOptions(sections);
  const known = new Set([BOOK, ...pageOpts.map((o) => o.value), ...secOpts.map((o) => o.value)]);
  // A "#name" link a template or an older save left behind (like
  // "#portfolio"): show where it actually goes on the live site, by name.
  // One that goes nowhere is shown as such, never as raw "#name".
  const named = v.startsWith('#') && !known.has(v) ? namedTarget(v, pages, sections, known) : null;
  const dead = v.startsWith('#') && !known.has(v) && !named;
  const derived = v === '' ? NONE
    : known.has(v) ? v
    : named ? named
    : dead ? DEAD
    : /^mailto:/i.test(v) ? EMAIL
    : /^tel:/i.test(v) ? PHONE
    : CUSTOM;
  const mode = pick ?? derived;

  const choose = (m) => {
    if (m === DEAD) return;
    if (m === CUSTOM || m === EMAIL || m === PHONE) {
      setPick(m);
      if (derived !== m) onChange('');
      return;
    }
    setPick(null);
    onChange(m);
  };
  const defaultLabel = emptyMeans === 'booking' ? 'Your booking page' : emptyMeans === 'top' ? 'Top of the page' : 'No link';
  return (
    <Row label={label} as="div" hint={hint}>
      <Select value={mode} onChange={choose} aria-label={label}>
        {mode === DEAD && <option value={DEAD}>Not linked to anything yet. Pick where it goes</option>}
        <option value={NONE}>{defaultLabel}</option>
        {emptyMeans !== 'booking' && <option value={BOOK}>Your booking page</option>}
        {pageOpts.length > 0 && (
          <optgroup label="Pages on your site">
            {pageOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        )}
        {secOpts.length > 0 && (
          <optgroup label="On this page">
            {secOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        )}
        <optgroup label="Somewhere else">
          <option value={CUSTOM}>A web address</option>
          <option value={EMAIL}>An email address</option>
          <option value={PHONE}>A phone number</option>
        </optgroup>
      </Select>
      {mode === CUSTOM && (
        <input type="url" value={derived === CUSTOM ? v : ''} inputMode="url" autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => { const t = e.target.value.trim(); if (t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('#') && !t.startsWith('/')) onChange(`https://${t}`); }}
          placeholder="www.example.com" style={inputS}/>
      )}
      {mode === EMAIL && (
        <input type="email" value={derived === EMAIL ? v.replace(/^mailto:/i, '') : ''} inputMode="email" autoComplete="off"
          onChange={(e) => onChange(e.target.value ? `mailto:${e.target.value.trim()}` : '')}
          placeholder="you@example.com" style={inputS}/>
      )}
      {mode === PHONE && (
        <input type="tel" value={derived === PHONE ? v.replace(/^tel:/i, '') : ''} inputMode="tel" autoComplete="off"
          onChange={(e) => onChange(e.target.value ? `tel:${e.target.value.replace(/[^\d+()\-\s.]/g, '').trim()}` : '')}
          placeholder="+1 555 123 4567" style={inputS}/>
      )}
    </Row>
  );
}

// ---------- Date / time ----------
// <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in local time;
// the section stores an ISO string.
export function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function localInputToIso(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function DateTimeInput({ value, onChange }) {
  return (
    <input type="datetime-local" value={isoToLocalInput(value)}
      onChange={(e) => onChange(localInputToIso(e.target.value))}
      style={inputS}/>
  );
}

export function DateInput({ value, onChange }) {
  const v = /^\d{4}-\d{2}-\d{2}/.test(String(value || '')) ? String(value).slice(0, 10) : '';
  return <input type="date" value={v} onChange={(e) => onChange(e.target.value)} style={inputS}/>;
}
