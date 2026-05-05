// /me/discover — directory of THRYVE businesses that have opted in to be
// listed publicly. Filters compose server-side: category + price range +
// service-name search + distance from the client's location are all
// real DB queries (see /api/me/discover) so a search like "botox $10–50"
// only returns businesses whose botox is in that range, sorted by distance
// when the user shares their location.
//
// State lives in URL search params so links are shareable / bookmarkable
// and the back button rewinds the filter, not the route.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelPageHeader, SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';

const CATEGORIES = ['All', 'Wellness', 'Beauty', 'Fitness', 'Health', 'Professional'];

const BANNER_PALETTE = ['#C8D8FF', '#FFD1DC', '#D0E8D0', '#FFE3B0', '#E0D4F7', '#CDEBF0'];
function bannerFor(slug) {
  let h = 0;
  for (let i = 0; i < (slug || '').length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  return BANNER_PALETTE[Math.abs(h) % BANNER_PALETTE.length];
}

export default function ClientDiscover() {
  const [params, setParams] = useSearchParams();

  // Read filter state from URL params on every render so external links
  // / back-button drive the same filters.
  const q         = params.get('q') || '';
  const cat       = params.get('category') || 'All';
  const priceMin  = params.get('priceMin') ? Number(params.get('priceMin')) : null;
  const priceMax  = params.get('priceMax') ? Number(params.get('priceMax')) : null;
  const radiusKm  = params.get('radiusKm') ? Number(params.get('radiusKm')) : null;
  const lat       = params.get('lat') ? Number(params.get('lat')) : null;
  const lng       = params.get('lng') ? Number(params.get('lng')) : null;
  const minRating = params.get('minRating') ? Number(params.get('minRating')) : null;

  const setFilter = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '' || v === 'All') next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next, { replace: true });
  };

  const [businesses, setBusinesses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Debounce text input so each keystroke doesn't fire a request.
  const debouncedQ = useDebounced(q, 220);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    const qs = new URLSearchParams();
    if (debouncedQ)         qs.set('q', debouncedQ);
    if (cat && cat !== 'All') qs.set('category', cat);
    if (priceMin != null)   qs.set('priceMin', priceMin);
    if (priceMax != null)   qs.set('priceMax', priceMax);
    if (radiusKm != null && lat != null && lng != null) {
      qs.set('radiusKm', radiusKm);
      qs.set('lat', lat);
      qs.set('lng', lng);
    }
    if (minRating != null) qs.set('minRating', minRating);
    api.get('/me/discover' + (qs.toString() ? '?' + qs.toString() : ''))
      .then((r) => live && setBusinesses(r.businesses || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [debouncedQ, cat, priceMin, priceMax, radiusKm, lat, lng, minRating, reloadKey]);

  if (loading && businesses.length === 0) return (
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

  const anyFiltersActive = !!(q || (cat && cat !== 'All') || priceMin != null || priceMax != null || radiusKm != null || minRating != null);

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
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
          Every business here runs on THRYVE — appointments, payments, and
          paperwork live in one place.
        </p>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Search */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 12px', borderRadius: 10, flex: 1, minWidth: 240,
            background: 'var(--surface)', border: '1px solid var(--border)',
          }}>
            <Icons.Search size={14} stroke="var(--muted)" sw={1.7}/>
            <input value={q} onChange={(e) => setFilter({ q: e.target.value })}
              placeholder="Search by service or business — e.g. botox"
              style={{ flex: 1, border: 0, background: 'transparent', outline: 'none',
                color: 'var(--fg)', fontSize: 13.5 }}/>
            {q && (
              <button onClick={() => setFilter({ q: '' })} aria-label="Clear search"
                style={{ padding: 2, color: 'var(--muted)' }}>
                <Icons.X size={12}/>
              </button>
            )}
          </div>

          <PriceFilter priceMin={priceMin} priceMax={priceMax}
            onChange={(v) => setFilter(v)}/>

          <DistanceFilter radiusKm={radiusKm} lat={lat} lng={lng}
            onChange={(v) => setFilter(v)}/>

          <RatingFilter minRating={minRating} onChange={(v) => setFilter(v)}/>

          {anyFiltersActive && (
            <button onClick={() => setFilter({
              q: '', category: '', priceMin: '', priceMax: '',
              radiusKm: '', lat: '', lng: '', minRating: '',
            })}
              className="btn btn-ghost"
              style={{ color: 'var(--muted)', fontSize: 12.5 }}>
              Clear all
            </button>
          )}
        </div>

        {/* Category chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {CATEGORIES.map((c) => {
            const on = cat === c;
            return (
              <button key={c} type="button"
                onClick={() => setFilter({ category: c === 'All' ? '' : c })}
                style={{
                  padding: '5px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600,
                  background: on ? 'var(--fg)' : 'var(--surface)',
                  color: on ? 'var(--page)' : 'var(--fg-2)',
                  border: `1px solid ${on ? 'var(--fg)' : 'var(--border)'}`,
                  cursor: 'pointer',
                }}>{c}</button>
            );
          })}
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <SkelRowList rows={3} withAvatar/>
      ) : businesses.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Search" title="No matches"
            hint={anyFiltersActive
              ? 'Loosen a filter — or clear them all to see everything.'
              : 'No public businesses listed yet.'}
            action={anyFiltersActive
              ? <button className="btn btn-outline" onClick={() => setFilter({
                  q: '', category: '', priceMin: '', priceMax: '',
                  radiusKm: '', lat: '', lng: '', minRating: '',
                })}>Clear filters</button>
              : null}/>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {businesses.length} match{businesses.length === 1 ? '' : 'es'}
            {radiusKm != null && lat != null && <> · within {radiusKm} km of you</>}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}>
            {businesses.map((b) => <BusinessCard key={b.slug} biz={b} q={q}/>)}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Filter controls ────────────────────────────────────────────────

function PriceFilter({ priceMin, priceMax, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutsideClick(ref, () => setOpen(false));
  const label = priceMin != null && priceMax != null ? `$${priceMin}–${priceMax}`
    : priceMin != null ? `≥ $${priceMin}`
    : priceMax != null ? `≤ $${priceMax}`
    : 'Price';
  const active = priceMin != null || priceMax != null;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} className="btn btn-outline"
        style={{
          fontSize: 12.5,
          background: active ? 'var(--accent-soft)' : 'transparent',
          borderColor: active ? 'var(--accent)' : 'var(--border-strong)',
          color: active ? 'var(--accent)' : 'var(--fg-2)',
          fontWeight: active ? 600 : 500,
        }}>
        <Icons.Dollar size={12} sw={1.7}/> {label}
        <Icons.ArrowDown size={11} sw={2}/>
      </button>
      {open && (
        <Popover>
          <PopoverTitle>Price range</PopoverTitle>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <NumberField placeholder="Min" value={priceMin} onChange={(v) => onChange({ priceMin: v })}/>
            <span style={{ color: 'var(--muted)' }}>–</span>
            <NumberField placeholder="Max" value={priceMax} onChange={(v) => onChange({ priceMax: v })}/>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            {[[0, 25, '<$25'], [25, 75, '$25–75'], [75, 200, '$75–200'], [200, null, '$200+']].map(([lo, hi, lab]) => (
              <button key={lab} onClick={() => onChange({ priceMin: lo, priceMax: hi })}
                className="btn btn-ghost"
                style={{
                  fontSize: 11.5, padding: '4px 10px', borderRadius: 99,
                  background: priceMin === lo && priceMax === hi ? 'var(--accent-soft)' : 'var(--surface-2)',
                  color: priceMin === lo && priceMax === hi ? 'var(--accent)' : 'var(--fg-2)',
                }}>{lab}</button>
            ))}
          </div>
          {(priceMin != null || priceMax != null) && (
            <button onClick={() => onChange({ priceMin: '', priceMax: '' })}
              style={{
                background: 'transparent', border: 0, padding: 0, marginTop: 6,
                color: 'var(--muted)', fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline',
              }}>Reset</button>
          )}
        </Popover>
      )}
    </div>
  );
}

function DistanceFilter({ radiusKm, lat, lng, onChange }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);
  useOutsideClick(ref, () => setOpen(false));
  const haveLoc = lat != null && lng != null;
  const label = haveLoc && radiusKm != null ? `Within ${radiusKm} km`
    : 'Distance';
  const active = haveLoc && radiusKm != null;

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setErr('Geolocation is not supported in this browser.');
      return;
    }
    setBusy(true); setErr(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        onChange({
          lat: pos.coords.latitude.toFixed(5),
          lng: pos.coords.longitude.toFixed(5),
          radiusKm: radiusKm ?? 25,
        });
      },
      (e) => {
        setBusy(false);
        // Map the three GeolocationPositionError codes to copy a user
        // can act on. Default to whatever the browser said for anything
        // unexpected.
        if (e.code === 1) {
          setErr('Permission denied. Allow location for this site in your browser settings, then try again.');
        } else if (e.code === 2) {
          setErr("Couldn't read your position — try again, or check that location services are on.");
        } else if (e.code === 3) {
          setErr('Timed out. Try again with a clearer signal.');
        } else {
          setErr(e.message || 'Could not read your location.');
        }
      },
      { maximumAge: 5 * 60 * 1000, timeout: 10000 },
    );
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} className="btn btn-outline"
        style={{
          fontSize: 12.5,
          background: active ? 'var(--accent-soft)' : 'transparent',
          borderColor: active ? 'var(--accent)' : 'var(--border-strong)',
          color: active ? 'var(--accent)' : 'var(--fg-2)',
          fontWeight: active ? 600 : 500,
        }}>
        <Icons.Globe size={12} sw={1.7}/> {label}
        <Icons.ArrowDown size={11} sw={2}/>
      </button>
      {open && (
        <Popover>
          <PopoverTitle>Distance from you</PopoverTitle>
          {!haveLoc ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 10, lineHeight: 1.5 }}>
                Share your location once to see nearby businesses sorted by distance.
              </div>
              <button onClick={useMyLocation} disabled={busy} className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}>
                {busy ? 'Locating…' : 'Use my location'}
              </button>
              {err && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
            </>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {[5, 10, 25, 50, 100].map((km) => (
                  <button key={km} onClick={() => onChange({ radiusKm: km })}
                    className="btn btn-ghost"
                    style={{
                      fontSize: 11.5, padding: '4px 10px', borderRadius: 99,
                      background: radiusKm === km ? 'var(--accent-soft)' : 'var(--surface-2)',
                      color: radiusKm === km ? 'var(--accent)' : 'var(--fg-2)',
                    }}>{km} km</button>
                ))}
              </div>
              <button onClick={() => onChange({ lat: '', lng: '', radiusKm: '' })}
                style={{
                  background: 'transparent', border: 0, padding: 0, marginTop: 10,
                  color: 'var(--muted)', fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline',
                }}>Forget my location</button>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}

function RatingFilter({ minRating, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutsideClick(ref, () => setOpen(false));
  const label = minRating != null ? `${minRating}★+` : 'Rating';
  const active = minRating != null;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} className="btn btn-outline"
        style={{
          fontSize: 12.5,
          background: active ? 'var(--accent-soft)' : 'transparent',
          borderColor: active ? 'var(--accent)' : 'var(--border-strong)',
          color: active ? 'var(--accent)' : 'var(--fg-2)',
          fontWeight: active ? 600 : 500,
        }}>
        ★ {label}
        <Icons.ArrowDown size={11} sw={2}/>
      </button>
      {open && (
        <Popover>
          <PopoverTitle>Minimum rating</PopoverTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[5, 4, 3, 2].map((n) => {
              const on = minRating === n;
              return (
                <button key={n} onClick={() => onChange({ minRating: n })}
                  className="btn btn-ghost"
                  style={{
                    justifyContent: 'flex-start',
                    fontSize: 12.5, padding: '6px 10px', borderRadius: 8,
                    background: on ? 'var(--accent-soft)' : 'transparent',
                    color: on ? 'var(--accent)' : 'var(--fg-2)',
                  }}>
                  {'★'.repeat(n)}{'☆'.repeat(5 - n)} <span style={{ marginLeft: 8, opacity: 0.7 }}>{n}+</span>
                </button>
              );
            })}
          </div>
          {minRating != null && (
            <button onClick={() => onChange({ minRating: '' })}
              style={{
                background: 'transparent', border: 0, padding: 0, marginTop: 8,
                color: 'var(--muted)', fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline',
              }}>Reset</button>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
            Businesses without reviews yet are hidden when this filter is on.
          </div>
        </Popover>
      )}
    </div>
  );
}

function NumberField({ placeholder, value, onChange }) {
  return (
    <input type="number" inputMode="numeric" min="0"
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      style={{
        width: 80, padding: '6px 8px', borderRadius: 6,
        border: '1px solid var(--border-strong)', background: 'var(--surface)',
        color: 'var(--fg)', fontSize: 13,
      }}/>
  );
}

function Popover({ children }) {
  return (
    <div className="card" style={{
      position: 'absolute', top: 'calc(100% + 6px)', left: 0,
      minWidth: 220, padding: 12, zIndex: 30,
      boxShadow: 'var(--shadow)',
    }}>{children}</div>
  );
}
function PopoverTitle({ children }) {
  return <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 8 }}>{children}</div>;
}

function useOutsideClick(ref, fn) {
  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) fn(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ref, fn]);
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ─── Card ───────────────────────────────────────────────────────────

function BusinessCard({ biz, q }) {
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
      <div style={{
        height: 96, background: banner, position: 'relative',
        display: 'flex', alignItems: 'flex-end', padding: 14,
      }}>
        <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 6 }}>
          {biz.ratingAvg != null && biz.reviewCount > 0 && (
            <div style={{
              padding: '3px 8px', borderRadius: 99,
              background: 'rgba(255,255,255,0.92)',
              fontSize: 10.5, fontWeight: 700,
              color: '#333',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }} title={`${biz.reviewCount} review${biz.reviewCount === 1 ? '' : 's'}`}>
              <span style={{ color: '#E0A82E' }}>★</span>
              {biz.ratingAvg.toFixed(1)}
              <span style={{ opacity: 0.5, fontWeight: 500 }}>({biz.reviewCount})</span>
            </div>
          )}
          {biz.category && (
            <div style={{
              padding: '3px 8px', borderRadius: 99,
              background: 'rgba(255,255,255,0.85)',
              fontSize: 10.5, fontWeight: 600,
              color: '#333', letterSpacing: '0.04em', textTransform: 'uppercase',
            }}>{biz.category}</div>
          )}
        </div>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '2px solid #fff', boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 19,
          color: '#333',
        }}>{initial}</div>
      </div>

      <div style={{ padding: 16, flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>{biz.bizName}</div>
          {biz.distanceKm != null && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {fmtDistance(biz.distanceKm)}
            </div>
          )}
        </div>
        {biz.tagline && (
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.45,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {biz.tagline}
          </div>
        )}
        {biz.addressLabel && (
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{biz.addressLabel}</div>
        )}

        {/* Show matched services when there's a query */}
        {q && biz.matchingServices && biz.matchingServices.length > 0 && (
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {biz.matchingServices.map((s) => (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                fontSize: 12, color: 'var(--fg-2)',
                background: 'var(--surface-2)', padding: '4px 8px', borderRadius: 6,
              }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.name}
                </span>
                <span className="mono-num" style={{ fontWeight: 600, marginLeft: 6 }}>
                  ${Number(s.price).toFixed(0)}
                </span>
              </div>
            ))}
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

function fmtDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}
