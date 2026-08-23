// /me - overview cards + per-business list. Acts as the landing page for
// client-only users and the place owners-who-are-also-clients drop into when
// they switch views.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelPageHeader, SkelStatGrid, SkelRowList } from '../../components/Skeleton.jsx';
import { useClientPortal } from './clientContext.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';

export default function ClientHome() {
  const { data, loading, error, refresh } = useClientPortal();
  const { user } = useAuth();
  if (loading || (!data && !error)) {
    return (
      <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <SkelPageHeader/>
        <SkelStatGrid count={4}/>
        <SkelRowList rows={3} withAvatar/>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="page-pad">
        <div className="card" style={{ padding: 28 }}>
          <EmptyNote icon="Users" title="Couldn't load your portal"
            hint={error?.message || 'Try refreshing.'}
            action={refresh && (
              <button className="btn btn-outline" onClick={refresh}>Retry</button>
            )}/>
        </div>
      </div>
    );
  }

  const { memberships, summary, isClient } = data;
  const greet = greeting();

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <FirstVisitWelcome/>
      {/* Hero mirrors the business dashboard's HeroBand (date kicker +
          display greeting + subtitle) so the two views feel like one app. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, letterSpacing: '0.04em' }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}
          </div>
          <h2 className="page-title" style={{ margin: 0, fontSize: 36 }}>
            {greet}{user?.name ? `, ${user.name.split(' ')[0]}` : ''}.
          </h2>
          <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--fg-2)', maxWidth: 560 }}>
            {isClient
              ? `Everything from ${memberships.length === 1 ? 'your business' : `your ${memberships.length} businesses`} on Ivy - bookings, payments, and messages in one place.`
              : "You're not yet linked to any businesses."}
          </p>
        </div>
        {isClient && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <Link to="/me/discover" className="btn btn-outline">
              <Icons.Globe size={14}/>Discover
            </Link>
            <Link to="/me/bookings" className="btn btn-primary">
              <Icons.Calendar size={14}/>My bookings
            </Link>
          </div>
        )}
      </div>

      {!isClient && (
        <div className="card" style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <EmptyNote icon="Users" title="No businesses yet"
            hint={user?.email_verified_at
              ? `Once a business owner adds you as a client (or you book through their Ivy link), they'll show up here. Make sure you signed up with the same email they have on file (${user?.email}).`
              : `If a business already added you, verify your email (${user?.email}) to link your account - businesses are matched to you by your verified email address. Check your inbox for the confirmation link, then refresh.`}/>
          <Link to="/me/discover" className="btn btn-primary"
            style={{ alignSelf: 'flex-start' }}>
            <Icons.Globe size={13} sw={1.7}/> Browse businesses on Ivy
          </Link>
        </div>
      )}

      {isClient && (
        <>
          <NeedsAttention summary={summary}/>

          <div className="grid-auto-sm">
            <Stat label="Unread messages" value={summary.unreadMessages}
              icon="Chat" tone={summary.unreadMessages > 0 ? 'accent' : 'muted'} to="/me/messages"/>
            <Stat label="Upcoming bookings" value={summary.upcomingBookings}
              icon="Calendar" tone="muted" to="/me/bookings"/>
            <Stat label="Open invoices" value={summary.openInvoices}
              icon="Dollar" tone={summary.openInvoices > 0 ? 'warn' : 'muted'} to="/me/invoices"/>
            <Stat label="Pending documents" value={summary.pendingDocs}
              icon="Doc" tone={summary.pendingDocs > 0 ? 'warn' : 'muted'} to="/me/documents"/>
            {summary.pendingReviews > 0 && (
              <Stat label="Reviews to leave" value={summary.pendingReviews}
                icon="Check" tone="accent" to="/me/bookings?tab=past"/>
            )}
          </div>

          <div className="card" style={{ padding: 18 }}>
            <div className="metric-label" style={{ marginBottom: 4 }}>Businesses you're a client of</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
              These are businesses that have you in their client list - book,
              message, and pay them from here. This isn't about businesses you own.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {memberships.map((m) => (
                <div key={m.clientId} style={{
                  padding: '10px 12px', borderRadius: 10,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                    background: 'var(--accent-soft)', color: 'var(--accent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 600, fontSize: 14,
                  }}>{(m.businessName[0] || '?').toUpperCase()}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{m.businessName}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      They have you saved as {m.clientName}
                    </div>
                  </div>
                  <Link to={`/me/messages?clientId=${encodeURIComponent(m.clientId)}`}
                    className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }}>
                    Message <Icons.Chat size={12} sw={1.8}/>
                  </Link>
                  <button className="btn btn-ghost"
                    title="Hide this business from your portal. They keep their own records; you can ask them to re-invite you if you change your mind."
                    onClick={async () => {
                      if (!confirm(`Hide ${m.businessName} from your portal? Their bookings, invoices, and messages will stop showing here. They keep their own records - nothing changes on their side.`)) return;
                      try {
                        await api.post('/me/businesses/hide', { clientId: m.clientId });
                        window.location.reload();
                      } catch { /* row stays; retry available */ }
                    }}
                    style={{ padding: '6px 8px', fontSize: 12, color: 'var(--muted)' }}>
                    Hide
                  </button>
                </div>
              ))}
            </div>
          </div>

          <PackagesCard/>
        </>
      )}
    </div>
  );
}

// One-time welcome banner. Shows on first visit to /me, dismisses on
// click, and never reappears (flag in localStorage). Mirrors the friendly
// tone of the owner walkthrough's Ivy step but stays compact - clients
// don't need a multi-step tour.
const WELCOME_KEY = 'ivy.client.welcomed.v1';
function FirstVisitWelcome() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(WELCOME_KEY)) setVisible(true);
    } catch { /* localStorage blocked - just don't show it */ }
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try { localStorage.setItem(WELCOME_KEY, String(Date.now())); }
    catch { /* ignore */ }
    setVisible(false);
  };

  return (
    <div className="card" style={{
      padding: 18, display: 'flex', alignItems: 'flex-start', gap: 14,
      borderColor: 'var(--accent)',
      background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--surface))',
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, flexShrink: 0,
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Spark size={18}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
          Welcome to your Ivy portal
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          This is your one place for everything across the businesses you
          work with: bookings, invoices, documents to sign, and direct
          messages. We'll surface what needs your attention up top - quick
          glance, you're set.
        </p>
        <button onClick={dismiss} className="btn btn-primary"
          style={{ padding: '6px 14px', fontSize: 12.5 }}>
          Got it <Icons.Check size={11} sw={2.4}/>
        </button>
      </div>
      <button onClick={dismiss} aria-label="Dismiss welcome"
        className="btn btn-ghost" style={{ padding: 6, marginTop: -2 }}>
        <Icons.X size={14}/>
      </button>
    </div>
  );
}

// Packages a user has bought from any business they work with. Defaults
// to active (credits remaining + not expired); a "Show history" toggle
// loads exhausted/expired/cancelled rows too so clients can see "I've
// used 3 packs from this business" - useful for taxes + loyalty proof.
//
// Hidden entirely when the user has zero packages of any kind.
function PackagesCard() {
  const [active, setActive] = useState(null);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [allPackages, setAllPackages] = useState(null); // lazy-loaded
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [redeemingPackage, setRedeemingPackage] = useState(null);

  useEffect(() => {
    api.get('/me/packages')
      .then((r) => setActive(r.packages || []))
      .catch(() => setActive([]));
  }, []);

  // Lazy-load history the first time the toggle is flipped on, then
  // cache. Avoids the larger query for the common case (user just
  // wants their current sessions-left).
  useEffect(() => {
    if (!includeHistory || allPackages != null) return;
    setLoadingHistory(true);
    api.get('/me/packages?all=1')
      .then((r) => setAllPackages(r.packages || []))
      .catch(() => setAllPackages([]))
      .finally(() => setLoadingHistory(false));
  }, [includeHistory, allPackages]);

  if (!active) return null;
  const showing = includeHistory && allPackages ? allPackages : active;
  if (showing.length === 0 && !includeHistory) return null;

  const historyCount = (allPackages?.length ?? 0) - active.length;

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div className="metric-label" style={{ flex: 1 }}>Your packages</div>
        <button
          type="button"
          onClick={() => setIncludeHistory((v) => !v)}
          style={{
            fontSize: 11.5, color: 'var(--muted)', padding: '2px 8px',
            background: 'transparent', textDecoration: 'underline',
            cursor: 'pointer',
          }}>
          {includeHistory
            ? 'Hide history'
            : (historyCount > 0 ? `Show history (${historyCount})` : 'Show history')}
        </button>
      </div>
      {loadingHistory && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Loading history…</div>
      )}
      {showing.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          No packages yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {showing.map((p) => {
            const ratio = p.creditsTotal > 0 ? p.creditsRemaining / p.creditsTotal : 0;
            const isInactive = p.status !== 'active' || p.creditsRemaining === 0;
            return (
              <div key={p.id} style={{
                padding: 12, borderRadius: 10,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                opacity: isInactive ? 0.7 : 1,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>{p.name}</span>
                  {isInactive && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 99,
                      background: 'var(--surface)', color: 'var(--muted)',
                      textTransform: 'uppercase', letterSpacing: '0.06em',
                    }}>{p.status}</span>
                  )}
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{p.businessName}</span>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
                  fontSize: 12.5, color: 'var(--fg-2)',
                }}>
                  <strong>{p.creditsRemaining}</strong>
                  <span>of {p.creditsTotal} sessions {isInactive ? 'used' : 'left'}</span>
                  {!isInactive && p.daysToExpiry != null && p.daysToExpiry <= 30 && (
                    <span style={{ marginLeft: 'auto', color: 'var(--warn)', fontSize: 11.5 }}>
                      {p.daysToExpiry > 0 ? `${p.daysToExpiry}d to use` : 'expired'}
                    </span>
                  )}
                </div>
                <div style={{
                  marginTop: 8, height: 4, borderRadius: 99,
                  background: 'var(--border)', overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${Math.round(ratio * 100)}%`, height: '100%',
                    background: isInactive ? 'var(--muted)' : 'var(--accent)',
                    transition: 'width 0.3s ease',
                  }}/>
                </div>
                {!isInactive && p.bookingSlug && (
                  <button
                    type="button"
                    onClick={() => setRedeemingPackage(p)}
                    className="btn btn-outline"
                    style={{ marginTop: 10, fontSize: 12, padding: '6px 12px', width: '100%', justifyContent: 'center' }}>
                    Book sessions
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {redeemingPackage && (
        <RedeemPackageModal
          pkg={redeemingPackage}
          onClose={() => setRedeemingPackage(null)}
          onBooked={() => {
            setRedeemingPackage(null);
            // Re-fetch packages so the credit count updates.
            api.get('/me/packages').then((r) => setActive(r.packages || [])).catch(() => {});
            if (includeHistory) {
              api.get('/me/packages?all=1').then((r) => setAllPackages(r.packages || [])).catch(() => {});
            }
          }}
        />
      )}
    </div>
  );
}

// Redeem a package by booking N sessions in one shot. Backed by
// POST /api/me/packages/:id/book which spends credits upfront, validates
// each slot against the workspace's availability + min-notice +
// max-advance + conflicts, and creates one bookings row per occurrence
// (each tagged with client_package_id so a cancellation refunds the
// credit). The form supports two paths:
//   • One-off - single session against this package
//   • Recurring - weekly / bi-weekly / monthly for N occurrences
function RedeemPackageModal({ pkg, onClose, onBooked }) {
  const [calendar, setCalendar] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [serviceId, setServiceId] = useState(null);
  const [mode, setMode] = useState('once'); // 'once'|'weekly'|'biweekly'|'monthly'
  const [firstDate, setFirstDate] = useState(() => {
    // Tomorrow as a sensible default - most workspaces require some notice.
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
    fetch(`/api/calendar/public/${encodeURIComponent(pkg.bookingSlug)}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return;
        if (!ok) throw new Error(j.error || 'Could not load business calendar');
        setCalendar(j.calendar);
        // Default to the first service the package covers.
        const covered = filterCoveredServices(j.calendar.services || [], pkg.serviceIds);
        if (covered.length > 0) setServiceId(covered[0].id);
      })
      .catch((e) => { if (!cancelled) setLoadErr(e.message); });
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
        : {
            serviceId: service.id,
            recurrence: mode,
            firstDate, startMin, endMin,
            occurrences: slotCount,
          };
      const res = await fetch(`/api/me/packages/${encodeURIComponent(pkg.id)}/book`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onBooked?.(j);
    } catch (ex) {
      setErr(ex.message || 'Could not book');
      setSubmitting(false);
    }
  };

  return (
    <div onClick={submitting ? null : onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card"
        style={{ width: '100%', maxWidth: 480, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Calendar size={16} sw={1.8}/></div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Book sessions</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {pkg.name} · {pkg.creditsRemaining} credit{pkg.creditsRemaining === 1 ? '' : 's'} left
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {loadErr && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 14,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{loadErr}</div>
        )}

        {!calendar && !loadErr && (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: 12 }}>Loading…</div>
        )}

        {calendar && services.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: 12 }}>
            None of this business's current services are covered by this package.
          </div>
        )}

        {calendar && services.length > 0 && (
          <>
            <RedeemField label="Service">
              <select value={serviceId || ''} onChange={(e) => setServiceId(e.target.value)}
                className="input" required>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.durationMinutes} min
                  </option>
                ))}
              </select>
            </RedeemField>

            <RedeemField label="Repeat">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { id: 'once',     label: 'Just once' },
                  { id: 'weekly',   label: 'Weekly' },
                  { id: 'biweekly', label: 'Every 2 wks' },
                  { id: 'monthly',  label: 'Monthly' },
                ].map(({ id, label }) => (
                  <button key={id} type="button" onClick={() => setMode(id)}
                    style={{
                      padding: '6px 12px', borderRadius: 999,
                      border: '1px solid ' + (mode === id ? 'var(--accent)' : 'var(--border)'),
                      background: mode === id ? 'var(--accent-soft)' : 'var(--surface)',
                      color: mode === id ? 'var(--accent)' : 'var(--fg-2)',
                      fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                    }}>
                    {label}
                  </button>
                ))}
              </div>
            </RedeemField>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <RedeemField label={mode === 'once' ? 'Date' : 'First date'}>
                <input type="date" value={firstDate}
                  onChange={(e) => setFirstDate(e.target.value)}
                  required className="input"/>
              </RedeemField>
              <RedeemField label="Start time">
                <input type="time" step={300} value={startHm}
                  onChange={(e) => setStartHm(e.target.value)}
                  required className="input"/>
              </RedeemField>
            </div>

            {mode !== 'once' && (
              <RedeemField label="Number of sessions"
                hint={`You'll use ${slotCount} of your ${pkg.creditsRemaining} credit${pkg.creditsRemaining === 1 ? '' : 's'}.`}>
                <input type="number" min={1} max={pkg.creditsRemaining}
                  value={occurrences}
                  onChange={(e) => setOccurrences(Math.max(1, Math.min(pkg.creditsRemaining, Number(e.target.value) || 1)))}
                  className="input"/>
              </RedeemField>
            )}

            {service && (
              <div style={{
                padding: 10, borderRadius: 8, marginBottom: 14,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5,
              }}>
                Each session is {service.durationMinutes} min ·{' '}
                ends at {fmtTimeFromMin(endMin)}.
              </div>
            )}

            {err && (
              <div style={{
                padding: '8px 12px', borderRadius: 8, marginBottom: 14,
                background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
                color: 'var(--danger)', fontSize: 12.5,
              }}>{err}</div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button type="button" className="btn btn-outline"
                onClick={onClose} disabled={submitting}
                style={{ flex: 1, justifyContent: 'center' }}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting || !service}
                style={{ flex: 2, justifyContent: 'center' }}>
                {submitting ? 'Booking…' : (slotCount === 1 ? 'Book session' : `Book ${slotCount} sessions`)}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function RedeemField({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 5, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

function filterCoveredServices(allServices, packageServiceIds) {
  if (!packageServiceIds || packageServiceIds.length === 0) return allServices;
  const set = new Set(packageServiceIds);
  return allServices.filter((s) => set.has(s.id));
}

function hmToMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function fmtTimeFromMin(m) {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${mm} ${ap}`;
}

// Hero card that aggregates the few "you should do this now" items
// - pending documents, open invoices, reviews to leave - into a
// single bold prompt above the at-a-glance stat grid. Hides itself
// when there's nothing actionable so the home page stays calm.
function NeedsAttention({ summary }) {
  const items = [];
  if (summary.pendingDocs > 0) {
    items.push({
      label: `${summary.pendingDocs} document${summary.pendingDocs === 1 ? '' : 's'} to sign`,
      icon: 'Doc', to: '/me/documents', tone: 'warn',
    });
  }
  if (summary.openInvoices > 0) {
    items.push({
      label: `${summary.openInvoices} invoice${summary.openInvoices === 1 ? '' : 's'} to pay`,
      icon: 'Dollar', to: '/me/invoices', tone: 'warn',
    });
  }
  if (summary.pendingReviews > 0) {
    items.push({
      label: `${summary.pendingReviews} review${summary.pendingReviews === 1 ? '' : 's'} to leave`,
      icon: 'Check', to: '/me/bookings?tab=past', tone: 'accent',
    });
  }
  if (items.length === 0) return null;

  return (
    <div className="card" style={{
      padding: 18,
      borderColor: 'var(--accent)',
      background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--surface))',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icons.Bell size={14} sw={1.8} stroke="var(--accent)"/>
        <div className="metric-label" style={{ color: 'var(--accent)' }}>Needs your attention</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((it) => {
          const Icon = Icons[it.icon];
          return (
            <Link key={it.to} to={it.to}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 10,
                background: 'var(--surface)', border: '1px solid var(--border)',
                textDecoration: 'none', color: 'var(--fg)',
                fontSize: 13.5, fontWeight: 600,
              }}>
              {Icon && <Icon size={14} sw={1.8} stroke={it.tone === 'warn' ? 'var(--warn)' : 'var(--accent)'}/>}
              <span style={{ flex: 1 }}>{it.label}</span>
              <Icons.Arrow size={13} stroke="var(--muted)"/>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, icon, tone, to }) {
  const Icon = Icons[icon];
  const toneColor = tone === 'accent' ? 'var(--accent)' : tone === 'warn' ? 'var(--warn)' : 'var(--muted)';
  const card = (
    <div className="card" style={{
      padding: 18, display: 'flex', flexDirection: 'column', gap: 6,
      cursor: to ? 'pointer' : 'default',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {Icon && <Icon size={14} sw={1.7} stroke={toneColor}/>}
        <div className="metric-label">{label}</div>
      </div>
      <div className="metric-value" style={{ fontSize: 28, color: Number(value) > 0 ? toneColor : 'var(--fg)' }}>
        {value}
      </div>
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: 'none', color: 'inherit' }}>{card}</Link> : card;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
