// /me/discover — directory of THRYVE businesses that have opted in to be
// listed publicly. Click through opens /book/<slug> in a new tab so the
// existing public-booking flow handles the actual booking.
import React, { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelPageHeader, SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';

const CATEGORIES = ['All', 'Wellness', 'Beauty', 'Fitness', 'Health', 'Professional'];

// Cycle through accent palette for card banners — stable per slug so a given
// business always renders the same colour without us storing one.
const BANNER_PALETTE = ['#C8D8FF', '#FFD1DC', '#D0E8D0', '#FFE3B0', '#E0D4F7', '#CDEBF0'];
function bannerFor(slug) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  return BANNER_PALETTE[Math.abs(h) % BANNER_PALETTE.length];
}

export default function ClientDiscover() {
  const [businesses, setBusinesses] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [q, setQ]                   = useState('');
  const [cat, setCat]               = useState('All');
  const [reloadKey, setReloadKey]   = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    api.get('/me/discover')
      .then((r) => live && setBusinesses(r.businesses || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [reloadKey]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return businesses.filter((b) => {
      if (cat !== 'All' && b.category !== cat) return false;
      if (!needle) return true;
      return (b.bizName || '').toLowerCase().includes(needle)
        || (b.tagline || '').toLowerCase().includes(needle);
    });
  }, [businesses, q, cat]);

  const categoryCounts = useMemo(() => {
    const c = { All: businesses.length };
    for (const cat of CATEGORIES) if (cat !== 'All') c[cat] = 0;
    for (const b of businesses) if (b.category && b.category in c) c[b.category]++;
    return c;
  }, [businesses]);

  if (loading) return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SkelPageHeader/>
      <SkelRowList rows={5} withAvatar/>
    </div>
  );
  if (error) return (
    <div style={{ padding: 48 }}>
      <div className="card" style={{ padding: 40 }}>
        <EmptyNote icon="Globe" title="Couldn't load Discover"
          hint={error.message || 'Try refreshing.'}
          action={<button className="btn btn-outline" onClick={() => setReloadKey((n) => n + 1)}>Retry</button>}/>
      </div>
    </div>
  );

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Hero */}
      <div>
        <h2 style={{
          fontFamily: 'var(--font-display)', fontWeight: 500,
          fontSize: 'clamp(28px, 4.5vw, 40px)',
          letterSpacing: '-0.03em', margin: '0 0 6px', lineHeight: 1.05,
        }}>
          Find a business.<br/>
          <span style={{ color: 'var(--muted)' }}>Book in two taps.</span>
        </h2>
        <p style={{ color: 'var(--fg-2)', fontSize: 15, maxWidth: 560, margin: 0, lineHeight: 1.5 }}>
          Every business here runs on THRYVE, so your appointments, payments, and paperwork live in one place.
        </p>
      </div>

      {businesses.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Category chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CATEGORIES.map((c) => {
              const on = cat === c;
              const count = categoryCounts[c] ?? 0;
              const dim = c !== 'All' && count === 0;
              return (
                <button key={c} type="button" onClick={() => !dim && setCat(c)}
                  disabled={dim}
                  style={{
                    padding: '6px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600,
                    background: on ? 'var(--fg)' : 'var(--surface)',
                    color: on ? 'var(--page)' : (dim ? 'var(--muted)' : 'var(--fg-2)'),
                    border: `1px solid ${on ? 'var(--fg)' : 'var(--border)'}`,
                    cursor: dim ? 'not-allowed' : 'pointer',
                    opacity: dim ? 0.5 : 1,
                  }}>
                  {c}{c !== 'All' && count > 0 && (
                    <span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 500 }}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 12px', borderRadius: 10,
            background: 'var(--surface)', border: '1px solid var(--border)',
            maxWidth: 420,
          }}>
            <Icons.Search size={14} stroke="var(--muted)" sw={1.7}/>
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or what they do"
              style={{ flex: 1, border: 0, background: 'transparent', outline: 'none',
                color: 'var(--fg)', fontSize: 13.5 }}/>
            {q && (
              <button onClick={() => setQ('')} aria-label="Clear search"
                style={{ padding: 2, color: 'var(--muted)' }}>
                <Icons.X size={12}/>
              </button>
            )}
          </div>
        </div>
      )}

      {businesses.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Globe" title="No public businesses yet"
            hint="When THRYVE businesses opt in to the public directory, they'll show up here."/>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Search" title="No matches"
            hint={q
              ? `Nothing in ${cat === 'All' ? 'the directory' : cat} matches “${q}”.`
              : `No ${cat} businesses listed yet.`}/>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 16,
        }}>
          {filtered.map((b) => <BusinessCard key={b.slug} biz={b}/>)}
        </div>
      )}
    </div>
  );
}

function BusinessCard({ biz }) {
  const initial = (biz.bizName || '?').trim()[0]?.toUpperCase() || '?';
  const banner  = bannerFor(biz.slug || biz.bizName || '?');
  const href    = `/book/${biz.slug}`;
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className="card"
      style={{
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
        textDecoration: 'none', color: 'inherit', cursor: 'pointer',
        padding: 0,
      }}>
      {/* Coloured banner with the initial chip */}
      <div style={{
        height: 96, background: banner, position: 'relative',
        display: 'flex', alignItems: 'flex-end', padding: 14,
      }}>
        {biz.category && (
          <div style={{
            position: 'absolute', top: 12, right: 12,
            padding: '3px 8px', borderRadius: 99,
            background: 'rgba(255,255,255,0.85)',
            fontSize: 10.5, fontWeight: 600,
            color: '#333', letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>{biz.category}</div>
        )}
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '2px solid #fff', boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 19,
          color: '#333',
        }}>{initial}</div>
      </div>

      <div style={{ padding: 16, flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{biz.bizName}</div>
        {biz.tagline && (
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.45,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {biz.tagline}
          </div>
        )}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 12, color: 'var(--muted)', marginTop: 'auto', paddingTop: 8,
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icons.Doc size={12} sw={1.7}/>
            {biz.serviceCount} service{biz.serviceCount === 1 ? '' : 's'}
            {biz.minPrice != null && biz.minPrice > 0 && (
              <> · from ${Number(biz.minPrice).toFixed(0)}</>
            )}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)', fontWeight: 600 }}>
            Book <Icons.Arrow size={11} sw={2.2}/>
          </span>
        </div>
      </div>
    </a>
  );
}
