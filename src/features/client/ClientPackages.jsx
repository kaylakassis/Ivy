// Packages a client bought from the businesses they work with: sessions
// left, an expiry nudge, "Book a session" (spends a credit through
// POST /api/me/packages/:id/book) and a "buy another" link when running
// low. Used on the Payments page; Home shows a one-line summary per
// business instead.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import PolicyConsent, { usePolicyConsent } from '../calendar/PolicyConsent.jsx';
import { api } from '../../lib/api.js';
import { Sheet, ErrorNote, actionBtn, bookHref, plural, fmtDate } from './portalUi.jsx';

// The used-up / expired prompt: shown on the package card and in the
// booking sheet when a package can't be used any more. "Buy again" opens
// the business's own package checkout on their booking page; "See all
// services" opens the booking page.
export function RepurchasePrompt({ pkg: p, compact = false }) {
  const expired = p.state === 'expired';
  const slug = p.bookingSlug;
  const buyHref = slug && p.buyAgainPackageId
    ? `/book/${encodeURIComponent(slug)}?buy=${encodeURIComponent(p.buyAgainPackageId)}`
    : null;
  const allHref = slug ? bookHref(slug) : null;
  return (
    <div role="status" style={{
      marginTop: compact ? 0 : 12, padding: 12, borderRadius: 12,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      fontSize: 13.5, lineHeight: 1.5, color: 'var(--fg)',
    }}>
      <div>
        {expired
          ? 'This package has expired. Buy it again or see other services.'
          : "You've used all your sessions. Buy this package again or see other services."}
      </div>
      {(buyHref || allHref) && !p.archived && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {buyHref && (
            <Link to={buyHref} className="btn btn-primary" style={{ ...actionBtn, textDecoration: 'none' }}>
              <Icons.Gift size={14} sw={1.8}/> Buy again
            </Link>
          )}
          {allHref && (
            <Link to={allHref} className="btn btn-outline" style={{ ...actionBtn, textDecoration: 'none' }}>
              See all services
            </Link>
          )}
        </div>
      )}
      {!buyHref && !p.archived && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>
          {p.businessName ? `Message ${p.businessName}` : 'Message the business'} to get a new package.
        </div>
      )}
    </div>
  );
}

// Older servers don't send `state`; derive it the same way.
export function pkgState(p) {
  if (p.state) return p.state;
  if (p.status === 'cancelled') return 'ended';
  if (p.creditsRemaining <= 0 || p.status === 'exhausted') return 'used_up';
  if (p.status === 'expired' || (p.expiresAt && new Date(p.expiresAt).getTime() <= Date.now())) return 'expired';
  return 'active';
}

export function PackageCard({ pkg: p, onBook }) {
  const state = pkgState(p);
  const ratio = p.creditsTotal > 0 ? p.creditsRemaining / p.creditsTotal : 0;
  const inactive = state !== 'active';
  const low = !inactive && p.creditsRemaining <= Math.max(1, Math.min(2, Math.floor(p.creditsTotal / 5)));
  const canBook = !inactive && p.bookingSlug && !p.archived;
  const buyHref = p.bookingSlug && p.buyAgainPackageId
    ? `/book/${encodeURIComponent(p.bookingSlug)}?buy=${encodeURIComponent(p.buyAgainPackageId)}`
    : (p.bookingSlug ? bookHref(p.bookingSlug) : null);
  const left = Math.max(0, Number(p.creditsRemaining) || 0);
  const booked = Number(p.sessionsBooked) || 0;
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 650, overflowWrap: 'anywhere' }}>{p.name}</div>
          <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 2 }}>{p.businessName}</div>
        </div>
        {inactive && (
          <span style={{
            fontSize: 11, fontWeight: 650, padding: '2px 8px', borderRadius: 99,
            background: 'var(--surface-2)', color: 'var(--muted)', flexShrink: 0,
          }}>{state === 'used_up' ? 'Used up' : state === 'expired' ? 'Expired' : 'Ended'}</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 10, fontSize: 14, flexWrap: 'wrap', opacity: inactive ? 0.75 : 1 }}>
        <strong style={{ fontSize: 20 }}>{left}</strong>
        <span style={{ color: 'var(--fg-2)' }}>
          {left === 1 ? 'session left' : 'sessions left'} of {p.creditsTotal}
          {booked > 0 ? ` · ${booked} booked` : ''}
        </span>
      </div>
      <div style={{ marginTop: 8, height: 6, borderRadius: 99, background: 'var(--border)', overflow: 'hidden' }}
        role="progressbar" aria-label={`${left} of ${p.creditsTotal} sessions left`}
        aria-valuemin={0} aria-valuemax={p.creditsTotal} aria-valuenow={left}>
        <div style={{ width: `${Math.round(ratio * 100)}%`, height: '100%', background: inactive ? 'var(--muted)' : 'var(--accent)' }}/>
      </div>
      {(p.serviceNames?.length > 0 || p.anyService) && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
          Good for: {p.serviceNames?.length > 0 ? p.serviceNames.join(', ') : 'any service'}
        </div>
      )}
      {Number(p.sessionsHeld) > 0 && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)' }}>
          Booked sessions are held for you and count once you attend.
        </div>
      )}
      {!inactive && p.expiresAt && p.daysToExpiry != null && p.daysToExpiry <= 30 && (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--warn)' }}>
          {p.daysToExpiry > 0 ? `Use by ${fmtDate(p.expiresAt)} (${plural(p.daysToExpiry, 'day')} left)` : 'Expires today'}
        </div>
      )}
      {low && p.bookingSlug && !p.archived && (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          {left === 1 ? '1 session left. This is your last one.' : `Only ${left} sessions left.`}{' '}
          {buyHref && <Link to={buyHref} style={{ color: 'var(--accent)', fontWeight: 600 }}>Buy another package</Link>}
        </div>
      )}
      {(state === 'used_up' || state === 'expired') && <RepurchasePrompt pkg={p}/>}
      {canBook && (
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={() => onBook(p)} className="btn btn-outline" style={actionBtn}>
            <Icons.Calendar size={14} sw={1.8}/> Book a session
          </button>
        </div>
      )}
    </div>
  );
}

// Redeem a package by booking one or more sessions. Backed by
// POST /api/me/packages/:id/book, which spends credits up front, checks
// each slot against the business's availability and notice rules, and
// creates one booking per session (cancelling one gives the credit back).
export function RedeemPackageModal({ pkg, onClose, onBooked }) {
  const [calendar, setCalendar] = useState(null);
  const consent = usePolicyConsent(calendar);
  const [loadErr, setLoadErr] = useState(null);
  const [serviceId, setServiceId] = useState(null);
  const [mode, setMode] = useState('once');
  const [firstDate, setFirstDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [startHm, setStartHm] = useState('10:00');
  const [occurrences, setOccurrences] = useState(Math.min(4, pkg.creditsRemaining));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);
  // Set when the server says the package can't be used any more (someone
  // else took the last session, or it expired while the sheet was open).
  const [blocked, setBlocked] = useState(() => (pkgState(pkg) === 'active' ? null : pkgState(pkg)));

  useEffect(() => {
    let cancelled = false;
    api.get(`/calendar/public/${encodeURIComponent(pkg.bookingSlug)}`)
      .then((j) => {
        if (cancelled) return;
        setCalendar(j.calendar);
        const covered = filterCoveredServices(j.calendar?.services || [], pkg.serviceIds);
        if (covered.length > 0) setServiceId(covered[0].id);
      })
      .catch(() => { if (!cancelled) setLoadErr("We couldn't load this business's calendar. Please try again."); });
    return () => { cancelled = true; };
  }, [pkg.bookingSlug, pkg.serviceIds]);

  const services = calendar ? filterCoveredServices(calendar.services || [], pkg.serviceIds) : [];
  const service = services.find((s) => s.id === serviceId) || null;
  const slotCount = mode === 'once' ? 1 : Math.max(1, Math.min(occurrences, pkg.creditsRemaining));
  const startMin = hmToMin(startHm);
  const endMin = service ? startMin + (service.durationMinutes || 60) : startMin + 60;

  const submit = async (e) => {
    e?.preventDefault?.();
    if (submitting) return;
    if (!service) { setErr('Pick a service'); return; }
    setSubmitting(true);
    setErr(null);
    try {
      const body = mode === 'once'
        ? { serviceId: service.id, slots: [{ date: firstDate, startMin, endMin }] }
        : { serviceId: service.id, recurrence: mode, firstDate, startMin, endMin, occurrences: slotCount };
      const j = await api.post(`/me/packages/${encodeURIComponent(pkg.id)}/book`, { ...body, ...consent.fields() });
      onBooked?.(j);
    } catch (ex) {
      consent.handleError(ex);
      const code = ex?.details?.code;
      if (code === 'package_used_up' || code === 'package_expired') {
        setBlocked(code === 'package_expired' ? 'expired' : 'used_up');
        setErr(null);
      } else {
        setErr(ex.message || 'Could not book');
      }
      setSubmitting(false);
    }
  };

  return (
    <Sheet onClose={onClose} busy={submitting} labelledBy="redeem-title" maxWidth={480}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Calendar size={16} sw={1.8}/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 id="redeem-title" style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Book with your package</h3>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              {pkg.name} · {blocked === 'used_up' ? '0 sessions' : plural(pkg.creditsRemaining, 'session')} left
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }} aria-label="Close">
            <Icons.X size={16}/>
          </button>
        </div>

        {blocked && (
          <RepurchasePrompt compact pkg={{ ...pkg, state: blocked, creditsRemaining: blocked === 'used_up' ? 0 : pkg.creditsRemaining }}/>
        )}
        {!blocked && <ErrorNote>{loadErr}</ErrorNote>}
        {!blocked && !calendar && !loadErr && <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>Loading…</div>}
        {!blocked && calendar && services.length === 0 && (
          <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>
            This package does not cover any of the business's current services. Message them to book,
            or <Link to={bookHref(pkg.bookingSlug)} style={{ color: 'var(--accent)', fontWeight: 600 }}>see all services</Link>.
          </div>
        )}

        {!blocked && calendar && services.length > 0 && (
          <>
            <Field label="Service">
              <select value={serviceId || ''} onChange={(e) => setServiceId(e.target.value)} className="input" required style={{ fontSize: 15 }}>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} · {s.durationMinutes} min</option>
                ))}
              </select>
            </Field>
            <Field label="How often">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { id: 'once', label: 'Just once' },
                  { id: 'weekly', label: 'Weekly' },
                  { id: 'biweekly', label: 'Every 2 weeks' },
                  { id: 'monthly', label: 'Monthly' },
                ].map(({ id, label }) => (
                  <button key={id} type="button" onClick={() => setMode(id)} aria-pressed={mode === id}
                    style={{
                      padding: '8px 12px', borderRadius: 999,
                      border: '1px solid ' + (mode === id ? 'var(--accent)' : 'var(--border)'),
                      background: mode === id ? 'var(--accent-soft)' : 'var(--surface)',
                      color: mode === id ? 'var(--accent)' : 'var(--fg-2)',
                      fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    }}>{label}</button>
                ))}
              </div>
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
              <Field label={mode === 'once' ? 'Day' : 'First day'}>
                <input type="date" value={firstDate} onChange={(e) => setFirstDate(e.target.value)} required className="input" style={{ fontSize: 15 }}/>
              </Field>
              <Field label="Start time">
                <input type="time" step={300} value={startHm} onChange={(e) => setStartHm(e.target.value)} required className="input" style={{ fontSize: 15 }}/>
              </Field>
            </div>
            {mode !== 'once' && (
              <Field label="Number of sessions"
                hint={`Uses ${slotCount} of your ${plural(pkg.creditsRemaining, 'session')}.`}>
                <input type="number" min={1} max={pkg.creditsRemaining} value={occurrences}
                  onChange={(e) => setOccurrences(Math.max(1, Math.min(pkg.creditsRemaining, Number(e.target.value) || 1)))}
                  className="input" style={{ fontSize: 15 }}/>
              </Field>
            )}
            {service && (
              <div style={{
                padding: 10, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
                fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5,
              }}>
                Each session is {service.durationMinutes} minutes and ends at {fmtTimeFromMin(endMin)}.
              </div>
            )}
            <PolicyConsent consent={consent} svc={service} total={0} bizName={calendar?.settings?.bizName}/>
            <ErrorNote>{err}</ErrorNote>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-outline" onClick={onClose} disabled={submitting} style={{ ...actionBtn, flex: 1 }}>
                Not now
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting || !service || !consent.ready} style={{ ...actionBtn, flex: 2 }}>
                {submitting ? 'Booking…' : (slotCount === 1 ? 'Book session' : `Book ${slotCount} sessions`)}
              </button>
            </div>
          </>
        )}
      </form>
    </Sheet>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, color: 'var(--fg-2)', fontWeight: 550 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>{hint}</span>}
    </label>
  );
}

function filterCoveredServices(allServices, packageServiceIds) {
  if (!packageServiceIds || packageServiceIds.length === 0) return allServices;
  const set = new Set(packageServiceIds);
  return allServices.filter((s) => set.has(s.id));
}
function hmToMin(hm) {
  const [h, m] = String(hm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fmtTimeFromMin(m) {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${mm} ${ap}`;
}
