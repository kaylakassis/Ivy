// Right-panel inspector - edits the currently selected section with a
// plain-language form (one per section type, see sectionEditors.jsx).
// Owners never see or type code here: lists are Add / Remove / up / down,
// images are uploads, links are picked from the site's own pages.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';
import { SECTION_TYPES, ANIMATIONS, isLegacyCodeType } from './sections.js';
import { BG_SWATCHES, HEADLINE_SWATCHES } from './sectionStyle.js';
import { EDITORS, LegacyCodePanel, NoSettingsEditor } from './sectionEditors.jsx';
import { EditorContext, FieldBlock, ImageInput, GalleryPhotos, Hint, inputS } from './editorKit.jsx';

// Other editor files import these from here.
export { ImageInput, GalleryPhotos };

export default function Inspector({
  section, onChange, onMoveUp, onMoveDown, onDuplicate, onDelete, onToggleVisible,
  onMoveToPage = null, onCopyToPage = null, mobile = false, currentPage = null, onPageChange = null,
  pages = [], sections = [], onOpenLibrary = null,
}) {
  const ctx = { pages, sections, mobile, onOpenLibrary };
  if (!section) {
    // No section selected - surface the page-level search / sharing
    // settings instead of an empty placeholder.
    return (
      <EditorContext.Provider value={ctx}>
        <Shell title={currentPage ? `Page · ${currentPage.title || 'Home'}` : 'Edit'} mobile={mobile}>
          {currentPage && onPageChange ? (
            <PageSeoPanel page={currentPage} onChange={onPageChange}/>
          ) : (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
              {mobile ? 'Tap a section on the canvas to edit it.' : 'Click a section in the canvas to edit it.'}
            </div>
          )}
        </Shell>
      </EditorContext.Provider>
    );
  }

  const cfg = SECTION_TYPES[section.type];
  const legacy = isLegacyCodeType(section.type);
  const update = (patch) => onChange({ data: { ...section.data, ...patch } });
  // Layout variant + per-section style overrides live OUTSIDE data so
  // they don't pollute the form-data shape each renderer consumes.
  const updateVariant = (variant) => onChange({ variant });
  const updateStyle   = (patch)   => onChange({ style: { ...(section.style || {}), ...patch } });
  const Editor = EDITORS[section.type] || NoSettingsEditor;
  const variants = cfg?.variants || [];
  const tap = mobile ? 44 : undefined;

  return (
    <EditorContext.Provider value={ctx}>
      <Shell title={cfg?.label || 'Section'} mobile={mobile}>
        <div style={{ padding: 14, display: 'flex', gap: 6 }}>
          <IconBtn onClick={onMoveUp} title="Move up" tap={tap}><Icons.ArrowUp size={14} /></IconBtn>
          <IconBtn onClick={onMoveDown} title="Move down" tap={tap}><Icons.ArrowDown size={14} /></IconBtn>
          <IconBtn onClick={onToggleVisible} title={section.visible ? 'Hide section' : 'Show section'} tap={tap}>
            {section.visible ? <Icons.Eye size={14} /> : <Icons.EyeOff size={14} />}
          </IconBtn>
          {onDuplicate && !legacy && (
            <IconBtn onClick={onDuplicate} title="Duplicate section" tap={tap}>
              <Icons.Copy size={14} />
            </IconBtn>
          )}
          <div style={{ flex: 1 }} />
          <IconBtn onClick={onDelete} title="Delete section" danger tap={tap}>
            <Icons.Trash size={14} />
          </IconBtn>
        </div>
        {(onMoveToPage || (onCopyToPage && !legacy)) && (
          <div style={{ padding: '0 14px 14px', display: 'flex', gap: 6 }}>
            {onMoveToPage && (
              <button type="button" className="btn btn-outline" onClick={onMoveToPage}
                style={{ flex: 1, justifyContent: 'center', fontSize: 12.5, padding: '7px 8px', minHeight: tap }}>
                <Icons.MoveTo size={14}/> Move to page…
              </button>
            )}
            {onCopyToPage && !legacy && (
              <button type="button" className="btn btn-outline" onClick={onCopyToPage}
                style={{ flex: 1, justifyContent: 'center', fontSize: 12.5, padding: '7px 8px', minHeight: tap }}>
                <Icons.Copy size={14}/> Copy to page…
              </button>
            )}
          </div>
        )}
        <div className="divider" />
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', overflowX: 'hidden', flex: 1, minWidth: 0 }} className="scroll">
          {legacy ? (
            <LegacyCodePanel onDelete={onDelete}/>
          ) : (
            <>
              {variants.length > 0 && (
                <FieldBlock label="Layout">
                  <select value={section.variant || variants[0].id}
                    onChange={(e) => updateVariant(e.target.value)}
                    style={inputS}>
                    {variants.map((v) => (
                      <option key={v.id} value={v.id}>{v.label}</option>
                    ))}
                  </select>
                </FieldBlock>
              )}
              <Editor data={section.data || {}} update={update} />
              <Divider/>
              <StyleControls style={section.style || {}} updateStyle={updateStyle} mobile={mobile}/>
              <Divider/>
              <AnimationPicker animate={section.animate || ''} onChange={(animate) => onChange({ animate: animate || null })}/>
            </>
          )}
        </div>
      </Shell>
    </EditorContext.Provider>
  );
}

// Per-page search and sharing settings. Lives in the Inspector when no
// section is selected. Fields are all optional; the server falls back to
// site-level defaults (and then to copy from the hero/about sections).
function PageSeoPanel({ page, onChange }) {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', flex: 1 }} className="scroll">
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Search and sharing
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55, marginTop: -6 }}>
        How this page looks in Google results and when someone shares the link.
        Leave blank to use your site's defaults.
      </div>
      <FieldBlock label="Page title shown in Google" hint="Also the browser tab name. About 60 characters works best.">
        <input type="text" value={page.metaTitle || ''}
          onChange={(e) => onChange({ metaTitle: e.target.value })}
          placeholder={page.title || 'e.g. Rivers Coaching - 1:1 Career Coaching'}
          maxLength={200}
          style={inputS}/>
      </FieldBlock>
      <FieldBlock label="Short description shown in Google" hint="One or two sentences. About 155 characters works best.">
        <textarea rows={3} value={page.metaDescription || ''}
          onChange={(e) => onChange({ metaDescription: e.target.value })}
          placeholder="One sentence that tells people what this page is about."
          maxLength={400}
          style={{ ...inputS, resize: 'vertical', lineHeight: 1.5 }}/>
      </FieldBlock>
      <FieldBlock label="Image shown when the page is shared" hint="Shown on Facebook, X, LinkedIn and in messages. A wide photo (about 1200 by 630) works best.">
        <ImageInput value={page.ogImage || ''}
          onChange={(url) => onChange({ ogImage: url })}/>
      </FieldBlock>
    </div>
  );
}

function AnimationPicker({ animate, onChange }) {
  // `animate` is either null/'' or a string for the legacy shape, or
  // { type, delayMs, durationMs } for the fine-grained form. We
  // normalize to the object form for the editor UI.
  const cur = typeof animate === 'object' && animate
    ? animate
    : { type: animate || '', delayMs: 0, durationMs: 700 };
  const commit = (patch) => {
    const next = { ...cur, ...patch };
    if (!next.type) { onChange(null); return; }
    // Keep simple strings simple - only upgrade to the object shape if
    // delay/duration are non-default. Saves bytes on the wire.
    if ((!next.delayMs || next.delayMs === 0) && (!next.durationMs || next.durationMs === 700)) {
      onChange(next.type);
    } else {
      onChange({ type: next.type, delayMs: Number(next.delayMs) || 0, durationMs: Number(next.durationMs) || 700 });
    }
  };
  const secs = (ms) => `${(Number(ms) / 1000).toFixed(ms % 1000 === 0 ? 0 : 2).replace(/0$/, '')} s`;
  return (
    <>
      <FieldBlock label="How it appears when scrolled into view">
        <select value={cur.type || ''} onChange={(e) => commit({ type: e.target.value })}
          style={inputS}>
          <option value="">Just appears</option>
          {Object.entries(ANIMATIONS).map(([id, cfg]) => (
            <option key={id} value={id}>{cfg.label}</option>
          ))}
        </select>
      </FieldBlock>
      {cur.type && (
        <>
          <FieldBlock label={`Waits before starting: ${secs(cur.delayMs || 0)}`}>
            <input type="range" min={0} max={2000} step={50}
              value={cur.delayMs || 0}
              onChange={(e) => commit({ delayMs: Number(e.target.value) })}
              style={{ width: '100%' }}/>
          </FieldBlock>
          <FieldBlock label={`How long it takes: ${secs(cur.durationMs || 700)}`}>
            <input type="range" min={150} max={2000} step={50}
              value={cur.durationMs || 700}
              onChange={(e) => commit({ durationMs: Number(e.target.value) })}
              style={{ width: '100%' }}/>
          </FieldBlock>
        </>
      )}
    </>
  );
}

// Per-section style overrides - background, spacing, text alignment,
// which devices show it, headline color effect. Colors are picked from
// swatches or a color picker; nothing is typed.
// The swatch lists live in sectionStyle.js so Ivy offers exactly the same
// choices (api/_lib/ivyWebsiteTools.js).
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ''));

function StyleControls({ style, updateStyle, mobile }) {
  const swatchBtn = (on) => ({
    width: mobile ? 36 : 28, height: mobile ? 36 : 28, borderRadius: 6,
    border: on ? '2px solid var(--accent)' : '1px solid var(--border)',
    cursor: 'pointer', padding: 0,
  });
  const pill = (on) => ({
    flex: 1, padding: mobile ? '9px 8px' : '6px 8px', fontSize: 11.5,
    border: '1px solid var(--border)',
    background: on ? 'var(--accent)' : 'var(--surface)',
    color: on ? 'var(--accent-ink)' : 'var(--fg)',
    borderRadius: 6, cursor: 'pointer',
  });
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Section style
      </div>
      <FieldBlock label="Background color">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {BG_SWATCHES.map((s) => (
            <button key={s.v || 'none'} type="button"
              onClick={() => updateStyle({ background: s.v || undefined })}
              title={s.label} aria-label={s.label}
              style={{
                ...swatchBtn((style.background || '') === s.v),
                background: s.v || 'transparent',
                ...(s.v ? {} : {
                  backgroundImage: 'linear-gradient(45deg, var(--border) 25%, transparent 25%, transparent 75%, var(--border) 75%, var(--border)), linear-gradient(45deg, var(--border) 25%, transparent 25%, transparent 75%, var(--border) 75%, var(--border))',
                  backgroundSize: '8px 8px',
                  backgroundPosition: '0 0, 4px 4px',
                }),
              }}/>
          ))}
          <label title="Pick any color" style={{ ...swatchBtn(isHex(style.background) && !BG_SWATCHES.some((s) => s.v === style.background)), position: 'relative', overflow: 'hidden', background: isHex(style.background) ? style.background : 'conic-gradient(#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f87171)', display: 'inline-block' }}>
            <input type="color" value={isHex(style.background) ? style.background : '#ffffff'}
              onChange={(e) => updateStyle({ background: e.target.value })}
              aria-label="Pick any background color"
              style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}/>
          </label>
        </div>
        <Hint>The rainbow swatch opens a color picker.</Hint>
      </FieldBlock>
      <FieldBlock label="Space above and below">
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            ['compact',  'Snug'],
            ['normal',   'Normal'],
            ['spacious', 'Roomy'],
          ].map(([id, label]) => (
            <button key={id} type="button"
              onClick={() => updateStyle({ padding: id === 'normal' ? undefined : id })}
              style={pill((style.padding || 'normal') === id)}>{label}</button>
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
              style={pill((style.textAlign || '') === id)}>{label}</button>
          ))}
        </div>
      </FieldBlock>
      <FieldBlock label="Show on">
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { id: 'desktop', label: 'Computers', styleKey: 'hideOnDesktop' },
            { id: 'mobile',  label: 'Phones',    styleKey: 'hideOnMobile'  },
          ].map((d) => {
            const on = !style[d.styleKey];
            return (
              <button key={d.id} type="button"
                onClick={() => updateStyle({ [d.styleKey]: on ? true : undefined })}
                title={on ? `Hide on ${d.label.toLowerCase()}` : `Show on ${d.label.toLowerCase()}`}
                aria-pressed={on}
                style={pill(on)}>{d.label}</button>
            );
          })}
        </div>
      </FieldBlock>
      <FieldBlock label="Headline color effect">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {HEADLINE_SWATCHES.map((g) => (
            <button key={g.v || 'none'} type="button"
              onClick={() => updateStyle({ headlineGradient: g.v || undefined })}
              title={g.label} aria-label={g.label}
              style={{
                ...swatchBtn((style.headlineGradient || '') === g.v),
                width: mobile ? 48 : 40, height: mobile ? 28 : 20, borderRadius: 4,
                background: g.v || 'var(--surface-2)',
              }}/>
          ))}
        </div>
      </FieldBlock>
      <FieldBlock label="Background photo effect">
        <button type="button"
          onClick={() => updateStyle({ parallax: !style.parallax ? true : undefined })}
          aria-pressed={!!style.parallax}
          style={{
            width: '100%', padding: mobile ? '10px' : '7px 10px', fontSize: 12.5, fontWeight: 600,
            border: '1px solid var(--border)',
            background: style.parallax ? 'var(--accent)' : 'var(--surface)',
            color: style.parallax ? 'var(--accent-ink)' : 'var(--fg)',
            borderRadius: 8, cursor: 'pointer',
          }}>{style.parallax ? 'Photo moves slower than the page (on)' : 'Photo moves slower than the page (off)'}</button>
        <Hint>Only matters when this section has a background photo.</Hint>
      </FieldBlock>
    </>
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
      maxWidth: '100%',
      flex: mobile ? 1 : '0 0 auto',
      background: 'var(--surface)',
      borderLeft: mobile ? 'none' : '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      height: '100%',
      overflowX: 'hidden',
    }}>
      <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
        <div className="metric-label">Edit</div>
        <div style={{ fontSize: 15, fontWeight: 550, marginTop: 2 }}>{title}</div>
      </div>
      {children}
    </aside>
  );
}

function IconBtn({ children, onClick, title, danger, tap }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="btn btn-outline"
      style={{ padding: 7, minWidth: tap, minHeight: tap, justifyContent: 'center', color: danger ? 'var(--danger)' : undefined }}
    >{children}</button>
  );
}
