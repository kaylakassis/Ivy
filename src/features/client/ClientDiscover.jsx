// /me/discover — directory of THRYVE businesses that have opted in to be
// listed publicly. Filters compose server-side: category + price range +
// service-name search + distance from the client's location are all
// real DB queries (see /api/me/discover) so a search like "botox $10–50"
// only returns businesses whose botox is in that range, sorted by distance
// when the user shares their location.
//
// State lives in URL search params so links are shareable / bookmarkable
// and the back button rewinds the filter, not the route.
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelPageHeader, SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';
import { publicOrigin } from '../../lib/publicUrl.js';

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
  // Slug of the currently expanded business card. Drives the BusinessExpandedView
  // overlay that renders over the grid. Lives in component state instead
  // of the URL so the back-button doesn't navigate away from Discover.
  const [openSlug, setOpenSlug] = useState(null);
  // When a review is posted from inside the expanded view, bump this so
  // the underlying grid refetches its rating/count cells.
  const reloadGrid = useCallback(() => setReloadKey((n) => n + 1), []);

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
          <div className="discover-grid">
            {businesses.map((b) => (
              <BusinessCard key={b.slug} biz={b} q={q}
                onOpen={() => setOpenSlug(b.slug)}/>
            ))}
          </div>
        </>
      )}
      {openSlug && (
        <BusinessExpandedView
          slug={openSlug}
          onClose={() => setOpenSlug(null)}
          onReviewPosted={reloadGrid}
        />
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

function BusinessCard({ biz, q, onOpen }) {
  const initial = (biz.bizName || '?').trim()[0]?.toUpperCase() || '?';
  const fallbackBanner = bannerFor(biz.slug || biz.bizName || '?');
  const accent = biz.accentColor || null;
  // Cover priority: real service photo > workspace's accent gradient > fallback hashed pastel.
  const coverBg = biz.coverPhotoUrl
    ? `linear-gradient(0deg, rgba(0,0,0,0.18), rgba(0,0,0,0)), url(${biz.coverPhotoUrl}) center/cover`
    : accent
    ? `linear-gradient(135deg, ${accent}, ${accent}cc)`
    : fallbackBanner;

  return (
    <button type="button" onClick={onOpen}
      className="card discover-card"
      style={{
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
        cursor: 'pointer', padding: 0, textAlign: 'left',
        border: '1px solid var(--border)',
      }}>
      <div style={{
        aspectRatio: '4 / 3', background: coverBg, position: 'relative',
        display: 'flex', alignItems: 'flex-end', padding: 12,
      }}>
        <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 6 }}>
          {biz.ratingAvg != null && biz.reviewCount > 0 && (
            <div style={{
              padding: '3px 8px', borderRadius: 99,
              background: 'rgba(15,15,15,0.78)',
              fontSize: 10.5, fontWeight: 700,
              color: '#fff', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }} title={`${biz.reviewCount} review${biz.reviewCount === 1 ? '' : 's'}`}>
              <span style={{ color: '#FFD24A' }}>★</span>
              {biz.ratingAvg.toFixed(1)}
              <span style={{ opacity: 0.7, fontWeight: 500 }}>({biz.reviewCount})</span>
            </div>
          )}
        </div>
        {/* Logo / initial badge — pinned bottom-left over the cover. */}
        {biz.logoUrl ? (
          <img src={biz.logoUrl} alt={biz.bizName}
            style={{
              width: 44, height: 44, borderRadius: 12, objectFit: 'cover',
              background: '#fff', border: '2px solid #fff',
              boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
            }}/>
        ) : (
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '2px solid #fff', boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
            fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 19,
            color: accent || '#333',
          }}>{initial}</div>
        )}
      </div>

      <div style={{ padding: 14, flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{
            fontSize: 14.5, fontWeight: 600, flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{biz.bizName}</div>
          {biz.distanceKm != null && (
            <div style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
              {fmtDistance(biz.distanceKm)}
            </div>
          )}
        </div>
        {biz.category && (
          <div style={{
            display: 'inline-block', alignSelf: 'flex-start',
            padding: '2px 8px', borderRadius: 6,
            fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em',
            textTransform: 'uppercase',
            background: 'var(--surface-2)', color: 'var(--muted)',
          }}>{biz.category}</div>
        )}
        {biz.tagline && (
          <div style={{
            fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.4,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {biz.tagline}
          </div>
        )}

        {/* Matched services only show on filtered queries — clearer signal */}
        {q && biz.matchingServices && biz.matchingServices.length > 0 && (
          <div style={{ marginTop: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {biz.matchingServices.slice(0, 2).map((s) => (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                fontSize: 11.5, color: 'var(--fg-2)',
                background: 'var(--surface-2)', padding: '3px 7px', borderRadius: 5,
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
          fontSize: 11.5, color: 'var(--muted)', marginTop: 'auto', paddingTop: 6,
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {biz.minPrice != null && biz.minPrice > 0
              ? <>From ${Number(biz.minPrice).toFixed(0)}</>
              : <>{biz.serviceCount} service{biz.serviceCount === 1 ? '' : 's'}</>}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            color: accent || 'var(--accent)', fontWeight: 600, fontSize: 11.5,
          }}>
            View <Icons.Arrow size={11} sw={2.2}/>
          </span>
        </div>
      </div>
    </button>
  );
}

function fmtDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

// ─── Expanded view ──────────────────────────────────────────────────
//
// Big modal sheet that pops over the grid when a card is clicked.
// Loads /api/businesses/:slug, shows hero (cover + logo + accent),
// services, reviews (+ a review form when the signed-in user is
// eligible), and a "Visit site" CTA that opens the public booking
// page in a new tab.
//
// On desktop we render as a centered card; on phones the same modal
// behaves as a full-screen sheet so the content has room to breathe.
function BusinessExpandedView({ slug, onClose, onReviewPosted }) {
  const navigate = useNavigate();
  const [data, setData]     = useState(null);
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [msgBusy, setMsgBusy] = useState(false);
  const [msgErr, setMsgErr] = useState(null);
  // Bumped after a review post so the same view re-fetches eligibility
  // + the recent-reviews list and updates the inline summary.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api.get('/businesses/' + encodeURIComponent(slug))
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [slug, reloadKey]);

  // Esc closes — drawer-style escape hatch.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const biz = data?.business;
  const gallery = data?.gallery || [];
  const accent = biz?.accentColor || 'var(--accent)';
  const fallback = bannerFor(slug);
  // Hero cover prefers the first gallery photo (uploaded by the
  // business), falls back to the workspace's accent color, and
  // finally to the deterministic pastel banner so a brand-new
  // workspace still has a hero.
  const heroCover = gallery[0]
    ? `linear-gradient(0deg, rgba(0,0,0,0.35), rgba(0,0,0,0)), url(${gallery[0]}) center/cover`
    : biz?.accentColor
    ? `linear-gradient(135deg, ${accent}, ${accent}cc)`
    : fallback;
  const visitHref = biz ? `${publicOrigin()}/book/${biz.slug}` : '#';

  // Message button — starts (or reuses) a thread with this workspace
  // by handing the client_id we already loaded with the eligibility
  // payload. Falls through to /me/messages?threadId=<id> so the
  // existing Messages page does the rest. When the user isn't a
  // client of this business yet, the button is disabled with copy
  // explaining why (you have to book or be added first).
  const startMessage = async () => {
    if (!data?.eligibility?.clientId || msgBusy) return;
    setMsgBusy(true); setMsgErr(null);
    try {
      const r = await api.post('/me/threads', { clientId: data.eligibility.clientId });
      const threadId = r?.thread?.id;
      onClose();
      navigate(threadId ? `/me/messages?threadId=${threadId}` : '/me/messages');
    } catch (e) {
      setMsgErr(e.message || 'Could not open the message thread');
      setMsgBusy(false);
    }
  };
  const canMessage = !!data?.eligibility?.clientId;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 0, overflowY: 'auto',
      }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="discover-sheet"
        style={{
          width: '100%', maxWidth: 880,
          background: 'var(--surface)',
          color: 'var(--fg)',
          borderRadius: 0, // overridden on desktop in CSS
          minHeight: '100vh',
          margin: 0,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
        }}>
        {/* Hero — a full 220px photo when the business uploaded one, but a
            shorter banner for color-only heroes so a flat accent slab doesn't
            dominate the card. */}
        <div style={{
          position: 'relative',
          height: gallery[0] ? 220 : 132,
          background: heroCover,
        }}>
          <button onClick={onClose} aria-label="Close"
            style={{
              position: 'absolute', top: 14, right: 14,
              width: 36, height: 36, borderRadius: 999,
              border: 'none', cursor: 'pointer',
              background: 'rgba(15,15,15,0.6)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            }}>
            <Icons.X size={16}/>
          </button>
        </div>

        {/* Header card — overlaps the hero */}
        <div style={{ padding: '0 22px', marginTop: -38 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            {biz?.logoUrl ? (
              <img src={biz.logoUrl} alt={biz.bizName}
                style={{
                  width: 76, height: 76, borderRadius: 18, objectFit: 'cover',
                  background: '#fff', border: '3px solid var(--surface)',
                  boxShadow: '0 6px 16px rgba(0,0,0,0.18)', flexShrink: 0,
                }}/>
            ) : (
              <div style={{
                width: 76, height: 76, borderRadius: 18,
                background: 'var(--surface)', border: '3px solid var(--surface)',
                boxShadow: '0 6px 16px rgba(0,0,0,0.18)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 30,
                color: accent, flexShrink: 0,
              }}>{(biz?.bizName || slug)[0]?.toUpperCase()}</div>
            )}
            <div style={{ flex: 1, minWidth: 0, paddingBottom: 8 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--fg)' }}>
                {biz?.bizName || slug}
              </div>
              {data?.reviews?.summary?.count > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginTop: 4,
                  fontSize: 12.5, color: 'var(--fg-2)',
                }}>
                  <Stars value={data.reviews.summary.avg || 0}/>
                  <span style={{ fontWeight: 600 }}>{(data.reviews.summary.avg || 0).toFixed(1)}</span>
                  <span style={{ color: 'var(--muted)' }}>({data.reviews.summary.count})</span>
                </div>
              )}
              {biz?.category && (
                <div style={{
                  display: 'inline-block', marginTop: 6,
                  padding: '2px 8px', borderRadius: 6,
                  fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  background: 'var(--surface-2)', color: 'var(--muted)',
                }}>{biz.category}</div>
              )}
            </div>
          </div>

          {biz?.tagline && (
            <p style={{
              fontSize: 14.5, color: 'var(--fg-2)', lineHeight: 1.55,
              margin: '14px 0 0',
            }}>{biz.tagline}</p>
          )}
          {biz?.addressLabel && (
            <div style={{
              fontSize: 12.5, color: 'var(--muted)', marginTop: 8,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <Icons.Globe size={12} sw={1.7}/> {biz.addressLabel}
            </div>
          )}

          {/* Three big CTAs — Google-Business-style action row.
              Always-visible. Disabled states explain themselves. */}
          <div className="discover-ctas" style={{ marginTop: 20 }}>
            <ActionButton
              icon="Calendar"
              label="Book"
              href={visitHref}
              accent={accent}
              primary
            />
            <ActionButton
              icon="Globe"
              label="Website"
              href={biz?.siteHandle ? `/site/${biz.siteHandle}` : null}
              accent={accent}
              hint={biz?.siteHandle ? null : 'No website yet'}
            />
            <ActionButton
              icon="Chat"
              label="Message"
              onClick={canMessage ? startMessage : null}
              accent={accent}
              busy={msgBusy}
              hint={canMessage
                ? null
                : 'Book or join their client list to message them'}
            />
          </div>
          {msgErr && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              fontSize: 12, color: 'var(--danger)',
            }}>{msgErr}</div>
          )}
        </div>

        {loading && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            Loading…
          </div>
        )}

        {error && (
          <div style={{ padding: 22 }}>
            <EmptyNote icon="Globe" title="Couldn't load this business"
              hint={error.message || 'Try again in a moment.'}/>
          </div>
        )}

        {/* Snapshot sections — Google Business shape: photos, hours,
            services, reviews. Iframe of the workspace's published
            site is gone (it took up too much real estate and was
            blocked from many of the page's interactive controls
            anyway by the sandbox). The "Website" CTA above takes
            interested users straight there. */}
        {data && !loading && (
          <>
            {gallery.length > 0 && (
              <section style={{ padding: '24px 0 0' }}>
                <div style={{ padding: '0 22px' }}>
                  <SectionTitle>Photos</SectionTitle>
                </div>
                <div className="discover-gallery">
                  {gallery.map((url, i) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer"
                      style={{
                        flex: '0 0 auto',
                        width: 200, aspectRatio: '4 / 3',
                        borderRadius: 12, overflow: 'hidden',
                        background: `url(${url}) center/cover, var(--surface-2)`,
                        border: '1px solid var(--border)',
                        cursor: 'zoom-in',
                      }}
                      aria-label={`Photo ${i + 1} of ${gallery.length}`}
                    />
                  ))}
                </div>
              </section>
            )}

            {biz?.availability && (
              <section style={{ padding: '24px 22px 0' }}>
                <SectionTitle>Hours</SectionTitle>
                <HoursList availability={biz.availability} />
              </section>
            )}

            {data.services && data.services.length > 0 && (
              <section style={{ padding: '24px 22px 0' }}>
                <SectionTitle>Services</SectionTitle>
                <div style={{
                  marginTop: 10, display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
                  gap: 10,
                }}>
                  {data.services.map((s) => (
                    <div key={s.id} className="card"
                      style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
                      {s.photoUrl ? (
                        <img src={s.photoUrl} alt={s.name}
                          style={{ width: 52, height: 52, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}/>
                      ) : (
                        <div style={{
                          width: 52, height: 52, borderRadius: 10,
                          background: 'var(--surface-2)', flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: 'var(--muted)',
                        }}><Icons.Spark size={18} sw={1.6}/></div>
                      )}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{
                          fontSize: 13, fontWeight: 600, lineHeight: 1.3,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{s.name}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                          {s.durationMinutes} min{s.price > 0 ? ` · $${s.price.toFixed(0)}` : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Reviews */}
            <section style={{ padding: '24px 22px 32px' }}>
              <SectionTitle>
                Reviews
                {data.reviews.summary.count > 0 && (
                  <span style={{ marginLeft: 8, color: 'var(--muted)', fontWeight: 500 }}>
                    {data.reviews.summary.count}
                  </span>
                )}
              </SectionTitle>

              <ReviewSection
                slug={biz.slug}
                summary={data.reviews.summary}
                recent={data.reviews.recent}
                eligibility={data.eligibility}
                accent={accent}
                onPosted={() => { setReloadKey((n) => n + 1); onReviewPosted?.(); }}
              />
            </section>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function SectionTitle({ children }) {
  return (
    <h3 style={{
      fontSize: 16, fontWeight: 600, margin: 0, color: 'var(--fg)',
      letterSpacing: '-0.01em',
    }}>{children}</h3>
  );
}

// One of the three big CTAs in the expanded card. Renders as <a> when
// `href` is set, <button> when `onClick` is set, and a disabled chip
// otherwise (with the hint as a tooltip + below the icon). Visually
// matches Google Business's action row: icon stacked over a label.
function ActionButton({ icon, label, href, onClick, accent, primary, busy, hint }) {
  const Icon = Icons[icon] || Icons.Spark;
  const disabled = !href && !onClick;
  const baseStyle = {
    flex: 1,
    padding: '12px 8px',
    borderRadius: 12,
    border: primary
      ? `1px solid ${accent}`
      : '1px solid var(--border)',
    background: primary ? accent : 'var(--surface-2)',
    color: primary ? pickInk(accent) : 'var(--fg)',
    fontSize: 12.5, fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : busy ? 0.7 : 1,
    textDecoration: 'none',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    minHeight: 70,
    transition: 'transform .12s ease, background .12s ease',
    textAlign: 'center',
  };
  const inner = (
    <>
      <Icon size={20} sw={1.7} stroke="currentColor"/>
      <span>{busy ? 'Opening…' : label}</span>
    </>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" style={baseStyle} title={hint || ''}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy}
      style={{ ...baseStyle, fontFamily: 'inherit' }}
      title={hint || ''}>
      {inner}
    </button>
  );
}

// Weekly schedule. `availability` is { 0..6: [{start, end}, …] } where
// 0 = Sunday and start/end are minutes-from-midnight in the workspace's
// local time. Closed days collapse to "Closed". Today's row is bolded
// so the most-asked question ("are they open right now?") gets the
// fastest answer.
function HoursList({ availability }) {
  const today = new Date().getDay();
  const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return (
    <div style={{
      marginTop: 10, padding: '12px 14px',
      background: 'var(--surface-2)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      display: 'flex', flexDirection: 'column', gap: 6,
      fontSize: 13,
    }}>
      {labels.map((label, i) => {
        const intervals = availability[i] || availability[String(i)] || [];
        const isToday = i === today;
        const text = intervals.length === 0
          ? 'Closed'
          : intervals.map((iv) => `${minToLabel(iv.start)} – ${minToLabel(iv.end)}`).join(', ');
        return (
          <div key={i} style={{
            display: 'flex', justifyContent: 'space-between', gap: 16,
            color: isToday ? 'var(--fg)' : 'var(--fg-2)',
            fontWeight: isToday ? 600 : 400,
          }}>
            <span>{label}{isToday && <span style={{
              marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 4,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 700,
            }}>Today</span>}</span>
            <span style={{
              color: intervals.length === 0 ? 'var(--muted)' : 'inherit',
              fontVariantNumeric: 'tabular-nums',
            }}>{text}</span>
          </div>
        );
      })}
    </div>
  );
}

function minToLabel(min) {
  if (min == null || !Number.isFinite(min)) return '';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  const am = h < 12;
  const h12 = ((h + 11) % 12) + 1;
  const mm = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
  return `${h12}${mm} ${am ? 'AM' : 'PM'}`;
}

function Stars({ value, size = 14 }) {
  const v = Math.max(0, Math.min(5, Number(value) || 0));
  return (
    <span aria-label={`${v.toFixed(1)} stars`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 1, fontSize: size,
      color: '#FFD24A', letterSpacing: 1,
    }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{ opacity: i <= Math.round(v) ? 1 : 0.28 }}>★</span>
      ))}
    </span>
  );
}

function ReviewSection({ slug, summary, recent, eligibility, accent, onPosted }) {
  return (
    <div style={{ marginTop: 12 }}>
      {summary.count > 0 ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
          padding: '12px 14px', borderRadius: 12,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
        }}>
          <div style={{
            fontSize: 28, fontWeight: 700, lineHeight: 1, color: 'var(--fg)',
          }}>{(summary.avg || 0).toFixed(1)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Stars value={summary.avg || 0}/>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Based on {summary.count} verified review{summary.count === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      ) : (
        <div style={{
          padding: '16px 14px', borderRadius: 12,
          background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
          fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 16,
        }}>
          No reviews yet. {eligibility?.canReview ? 'Be the first to leave one.' : ''}
        </div>
      )}

      {/* Review form — only when the signed-in user is eligible AND
          hasn't already reviewed this workspace. */}
      {eligibility && (
        eligibility.canReview ? (
          <ReviewForm slug={slug} accent={accent} onPosted={onPosted}/>
        ) : eligibility.hasReviewed ? (
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            background: 'color-mix(in srgb, var(--ok) 8%, var(--surface-2))',
            border: '1px solid var(--ok)',
            fontSize: 12.5, color: 'var(--ok)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Icons.Check size={14}/> You've already reviewed this business — thanks!
          </div>
        ) : eligibility.reason === 'no-booking-or-message' || eligibility.reason === 'not-a-client' ? (
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55,
          }}>
            Reviews are only open to verified clients. Book or message this business once and you'll be able to leave one.
          </div>
        ) : null
      )}

      {/* Recent reviews */}
      {recent && recent.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {recent.map((r) => (
            <div key={r.id} style={{
              padding: '12px 14px', borderRadius: 12,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
              }}>
                <Stars value={r.rating} size={12}/>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.reviewerName}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  · {fmtRelative(r.createdAt)}
                </span>
              </div>
              {r.text && (
                <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
                  {r.text}
                </div>
              )}
              {r.ownerResponse && (
                <div style={{
                  marginTop: 10, padding: '8px 10px', borderRadius: 8,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5,
                }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>
                    Owner response
                  </div>
                  {r.ownerResponse}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewForm({ slug, accent, onPosted }) {
  const [rating, setRating] = useState(0);
  const [text, setText]     = useState('');
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!rating) { setErr('Pick a star rating first.'); return; }
    setBusy(true); setErr(null);
    try {
      await api.post(`/businesses/${encodeURIComponent(slug)}/reviews`, {
        rating, text: text.trim() || null,
      });
      onPosted();
    } catch (e2) {
      setErr(e2.message || 'Could not post your review');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{
      padding: 14, borderRadius: 12,
      background: 'var(--surface-2)',
      border: '1px solid var(--border-strong)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>Leave a review</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button"
            onClick={() => setRating(n)}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            style={{
              padding: 2, fontSize: 28, lineHeight: 1,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: n <= rating ? '#FFD24A' : 'var(--border-strong)',
              transition: 'color .12s ease',
            }}>
            ★
          </button>
        ))}
      </div>
      <textarea
        value={text} onChange={(e) => setText(e.target.value)}
        rows={3} maxLength={2000}
        placeholder="Tell other clients what you thought (optional)"
        style={{
          width: '100%', resize: 'vertical', minHeight: 70,
          padding: '8px 10px', borderRadius: 8,
          border: '1px solid var(--border-strong)',
          background: 'var(--surface)', color: 'var(--fg)',
          fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5,
          outline: 'none',
        }}/>
      {err && (
        <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>
      )}
      <button type="submit" disabled={busy || !rating}
        style={{
          alignSelf: 'flex-start',
          padding: '8px 16px', borderRadius: 8,
          border: 'none', cursor: busy || !rating ? 'default' : 'pointer',
          background: accent, color: pickInk(accent),
          fontSize: 13, fontWeight: 600,
          opacity: busy || !rating ? 0.5 : 1,
        }}>
        {busy ? 'Posting…' : 'Post review'}
      </button>
    </form>
  );
}

function fmtRelative(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 86400e3;
  if (d < 1)   return 'today';
  if (d < 2)   return 'yesterday';
  if (d < 30)  return `${Math.round(d)}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

// Mirror the email-shell luminance check so a dark accent gets light
// button text and a bright accent gets dark text. Default to dark
// (matches CFFF50 default and most owner-chosen lime/yellow accents).
function pickInk(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return '#0B0C08';
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 140 ? '#0B0C08' : '#F3F3EE';
}
