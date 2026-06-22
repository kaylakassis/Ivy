// /vs/:slug - switch-from-competitor landing page.
//
// Same shell as the other marketing pages; data per-competitor comes
// from compareData.js. Designed for high-intent search queries:
// "<competitor> alternative", "switch from <competitor>", etc.
import React, { useEffect } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import MarketingShell, { SimpleNav, SimpleFooter } from './MarketingShell.jsx';
import { COMPETITORS, FEATURE_ROWS, COMPETITOR_LIST } from './compareData.js';
import { IVY_PRICE, TRIAL_DAYS } from '../../lib/pricing.js';

const SYMBOL = { y: '✓', n: '-', l: '~' };
const SYMBOL_COLOR = { y: 'var(--accent)', n: 'var(--muted)', l: 'var(--fg-2)' };
const SYMBOL_TITLE = { y: 'Included', n: 'Not available', l: 'Limited or paid add-on' };

export default function ComparePage() {
  const { slug } = useParams();
  const c = COMPETITORS[slug];

  useEffect(() => {
    if (!c) return;
    document.title = `Ivy OS vs ${c.name} - switching guide`;
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', `Switching from ${c.name} to Ivy OS? Side-by-side comparison, why solo owners switch, and a free data import. From $${IVY_PRICE}/4 weeks, AI included.`);
  }, [c]);

  if (!c) return <Navigate to="/pricing" replace/>;

  return (
    <MarketingShell>
      <SimpleNav/>
      <main style={{ maxWidth: 1000, margin: '0 auto', padding: '48px 24px 64px' }}>

        {/* Hero */}
        <section style={{ marginBottom: 56 }}>
          <div style={{
            display: 'inline-block', padding: '4px 12px', borderRadius: 99,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
            textTransform: 'uppercase', marginBottom: 16,
          }}>
            Ivy OS vs {c.name}
          </div>
          <h1 style={{
            margin: 0, fontFamily: 'var(--font-display)',
            fontSize: 'clamp(32px, 4.5vw, 48px)', fontWeight: 500,
            letterSpacing: '-0.025em', lineHeight: 1.1,
          }}>
            {c.headline}
          </h1>
          <p style={{
            margin: '16px 0 0', maxWidth: 700,
            fontSize: 16, lineHeight: 1.55, color: 'var(--fg-2)',
          }}>
            {c.sub}
          </p>
          <div style={{ marginTop: 24, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Link to="/signup" className="btn btn-primary"
              style={{ padding: '12px 22px', fontSize: 14, fontWeight: 600 }}>
              Start your {TRIAL_DAYS}-day free trial <Icons.Arrow size={13} sw={2}/>
            </Link>
            <Link to="/pricing" className="btn btn-outline"
              style={{ padding: '12px 18px', fontSize: 14 }}>
              See pricing
            </Link>
          </div>
        </section>

        {/* Pains */}
        <section style={{ marginBottom: 56 }}>
          <div className="metric-label" style={{ marginBottom: 12 }}>
            Why solo owners switch
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14,
          }}>
            {c.pains.map((p, i) => (
              <div key={i} style={{
                padding: '20px 18px', borderRadius: 12,
                background: 'var(--surface)', border: '1px solid var(--border)',
              }}>
                <div style={{
                  fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600,
                  color: 'var(--accent)', lineHeight: 1, marginBottom: 10,
                }}>
                  {String(i + 1).padStart(2, '0')}
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--fg-2)' }}>
                  {p}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Feature matrix */}
        <section style={{ marginBottom: 56 }}>
          <h2 style={{
            margin: '0 0 18px', fontFamily: 'var(--font-display)',
            fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em',
          }}>
            Feature-by-feature comparison
          </h2>
          <div style={{
            border: '1px solid var(--border)', borderRadius: 12,
            background: 'var(--surface)', overflow: 'hidden',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)' }}>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Capability</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: 600, color: 'var(--accent)' }}>Ivy OS</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: 600 }}>{c.name}</th>
                </tr>
              </thead>
              <tbody>
                {FEATURE_ROWS.map((row) => {
                  const ours = 'y';
                  const theirs = c.matrix[row.key] || 'n';
                  return (
                    <tr key={row.key} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 16px' }}>{row.label}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'center', color: SYMBOL_COLOR[ours], fontWeight: 700 }} title={SYMBOL_TITLE[ours]}>{SYMBOL[ours]}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'center', color: SYMBOL_COLOR[theirs], fontWeight: 700 }} title={SYMBOL_TITLE[theirs]}>{SYMBOL[theirs]}</td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface-2)' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 600 }}>Price</td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--accent)' }}>${IVY_PRICE}/4 weeks</td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontFamily: 'var(--font-display)', fontWeight: 600 }}>{c.theirPrice}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted)' }}>
            ~ = limited or paid add-on. Comparison reflects publicly listed
            feature parity as of {new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}.
          </div>
        </section>

        {/* Migration help */}
        <section style={{
          marginBottom: 56,
          padding: 28, borderRadius: 16,
          background: 'var(--accent-soft)',
          border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
        }}>
          <h2 style={{
            margin: 0, fontFamily: 'var(--font-display)',
            fontSize: 24, fontWeight: 500, letterSpacing: '-0.02em',
            color: 'var(--accent)',
          }}>
            We'll move your data over - free.
          </h2>
          <p style={{ margin: '10px 0 16px', color: 'var(--fg-2)', fontSize: 14.5, lineHeight: 1.6 }}>
            Export your client list, booking history, and invoices from {c.name} (or share read-only access),
            and our team will import everything into your new Ivy OS workspace within a business day. No charge,
            no catch.
          </p>
          <a href={`mailto:hello@getivyos.com?subject=${encodeURIComponent(`Switching from ${c.name}`)}`}
            className="btn btn-primary"
            style={{ padding: '10px 18px', fontSize: 13, fontWeight: 600 }}>
            Get migration help →
          </a>
        </section>

        {/* Other comparisons */}
        <section style={{ marginBottom: 56 }}>
          <div className="metric-label" style={{ marginBottom: 12 }}>
            Considering other tools?
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {COMPETITOR_LIST.filter((x) => x.slug !== slug).map((x) => (
              <Link key={x.slug} to={`/vs/${x.slug}`}
                className="btn btn-outline"
                style={{ padding: '6px 12px', fontSize: 12.5, fontWeight: 500 }}>
                vs {x.name}
              </Link>
            ))}
          </div>
        </section>

      </main>
      <SimpleFooter/>
    </MarketingShell>
  );
}
