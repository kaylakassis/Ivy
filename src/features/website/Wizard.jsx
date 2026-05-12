// First-run "let's build your site" wizard.
//
// Four quick decisions:
//   1. Business name
//   2. Public handle (slug)
//   3. Starter pack — picks a multi-page section layout + a sensible
//      template + font pair as a coherent starting point
//   4. (Optional) Override the template the pack suggests
//
// Hitting "Open editor" launches the site with the chosen pack's full
// pages array applied. The owner can rearrange anything from there.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { TEMPLATE_LIST, TEMPLATES } from './templates.js';
import { STARTER_PACK_LIST, STARTER_PACKS } from './sections.js';
import { slugify } from './state.js';

export default function Wizard({ onLaunch }) {
  const [name, setName]       = useState('');
  const [handle, setHandle]   = useState('');
  const [packId, setPackId]   = useState('service_pro');
  const [tplOverride, setTplOverride] = useState(null);
  const [showTplPicker, setShowTplPicker] = useState(false);

  const pack = STARTER_PACKS[packId] || STARTER_PACK_LIST[0];
  const tpl  = tplOverride || pack.template;

  const autoHandle = slugify(name);
  const effectiveHandle = handle || autoHandle;
  const canLaunch = !!name.trim() && !!effectiveHandle;

  const go = () => {
    if (!canLaunch) return;
    const businessName = name.trim();
    // Build the multi-page structure from the pack. The first page is
    // the home page (slug=''); subsequent pages are sub-paths.
    const pages = pack.build(businessName);
    const homeSections = pages[0]?.sections || [];
    onLaunch({
      launched: true,
      businessName,
      handle: effectiveHandle,
      template: tpl,
      fontPair: pack.fontPair || null,
      // Send BOTH pages and the legacy sections field. state.js syncs
      // them; sending sections too keeps older code paths working
      // unconditionally.
      pages,
      sections: homeSections,
    });
  };

  return (
    <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}>
      <div className="card" style={{
        width: '100%', maxWidth: 820, padding: 40,
        display: 'flex', flexDirection: 'column', gap: 28,
      }}>
        <div>
          <div className="metric-label" style={{ marginBottom: 8 }}>Website builder</div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 32 }}>Let&rsquo;s build your site.</h1>
          <p style={{ margin: '8px 0 0', color: 'var(--fg-2)', fontSize: 14, maxWidth: 540 }}>
            Pick a starter that fits your business — multi-page, animated, with the
            section types you actually need. Customize anything from there.
          </p>
        </div>

        <Field label="Business name" hint="Shows in the header, footer, and emails.">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Rivers Coaching"
            autoFocus
            style={inputStyle}
          />
        </Field>

        <Field label="Your handle" hint="Your public URL. Letters, numbers, and hyphens only.">
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, border: '1px solid var(--border-strong)', borderRadius: 10, overflow: 'hidden', background: 'var(--surface)' }}>
            <span style={{ padding: '10px 12px', color: 'var(--muted)', fontSize: 13, background: 'var(--surface-2)', borderRight: '1px solid var(--border)' }}>
              getthryve.ai/site/
            </span>
            <input
              value={effectiveHandle}
              onChange={(e) => setHandle(slugify(e.target.value))}
              placeholder={autoHandle || 'your-handle'}
              style={{ ...inputStyle, border: 0, borderRadius: 0, flex: 1 }}
            />
          </div>
        </Field>

        <Field label="Starter pack" hint="Each pack is a curated multi-page layout. Switching packs replaces the suggested template + font pair too — you can override below.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {STARTER_PACK_LIST.map((p) => {
              const Icon = Icons[p.icon] || Icons.Globe;
              const previewTpl = TEMPLATES[p.template] || TEMPLATES.clean;
              const active = packId === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    setPackId(p.id);
                    setTplOverride(null);  // pack switch resets the override
                  }}
                  style={{
                    textAlign: 'left', padding: 0,
                    border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 12,
                    background: 'var(--surface)',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    transition: 'border-color .15s',
                  }}>
                  <div style={{
                    height: 70,
                    background: previewTpl.vars['--site-bg'],
                    color: previewTpl.vars['--site-fg'],
                    fontFamily: previewTpl.vars['--site-font-display'],
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: 6, borderBottom: '1px solid var(--border)',
                    position: 'relative',
                  }}>
                    <Icon size={18} sw={1.5} stroke={previewTpl.vars['--site-accent']}/>
                    <span style={{ fontSize: 14, letterSpacing: '-0.01em' }}>{p.label}</span>
                    <div style={{
                      position: 'absolute', bottom: 6, right: 8,
                      width: 10, height: 10, borderRadius: 99,
                      background: previewTpl.vars['--site-accent'],
                    }}/>
                  </div>
                  <div style={{ padding: '10px 12px' }}>
                    <div style={{ fontSize: 13, fontWeight: 550 }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>{p.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </Field>

        {/* Template override — collapsed by default since the pack
            already nominates one. Owners can expand to switch. */}
        <div>
          <button
            type="button"
            onClick={() => setShowTplPicker((v) => !v)}
            style={{
              background: 'transparent', border: 0, padding: 0,
              fontSize: 13, color: 'var(--fg-2)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
            <span style={{
              width: 12, height: 12, borderRadius: 99,
              background: TEMPLATES[tpl]?.vars['--site-accent'],
              display: 'inline-block',
            }}/>
            Template: <strong>{TEMPLATES[tpl]?.name}</strong>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              · {showTplPicker ? 'hide' : 'change'}
            </span>
          </button>
          {showTplPicker && (
            <div style={{
              marginTop: 10,
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10,
            }}>
              {TEMPLATE_LIST.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTplOverride(t.id)}
                  style={{
                    textAlign: 'left', padding: 0,
                    border: `1.5px solid ${tpl === t.id ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 10,
                    background: 'var(--surface)',
                    overflow: 'hidden',
                    cursor: 'pointer',
                  }}>
                  <div style={{
                    height: 60,
                    background: t.vars['--site-bg'],
                    color: t.vars['--site-fg'],
                    fontFamily: t.vars['--site-font-display'],
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderBottom: '1px solid var(--border)',
                    position: 'relative',
                  }}>
                    <div style={{ fontSize: 18, letterSpacing: '-0.02em' }}>Aa</div>
                    <div style={{
                      position: 'absolute', bottom: 6, right: 8,
                      width: 12, height: 12, borderRadius: 99,
                      background: t.vars['--site-accent'],
                      border: `1px solid ${t.vars['--site-border']}`,
                    }}/>
                  </div>
                  <div style={{ padding: '8px 10px' }}>
                    <div style={{ fontSize: 12, fontWeight: 550 }}>{t.name}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Page preview — shows how many pages + the layout the pack
            will produce so the owner doesn't get a surprise. */}
        <div style={{
          padding: 14, borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 12.5, color: 'var(--fg-2)',
        }}>
          <div style={{ fontWeight: 550, marginBottom: 6, color: 'var(--fg)' }}>
            You'll land in the editor with:
          </div>
          {pack.build(name.trim() || 'Your business').map((p, i) => (
            <div key={p.id} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
              <span style={{ color: 'var(--muted)', minWidth: 14 }}>{i + 1}.</span>
              <span style={{ fontWeight: 500 }}>{p.title}</span>
              <span style={{ color: 'var(--muted)' }}>
                — {p.sections.length} section{p.sections.length === 1 ? '' : 's'}
                {p.slug ? ` · /${p.slug}` : ''}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
          <button className="btn btn-primary" onClick={go} disabled={!canLaunch}
            style={{ opacity: canLaunch ? 1 : 0.5 }}>
            Open editor
            <Icons.Arrow size={14} sw={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--border-strong)',
  background: 'var(--surface)',
  outline: 'none',
  fontSize: 14,
  color: 'var(--fg)',
};

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 550, color: 'var(--fg)' }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>}
    </label>
  );
}
