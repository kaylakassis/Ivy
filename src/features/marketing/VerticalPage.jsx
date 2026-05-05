// /for/:slug — vertical-specific landing pages. Same shell, different
// copy + use cases per vertical. Major SEO win for queries like
// "booking software for massage therapists" or "CRM for personal trainers".
//
// Adding a vertical: drop a row in VERTICALS below. Slug is the URL.
// keep the angle phrase tight ("for massage therapists") — it should
// drop into Google search verbatim.
import React, { useEffect } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import { SimpleNav, SimpleFooter } from './ChangelogPage.jsx';
import { VERTICALS } from './verticalsData.js';

const VERTICAL_LIST = Object.entries(VERTICALS);

export default function VerticalPage() {
  const { slug } = useParams();
  const v = VERTICALS[slug];
  const [tweaks] = useTweaks();

  // Bad slug → bounce to the home page rather than 404; better UX,
  // and the visitor still lands on something useful.
  useEffect(() => {
    if (!v) return;
    const dom = typeof window !== 'undefined' ? window.location.origin : '';
    document.title = `THRYVE — ${capFirst(v.angle)} run their business in one place`;
    const upsert = (attr, key, value) => {
      let el = document.querySelector(`meta[${attr}="${key}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.setAttribute('content', value);
    };
    upsert('name', 'description', `${v.headline} ${v.sub}`);
    upsert('property', 'og:title', `THRYVE for ${v.angle}`);
    upsert('property', 'og:description', v.headline);
    upsert('property', 'og:url', dom + '/for/' + slug);
    upsert('property', 'og:type', 'website');
  }, [v, slug]);

  if (!v) return <Navigate to="/" replace/>;
  const Icon = Icons[v.icon] || Icons.Check;

  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', background: 'var(--page)' }}>
      <SimpleNav/>

      {/* Hero */}
      <section style={{ maxWidth: 880, margin: '0 auto', padding: '64px 24px 32px' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '5px 12px', borderRadius: 99,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em',
          textTransform: 'uppercase', marginBottom: 20,
        }}>
          <Icon size={12} sw={2}/> THRYVE for {v.angle}
        </div>
        <h1 className="page-title" style={{
          margin: 0, fontSize: 'clamp(30px, 5vw, 46px)',
          lineHeight: 1.08, maxWidth: 720,
        }}>
          {v.headline}
        </h1>
        <p style={{
          margin: '20px 0 0', maxWidth: 620,
          fontSize: 17, lineHeight: 1.55, color: 'var(--fg-2)',
        }}>
          {v.sub}
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 28, flexWrap: 'wrap' }}>
          <Link to="/signup" className="btn btn-primary"
            style={{ padding: '13px 22px', fontSize: 14.5, gap: 10 }}>
            Start free <Icons.Arrow size={13} sw={2}/>
          </Link>
          <Link to="/" className="btn btn-outline"
            style={{ padding: '13px 22px', fontSize: 14.5 }}>
            See everything THRYVE does
          </Link>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
          No credit card · Free during beta
        </div>
      </section>

      {/* Bullets */}
      <section style={{ maxWidth: 880, margin: '0 auto', padding: '24px 24px 32px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          {v.bullets.map((b, i) => (
            <div key={i} className="card" style={{
              padding: 22, display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <Icons.Check size={16} sw={2.4} stroke="var(--accent)"/>
              <h3 style={{ margin: '4px 0 0', fontSize: 15.5, fontWeight: 600 }}>{b.title}</h3>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>
                {b.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* "How to set up" — concrete first-day instructions */}
      <section style={{ maxWidth: 720, margin: '0 auto', padding: '32px 24px' }}>
        <div className="card" style={{
          padding: 24,
          background: 'color-mix(in srgb, var(--accent-soft) 40%, var(--surface))',
          border: '1px solid var(--accent)',
        }}>
          <div className="metric-label" style={{ color: 'var(--accent)' }}>Day-one setup</div>
          <h3 className="page-title" style={{ margin: '6px 0 10px', fontSize: 22 }}>
            Get up in three minutes.
          </h3>
          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>
            {v.use}
          </p>
        </div>
      </section>

      {/* Cross-links to other verticals so visitors can find their actual fit */}
      <section style={{ maxWidth: 880, margin: '0 auto', padding: '32px 24px 64px' }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div className="metric-label">Built for more</div>
          <h2 className="page-title" style={{ margin: '8px 0 0', fontSize: 22 }}>
            Different business? THRYVE fits.
          </h2>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {VERTICAL_LIST
            .filter(([s]) => s !== slug)
            .map(([s, other]) => {
              const OtherIcon = Icons[other.icon] || Icons.Check;
              return (
                <Link key={s} to={`/for/${s}`} className="btn btn-outline"
                  style={{ padding: '8px 14px', fontSize: 12.5 }}>
                  <OtherIcon size={12} sw={1.7}/> For {other.angle}
                </Link>
              );
            })}
        </div>
      </section>

      <SimpleFooter/>
    </div>
  );
}

function capFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
