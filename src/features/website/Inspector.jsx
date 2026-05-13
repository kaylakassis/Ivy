// Right-panel inspector — edits the currently selected section.
import React, { useState } from 'react';
import { upload } from '@vercel/blob/client';
import { Icons } from '../../components/Icons.jsx';
import { SECTION_TYPES, ANIMATIONS } from './sections.js';

export default function Inspector({ section, onChange, onMoveUp, onMoveDown, onDuplicate, onDelete, onToggleVisible, mobile = false, currentPage = null, onPageChange = null }) {
  if (!section) {
    // No section selected — surface the page-level SEO editor instead
    // of an empty placeholder. This is the spot owners reach for when
    // they want their share previews + search-result snippets to look
    // right.
    return (
      <Shell title={currentPage ? `Page · ${currentPage.title || 'Home'}` : 'Inspector'} mobile={mobile}>
        {currentPage && onPageChange ? (
          <PageSeoPanel page={currentPage} onChange={onPageChange}/>
        ) : (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
            Click a section in the canvas to edit it.
          </div>
        )}
      </Shell>
    );
  }

  const cfg = SECTION_TYPES[section.type];
  const update = (patch) => onChange({ data: { ...section.data, ...patch } });
  // Layout variant + per-section style overrides live OUTSIDE data so
  // they don't pollute the form-data shape each renderer consumes.
  const updateVariant = (variant) => onChange({ variant });
  const updateStyle   = (patch)   => onChange({ style: { ...(section.style || {}), ...patch } });
  const Editor = EDITORS[section.type] || FallbackEditor;
  const variants = cfg?.variants || [];

  return (
    <Shell title={cfg?.label || section.type} mobile={mobile}>
      <div style={{ padding: 14, display: 'flex', gap: 6 }}>
        <IconBtn onClick={onMoveUp} title="Move up"><Icons.ArrowUp size={14} /></IconBtn>
        <IconBtn onClick={onMoveDown} title="Move down"><Icons.ArrowDown size={14} /></IconBtn>
        <IconBtn onClick={onToggleVisible} title={section.visible ? 'Hide section' : 'Show section'}>
          <Icons.Eye size={14} />
        </IconBtn>
        {onDuplicate && (
          <IconBtn onClick={onDuplicate} title="Duplicate section">
            <Icons.Plus size={14} />
          </IconBtn>
        )}
        <div style={{ flex: 1 }} />
        <IconBtn onClick={onDelete} title="Delete section" danger>
          <Icons.Trash size={14} />
        </IconBtn>
      </div>
      <div className="divider" />
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', flex: 1 }} className="scroll">
        {variants.length > 0 && (
          <FieldBlock label="Layout variant">
            <select value={section.variant || variants[0].id}
              onChange={(e) => updateVariant(e.target.value)}
              style={inputS}>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </FieldBlock>
        )}
        <Editor data={section.data} update={update} />
        <Divider/>
        <StyleControls style={section.style || {}} updateStyle={updateStyle}/>
        <Divider/>
        <AnimationPicker animate={section.animate || ''} onChange={(animate) => onChange({ animate: animate || null })}/>
      </div>
    </Shell>
  );
}

// Per-page SEO. Lives in the Inspector when no section is selected.
// Fields are all optional; the SSR layer falls back to site-level
// defaults (and then to derived copy from the hero/about sections) so
// every page gets a usable title + description even when this is left
// blank.
function PageSeoPanel({ page, onChange }) {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', flex: 1 }} className="scroll">
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Page SEO
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55, marginTop: -6 }}>
        How this page looks in Google results + when shared on social.
        Leave blank to inherit the site defaults.
      </div>
      <FieldBlock label="Title (shown in browser tabs + Google results — ~60 chars)">
        <input type="text" value={page.metaTitle || ''}
          onChange={(e) => onChange({ metaTitle: e.target.value })}
          placeholder={page.title || 'e.g. Rivers Coaching — 1:1 Career Coaching'}
          maxLength={200}
          style={inputS}/>
      </FieldBlock>
      <FieldBlock label="Description (1–2 sentences — ~155 chars)">
        <textarea rows={3} value={page.metaDescription || ''}
          onChange={(e) => onChange({ metaDescription: e.target.value })}
          placeholder="One sentence that tells visitors (and Google) what this page is about."
          maxLength={400}
          style={{ ...inputS, resize: 'vertical', lineHeight: 1.5 }}/>
      </FieldBlock>
      <FieldBlock label="Share image (1200×630 works best — shown on Facebook, Twitter, LinkedIn)">
        <ImageInput value={page.ogImage || ''}
          onChange={(url) => onChange({ ogImage: url })}/>
      </FieldBlock>
    </div>
  );
}

function AnimationPicker({ animate, onChange }) {
  return (
    <FieldBlock label="Entry animation (when this section scrolls into view)">
      <select value={animate || ''} onChange={(e) => onChange(e.target.value)}
        style={inputS}>
        <option value="">None</option>
        {Object.entries(ANIMATIONS).map(([id, cfg]) => (
          <option key={id} value={id}>{cfg.label}</option>
        ))}
      </select>
    </FieldBlock>
  );
}

// Reusable image-URL field with a "Browse / upload" button that pushes
// to Vercel Blob via the existing /api/clients/upload-token endpoint
// (image-only allowlist enforced server-side). Used by Inspector
// section editors that need image fields.
export function ImageInput({ value, onChange, placeholder = 'https://… or upload' }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const inputId = `img-up-${Math.random().toString(36).slice(2, 8)}`;

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
    } catch (e2) {
      setErr(e2.message || 'Upload failed');
    } finally {
      setBusy(false);
      e.target.value = '';  // allow re-picking the same file
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="url" value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder} style={{ ...inputS, flex: 1 }}/>
        <label htmlFor={inputId} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '8px 12px', fontSize: 12,
          border: '1px solid var(--border-strong)',
          background: 'var(--surface-2)', color: 'var(--fg)',
          borderRadius: 'var(--radius-sm, 10px)',
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}>
          {busy ? '…' : 'Upload'}
        </label>
        <input id={inputId} type="file" accept="image/*"
          onChange={onPick} disabled={busy}
          style={{ display: 'none' }}/>
      </div>
      {value && (
        <div style={{
          aspectRatio: '16 / 9', borderRadius: 6,
          background: `center/cover no-repeat url("${value}"), var(--surface-2)`,
          border: '1px solid var(--border)',
        }}/>
      )}
      {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

// Per-section style overrides — background color/gradient, padding
// density, text alignment. Kept inline so they're always available
// regardless of section type.
function StyleControls({ style, updateStyle }) {
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Section style
      </div>
      <FieldBlock label="Background (color or CSS gradient — leaves the template default if empty)">
        <input type="text" className="input" value={style.background || ''}
          onChange={(e) => updateStyle({ background: e.target.value || undefined })}
          placeholder="#FFFFFF or linear-gradient(…)"
          style={inputS}/>
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {['', '#FFFFFF', '#0D0E0C', '#F5F1EA', '#5B7C5F',
            'linear-gradient(135deg,#E5572B,#F2D2BC)',
            'linear-gradient(180deg,#15201A,#1F2B23)'].map((bg) => (
            <button key={bg || 'none'} type="button"
              onClick={() => updateStyle({ background: bg || undefined })}
              title={bg || 'Reset to template'}
              style={{
                width: 28, height: 28, borderRadius: 6,
                background: bg || 'transparent',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                ...(bg ? {} : {
                  backgroundImage: 'linear-gradient(45deg, var(--border) 25%, transparent 25%, transparent 75%, var(--border) 75%, var(--border)), linear-gradient(45deg, var(--border) 25%, transparent 25%, transparent 75%, var(--border) 75%, var(--border))',
                  backgroundSize: '8px 8px',
                  backgroundPosition: '0 0, 4px 4px',
                }),
              }}/>
          ))}
        </div>
      </FieldBlock>
      <FieldBlock label="Vertical padding">
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            ['compact',  'Compact'],
            ['normal',   'Normal'],
            ['spacious', 'Spacious'],
          ].map(([id, label]) => (
            <button key={id} type="button"
              onClick={() => updateStyle({ padding: id === 'normal' ? undefined : id })}
              style={{
                flex: 1, padding: '6px 8px', fontSize: 11.5,
                border: '1px solid var(--border)',
                background: (style.padding || 'normal') === id ? 'var(--accent)' : 'var(--surface)',
                color: (style.padding || 'normal') === id ? 'var(--accent-ink)' : 'var(--fg)',
                borderRadius: 6, cursor: 'pointer',
              }}>{label}</button>
          ))}
        </div>
      </FieldBlock>
      <FieldBlock label="Text alignment">
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            ['',       'Default'],
            ['left',   'Left'],
            ['center', 'Center'],
            ['right',  'Right'],
          ].map(([id, label]) => (
            <button key={id || 'default'} type="button"
              onClick={() => updateStyle({ textAlign: id || undefined })}
              style={{
                flex: 1, padding: '6px 8px', fontSize: 11.5,
                border: '1px solid var(--border)',
                background: (style.textAlign || '') === id ? 'var(--accent)' : 'var(--surface)',
                color: (style.textAlign || '') === id ? 'var(--accent-ink)' : 'var(--fg)',
                borderRadius: 6, cursor: 'pointer',
              }}>{label}</button>
          ))}
        </div>
      </FieldBlock>
      <FieldBlock label="Show on">
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { id: 'desktop', label: 'Desktop', styleKey: 'hideOnDesktop' },
            { id: 'mobile',  label: 'Mobile',  styleKey: 'hideOnMobile'  },
          ].map((d) => {
            const on = !style[d.styleKey];
            return (
              <button key={d.id} type="button"
                onClick={() => updateStyle({ [d.styleKey]: on ? true : undefined })}
                title={on ? `Hide on ${d.label.toLowerCase()}` : `Show on ${d.label.toLowerCase()}`}
                style={{
                  flex: 1, padding: '6px 8px', fontSize: 11.5,
                  border: '1px solid var(--border)',
                  background: on ? 'var(--accent)' : 'var(--surface)',
                  color: on ? 'var(--accent-ink)' : 'var(--fg)',
                  borderRadius: 6, cursor: 'pointer',
                }}>{d.label}</button>
            );
          })}
        </div>
      </FieldBlock>
    </>
  );
}

function FieldBlock({ label, children }) {
  return (
    <div>
      <label style={{
        display: 'block', fontSize: 11, fontWeight: 600,
        color: 'var(--muted)', letterSpacing: '0.04em',
        textTransform: 'uppercase', marginBottom: 6,
      }}>{label}</label>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }}/>;
}

function Shell({ title, children, mobile = false }) {
  return (
    <aside style={{
      // Same responsive treatment as SectionLibrary: full-width pane on
      // mobile (only one panel visible at a time), fixed 320px rail
      // everywhere else.
      width: mobile ? '100%' : 320,
      minWidth: mobile ? 0 : 320,
      flex: mobile ? 1 : '0 0 auto',
      background: 'var(--surface)',
      borderLeft: mobile ? 'none' : '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      height: '100%',
    }}>
      <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
        <div className="metric-label">Inspector</div>
        <div style={{ fontSize: 15, fontWeight: 550, marginTop: 2 }}>{title}</div>
      </div>
      {children}
    </aside>
  );
}

function IconBtn({ children, onClick, title, danger }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="btn btn-outline"
      style={{ padding: 7, color: danger ? 'var(--danger)' : undefined }}
    >{children}</button>
  );
}

// ---------- Shared inputs ----------
function Row({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      {children}
    </label>
  );
}

const inputS = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid var(--border-strong)',
  background: 'var(--surface-2)',
  outline: 'none',
  fontSize: 13,
  color: 'var(--fg)',
};

function TextInput(props)     { return <input {...props} style={inputS} />; }
function TextArea({ rows = 4, ...props }) { return <textarea rows={rows} {...props} style={{ ...inputS, resize: 'vertical', lineHeight: 1.5 }} />; }

function Repeater({ items, onAdd, onRemove, addLabel, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((item, idx) => (
        <div key={item.id} style={{
          padding: 12, borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Item {idx + 1}
            </span>
            <button onClick={() => onRemove(item.id)} className="btn btn-ghost" style={{ padding: 4, color: 'var(--danger)' }}>
              <Icons.Trash size={13} />
            </button>
          </div>
          {children(item, idx)}
        </div>
      ))}
      <button onClick={onAdd} className="btn btn-outline" style={{ justifyContent: 'center', fontSize: 12 }}>
        <Icons.Plus size={13} />{addLabel}
      </button>
    </div>
  );
}

// ---------- Per-section editors ----------
const EDITORS = {
  hero: ({ data, update }) => (
    <>
      <Row label="Headline"><TextInput value={data.headline} onChange={(e) => update({ headline: e.target.value })} /></Row>
      <Row label="Subheadline"><TextArea rows={3} value={data.sub} onChange={(e) => update({ sub: e.target.value })} /></Row>
      <Row label="Button text"><TextInput value={data.cta} onChange={(e) => update({ cta: e.target.value })} /></Row>
      <Row label="Button link (optional)">
        <TextInput value={data.ctaLink} placeholder="#book or https://…" onChange={(e) => update({ ctaLink: e.target.value })} />
      </Row>
      <Row label="Alignment">
        <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
          {['left', 'center'].map((a) => (
            <button key={a} onClick={() => update({ align: a })}
              style={{
                flex: 1, padding: '6px 8px', fontSize: 12, fontWeight: 500,
                borderRadius: 6,
                background: data.align === a ? 'var(--accent)' : 'transparent',
                color: data.align === a ? 'var(--accent-ink)' : 'var(--fg-2)',
              }}>
              {a[0].toUpperCase() + a.slice(1)}
            </button>
          ))}
        </div>
      </Row>
    </>
  ),

  services: ({ data, update }) => (
    <>
      <Row label="Headline"><TextInput value={data.headline} onChange={(e) => update({ headline: e.target.value })} /></Row>
      <Row label="Subheadline"><TextArea rows={2} value={data.sub || ''} onChange={(e) => update({ sub: e.target.value })} /></Row>
      <Row label="Services">
        <Repeater
          items={data.items || []}
          addLabel="Add service"
          onAdd={() => update({ items: [...(data.items || []), { id: `i${Date.now()}`, name: 'New service', desc: '', price: '', duration: '' }] })}
          onRemove={(id) => update({ items: (data.items || []).filter((i) => i.id !== id) })}
        >
          {(item) => {
            const setItem = (patch) => update({ items: data.items.map((i) => i.id === item.id ? { ...i, ...patch } : i) });
            return (
              <>
                <TextInput placeholder="Name" value={item.name} onChange={(e) => setItem({ name: e.target.value })} />
                <TextArea rows={2} placeholder="Description" value={item.desc} onChange={(e) => setItem({ desc: e.target.value })} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <TextInput placeholder="Price" value={item.price} onChange={(e) => setItem({ price: e.target.value })} />
                  <TextInput placeholder="Duration" value={item.duration} onChange={(e) => setItem({ duration: e.target.value })} />
                </div>
              </>
            );
          }}
        </Repeater>
      </Row>
    </>
  ),

  about: ({ data, update }) => (
    <>
      <Row label="Headline"><TextInput value={data.headline} onChange={(e) => update({ headline: e.target.value })} /></Row>
      <Row label="Body"><TextArea rows={6} value={data.body} onChange={(e) => update({ body: e.target.value })} /></Row>
      <Row label="Photo"><ImageInput value={data.imgUrl} onChange={(v) => update({ imgUrl: v })} placeholder="Paste URL or upload"/></Row>
    </>
  ),

  booking: ({ data, update }) => (
    <>
      <Row label="Headline"><TextInput value={data.headline} onChange={(e) => update({ headline: e.target.value })} /></Row>
      <Row label="Subheadline"><TextArea rows={2} value={data.sub} onChange={(e) => update({ sub: e.target.value })} /></Row>
      <Row label="Calendar handle (optional)">
        <TextInput
          value={data.handle}
          placeholder="Leave blank to use your site handle"
          onChange={(e) => update({ handle: e.target.value })}
        />
      </Row>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 8, border: '1px dashed var(--border)' }}>
        The button links to <code style={{ fontSize: 11 }}>/book/:handle</code> — your calendar's public booking page.
      </div>
    </>
  ),

  testimonials: ({ data, update }) => (
    <>
      <Row label="Headline"><TextInput value={data.headline} onChange={(e) => update({ headline: e.target.value })} /></Row>
      <Row label="Reviews">
        <Repeater
          items={data.items || []}
          addLabel="Add review"
          onAdd={() => update({ items: [...(data.items || []), { id: `t${Date.now()}`, name: '', role: '', text: '', rating: 5 }] })}
          onRemove={(id) => update({ items: (data.items || []).filter((i) => i.id !== id) })}
        >
          {(item) => {
            const setItem = (patch) => update({ items: data.items.map((i) => i.id === item.id ? { ...i, ...patch } : i) });
            return (
              <>
                <TextInput placeholder="Name" value={item.name} onChange={(e) => setItem({ name: e.target.value })} />
                <TextInput placeholder="Role or context" value={item.role} onChange={(e) => setItem({ role: e.target.value })} />
                <TextArea rows={3} placeholder="What they said" value={item.text} onChange={(e) => setItem({ text: e.target.value })} />
                <Row label="Stars">
                  <input type="number" min="1" max="5" value={item.rating || 5}
                    onChange={(e) => setItem({ rating: Math.max(1, Math.min(5, +e.target.value || 5)) })}
                    style={inputS} />
                </Row>
              </>
            );
          }}
        </Repeater>
      </Row>
    </>
  ),

  faq: ({ data, update }) => (
    <>
      <Row label="Headline"><TextInput value={data.headline} onChange={(e) => update({ headline: e.target.value })} /></Row>
      <Row label="Questions">
        <Repeater
          items={data.items || []}
          addLabel="Add question"
          onAdd={() => update({ items: [...(data.items || []), { id: `f${Date.now()}`, q: '', a: '' }] })}
          onRemove={(id) => update({ items: (data.items || []).filter((i) => i.id !== id) })}
        >
          {(item) => {
            const setItem = (patch) => update({ items: data.items.map((i) => i.id === item.id ? { ...i, ...patch } : i) });
            return (
              <>
                <TextInput placeholder="Question" value={item.q} onChange={(e) => setItem({ q: e.target.value })} />
                <TextArea rows={3} placeholder="Answer" value={item.a} onChange={(e) => setItem({ a: e.target.value })} />
              </>
            );
          }}
        </Repeater>
      </Row>
    </>
  ),

  gallery: ({ data, update }) => (
    <>
      <Row label="Headline"><TextInput value={data.headline} onChange={(e) => update({ headline: e.target.value })} /></Row>
      <Row label="Photo URLs">
        <TextArea
          rows={6}
          placeholder="One URL per line"
          value={(data.photos || []).join('\n')}
          onChange={(e) => update({ photos: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
        />
      </Row>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        File uploads coming once the backend is connected.
      </div>
    </>
  ),

  contact: ({ data, update }) => (
    <>
      <Row label="Headline"><TextInput value={data.headline} onChange={(e) => update({ headline: e.target.value })} /></Row>
      <Row label="Subheadline"><TextArea rows={2} value={data.sub} onChange={(e) => update({ sub: e.target.value })} /></Row>
      <Row label="Email"><TextInput type="email" value={data.email} onChange={(e) => update({ email: e.target.value })} /></Row>
      <Row label="Phone"><TextInput value={data.phone} onChange={(e) => update({ phone: e.target.value })} /></Row>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg-2)' }}>
        <input type="checkbox" checked={data.showForm !== false} onChange={(e) => update({ showForm: e.target.checked })} />
        Show contact form
      </label>
    </>
  ),

  footer: ({ data, update }) => (
    <>
      <Row label="Business name"><TextInput value={data.businessName} onChange={(e) => update({ businessName: e.target.value })} /></Row>
      <Row label="Tagline"><TextInput value={data.tagline} onChange={(e) => update({ tagline: e.target.value })} /></Row>
    </>
  ),
};

function FallbackEditor({ data }) {
  return <pre style={{ fontSize: 11, color: 'var(--muted)' }}>{JSON.stringify(data, null, 2)}</pre>;
}
