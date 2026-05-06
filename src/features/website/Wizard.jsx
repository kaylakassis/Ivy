import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { TEMPLATE_LIST } from './templates.js';
import { starterSections } from './sections.js';
import { slugify } from './state.js';

// Minimal one-screen setup — name, handle, template — then straight into the editor.
export default function Wizard({ onLaunch }) {
  const [name, setName]     = useState('');
  const [handle, setHandle] = useState('');
  const [tpl, setTpl]       = useState('clean');

  const autoHandle = slugify(name);
  const effectiveHandle = handle || autoHandle;

  const canLaunch = !!name.trim() && !!effectiveHandle;

  const go = () => {
    if (!canLaunch) return;
    onLaunch({
      launched: true,
      businessName: name.trim(),
      handle: effectiveHandle,
      template: tpl,
      sections: starterSections(name.trim()),
    });
  };

  return (
    <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}>
      <div className="card" style={{
        width: '100%', maxWidth: 720, padding: 40,
        display: 'flex', flexDirection: 'column', gap: 28,
      }}>
        <div>
          <div className="metric-label" style={{ marginBottom: 8 }}>Website builder</div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 32 }}>Let&rsquo;s build your site.</h1>
          <p style={{ margin: '8px 0 0', color: 'var(--fg-2)', fontSize: 14, maxWidth: 520 }}>
            Three quick questions, then you&rsquo;ll land in the editor with a starter page ready to customize.
          </p>
        </div>

        <Field label="Business name" hint="Shows in the header and footer.">
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

        <Field label="Template" hint="Pick a starting style — you can tweak colors and fonts later.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            {TEMPLATE_LIST.map((t) => (
              <button
                key={t.id}
                onClick={() => setTpl(t.id)}
                style={{
                  textAlign: 'left', padding: 0,
                  border: `1.5px solid ${tpl === t.id ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 12,
                  background: 'var(--surface)',
                  overflow: 'hidden',
                  transition: 'border-color .15s, transform .05s',
                }}
              >
                <div style={{
                  height: 90,
                  background: t.vars['--site-bg'],
                  color: t.vars['--site-fg'],
                  fontFamily: t.vars['--site-font-display'],
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderBottom: '1px solid var(--border)',
                  position: 'relative',
                }}>
                  <div style={{ fontSize: 20, letterSpacing: '-0.02em' }}>Aa</div>
                  <div style={{
                    position: 'absolute', bottom: 8, right: 8,
                    width: 16, height: 16, borderRadius: 99,
                    background: t.vars['--site-accent'],
                    border: `1px solid ${t.vars['--site-border']}`,
                  }} />
                </div>
                <div style={{ padding: '10px 12px' }}>
                  <div style={{ fontSize: 13, fontWeight: 550 }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.4 }}>{t.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </Field>

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
