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
import React from 'react';
import { Icons } from '../../components/Icons.jsx';
import { PADDING_DENSITIES } from './sections.js';

export default function SectionRenderer({ section, handle }) {
  const Comp = RENDERERS[section.type] || Fallback;
  const style = section.style || {};
  const wrapperStyle = {};
  if (style.background) wrapperStyle.background = style.background;
  if (style.padding && PADDING_DENSITIES[style.padding]) {
    wrapperStyle.padding = PADDING_DENSITIES[style.padding];
  }
  if (style.textAlign) wrapperStyle.textAlign = style.textAlign;
  const hasOverride = Object.keys(wrapperStyle).length > 0;
  const rendered = (
    <Comp data={section.data} handle={handle} variant={section.variant}/>
  );
  return hasOverride ? <div style={wrapperStyle}>{rendered}</div> : rendered;
}

const container = {
  padding: '80px 64px',
  maxWidth: 1200,
  margin: '0 auto',
};

// ---------- Hero ----------
function Hero({ data, variant }) {
  const v = variant || 'center';
  const ctaBtn = data.cta && (
    <a href={data.ctaLink || '#book'} style={ctaStyle}>
      {data.cta} <span style={{ fontSize: 18, lineHeight: 1 }}>→</span>
    </a>
  );
  const headline = (
    <h1 style={{
      margin: 0, fontFamily: 'var(--site-font-display)',
      fontSize: 'clamp(40px, 5vw, 64px)', fontWeight: 500,
      letterSpacing: '-0.03em', lineHeight: 1.05,
    }}>{data.headline}</h1>
  );
  const sub = data.sub && (
    <p style={{
      margin: '20px 0 0', fontSize: 'clamp(16px, 1.2vw, 20px)',
      color: 'var(--site-fg-2)', lineHeight: 1.55, maxWidth: 560,
    }}>{data.sub}</p>
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
function About({ data }) {
  return (
    <section style={{ background: 'var(--site-surface)', color: 'var(--site-fg)' }}>
      <div style={{ ...container, display: 'grid', gridTemplateColumns: data.imgUrl ? '1fr 1fr' : '1fr', gap: 48, alignItems: 'center' }}>
        <div>
          <Heading text={data.headline} align="left" />
          <p style={{ margin: '20px 0 0', fontSize: 16, lineHeight: 1.7, color: 'var(--site-fg-2)', whiteSpace: 'pre-wrap' }}>
            {data.body}
          </p>
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
function Contact({ data }) {
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
          {data.showForm !== false && (
            <form style={{ display: 'grid', gap: 12 }} onSubmit={(e) => e.preventDefault()}>
              <input placeholder="Your name" style={siteInput} />
              <input placeholder="Email" type="email" style={siteInput} />
              <textarea placeholder="Message" rows={5} style={{ ...siteInput, resize: 'vertical' }} />
              <button type="submit" style={{
                padding: '12px 22px',
                background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
                border: 0, borderRadius: 'var(--site-radius)',
                fontWeight: 550, fontSize: 14, cursor: 'pointer', justifySelf: 'start',
              }}>Send message</button>
            </form>
          )}
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
function Heading({ text, sub, align = 'center' }) {
  return (
    <div style={{ textAlign: align }}>
      <h2 style={{
        margin: 0,
        fontFamily: 'var(--site-font-display)',
        fontSize: 'clamp(28px, 3.4vw, 40px)',
        fontWeight: 500,
        letterSpacing: '-0.025em',
        lineHeight: 1.1,
      }}>{text}</h2>
      {sub && (
        <p style={{ margin: '12px auto 0', maxWidth: 560, color: 'var(--site-fg-2)', fontSize: 15, lineHeight: 1.55 }}>
          {sub}
        </p>
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
function Stats({ data }) {
  const items = data.items || [];
  return (
    <section style={{ background: 'var(--site-surface)', color: 'var(--site-fg)' }}>
      <div style={container}>
        {data.headline && <Heading text={data.headline} sub={data.sub}/>}
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
function CtaBanner({ data }) {
  return (
    <section style={{
      background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
    }}>
      <div style={{
        maxWidth: 900, margin: '0 auto', padding: '80px 64px', textAlign: 'center',
      }}>
        <h2 style={{
          margin: 0, fontFamily: 'var(--site-font-display)',
          fontSize: 'clamp(32px, 4vw, 48px)', fontWeight: 500,
          letterSpacing: '-0.02em', lineHeight: 1.1,
        }}>{data.headline}</h2>
        {data.sub && (
          <p style={{ margin: '20px auto 0', fontSize: 18, lineHeight: 1.55, maxWidth: 560, opacity: 0.92 }}>
            {data.sub}
          </p>
        )}
        {data.cta && (
          <div style={{ marginTop: 32 }}>
            <a href={data.ctaLink || '#book'} style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '14px 26px', fontSize: 15, fontWeight: 600,
              background: 'var(--site-accent-ink)', color: 'var(--site-accent)',
              borderRadius: 'var(--site-radius)', textDecoration: 'none',
            }}>
              {data.cta} <span style={{ fontSize: 18, lineHeight: 1 }}>→</span>
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
function Newsletter({ data }) {
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
        <form onSubmit={(e) => e.preventDefault()} style={{
          marginTop: 28, display: 'flex', gap: 8,
          maxWidth: 480, marginInline: 'auto',
        }}>
          <input type="email" placeholder={data.placeholder || 'you@example.com'}
            style={{
              flex: 1, padding: '12px 14px', fontSize: 15,
              border: '1px solid var(--site-border)',
              borderRadius: 'var(--site-radius)',
              background: 'var(--site-bg)', color: 'var(--site-fg)',
              outline: 'none',
            }}/>
          <button type="submit" style={{
            padding: '12px 18px', fontSize: 14, fontWeight: 600,
            background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
            border: 0, borderRadius: 'var(--site-radius)', cursor: 'pointer',
          }}>{data.buttonText || 'Subscribe'}</button>
        </form>
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

const RENDERERS = {
  hero: Hero,
  services: Services,
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
};
