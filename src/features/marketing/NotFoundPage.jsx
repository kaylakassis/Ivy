// 404 catch-all. Reached when react-router can't match the URL to any
// declared route. Renders a tiny page rather than an empty <Routes/>
// outlet so users don't see a blank screen on bad URLs.
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SimpleNav, SimpleFooter } from './ChangelogPage.jsx';

export default function NotFoundPage() {
  const loc = useLocation();
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <SimpleNav/>
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '64px 18px' }}>
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 86, lineHeight: 1,
            letterSpacing: '-0.04em', color: 'var(--muted)' }}>404</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, letterSpacing: '-0.02em',
            margin: '12px 0 8px' }}>
            We can't find that page
          </h1>
          <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 24 }}>
            The page you were looking for doesn't exist — maybe a typo in the URL, or a link
            that's gone stale. Try one of the links below.
          </p>
          <p style={{ fontSize: 11.5, color: 'var(--muted2, var(--muted))',
            wordBreak: 'break-all', marginBottom: 28 }}>
            <code>{loc.pathname}</code>
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/" className="btn btn-primary">
              <Icons.Home size={13}/> Home
            </Link>
            <Link to="/dashboard" className="btn btn-outline">
              <Icons.Trending size={13}/> My dashboard
            </Link>
            <Link to="/me" className="btn btn-outline">
              <Icons.Users size={13}/> Client portal
            </Link>
          </div>
        </div>
      </main>
      <SimpleFooter/>
    </div>
  );
}
