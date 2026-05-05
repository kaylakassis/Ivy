// Renders a section using the template's CSS variables.
// Used by the editor Canvas AND the public-facing site.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';

export default function SectionRenderer({ section, handle }) {
  const Comp = RENDERERS[section.type] || Fallback;
  return <Comp data={section.data} handle={handle} />;
}

const container = {
  padding: '80px 64px',
  maxWidth: 1200,
  margin: '0 auto',
};

// ---------- Hero ----------
function Hero({ data }) {
  const align = data.align || 'center';
  return (
    <section style={{
      background: 'var(--site-bg)',
      color: 'var(--site-fg)',
      padding: '120px 64px',
      textAlign: align,
    }}>
      <div style={{ maxWidth: 760, margin: align === 'center' ? '0 auto' : 0 }}>
        <h1 style={{
          margin: 0,
          fontFamily: 'var(--site-font-display)',
          fontSize: 'clamp(40px, 5vw, 64px)',
          fontWeight: 500,
          letterSpacing: '-0.03em',
          lineHeight: 1.05,
        }}>{data.headline}</h1>
        {data.sub && (
          <p style={{
            margin: '20px 0 0',
            fontSize: 'clamp(16px, 1.2vw, 20px)',
            color: 'var(--site-fg-2)',
            lineHeight: 1.55,
            maxWidth: 560,
            marginLeft: align === 'center' ? 'auto' : 0,
            marginRight: align === 'center' ? 'auto' : 0,
          }}>{data.sub}</p>
        )}
        {data.cta && (
          <div style={{ marginTop: 32 }}>
            <a
              href={data.ctaLink || '#book'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '14px 24px',
                background: 'var(--site-accent)',
                color: 'var(--site-accent-ink)',
                borderRadius: 'var(--site-radius)',
                textDecoration: 'none',
                fontWeight: 550,
                fontSize: 15,
              }}
            >
              {data.cta}
              <span style={{ fontSize: 18, lineHeight: 1 }}>→</span>
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- Services ----------
function Services({ data }) {
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        <Heading text={data.headline} sub={data.sub} />
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, data.items?.length || 1))}, 1fr)`,
          gap: 20,
          marginTop: 40,
        }}>
          {(data.items || []).map((s) => (
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
};
