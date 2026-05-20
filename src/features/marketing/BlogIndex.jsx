// /blog — index of every post. Sorted newest-first.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SimpleNav, SimpleFooter } from './ChangelogPage.jsx';
import MarketingShell from './MarketingShell.jsx';
import { POSTS } from './blogData.js';

export default function BlogIndex() {
  useEffect(() => {
    document.title = 'Blog — THRYVE';
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', 'Working notes for solo service businesses — pricing, intake forms, no-shows, payments, and the admin tax.');
  }, []);
  const sorted = [...POSTS].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return (
    <MarketingShell>
      <SimpleNav/>
      <main style={{ maxWidth: 820, margin: '0 auto', padding: '48px 24px 64px' }}>
        <header style={{ marginBottom: 36 }}>
          <div className="metric-label" style={{ marginBottom: 6 }}>Working notes</div>
          <h1 style={{
            margin: 0, fontFamily: 'var(--font-display)',
            fontSize: 'clamp(32px, 4vw, 44px)', fontWeight: 500,
            letterSpacing: '-0.025em', lineHeight: 1.1,
          }}>
            Lessons from running a solo business.
          </h1>
          <p style={{
            margin: '12px 0 0', maxWidth: 600,
            fontSize: 15.5, color: 'var(--fg-2)', lineHeight: 1.6,
          }}>
            Pricing, intake forms, no-shows, payment processors, the admin tax —
            everything we wish someone had written down before we did it the hard way.
          </p>
        </header>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {sorted.map((p) => (
            <Link key={p.slug} to={`/blog/${p.slug}`} style={{
              display: 'block', padding: '20px 22px',
              borderRadius: 12, border: '1px solid var(--border)',
              background: 'var(--surface)', textDecoration: 'none', color: 'inherit',
            }}>
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6,
                fontSize: 11.5, color: 'var(--muted)',
                letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600,
              }}>
                <span>{formatDate(p.date)}</span>
                <span>·</span>
                <span>{p.readMinutes} min read</span>
              </div>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500,
                letterSpacing: '-0.015em', lineHeight: 1.2,
              }}>
                {p.title}
              </div>
              <div style={{ marginTop: 8, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
                {p.excerpt}
              </div>
            </Link>
          ))}
        </div>
      </main>
      <SimpleFooter/>
    </MarketingShell>
  );
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}
