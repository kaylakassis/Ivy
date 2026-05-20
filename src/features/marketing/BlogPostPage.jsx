// /blog/:slug — single post. Reads from blogData.POST_MAP.
import React, { useEffect } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { SimpleNav, SimpleFooter } from './ChangelogPage.jsx';
import MarketingShell from './MarketingShell.jsx';
import { POST_MAP, POSTS } from './blogData.js';
import { Icons } from '../../components/Icons.jsx';

export default function BlogPostPage() {
  const { slug } = useParams();
  const post = POST_MAP[slug];

  useEffect(() => {
    if (!post) return;
    document.title = `${post.title} — THRYVE blog`;
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', post.excerpt);
  }, [post]);

  if (!post) return <Navigate to="/blog" replace/>;

  const sorted = [...POSTS].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const idx = sorted.findIndex((p) => p.slug === slug);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;

  return (
    <MarketingShell>
      <SimpleNav/>
      <main style={{ maxWidth: 700, margin: '0 auto', padding: '48px 24px 64px' }}>
        <Link to="/blog" style={{
          fontSize: 12.5, color: 'var(--muted)', textDecoration: 'none',
          display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 18,
        }}>← All posts</Link>

        <article>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10,
            fontSize: 11.5, color: 'var(--muted)',
            letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600,
          }}>
            <span>{formatDate(post.date)}</span>
            <span>·</span>
            <span>{post.readMinutes} min read</span>
          </div>
          <h1 style={{
            margin: 0, fontFamily: 'var(--font-display)',
            fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 500,
            letterSpacing: '-0.025em', lineHeight: 1.15,
          }}>
            {post.title}
          </h1>
          <p style={{
            margin: '14px 0 32px', fontSize: 17, lineHeight: 1.55, color: 'var(--fg-2)',
          }}>
            {post.excerpt}
          </p>

          {post.body.map((blk, i) => (
            blk.type === 'h'
              ? <h2 key={i} style={{
                  marginTop: 28, marginBottom: 10,
                  fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500,
                  letterSpacing: '-0.02em', lineHeight: 1.2,
                }}>{blk.text}</h2>
              : <p key={i} style={{
                  margin: '0 0 14px', fontSize: 16, lineHeight: 1.7, color: 'var(--fg)',
                }}>{blk.text}</p>
          ))}
        </article>

        <section style={{
          marginTop: 48, padding: 22, borderRadius: 14,
          background: 'var(--accent-soft)',
          border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
        }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, color: 'var(--accent)' }}>
            Want THRYVE to handle this for you?
          </div>
          <p style={{ margin: '8px 0 14px', fontSize: 14, lineHeight: 1.55, color: 'var(--fg-2)' }}>
            Pricing, intake, no-shows, invoicing — every problem in this post is one tab in THRYVE. Free during beta.
          </p>
          <Link to="/signup" className="btn btn-primary"
            style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600 }}>
            Start free <Icons.Arrow size={12} sw={2}/>
          </Link>
        </section>

        <nav style={{
          marginTop: 36, paddingTop: 24, borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
        }}>
          {prev ? (
            <Link to={`/blog/${prev.slug}`} style={{
              flex: 1, minWidth: 200,
              padding: 14, borderRadius: 10,
              background: 'var(--surface)', border: '1px solid var(--border)',
              textDecoration: 'none', color: 'inherit',
            }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>← Newer</div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{prev.title}</div>
            </Link>
          ) : <div style={{ flex: 1 }}/>}
          {next ? (
            <Link to={`/blog/${next.slug}`} style={{
              flex: 1, minWidth: 200, textAlign: 'right',
              padding: 14, borderRadius: 10,
              background: 'var(--surface)', border: '1px solid var(--border)',
              textDecoration: 'none', color: 'inherit',
            }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Older →</div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{next.title}</div>
            </Link>
          ) : <div style={{ flex: 1 }}/>}
        </nav>
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
