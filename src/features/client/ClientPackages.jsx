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

export function PackageCard({ pkg: p, onBook }) {
  const ratio = p.creditsTotal > 0 ? p.creditsRemaining / p.creditsTotal : 0;
  const inactive = p.status !== 'active' || p.creditsRemaining === 0;
  const low = !inactive && p.creditsRemaining <= Math.max(1, Math.min(2, Math.floor(p.creditsTotal / 5)));
  const canBook = !inactive && p.bookingSlug && !p.archived;
  return (
    <div className="card" style={{ padding: 16, opacity: inactive ? 0.75 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 650, overflowWrap: 'anywhere' }}>{p.name}</div>
          <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 2 }}>{p.businessName}</div>
        </div>
        {inactive && (
          <span style={{
            fontSize: 11, fontWeight: 650, padding: '2px 8px', borderRadius: 99,
            background: 'var(--surface-2)', color: 'var(--muted)',
          }}>{p.creditsRemaining === 0 ? 'Used up' : p.status === 'expired' ? 'Expired' : 'Ended'}</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 10, fontSize: 14 }}>
        <strong style={{ fontSize: 20 }}>{p.creditsRemaining}</strong>
        <span style={{ color: 'var(--fg-2)' }}>of {plural(p.creditsTotal, 'session')} left</span>
      </div>
      <div style={{ marginTop: 8, height: 6, borderRadius: 99, background: 'var(--border)', overflow: 'hidden' }}
        role="progressbar" aria-valuemin={0} aria-valuemax={p.creditsTotal} aria-valuenow={p.creditsRemaining}>
        <div style={{ width: `${Math.round(ratio * 100)}%`, height: '100%', background: inactive ? 'var(--muted)' : 'var(--accent)' }}/>
      </div>
      {!inactive && p.expiresAt && p.daysToExpiry != null && p.daysToExpiry <= 30 && (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--warn)' }}>
          {p.daysToExpiry > 0 ? `Use by ${fmtDate(p.expiresAt)} (${plural(p.daysToExpiry, 'day')} left)` : 'Expires today'}
        </div>
      )}
      {low && p.bookingSlug && !p.archived && (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          {p.creditsRemaining === 1 ? 'This is your last session.' : `Only ${p.creditsRemaining} sessions left.`}{' '}
          <Link to={bookHref(p.bookingSlug)} style={{ color: 'var(--accent)', fontWeight: 600 }}>Buy another package</Link>
        </div>
      )}
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
      setErr(ex.message || 'Could not book');
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
              {pkg.name} · {plural(pkg.creditsRemaining, 'session')} left
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }} aria-label="Close">
            <Icons.X size={16}/>
          </button>
        </div>

        <ErrorNote>{loadErr}</ErrorNote>
        {!calendar && !loadErr && <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>Loading…</div>}
        {calendar && services.length === 0 && (
          <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>
            This package does not cover any of the business's current services. Message them to book.
          </div>
        )}

        {calendar && services.length > 0 && (
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
