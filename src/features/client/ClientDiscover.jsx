// /me/discover — directory of THRYVE businesses that have opted in to be
// listed publicly. Click through opens /book/<slug> in a new tab so the
// existing public-booking flow handles the actual booking.
import React, { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelPageHeader, SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';

export default function ClientDiscover() {
  const [businesses, setBusinesses] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [q, setQ]                   = useState('');
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
    if (!needle) return businesses;
    return businesses.filter((b) =>
      (b.bizName || '').toLowerCase().includes(needle)
      || (b.tagline || '').toLowerCase().includes(needle),
    );
  }, [businesses, q]);

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
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>
          {businesses.length} business{businesses.length === 1 ? '' : 'es'} on THRYVE accepting bookings.
        </div>
      </div>

      {businesses.length > 0 && (
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
      )}

      {businesses.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Globe" title="No public businesses yet"
            hint="When THRYVE businesses opt in to the public directory, they'll show up here."/>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Search" title="No matches"
            hint={`Nothing here matches “${q}”.`}/>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 14,
        }}>
          {filtered.map((b) => <BusinessCard key={b.slug} biz={b}/>)}
        </div>
      )}
    </div>
  );
}

function BusinessCard({ biz }) {
  const initials = (biz.bizName || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0].toUpperCase()).join('');
  const href = `/book/${biz.slug}`;
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className="card"
      style={{
        padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
        textDecoration: 'none', color: 'inherit', cursor: 'pointer',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 11, flexShrink: 0,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 600, fontSize: 16,
        }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {biz.bizName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2,
            fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
            /book/{biz.slug}
          </div>
        </div>
      </div>
      {biz.tagline && (
        <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          {biz.tagline}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12,
        fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icons.Doc size={12} sw={1.7}/> {biz.serviceCount} service{biz.serviceCount === 1 ? '' : 's'}
        </span>
        {biz.minPrice != null && biz.minPrice > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icons.Dollar size={12} sw={1.7}/> from ${Number(biz.minPrice).toFixed(0)}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
          color: 'var(--accent)' }}>
          Book <Icons.Arrow size={11} sw={2.2}/>
        </span>
      </div>
    </a>
  );
}
