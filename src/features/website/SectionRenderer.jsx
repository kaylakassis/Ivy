// Renders a section using the template's CSS variables.
// Used by the editor Canvas AND the public-facing site.
//
// Section-level overrides (set via Inspector):
//   section.variant — which layout to use (e.g. 'left' vs 'center' hero)
//   section.style.background — custom CSS color/gradient/image
//   section.style.padding    — density key from PADDING_DENSITIES
//   section.style.textAlign  — 'left' | 'center' | 'right' override
//
// The wrapper here applies the style overrides as a thin shell around
// whatever the per-section renderer outputs — keeps the renderers focused.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { PADDING_DENSITIES } from './sections.js';

export default function SectionRenderer({ section, handle, editable = false, onUpdate = null }) {
  const Comp = RENDERERS[section.type] || Fallback;
  const style = section.style || {};
  const wrapperStyle = {};
  if (style.background) wrapperStyle.background = style.background;
  if (style.padding && PADDING_DENSITIES[style.padding]) {
    wrapperStyle.padding = PADDING_DENSITIES[style.padding];
  }
  if (style.textAlign) wrapperStyle.textAlign = style.textAlign;
  const hideMobile  = !!style.hideOnMobile;
  const hideDesktop = !!style.hideOnDesktop;
  const hasOverride = Object.keys(wrapperStyle).length > 0 || hideMobile || hideDesktop || style.headlineGradient || style.parallax;
  const rendered = (
    <Comp data={section.data} handle={handle} variant={section.variant} editable={editable} onUpdate={onUpdate}/>
  );
  // Per-section CSS overlays: hide-on-breakpoint + gradient-text on the
  // first h1/h2 of this section + parallax on the first background-image
  // section. All scoped via [data-section-id="..."] so they can't leak.
  const scopedCss = section.id ? [
    hideMobile  ? `@media (max-width: 720px)  { [data-section-id="${section.id}"] { display: none !important; } }` : '',
    hideDesktop ? `@media (min-width: 721px)  { [data-section-id="${section.id}"] { display: none !important; } }` : '',
    style.headlineGradient
      ? `[data-section-id="${section.id}"] h1, [data-section-id="${section.id}"] h2 { background: ${style.headlineGradient}; -webkit-background-clip: text; background-clip: text; color: transparent; }`
      : '',
    style.parallax
      ? `[data-section-id="${section.id}"] section { background-attachment: fixed !important; }`
      : '',
  ].filter(Boolean).join(' ') : '';
  const inner = hasOverride
    ? <div data-section-id={section.id} style={wrapperStyle}>{scopedCss && <style>{scopedCss}</style>}{rendered}</div>
    : rendered;
  // Animation key can be a plain string ('fade') OR an object
  // ({ type, delayMs, durationMs }) for fine-grained control.
  if (!section.animate) return inner;
  const animCfg = typeof section.animate === 'string'
    ? { type: section.animate }
    : section.animate;
  return <AnimateOnView animate={animCfg.type} delayMs={animCfg.delayMs} durationMs={animCfg.durationMs}>{inner}</AnimateOnView>;
}

// Inline-editable text. When `editable` is true the rendered span is
// contentEditable; on blur we commit the new value via `onCommit`. We
// intentionally use `dangerouslySetInnerHTML` ONLY to seed the initial
// text — subsequent renders are skipped (suppressContentEditableWarning)
// to avoid React fighting the cursor on each keystroke.
export function EditableText({ value, onCommit, editable, as = 'span', style }) {
  const ref = React.useRef(null);
  // Keep the DOM text synced when `value` changes externally (e.g. undo)
  // but only when we're NOT actively editing — otherwise we'd clobber
  // the user's typing.
  React.useEffect(() => {
    if (!editable) return;
    const el = ref.current;
    if (!el) return;
    if (document.activeElement !== el && el.innerText !== (value || '')) {
      el.innerText = value || '';
    }
  }, [value, editable]);
  if (!editable) {
    return React.createElement(as, { style }, value);
  }
  const commit = () => {
    const el = ref.current;
    if (!el || !onCommit) return;
    const next = el.innerText;
    if (next !== value) onCommit(next);
  };
  return React.createElement(as, {
    ref,
    contentEditable: true,
    suppressContentEditableWarning: true,
    spellCheck: true,
    onClick: (e) => e.stopPropagation(),
    onMouseDown: (e) => e.stopPropagation(),
    onBlur: commit,
    onKeyDown: (e) => {
      // Enter exits editing for single-line fields (commit + blur).
      // Shift+Enter still inserts a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.currentTarget.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
    style: {
      ...(style || {}),
      outline: 'none',
      cursor: 'text',
      // A faint highlight so users see this is editable. Doesn't
      // interfere with the rendered design.
      boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.06)',
    },
  }, value);
}

// Wraps a section in a div that fades / slides in when scrolled into
// view. Uses IntersectionObserver once per mount; the section stays
// in its visible state after the first reveal so scroll-up doesn't
// re-trigger the animation.
function AnimateOnView({ animate, children, delayMs = 0, durationMs = 700 }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (prefersReducedMotion) { setVisible(true); return; }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
          break;
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [prefersReducedMotion]);

  const off = ANIMATION_OFFSCREEN[animate] || ANIMATION_OFFSCREEN.fade;
  const dur = Math.max(50, Math.min(3000, Number(durationMs) || 700));
  const del = Math.max(0, Math.min(3000, Number(delayMs) || 0));
  const transition = prefersReducedMotion
    ? 'none'
    : `opacity ${dur}ms ease ${del}ms, transform ${dur}ms ease ${del}ms`;
  const styleNow = visible
    ? { opacity: 1, transform: 'none', transition }
    : { ...off, transition };
  return <div ref={ref} style={styleNow}>{children}</div>;
}

const ANIMATION_OFFSCREEN = {
  fade:        { opacity: 0, transform: 'none' },
  rise:        { opacity: 0, transform: 'translateY(28px)' },
  slide_left:  { opacity: 0, transform: 'translateX(-32px)' },
  slide_right: { opacity: 0, transform: 'translateX(32px)' },
  zoom:        { opacity: 0, transform: 'scale(0.97)' },
};

const container = {
  padding: '80px 64px',
  maxWidth: 1200,
  margin: '0 auto',
};

// ---------- Hero ----------
function Hero({ data, variant, editable, onUpdate }) {
  const v = variant || 'center';
  const commit = (key) => (val) => onUpdate && onUpdate({ data: { [key]: val } });
  const ctaBtn = (data.cta || editable) && (
    <a href={editable ? undefined : (data.ctaLink || '#book')}
       style={ctaStyle}
       onClick={editable ? (e) => e.preventDefault() : undefined}>
      <EditableText as="span" value={data.cta || ''} editable={editable} onCommit={commit('cta')}/>
      <span style={{ fontSize: 18, lineHeight: 1 }}>→</span>
    </a>
  );
  const headline = (
    <EditableText as="h1" value={data.headline} editable={editable} onCommit={commit('headline')}
      style={{
        margin: 0, fontFamily: 'var(--site-font-display)',
        fontSize: 'clamp(40px, 5vw, 64px)', fontWeight: 500,
        letterSpacing: '-0.03em', lineHeight: 1.05,
      }}/>
  );
  const sub = (data.sub || editable) && (
    <EditableText as="p" value={data.sub || ''} editable={editable} onCommit={commit('sub')}
      style={{
        margin: '20px 0 0', fontSize: 'clamp(16px, 1.2vw, 20px)',
        color: 'var(--site-fg-2)', lineHeight: 1.55, maxWidth: 560,
      }}/>
  );

  // Split-image: text on left half, image on right (stacks on mobile).
  if (v === 'split_image') {
    return (
      <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
        <div style={{
          maxWidth: 1200, margin: '0 auto',
          padding: '80px 64px',
          display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
          gap: 48, alignItems: 'center',
        }} className="hero-split">
          <div>
            {headline}{sub}
            {ctaBtn && <div style={{ marginTop: 32 }}>{ctaBtn}</div>}
          </div>
          <div style={{
            aspectRatio: '4 / 5', borderRadius: 'var(--site-radius)',
            background: data.imgUrl
              ? `center/cover no-repeat url("${data.imgUrl}")`
              : 'var(--site-surface)',
            border: '1px solid var(--site-border)',
          }}/>
        </div>
      </section>
    );
  }

  // Image background: hero image fills the section, text overlaid.
  if (v === 'image_bg') {
    return (
      <section style={{
        position: 'relative', color: '#fff',
        background: data.imgUrl
          ? `linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.45)), center/cover no-repeat url("${data.imgUrl}")`
          : 'var(--site-fg)',
        padding: '160px 64px', textAlign: 'center', minHeight: 480,
      }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <h1 style={{
            margin: 0, fontFamily: 'var(--site-font-display)',
            fontSize: 'clamp(44px, 6vw, 72px)', fontWeight: 600,
            letterSpacing: '-0.03em', lineHeight: 1.05, color: '#fff',
          }}>{data.headline}</h1>
          {data.sub && (
            <p style={{ margin: '20px auto 0', fontSize: 18, color: 'rgba(255,255,255,0.92)', lineHeight: 1.55, maxWidth: 560 }}>
              {data.sub}
            </p>
          )}
          {ctaBtn && <div style={{ marginTop: 32 }}>{ctaBtn}</div>}
        </div>
      </section>
    );
  }

  // Default — center or left aligned.
  const align = v === 'left' ? 'left' : 'center';
  return (
    <section style={{
      background: 'var(--site-bg)', color: 'var(--site-fg)',
      padding: '120px 64px', textAlign: align,
    }}>
      <div style={{ maxWidth: 760, margin: align === 'center' ? '0 auto' : 0 }}>
        {headline}
        {data.sub && (
          <p style={{
            margin: '20px 0 0', fontSize: 'clamp(16px, 1.2vw, 20px)',
            color: 'var(--site-fg-2)', lineHeight: 1.55, maxWidth: 560,
            marginLeft: align === 'center' ? 'auto' : 0,
            marginRight: align === 'center' ? 'auto' : 0,
          }}>{data.sub}</p>
        )}
        {ctaBtn && <div style={{ marginTop: 32 }}>{ctaBtn}</div>}
      </div>
    </section>
  );
}

const ctaStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  padding: '14px 24px',
  background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
  borderRadius: 'var(--site-radius)', textDecoration: 'none',
  fontWeight: 550, fontSize: 15,
};

// ---------- Services ----------
function Services({ data, variant }) {
  const v = variant || 'grid';
  const items = data.items || [];

  if (v === 'list') {
    // Stacked single-column rows — narrow, scannable, premium feel.
    return (
      <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
        <div style={container}>
          <Heading text={data.headline} sub={data.sub}/>
          <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column' }}>
            {items.map((s, i) => (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'baseline', gap: 24,
                padding: '24px 0',
                borderTop: i === 0 ? '1px solid var(--site-border)' : 'none',
                borderBottom: '1px solid var(--site-border)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 550, fontFamily: 'var(--site-font-display)', letterSpacing: '-0.015em' }}>{s.name}</div>
                  {s.desc && <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--site-fg-2)', lineHeight: 1.55 }}>{s.desc}</p>}
                </div>
                {s.duration && <div style={{ fontSize: 12, color: 'var(--site-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', minWidth: 70 }}>{s.duration}</div>}
                {s.price && <div style={{ fontSize: 22, fontFamily: 'var(--site-font-display)', color: 'var(--site-accent)', minWidth: 90, textAlign: 'right' }}>{s.price}</div>}
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (v === 'cards_image') {
    // Each service card has a hero image at top.
    return (
      <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
        <div style={container}>
          <Heading text={data.headline} sub={data.sub}/>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, items.length))}, 1fr)`,
            gap: 24, marginTop: 40,
          }}>
            {items.map((s) => (
              <div key={s.id} style={{
                background: 'var(--site-surface)',
                border: '1px solid var(--site-border)',
                borderRadius: 'var(--site-radius)',
                overflow: 'hidden',
              }}>
                <div style={{
                  aspectRatio: '16 / 10',
                  background: s.imgUrl
                    ? `center/cover no-repeat url("${s.imgUrl}")`
                    : 'linear-gradient(135deg, var(--site-accent) 0%, var(--site-fg-2) 100%)',
                }}/>
                <div style={{ padding: 24 }}>
                  <div style={{ fontSize: 20, fontWeight: 550, fontFamily: 'var(--site-font-display)' }}>{s.name}</div>
                  {s.duration && <div style={{ fontSize: 12, color: 'var(--site-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.duration}</div>}
                  {s.desc && <p style={{ margin: '12px 0 0', fontSize: 14, color: 'var(--site-fg-2)', lineHeight: 1.55 }}>{s.desc}</p>}
                  {s.price && <div style={{ marginTop: 16, fontSize: 22, fontFamily: 'var(--site-font-display)', color: 'var(--site-accent)' }}>{s.price}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  // Default: grid (3-up)
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        <Heading text={data.headline} sub={data.sub} />
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, items.length || 1))}, 1fr)`,
          gap: 20, marginTop: 40,
        }}>
          {items.map((s) => (
            <div key={s.id} style={{
              padding: 28,
              background: 'var(--site-surface)',
              border: '1px solid var(--site-border)',
              borderRadius: 'var(--site-radius)',
            }}>
              <div style={{ fontSize: 20, fontWeight: 550, fontFamily: 'var(--site-font-display)', letterSpacing: '-0.015em' }}>{s.name}</div>
              {s.duration && <div style={{ fontSize: 12, color: 'var(--site-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.duration}</div>}
              {s.desc && <p style={{ margin: '14px 0 0', fontSize: 14, color: 'var(--site-fg-2)', lineHeight: 1.55 }}>{s.desc}</p>}
              {s.price && (
                <div style={{
                  marginTop: 20, paddingTop: 16,
                  borderTop: '1px solid var(--site-border)',
                  fontSize: 24, fontWeight: 500,
                  fontFamily: 'var(--site-font-display)',
                  color: 'var(--site-accent)',
                }}>{s.price}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- About ----------
function About({ data, editable, onUpdate }) {
  const commit = (key) => (val) => onUpdate && onUpdate({ data: { [key]: val } });
  return (
    <section style={{ background: 'var(--site-surface)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, display: 'grid', gridTemplateColumns: data.imgUrl ? '1fr 1fr' : '1fr', gap: 48, alignItems: 'center' }}>
        <div>
          <Heading text={data.headline} align="left" editable={editable} onCommit={commit('headline')}/>
          <EditableText as="p" value={data.body} editable={editable} onCommit={commit('body')}
            style={{ margin: '20px 0 0', fontSize: 16, lineHeight: 1.7, color: 'var(--site-fg-2)', whiteSpace: 'pre-wrap' }}/>
        </div>
        {data.imgUrl && (
          <div style={{
            aspectRatio: '4/5',
            background: `url(${data.imgUrl}) center/cover`,
            borderRadius: 'var(--site-radius)',
            border: '1px solid var(--site-border)',
          }} />
        )}
      </div>
    </section>
  );
}

// ---------- Booking ----------
function Booking({ data, handle }) {
  const effective = data.handle || handle;
  return (
    <section id="book" style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        <Heading text={data.headline} sub={data.sub} />
        <div style={{
          marginTop: 32,
          padding: 40,
          background: 'var(--site-surface)',
          border: '1px solid var(--site-border)',
          borderRadius: 'var(--site-radius)',
          textAlign: 'center',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 99,
            background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 16,
          }}>
            <Icons.Calendar size={24} sw={1.8} />
          </div>
          <div style={{ fontSize: 15, color: 'var(--site-fg-2)', maxWidth: 480, margin: '0 auto' }}>
            Live booking widget — opens your available times from your calendar.
          </div>
          <a
            href={effective ? `/book/${effective}` : '#'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '12px 22px', marginTop: 20,
              background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
              borderRadius: 'var(--site-radius)', textDecoration: 'none',
              fontWeight: 550, fontSize: 14,
            }}
          >
            Open booking page →
          </a>
          {!effective && (
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--site-muted)' }}>
              Set your handle to activate the live booking link.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- Testimonials ----------
function Testimonials({ data }) {
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        <Heading text={data.headline} />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(2, Math.max(1, data.items?.length || 1))}, 1fr)`, gap: 20, marginTop: 40 }}>
          {(data.items || []).map((t) => (
            <div key={t.id} style={{
              padding: 28,
              background: 'var(--site-surface)',
              border: '1px solid var(--site-border)',
              borderRadius: 'var(--site-radius)',
            }}>
              <div style={{ color: 'var(--site-accent)', letterSpacing: '2px', marginBottom: 12 }}>
                {'★'.repeat(t.rating || 5)}
              </div>
              <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, fontFamily: 'var(--site-font-display)', color: 'var(--site-fg)' }}>
                &ldquo;{t.text}&rdquo;
              </p>
              <div style={{ marginTop: 20, fontSize: 13, fontWeight: 550 }}>{t.name}</div>
              {t.role && <div style={{ fontSize: 12, color: 'var(--site-muted)' }}>{t.role}</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- FAQ ----------
function FAQ({ data }) {
  return (
    <section style={{ background: 'var(--site-surface)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, maxWidth: 780 }}>
        <Heading text={data.headline} />
        <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(data.items || []).map((f) => (
            <details key={f.id} style={{
              background: 'var(--site-bg)',
              border: '1px solid var(--site-border)',
              borderRadius: 'var(--site-radius)',
              padding: '18px 22px',
            }}>
              <summary style={{ cursor: 'pointer', fontWeight: 550, fontSize: 15, listStyle: 'none' }}>
                {f.q}
              </summary>
              <div style={{ marginTop: 12, fontSize: 14, color: 'var(--site-fg-2)', lineHeight: 1.6 }}>
                {f.a}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- Gallery ----------
function Gallery({ data }) {
  const photos = data.photos || [];
  return (
    <section style={{ background: 'var(--site-bg)' }}>
      <div style={container}>
        <Heading text={data.headline} />
        {photos.length === 0 ? (
          <div style={{
            marginTop: 32, padding: 48,
            border: '1px dashed var(--site-border)',
            borderRadius: 'var(--site-radius)',
            textAlign: 'center', color: 'var(--site-muted)', fontSize: 13,
          }}>
            Add photos in the inspector to populate this gallery.
          </div>
        ) : (
          <div style={{ marginTop: 32, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            {photos.map((p, i) => (
              <div key={i} style={{
                aspectRatio: '1/1',
                background: `url(${p}) center/cover`,
                borderRadius: 'var(--site-radius)',
                border: '1px solid var(--site-border)',
              }} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- Contact ----------
// POST a public site form to the form-submission endpoint (email/webhook
// routing + persistence live server-side). Same-origin plain fetch — the
// endpoint is public (no auth). Returns true on success.
async function postSiteForm({ handle, formId, payload, hp }) {
  const res = await fetch('/api/website/form-submission', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, formId, payload, hp }),
  });
  return res.ok;
}

function Contact({ data, handle, editable }) {
  const [vals, setVals] = React.useState({ name: '', email: '', message: '' });
  const [hp, setHp] = React.useState('');
  const [state, setState] = React.useState('idle'); // idle | sending | sent | error
  const set = (k) => (e) => setVals((v) => ({ ...v, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    // Inert in the editor preview (or with no live handle) — only the
    // published site actually delivers submissions.
    if (editable || !handle || state === 'sending' || state === 'sent') return;
    setState('sending');
    try { setState((await postSiteForm({ handle, formId: 'contact', payload: vals, hp })) ? 'sent' : 'error'); }
    catch { setState('error'); }
  };
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, maxWidth: 680 }}>
        <Heading text={data.headline} sub={data.sub} />
        <div style={{ marginTop: 32, display: 'grid', gap: 16 }}>
          {(data.email || data.phone) && (
            <div style={{
              padding: 20,
              background: 'var(--site-surface)',
              border: '1px solid var(--site-border)',
              borderRadius: 'var(--site-radius)',
              display: 'grid', gap: 8, fontSize: 14,
            }}>
              {data.email && <div><strong style={{ color: 'var(--site-muted)', fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Email</strong><br />{data.email}</div>}
              {data.phone && <div><strong style={{ color: 'var(--site-muted)', fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Phone</strong><br />{data.phone}</div>}
            </div>
          )}
          {data.showForm !== false && (state === 'sent' ? (
            <div style={{
              padding: 20, borderRadius: 'var(--site-radius)',
              background: 'var(--site-surface)', border: '1px solid var(--site-border)',
              fontSize: 15, color: 'var(--site-fg)',
            }}>{data.successMessage || "Thanks — we'll be in touch shortly."}</div>
          ) : (
            <form style={{ display: 'grid', gap: 12 }} onSubmit={submit}>
              <input placeholder="Your name" style={siteInput} value={vals.name} onChange={set('name')} />
              <input placeholder="Email" type="email" required style={siteInput} value={vals.email} onChange={set('email')} />
              <textarea placeholder="Message" rows={5} style={{ ...siteInput, resize: 'vertical' }} value={vals.message} onChange={set('message')} />
              {/* Honeypot — hidden from humans; bots that fill it are dropped server-side. */}
              <input tabIndex={-1} autoComplete="off" aria-hidden="true" value={hp} onChange={(e) => setHp(e.target.value)}
                style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
              {state === 'error' && <div style={{ fontSize: 13, color: 'var(--site-accent)' }}>Couldn’t send — please try again.</div>}
              <button type="submit" disabled={state === 'sending'} style={{
                padding: '12px 22px',
                background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
                border: 0, borderRadius: 'var(--site-radius)',
                fontWeight: 550, fontSize: 14, cursor: 'pointer', justifySelf: 'start',
                opacity: state === 'sending' ? 0.7 : 1,
              }}>{state === 'sending' ? 'Sending…' : 'Send message'}</button>
            </form>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- Footer ----------
function Footer({ data }) {
  return (
    <footer style={{
      background: 'var(--site-surface)',
      color: 'var(--site-fg-2)',
      borderTop: '1px solid var(--site-border)',
      padding: '40px 64px',
    }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--site-font-display)', fontSize: 20, fontWeight: 500, color: 'var(--site-fg)' }}>
            {data.businessName}
          </div>
          {data.tagline && <div style={{ fontSize: 13, color: 'var(--site-muted)', marginTop: 4 }}>{data.tagline}</div>}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: 'var(--site-muted)' }}>
          © {data.year} {data.businessName}. Built with THRYVE.
        </div>
      </div>
    </footer>
  );
}

// ---------- Shared ----------
function Heading({ text, sub, align = 'center', editable = false, onCommit = null, onCommitSub = null }) {
  return (
    <div style={{ textAlign: align }}>
      <EditableText as="h2" value={text} editable={editable} onCommit={onCommit}
        style={{
          margin: 0,
          fontFamily: 'var(--site-font-display)',
          fontSize: 'clamp(28px, 3.4vw, 40px)',
          fontWeight: 500,
          letterSpacing: '-0.025em',
          lineHeight: 1.1,
        }}/>
      {(sub || (editable && onCommitSub)) && (
        <EditableText as="p" value={sub || ''} editable={editable && !!onCommitSub} onCommit={onCommitSub}
          style={{ margin: '12px auto 0', maxWidth: 560, color: 'var(--site-fg-2)', fontSize: 15, lineHeight: 1.55 }}/>
      )}
    </div>
  );
}

function Fallback({ data }) {
  return (
    <section style={{ padding: 48, textAlign: 'center', color: 'var(--site-muted)' }}>
      Unsupported section: {JSON.stringify(data)}
    </section>
  );
}

const siteInput = {
  width: '100%',
  padding: '12px 14px',
  background: 'var(--site-surface)',
  border: '1px solid var(--site-border)',
  borderRadius: 'var(--site-radius)',
  fontSize: 14,
  color: 'var(--site-fg)',
  outline: 'none',
};

// ---------- Stats ----------
function Stats({ data, editable, onUpdate }) {
  const items = data.items || [];
  const commit = (key) => (val) => onUpdate && onUpdate({ data: { [key]: val } });
  return (
    <section style={{ background: 'var(--site-surface)', color: 'var(--site-fg)' }}>
      <div style={container}>
        {(data.headline || editable) && <Heading text={data.headline || ''} sub={data.sub} editable={editable} onCommit={commit('headline')} onCommitSub={commit('sub')}/>}
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(4, Math.max(1, items.length || 1))}, 1fr)`,
          gap: 24, marginTop: data.headline ? 40 : 0,
          textAlign: 'center',
        }}>
          {items.map((it) => (
            <div key={it.id} style={{ padding: '20px 8px' }}>
              <div style={{
                fontFamily: 'var(--site-font-display)',
                fontSize: 'clamp(40px, 5vw, 64px)', fontWeight: 500,
                letterSpacing: '-0.03em', color: 'var(--site-accent)', lineHeight: 1,
              }}>{it.value}</div>
              <div style={{ marginTop: 10, fontSize: 13, color: 'var(--site-fg-2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {it.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- CTA banner ----------
function CtaBanner({ data, editable, onUpdate }) {
  const commit = (key) => (val) => onUpdate && onUpdate({ data: { [key]: val } });
  return (
    <section style={{
      background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
    }}>
      <div style={{
        maxWidth: 900, margin: '0 auto', padding: '80px 64px', textAlign: 'center',
      }}>
        <EditableText as="h2" value={data.headline} editable={editable} onCommit={commit('headline')}
          style={{
            margin: 0, fontFamily: 'var(--site-font-display)',
            fontSize: 'clamp(32px, 4vw, 48px)', fontWeight: 500,
            letterSpacing: '-0.02em', lineHeight: 1.1,
          }}/>
        {(data.sub || editable) && (
          <EditableText as="p" value={data.sub || ''} editable={editable} onCommit={commit('sub')}
            style={{ margin: '20px auto 0', fontSize: 18, lineHeight: 1.55, maxWidth: 560, opacity: 0.92 }}/>
        )}
        {(data.cta || editable) && (
          <div style={{ marginTop: 32 }}>
            <a href={editable ? undefined : (data.ctaLink || '#book')}
              onClick={editable ? (e) => e.preventDefault() : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '14px 26px', fontSize: 15, fontWeight: 600,
                background: 'var(--site-accent-ink)', color: 'var(--site-accent)',
                borderRadius: 'var(--site-radius)', textDecoration: 'none',
              }}>
              <EditableText as="span" value={data.cta || ''} editable={editable} onCommit={commit('cta')}/>
              <span style={{ fontSize: 18, lineHeight: 1 }}>→</span>
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- Team ----------
function Team({ data }) {
  const members = data.members || [];
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        <Heading text={data.headline}/>
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, members.length || 1))}, 1fr)`,
          gap: 32, marginTop: 40,
        }}>
          {members.map((m) => (
            <div key={m.id}>
              <div style={{
                aspectRatio: '1 / 1', borderRadius: '50%',
                margin: '0 auto', maxWidth: 200,
                background: m.imgUrl
                  ? `center/cover no-repeat url("${m.imgUrl}")`
                  : 'linear-gradient(135deg, var(--site-accent), var(--site-fg-2))',
                border: '1px solid var(--site-border)',
              }}/>
              <div style={{ marginTop: 18, textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 550, fontFamily: 'var(--site-font-display)' }}>{m.name}</div>
                <div style={{ fontSize: 12, color: 'var(--site-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{m.role}</div>
                {m.bio && <p style={{ margin: '14px 0 0', fontSize: 14, color: 'var(--site-fg-2)', lineHeight: 1.55 }}>{m.bio}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- Pricing ----------
function Pricing({ data }) {
  const tiers = data.tiers || [];
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        <Heading text={data.headline} sub={data.sub}/>
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, tiers.length || 1))}, 1fr)`,
          gap: 20, marginTop: 40, alignItems: 'stretch',
        }}>
          {tiers.map((t) => (
            <div key={t.id} style={{
              padding: 32,
              background: t.featured ? 'var(--site-accent)' : 'var(--site-surface)',
              color: t.featured ? 'var(--site-accent-ink)' : 'var(--site-fg)',
              border: '1px solid var(--site-border)',
              borderRadius: 'var(--site-radius)',
              display: 'flex', flexDirection: 'column', gap: 16,
              transform: t.featured ? 'scale(1.02)' : 'none',
              boxShadow: t.featured ? '0 12px 32px rgba(0,0,0,0.12)' : 'none',
            }}>
              <div>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.75 }}>{t.name}</div>
                <div style={{
                  marginTop: 8, fontFamily: 'var(--site-font-display)',
                  fontSize: 'clamp(28px, 3vw, 40px)', fontWeight: 500, letterSpacing: '-0.02em',
                }}>{t.price}</div>
                {t.description && <p style={{ margin: '8px 0 0', fontSize: 14, opacity: 0.85 }}>{t.description}</p>}
              </div>
              {Array.isArray(t.features) && t.features.length > 0 && (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {t.features.map((f, i) => (
                    <li key={i} style={{
                      fontSize: 14, lineHeight: 1.5,
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                    }}>
                      <span style={{ flexShrink: 0, opacity: 0.7 }}>✓</span> {f}
                    </li>
                  ))}
                </ul>
              )}
              {t.ctaText && (
                <a href={t.ctaLink || '#book'} style={{
                  display: 'block', textAlign: 'center',
                  padding: '12px 18px', borderRadius: 'var(--site-radius)',
                  background: t.featured ? 'var(--site-accent-ink)' : 'var(--site-accent)',
                  color: t.featured ? 'var(--site-accent)' : 'var(--site-accent-ink)',
                  textDecoration: 'none', fontWeight: 600, fontSize: 14,
                  marginTop: 'auto',
                }}>{t.ctaText}</a>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- Newsletter ----------
function Newsletter({ data, handle, editable }) {
  const [email, setEmail] = React.useState('');
  const [hp, setHp] = React.useState('');
  const [state, setState] = React.useState('idle'); // idle | sending | sent | error
  const submit = async (e) => {
    e.preventDefault();
    if (editable || !handle || state === 'sending' || state === 'sent') return;
    setState('sending');
    try { setState((await postSiteForm({ handle, formId: 'newsletter', payload: { email }, hp })) ? 'sent' : 'error'); }
    catch { setState('error'); }
  };
  return (
    <section style={{ background: 'var(--site-surface)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, maxWidth: 640, textAlign: 'center' }}>
        <h2 style={{
          margin: 0, fontFamily: 'var(--site-font-display)',
          fontSize: 'clamp(28px, 3.5vw, 40px)', fontWeight: 500, letterSpacing: '-0.02em',
        }}>{data.headline}</h2>
        {data.sub && (
          <p style={{ margin: '14px 0 0', fontSize: 16, color: 'var(--site-fg-2)', lineHeight: 1.55 }}>
            {data.sub}
          </p>
        )}
        {state === 'sent' ? (
          <div style={{ marginTop: 24, fontSize: 15, color: 'var(--site-fg)' }}>
            {data.successMessage || "You're subscribed — thanks!"}
          </div>
        ) : (
          <form onSubmit={submit} style={{
            marginTop: 28, display: 'flex', gap: 8,
            maxWidth: 480, marginInline: 'auto',
          }}>
            <input type="email" required placeholder={data.placeholder || 'you@example.com'}
              value={email} onChange={(e) => setEmail(e.target.value)}
              style={{
                flex: 1, padding: '12px 14px', fontSize: 15,
                border: '1px solid var(--site-border)',
                borderRadius: 'var(--site-radius)',
                background: 'var(--site-bg)', color: 'var(--site-fg)',
                outline: 'none',
              }}/>
            <input tabIndex={-1} autoComplete="off" aria-hidden="true" value={hp} onChange={(e) => setHp(e.target.value)}
              style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
            <button type="submit" disabled={state === 'sending'} style={{
              padding: '12px 18px', fontSize: 14, fontWeight: 600,
              background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
              border: 0, borderRadius: 'var(--site-radius)', cursor: 'pointer',
              opacity: state === 'sending' ? 0.7 : 1,
            }}>{state === 'sending' ? '…' : (data.buttonText || 'Subscribe')}</button>
          </form>
        )}
        {state === 'error' && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--site-accent)' }}>Couldn’t subscribe — please try again.</div>}
      </div>
    </section>
  );
}

// ---------- Video ----------
function Video({ data }) {
  const embedUrl = toEmbedUrl(data.videoUrl);
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        {(data.headline || data.sub) && (
          <Heading text={data.headline} sub={data.sub}/>
        )}
        <div style={{
          marginTop: data.headline ? 32 : 0,
          aspectRatio: '16 / 9',
          background: 'var(--site-surface)',
          border: '1px solid var(--site-border)',
          borderRadius: 'var(--site-radius)',
          overflow: 'hidden',
        }}>
          {embedUrl ? (
            <iframe src={embedUrl} title="Embedded video"
              style={{ width: '100%', height: '100%', border: 0 }}
              allowFullScreen
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"/>
          ) : (
            <div style={{
              width: '100%', height: '100%', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              fontSize: 13, color: 'var(--site-muted)',
            }}>
              Paste a YouTube or Vimeo URL in the Inspector to embed the video.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// Convert YouTube / Vimeo watch URLs into the corresponding embed URL.
// Returns null when the URL doesn't match a known provider.
function toEmbedUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/embed/${v}`;
    }
    if (host === 'youtu.be') {
      return `https://www.youtube.com/embed${u.pathname}`;
    }
    if (host === 'vimeo.com') {
      const id = u.pathname.replace(/^\//, '');
      if (/^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
    }
    // Generic — assume the URL is already an embed URL.
    return url;
  } catch { return null; }
}

// ---------- Featured-in logos ----------
function Logos({ data }) {
  const logos = data.logos || [];
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        {data.headline && (
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--site-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 28 }}>
            {data.headline}
          </div>
        )}
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
          gap: 48, opacity: 0.75,
        }}>
          {logos.map((l) => (
            l.imgUrl ? (
              <img key={l.id} src={l.imgUrl} alt={l.name}
                style={{ height: 32, width: 'auto', filter: 'grayscale(100%)' }}/>
            ) : (
              <div key={l.id} style={{
                fontFamily: 'var(--site-font-display)', fontSize: 22, fontWeight: 500,
                letterSpacing: '-0.01em', color: 'var(--site-fg-2)',
              }}>{l.name}</div>
            )
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- Pricing comparison table ----------
function PricingTable({ data }) {
  const tiers = data.tiers || [];
  const rows  = data.rows || [];
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        <Heading text={data.headline} sub={data.sub}/>
        <div style={{
          marginTop: 36, overflowX: 'auto',
          borderRadius: 'var(--site-radius)',
          border: '1px solid var(--site-border)',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 540 }}>
            <thead>
              <tr style={{ background: 'var(--site-surface)' }}>
                <th style={{ padding: '16px 20px', textAlign: 'left', fontWeight: 500, fontSize: 13, color: 'var(--site-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  &nbsp;
                </th>
                {tiers.map((t) => (
                  <th key={t} style={{
                    padding: '16px 20px', textAlign: 'center',
                    fontFamily: 'var(--site-font-display)',
                    fontSize: 18, fontWeight: 550,
                  }}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--site-border)' }}>
                  <td style={{ padding: '14px 20px', fontSize: 14, color: 'var(--site-fg-2)' }}>{r.label}</td>
                  {(r.values || []).map((v, i) => (
                    <td key={i} style={{
                      padding: '14px 20px', textAlign: 'center',
                      fontSize: 14, color: v ? 'var(--site-fg)' : 'var(--site-muted)',
                    }}>{v || '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---------- Blog / posts strip ----------
function Blog({ data }) {
  const posts = data.posts || [];
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        <Heading text={data.headline} sub={data.sub}/>
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, posts.length || 1))}, 1fr)`,
          gap: 24, marginTop: 40,
        }}>
          {posts.map((p) => (
            <a key={p.id} href={p.url || '#'} style={{
              textDecoration: 'none', color: 'inherit',
              padding: 24,
              background: 'var(--site-surface)',
              border: '1px solid var(--site-border)',
              borderRadius: 'var(--site-radius)',
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              {p.date && (
                <div style={{ fontSize: 11.5, color: 'var(--site-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  {fmtDate(p.date)}
                </div>
              )}
              <div style={{
                fontFamily: 'var(--site-font-display)', fontSize: 22, fontWeight: 500,
                letterSpacing: '-0.015em', lineHeight: 1.2,
              }}>{p.title}</div>
              {p.excerpt && (
                <p style={{ margin: 0, fontSize: 14, color: 'var(--site-fg-2)', lineHeight: 1.55 }}>
                  {p.excerpt}
                </p>
              )}
              <span style={{ fontSize: 13, color: 'var(--site-accent)', marginTop: 4 }}>Read →</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

// ---------- Instagram embed ----------
function Instagram({ data }) {
  // We use Instagram's official oEmbed-style iframe pattern. The URL
  // can be a post (/p/<id>/) or a reel (/reel/<id>/). For a profile
  // link, we fall back to a "View on Instagram" CTA card since IG
  // doesn't allow embedding profile feeds without their JS SDK.
  const url = String(data.url || '').trim();
  const isPost = /\/(p|reel)\//.test(url);
  const embed = isPost ? `${url.replace(/\/$/, '')}/embed` : null;
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, maxWidth: 560, textAlign: 'center' }}>
        {data.headline && <Heading text={data.headline} sub={data.sub}/>}
        <div style={{ marginTop: data.headline ? 32 : 0 }}>
          {embed ? (
            <iframe src={embed} title="Instagram embed" style={{
              width: '100%', maxWidth: 540, minHeight: 600, border: 0,
              borderRadius: 'var(--site-radius)',
              background: 'var(--site-surface)',
            }} allowFullScreen scrolling="no"/>
          ) : url ? (
            <a href={url} target="_blank" rel="noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '14px 22px',
              background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
              borderRadius: 'var(--site-radius)', textDecoration: 'none', fontWeight: 600,
            }}>
              View on Instagram →
            </a>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--site-muted)' }}>
              Paste an Instagram post or reel URL in the Inspector.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- Code / pre-formatted block ----------
function CodeSnippet({ data }) {
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        {data.headline && <Heading text={data.headline}/>}
        <div style={{
          marginTop: data.headline ? 24 : 0,
          background: '#0E1116',
          border: '1px solid var(--site-border)',
          borderRadius: 'var(--site-radius)',
          padding: 0, overflow: 'hidden',
        }}>
          {data.language && (
            <div style={{
              padding: '8px 18px',
              background: 'rgba(255,255,255,0.04)',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: '#9EA9B5', textTransform: 'lowercase', letterSpacing: '0.05em',
            }}>{data.language}</div>
          )}
          <pre style={{
            margin: 0, padding: 20,
            color: '#D1D8DF',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 13, lineHeight: 1.55,
            overflowX: 'auto',
            whiteSpace: 'pre',
          }}>{data.code || ''}</pre>
        </div>
      </div>
    </section>
  );
}

// ---------- Countdown ----------
function Countdown({ data }) {
  const target = useMemo(() => new Date(data.endDate || Date.now()).getTime(), [data.endDate]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const diff = Math.max(0, target - now);
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  const parts = [['d', d], ['h', h], ['m', m], ['s', s]];
  return (
    <section style={{ background: 'var(--site-surface)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, textAlign: 'center' }}>
        {(data.headline || data.sub) && <Heading text={data.headline} sub={data.sub}/>}
        <div style={{
          marginTop: data.headline ? 36 : 0,
          display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          {parts.map(([lbl, n]) => (
            <div key={lbl} style={{
              minWidth: 88, padding: '18px 14px',
              background: 'var(--site-bg)',
              border: '1px solid var(--site-border)',
              borderRadius: 'var(--site-radius)',
            }}>
              <div style={{ fontSize: 'clamp(28px,4vw,42px)', fontFamily: 'var(--site-font-display)', fontWeight: 500, lineHeight: 1 }}>{String(n).padStart(2, '0')}</div>
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--site-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{lbl}</div>
            </div>
          ))}
        </div>
        {data.cta && (
          <div style={{ marginTop: 32 }}>
            <a href={data.ctaLink || '#'} style={ctaStyle}>
              {data.cta} <span style={{ fontSize: 18, lineHeight: 1 }}>→</span>
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- Hours ----------
function Hours({ data }) {
  const rows = data.days || [];
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, maxWidth: 560 }}>
        {data.headline && <Heading text={data.headline}/>}
        {data.timezone && (
          <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12, color: 'var(--site-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{data.timezone}</div>
        )}
        <table style={{ width: '100%', marginTop: 28, borderCollapse: 'collapse', fontSize: 15 }}>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--site-border)' }}>
                <td style={{ padding: '14px 4px', fontWeight: 600, color: 'var(--site-fg)' }}>{r.label}</td>
                <td style={{ padding: '14px 4px', color: 'var(--site-fg-2)', textAlign: 'right' }}>{r.hours}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- Map (OpenStreetMap iframe — no API key required) ----------
function Map({ data }) {
  const zoom = Number(data.zoom) || 14;
  const lat  = Number(data.lat) || 0;
  const lng  = Number(data.lng) || 0;
  const span = 0.01 / Math.max(0.5, zoom / 14);
  // OSM expects bbox=lonMin,latMin,lonMax,latMax.
  const bbox = [lng - span, lat - span, lng + span, lat + span].join(',');
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        {data.headline && <Heading text={data.headline} sub={data.address}/>}
        <div style={{ marginTop: data.headline ? 32 : 0, borderRadius: 'var(--site-radius)', overflow: 'hidden', border: '1px solid var(--site-border)' }}>
          <iframe title="Map" src={src} style={{ width: '100%', height: 360, border: 0 }} loading="lazy"/>
        </div>
      </div>
    </section>
  );
}

// ---------- Accordion (collapsible FAQ) ----------
function Accordion({ data }) {
  const items = data.items || [];
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, maxWidth: 760 }}>
        {data.headline && <Heading text={data.headline}/>}
        <div style={{ marginTop: data.headline ? 32 : 0 }}>
          {items.map((it) => (
            <details key={it.id} style={{
              padding: '16px 18px',
              borderBottom: '1px solid var(--site-border)',
            }}>
              <summary style={{ cursor: 'pointer', fontWeight: 550, fontSize: 16, fontFamily: 'var(--site-font-display)', listStyle: 'none' }}>
                {it.q}
              </summary>
              <p style={{ margin: '12px 0 0', color: 'var(--site-fg-2)', lineHeight: 1.6, fontSize: 15 }}>{it.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- Process / How it works ----------
function Process({ data }) {
  const steps = data.steps || [];
  return (
    <section style={{ background: 'var(--site-surface)', color: 'var(--site-fg)' }}>
      <div style={container}>
        {(data.headline || data.sub) && <Heading text={data.headline} sub={data.sub}/>}
        <div style={{
          marginTop: data.headline ? 40 : 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, steps.length || 1))}, 1fr)`,
          gap: 28,
        }}>
          {steps.map((s) => (
            <div key={s.id} style={{ padding: '24px 20px', background: 'var(--site-bg)', border: '1px solid var(--site-border)', borderRadius: 'var(--site-radius)' }}>
              <div style={{ fontFamily: 'var(--site-font-display)', fontSize: 28, color: 'var(--site-accent)', fontWeight: 500, lineHeight: 1 }}>{s.number}</div>
              <div style={{ marginTop: 14, fontSize: 18, fontWeight: 550, color: 'var(--site-fg)' }}>{s.title}</div>
              <p style={{ margin: '8px 0 0', color: 'var(--site-fg-2)', fontSize: 14, lineHeight: 1.6 }}>{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- Before / after ----------
function BeforeAfter({ data }) {
  const card = (url, label) => (
    <div style={{
      position: 'relative', aspectRatio: '4/5',
      borderRadius: 'var(--site-radius)', overflow: 'hidden',
      background: url ? `center/cover no-repeat url("${url}")` : 'var(--site-surface)',
      border: '1px solid var(--site-border)',
    }}>
      <div style={{
        position: 'absolute', top: 12, left: 12,
        padding: '4px 10px', borderRadius: 99,
        background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 11,
        letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600,
      }}>{label}</div>
    </div>
  );
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        {(data.headline || data.sub) && <Heading text={data.headline} sub={data.sub}/>}
        <div style={{ marginTop: data.headline ? 32 : 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {card(data.beforeUrl, data.beforeLabel || 'Before')}
          {card(data.afterUrl,  data.afterLabel  || 'After')}
        </div>
      </div>
    </section>
  );
}

// ---------- Social feed (generic embed) ----------
function SocialFeed({ data }) {
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, maxWidth: 720, textAlign: 'center' }}>
        {(data.headline || data.sub) && <Heading text={data.headline} sub={data.sub}/>}
        <div style={{ marginTop: data.headline ? 28 : 0 }}>
          {data.url ? (
            <a href={data.url} target="_blank" rel="noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 10,
              padding: '14px 24px',
              background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
              borderRadius: 'var(--site-radius)', textDecoration: 'none', fontWeight: 600,
            }}>
              View on {data.platform || 'social'} →
            </a>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--site-muted)' }}>
              Paste a {data.platform || 'social'} URL in the Inspector.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- Custom HTML (sandboxed iframe) ----------
function CustomHtml({ data }) {
  const html = String(data.html || '');
  const height = Math.max(80, Math.min(2000, Number(data.height) || 280));
  return (
    <section style={{ background: 'var(--site-bg)' }}>
      <iframe
        title="Custom embed"
        srcDoc={`<!doctype html><html><body style="margin:0">${html}</body></html>`}
        sandbox=""
        style={{ width: '100%', height, border: 0, display: 'block' }}
      />
    </section>
  );
}

// Shop section: live product grid + add-to-cart. Read-only — owners
// edit the catalog in Finance → Products, not the section editor.
// Cart state lives in sessionStorage keyed by handle so a refresh
// doesn't dump it. Checkout POSTs to /api/site/:handle/checkout which
// resolves to a Stripe Checkout Session URL the browser navigates to.
function Shop({ section, handle }) {
  const { headline = 'Shop', sub = '', showOutOfStock = false } = section.props || {};
  const [products, setProducts] = React.useState(null);
  const [err, setErr]           = React.useState(null);
  const [cart, setCart]         = React.useState({});           // { productId: qty }
  const [cartOpen, setCartOpen] = React.useState(false);
  const [busy, setBusy]         = React.useState(false);
  const [customerName, setName] = React.useState('');
  const [customerEmail, setEmail] = React.useState('');
  const cartKey = `thryve:cart:${handle || 'preview'}`;

  React.useEffect(() => {
    if (!handle) return;
    fetch(`/api/site/${encodeURIComponent(handle)}/products`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error('Failed to load')))
      .then((j) => setProducts(j.products || []))
      .catch((e) => setErr(e.message || 'Failed'));
    try {
      const stored = JSON.parse(sessionStorage.getItem(cartKey) || '{}');
      if (stored && typeof stored === 'object') setCart(stored);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  React.useEffect(() => {
    try { sessionStorage.setItem(cartKey, JSON.stringify(cart)); } catch { /* quota */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart]);

  const visible = (products || []).filter((p) => showOutOfStock || p.inStock);
  const cartItems = (products || [])
    .filter((p) => (cart[p.id] || 0) > 0)
    .map((p) => ({ ...p, qty: cart[p.id] }));
  const cartCount = cartItems.reduce((n, x) => n + x.qty, 0);
  const cartTotal = cartItems.reduce((n, x) => n + (x.price * x.qty), 0);

  const add = (id) => setCart((c) => ({ ...c, [id]: (c[id] || 0) + 1 }));
  const dec = (id) => setCart((c) => {
    const next = { ...c, [id]: Math.max(0, (c[id] || 0) - 1) };
    if (next[id] === 0) delete next[id];
    return next;
  });

  const checkout = async () => {
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim());
    if (!customerName.trim() || !validEmail) {
      // eslint-disable-next-line no-alert
      window.alert('Name and a valid email are required.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/site/${encodeURIComponent(handle)}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cartItems.map((x) => ({ productId: x.id, qty: x.qty })),
          customer: { name: customerName.trim(), email: customerEmail.trim() },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Checkout failed');
      // Clear cart before navigating so a back-button doesn't show
      // a stale "x in cart" pill.
      try { sessionStorage.removeItem(cartKey); } catch { /* ignore */ }
      window.location.assign(j.url);
    } catch (e) {
      // eslint-disable-next-line no-alert
      window.alert(e.message || 'Checkout failed.');
    } finally { setBusy(false); }
  };

  return (
    <section style={{ padding: '48px 24px', position: 'relative' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <h2 style={{ fontSize: 28, margin: '0 0 6px', textAlign: 'center' }}>{headline}</h2>
        {sub && <p style={{ color: '#666', textAlign: 'center', marginTop: 0, marginBottom: 24 }}>{sub}</p>}
        {err && <div style={{ color: '#b22', textAlign: 'center' }}>{err}</div>}
        {products === null && !err && (
          <div style={{ color: '#888', textAlign: 'center' }}>Loading…</div>
        )}
        {products && visible.length === 0 && (
          <div style={{ color: '#888', textAlign: 'center' }}>No products yet.</div>
        )}

        <div style={{ display: 'grid', gap: 18,
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))' }}>
          {visible.map((p) => {
            const inCart = cart[p.id] || 0;
            const disabled = !p.inStock;
            return (
              <div key={p.id} style={{
                border: '1px solid #e6e2d6', borderRadius: 12, overflow: 'hidden',
                background: '#fff', display: 'flex', flexDirection: 'column',
              }}>
                {p.photoUrl && (
                  <div style={{ aspectRatio: '1 / 1', background: '#f6f5f1' }}>
                    <img src={p.photoUrl} alt={p.name}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}/>
                  </div>
                )}
                <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</div>
                  {p.description && (
                    <div style={{ fontSize: 12.5, color: '#666', lineHeight: 1.45 }}>{p.description}</div>
                  )}
                  <div style={{ fontSize: 15, color: '#000', marginTop: 'auto', paddingTop: 8, fontWeight: 600 }}>
                    ${Number(p.price).toFixed(2)}
                  </div>
                  {inCart === 0 ? (
                    <button onClick={() => add(p.id)} disabled={disabled}
                      style={{
                        marginTop: 6, padding: '8px 12px', borderRadius: 8,
                        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
                        background: disabled ? '#ddd' : '#0e0e0e', color: '#fff',
                        fontSize: 13, fontWeight: 600,
                      }}>
                      {disabled ? 'Out of stock' : 'Add to cart'}
                    </button>
                  ) : (
                    <div style={{
                      marginTop: 6, display: 'flex', alignItems: 'center', gap: 8,
                      border: '1px solid #ccc', borderRadius: 8, padding: 4,
                    }}>
                      <button onClick={() => dec(p.id)} style={{ width: 28, height: 28, border: 'none', cursor: 'pointer', background: 'transparent' }}>−</button>
                      <div style={{ flex: 1, textAlign: 'center', fontSize: 13 }}>{inCart}</div>
                      <button onClick={() => add(p.id)} style={{ width: 28, height: 28, border: 'none', cursor: 'pointer', background: 'transparent' }}>+</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {cartCount > 0 && !cartOpen && (
        <button onClick={() => setCartOpen(true)} style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 9990,
          padding: '12px 18px', borderRadius: 999, border: 'none', cursor: 'pointer',
          background: '#0e0e0e', color: '#fff', fontSize: 14, fontWeight: 600,
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        }}>
          🛒 {cartCount} · ${cartTotal.toFixed(2)}
        </button>
      )}

      {cartOpen && (
        <div onClick={() => setCartOpen(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9991,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: '#fff', borderRadius: 14, padding: 24,
            width: '100%', maxWidth: 480, maxHeight: '90vh', overflow: 'auto',
          }}>
            <h3 style={{ margin: '0 0 14px', fontSize: 18 }}>Your cart</h3>
            {cartItems.length === 0 ? (
              <div style={{ color: '#888', fontSize: 13 }}>Empty.</div>
            ) : (
              <>
                {cartItems.map((it) => (
                  <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between',
                    padding: '8px 0', borderBottom: '1px solid #eee', fontSize: 14 }}>
                    <span>{it.qty}× {it.name}</span>
                    <span>${(it.price * it.qty).toFixed(2)}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between',
                  fontWeight: 600, fontSize: 15, marginTop: 10 }}>
                  <span>Total</span>
                  <span>${cartTotal.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
                  <input value={customerName} onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #ccc', fontSize: 14 }}/>
                  <input value={customerEmail} onChange={(e) => setEmail(e.target.value)}
                    type="email" placeholder="Email"
                    style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #ccc', fontSize: 14 }}/>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <button onClick={() => setCartOpen(false)}
                    style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid #ccc',
                      background: '#fff', cursor: 'pointer' }}>
                    Keep shopping
                  </button>
                  <button onClick={checkout} disabled={busy || cartItems.length === 0}
                    style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none',
                      background: '#0e0e0e', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
                    {busy ? 'Redirecting…' : 'Checkout'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const RENDERERS = {
  hero: Hero,
  services: Services,
  shop: Shop,
  about: About,
  booking: Booking,
  testimonials: Testimonials,
  faq: FAQ,
  gallery: Gallery,
  contact: Contact,
  footer: Footer,
  stats: Stats,
  cta_banner: CtaBanner,
  team: Team,
  pricing: Pricing,
  newsletter: Newsletter,
  video: Video,
  logos: Logos,
  pricing_table: PricingTable,
  blog: Blog,
  instagram: Instagram,
  code_snippet: CodeSnippet,
  countdown:    Countdown,
  hours:        Hours,
  map:          Map,
  accordion:    Accordion,
  process:      Process,
  before_after: BeforeAfter,
  social_feed:  SocialFeed,
  custom_html:  CustomHtml,
};
