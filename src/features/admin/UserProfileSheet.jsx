// The super-admin profile sheet for one person (Admin > Users > Manage).
// Reads GET /api/admin/users/:id/profile (counts and dates only, never a
// client's name, contact details or messages) and, for web subscribers,
// the live Stripe part (?include=stripe) once the sheet is open.
//
// Every date is shown in the viewer's own time zone with a relative label
// ("Nov 4, 2026, 7:26 PM · 2 days ago"). Anything not recorded reads
// "Never" or "Not set" rather than a guess.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { publicOrigin } from '../../lib/publicUrl.js';
import { US_STATE_NAME } from '../../lib/locations.js';
import { CATEGORIES } from '../../lib/categories.js';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// "2 days ago" / "in 3 hours". null for a missing or bad date.
export function relTime(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < MIN) return diff <= 0 ? 'just now' : 'in a minute';
  const unit = (v, u) => `${v} ${u}${v === 1 ? '' : 's'}`;
  let s;
  if (abs < HOUR) s = unit(Math.round(abs / MIN), 'minute');
  else if (abs < DAY) s = unit(Math.round(abs / HOUR), 'hour');
  else if (abs < 45 * DAY) s = unit(Math.round(abs / DAY), 'day');
  else if (abs < 365 * DAY) s = unit(Math.round(abs / (30 * DAY)), 'month');
  else s = unit(Math.round(abs / (365 * DAY)), 'year');
  return diff < 0 ? `${s} ago` : `in ${s}`;
}

export function fmtDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const localZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
})();

// A date in local time plus its relative label. `never` when missing.
export function When({ iso, dateOnly = false, never = 'Never' }) {
  const abs = dateOnly ? fmtDate(iso) : fmtDateTime(iso);
  if (!abs) return <span style={{ color: 'var(--muted)' }}>{never}</span>;
  return (
    <span title={localZone ? `Your time (${localZone})` : undefined}>
      {abs} <span style={{ color: 'var(--muted)' }}>· {relTime(iso)}</span>
    </span>
  );
}

const muted = (t) => <span style={{ color: 'var(--muted)' }}>{t}</span>;
const fmtN = (v) => Number(v || 0).toLocaleString();
const money = (v, currency = 'usd') => {
  const cur = String(currency || 'usd').toUpperCase();
  try { return Number(v || 0).toLocaleString(undefined, { style: 'currency', currency: cur }); }
  catch { return `$${Number(v || 0).toFixed(2)}`; }
};

// { state, date } → plain words, dates in the viewer's time zone.
export function subscriptionWords(sub, now = Date.now()) {
  if (!sub) return 'No business';
  const d = fmtDate(sub.date);
  const future = sub.date && new Date(sub.date).getTime() > now;
  switch (sub.state) {
    case 'sponsored': return 'Free access (sponsored account)';
    case 'beta': return 'Free access (beta account)';
    case 'comped': {
      const far = sub.date && new Date(sub.date).getTime() - now > 50 * 365 * DAY;
      return far ? 'Comped, no end date' : `Comped until ${d}`;
    }
    case 'trial': return `Trial, ends ${d}`;
    case 'trial_ended': return `Trial ended ${d}`;
    case 'active': return `Active, renews ${d}`;
    case 'cancelling': return `Cancelled, ends ${d}`;
    case 'lapsed': return d ? `Inactive, paid period ended ${d}` : 'Inactive';
    case 'past_due': return d ? `Past due since ${d}` : 'Past due';
    case 'suspended': return d ? `Suspended since ${d}` : 'Suspended';
    case 'cancelled': return d ? `Cancelled, ${future ? 'ends' : 'ended'} ${d}` : 'Cancelled';
    default: return 'Inactive';
  }
}

const TONE = {
  trial: 'var(--warn)', trial_ended: 'var(--danger)', active: 'var(--ok)', comped: 'var(--ok)',
  sponsored: 'var(--ok)', beta: 'var(--ok)', cancelling: 'var(--warn)', past_due: 'var(--danger)',
  suspended: 'var(--danger)', cancelled: 'var(--muted)', lapsed: 'var(--muted)', inactive: 'var(--muted)',
};

function Section({ title, children, testId }) {
  return (
    <section data-testid={testId} style={{
      background: 'var(--surface-2)', borderRadius: 12, border: '1px solid var(--border)',
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <div className="metric-label" style={{ marginBottom: 4 }}>{title}</div>
      {children}
    </section>
  );
}

function R({ k, children }) {
  return (
    <div style={{ display: 'flex', gap: '2px 12px', flexWrap: 'wrap', padding: '4px 0', fontSize: 13, lineHeight: 1.45 }}>
      <div style={{ color: 'var(--muted)', flex: '0 0 168px', minWidth: 130, fontSize: 12.5 }}>{k}</div>
      <div style={{ flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere', color: 'var(--fg)' }}>{children}</div>
    </div>
  );
}

function Chip({ children, tone = 'var(--muted)' }) {
  return (
    <span style={{
      display: 'inline-block', margin: '0 6px 4px 0', fontSize: 11, fontWeight: 600,
      padding: '2px 8px', borderRadius: 99,
      background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone,
    }}>{children}</span>
  );
}

export default function UserProfileSheet({ userId, labels }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [stripe, setStripe] = useState(null);
  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null); setErr(null); setStripe(null);
    api.get(`/admin/users/${userId}/profile`)
      .then((r) => {
        if (!live) return;
        setData(r);
        // Live Stripe part (plan, what they paid Ivy). Web subscribers only.
        if (r?.subscription?.hasStripeCustomer && r.subscription.source !== 'apple') {
          api.get(`/admin/users/${userId}/profile?include=stripe`)
            .then((s) => { if (live) setStripe(s?.stripe || { available: false }); })
            .catch(() => { if (live) setStripe({ available: false }); });
        }
      })
      .catch((e) => { if (live) setErr(e.message || 'Could not load the profile'); });
    return () => { live = false; };
  }, [userId]);

  if (err) {
    return <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>;
  }
  if (!data) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading profile…</div>;

  const { account: a, devices: dv, subscription: sub, business: b, usage: us, acquisition: acq, health } = data;
  const L = labels || {};

  const roles = [];
  if (a.roles.superAdmin) roles.push(['Super admin', 'var(--accent)']);
  if (a.roles.owner) roles.push(['Owner', 'var(--ok)']);
  if (a.roles.client) roles.push(['Client', 'var(--muted)']);
  if (a.roles.helper) roles.push(['Helper', 'var(--accent)']);
  if (a.roles.tester) roles.push(['Tester', 'var(--warn)']);
  if (['sponsored', 'beta', 'affiliate'].includes(a.roles.userType)) {
    roles.push([a.roles.userType[0].toUpperCase() + a.roles.userType.slice(1), 'var(--accent)']);
  }

  const twoStep = a.twoStep.app && a.twoStep.email ? 'On (authenticator app and email codes)'
    : a.twoStep.app ? 'On (authenticator app)'
    : a.twoStep.email ? 'On (email codes)'
    : 'Off';

  const location = b?.locationState
    ? `${US_STATE_NAME[b.locationState] || b.locationState}, United States`
    : (b?.locationCountry || null);
  const category = b?.category ? (CATEGORIES.find((c) => c.id === b.category)?.label || b.category) : null;
  const payments = b ? [
    b.payments.stripe && 'Stripe', b.payments.square && 'Square', b.payments.paypal && 'PayPal',
  ].filter(Boolean) : [];

  const heard = acq ? [
    ...(acq.heardFrom || []).map((id) => L.heardFrom?.[id] || id),
    ...(acq.heardFromOther ? [`Other: "${acq.heardFromOther}"`] : []),
  ] : [];

  const plan = (() => {
    if (!sub) return null;
    if (sub.source === 'apple') return sub.appleProductId ? `Apple plan ${sub.appleProductId}` : null;
    const p = stripe?.plan;
    if (p && p.amount != null) {
      const every = p.interval ? (p.intervalCount > 1 ? `every ${p.intervalCount} ${p.interval}s` : `a ${p.interval}`) : '';
      return `${money(p.amount, p.currency)} ${every}`.trim();
    }
    return null;
  })();
  const stripeLoading = sub?.hasStripeCustomer && sub.source !== 'apple' && !stripe;
  const stripeNote = stripeLoading ? muted('Checking Stripe…')
    : (stripe && !stripe.available ? muted('Not available from Stripe right now') : null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="user-profile-sheet">
      {health?.length > 0 && (
        <div data-testid="profile-health" style={{
          display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 10,
          background: 'color-mix(in srgb, var(--warn) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
        }}>
          <div className="metric-label">Worth a look</div>
          {health.map((h) => (
            <div key={h.text} style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 99, flexShrink: 0, background: h.level === 'warn' ? 'var(--warn)' : 'var(--muted)', transform: 'translateY(-1px)' }}/>
              <span>{h.text}</span>
            </div>
          ))}
        </div>
      )}

      <Section title="Account" testId="profile-account">
        <R k="Name">{a.name || muted('Not set')}</R>
        <R k="Email">{a.email}</R>
        <R k="Email verified">{a.emailVerifiedAt ? <When iso={a.emailVerifiedAt}/> : muted('No')}</R>
        <R k="Signed up"><When iso={a.createdAt}/></R>
        <R k="Last login"><When iso={a.lastLoginAt}/></R>
        <R k="Last active"><When iso={a.lastActiveAt}/></R>
        <R k="Sign-ins, last 30 days">
          {fmtN(a.logins30d)}
          {dv.lastUsedOn === 'iPhone app' && <span style={{ color: 'var(--muted)', fontSize: 12 }}> (the iPhone app stays signed in)</span>}
        </R>
        <R k="2-step verification">{twoStep}</R>
        <R k="Account type">{roles.length ? roles.map(([t, tone]) => <Chip key={t} tone={tone}>{t}</Chip>) : muted('Not set')}</R>
        <R k="Account deletion">
          {a.deletedAt
            ? <span style={{ color: 'var(--danger)' }}>Deleted {fmtDateTime(a.deletedAt)}, removed for good {fmtDate(a.purgeAt)}</span>
            : muted('Not scheduled')}
        </R>
        {sub?.dataDeletionAt && (
          <R k="Business data deletion"><span style={{ color: 'var(--danger)' }}>Scheduled for {fmtDateTime(sub.dataDeletionAt)}</span></R>
        )}
        {sub?.dataPurgedAt && <R k="Business data deleted"><When iso={sub.dataPurgedAt}/></R>}
      </Section>

      <Section title="Devices" testId="profile-devices">
        <R k="Last used on">{dv.lastUsedOn || muted('Not recorded yet')}</R>
        <R k="Last sign-in from">
          {dv.lastSignIn ? <>{dv.lastSignIn.device || 'Unknown device'} <span style={{ color: 'var(--muted)' }}>· {relTime(dv.lastSignIn.at)}</span></> : muted('Never')}
        </R>
        <R k="App version">{dv.appVersion || muted('Not recorded (the app does not report it)')}</R>
        <R k="iPhone notifications">
          {dv.iphonePush.devices > 0
            ? <>On, {dv.iphonePush.devices} device{dv.iphonePush.devices === 1 ? '' : 's'} <span style={{ color: 'var(--muted)' }}>· last used {relTime(dv.iphonePush.lastUsedAt) || 'never'}</span></>
            : muted('Off')}
        </R>
        <R k="Browser notifications">
          {dv.webPush.browsers > 0
            ? <>On, {dv.webPush.browsers} browser{dv.webPush.browsers === 1 ? '' : 's'}</>
            : muted('Off')}
        </R>
      </Section>

      {sub && (
        <Section title="Subscription" testId="profile-subscription">
          <R k="Status"><span style={{ fontWeight: 600, color: TONE[sub.state] || 'var(--fg)' }}>{subscriptionWords(sub)}</span>
            {sub.date && ['trial', 'active', 'cancelling', 'comped'].includes(sub.state) && <span style={{ color: 'var(--muted)' }}> · {relTime(sub.date)}</span>}
          </R>
          <R k="Pays through">{sub.source === 'apple' ? 'Apple (iPhone app)' : sub.source === 'stripe' ? 'Stripe (web)' : muted('None yet')}</R>
          <R k="Plan">{plan || stripeNote || muted('Not set')}</R>
          {(sub.trialStartedAt || sub.trialEndsAt) && (
            <R k="Trial">
              {sub.trialStartedAt ? <>started {fmtDate(sub.trialStartedAt)}{sub.trialEndsAt ? ', ' : ''}</> : null}
              {sub.trialEndsAt ? <>ends {fmtDate(sub.trialEndsAt)} <span style={{ color: 'var(--muted)' }}>· {relTime(sub.trialEndsAt)}</span></> : null}
            </R>
          )}
          <R k="Payment method">{sub.paymentMethodOnFile ? 'On file' : muted('None on file')}</R>
          <R k="First payment">
            {stripe?.available ? (stripe.firstPaymentAt ? <When iso={stripe.firstPaymentAt} dateOnly/> : muted('None yet'))
              : sub.source === 'apple' ? muted('Kept by Apple') : (stripeNote || (sub.convertedAt ? <When iso={sub.convertedAt} dateOnly/> : muted('None yet')))}
          </R>
          <R k="Paid Ivy so far">
            {stripe?.available
              ? <>{stripe.currency === 'mixed' ? `${stripe.lifetimePaid.toFixed(2)} (more than one currency)` : money(stripe.lifetimePaid, stripe.currency)}
                  <span style={{ color: 'var(--muted)' }}> · {stripe.payments}{stripe.moreThanListed ? '+' : ''} payment{stripe.payments === 1 ? '' : 's'}</span></>
              : sub.source === 'apple' ? muted('Kept by Apple') : (stripeNote || muted('Nothing yet'))}
          </R>
          <R k="Cancels at period end">{sub.cancelAtPeriodEnd ? <span style={{ color: 'var(--warn)' }}>Yes</span> : 'No'}</R>
          <R k="Payment problems">
            {sub.pastDueSince || sub.failedAttempts > 0 || sub.suspendedAt
              ? <span style={{ color: 'var(--danger)' }}>
                  {sub.failedAttempts > 0 ? `${sub.failedAttempts} failed attempt${sub.failedAttempts === 1 ? '' : 's'}` : 'Payment failed'}
                  {sub.pastDueSince ? `, past due since ${fmtDate(sub.pastDueSince)}` : ''}
                  {sub.suspendedAt ? `, suspended ${fmtDate(sub.suspendedAt)}` : ''}
                </span>
              : muted('None')}
          </R>
          {sub.compUntil && <R k="Comp note">{sub.compNote || muted('Not set')}</R>}
        </Section>
      )}

      {b && (
        <Section title="Business" testId="profile-business">
          <R k="Name">{b.name || muted('Not set')}</R>
          <R k="Booking link">
            {b.slug
              ? <a href={`${publicOrigin()}/book/${encodeURIComponent(b.slug)}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                  {publicOrigin().replace(/^https?:\/\//, '')}/book/{b.slug}
                </a>
              : muted('Not set')}
          </R>
          <R k="Category">{category || muted('Not set')}</R>
          <R k="Based in">{location || muted('Not set')}</R>
          <R k="Onboarding finished">{b.onboardedAt ? <When iso={b.onboardedAt}/> : <span style={{ color: 'var(--warn)' }}>Not yet</span>}</R>
          <R k="Setup checklist">
            {b.setup ? (
              <>
                {b.setup.done} of {b.setup.total} done
                <button type="button" onClick={() => setShowSetup((v) => !v)} className="btn btn-ghost"
                  aria-expanded={showSetup} style={{ padding: '1px 8px', fontSize: 12, marginLeft: 6 }}>
                  {showSetup ? 'Hide' : 'Show'}
                </button>
                {showSetup && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                    {b.setup.items.map((i) => (
                      <div key={i.id} style={{ fontSize: 12.5, color: i.done ? 'var(--fg-2)' : 'var(--fg)' }}>
                        <span role="img" aria-label={i.done ? 'Done:' : 'Not done:'} style={{ color: i.done ? 'var(--ok)' : 'var(--muted)', marginRight: 6 }}>{i.done ? '✓' : '○'}</span>
                        {i.label}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : muted('Not available')}
          </R>
          <R k="Website">{b.websitePublished ? <>Published {b.websitePublishedAt ? fmtDate(b.websitePublishedAt) : ''}{b.customDomain ? ' (own domain)' : ''}</> : muted('Not published')}</R>
          <R k="Payments connected">
            {payments.length ? payments.join(', ') : (b.payments.stripeStarted ? <span style={{ color: 'var(--warn)' }}>Stripe started, not finished</span> : muted('Not connected'))}
          </R>
          <R k="Google Calendar">{b.googleCalendar ? 'Connected' : muted('Not connected')}</R>
          {b.workspaceCount > 1 && (
            <R k="Businesses"><span style={{ color: 'var(--warn)', fontWeight: 600 }}>{b.workspaceCount} businesses</span> <span style={{ color: 'var(--muted)' }}>(the app uses the oldest)</span></R>
          )}
        </Section>
      )}

      {us && (
        <Section title="Usage (counts only)" testId="profile-usage">
          <R k="Clients">{fmtN(us.clients)}</R>
          <R k="Bookings added">{fmtN(us.bookings.last30d)} in the last 30 days · {fmtN(us.bookings.all)} all time</R>
          <R k="Upcoming bookings">{fmtN(us.bookings.upcoming)}</R>
          <R k="Last booking added"><When iso={us.bookings.lastCreatedAt}/></R>
          <R k="Invoices">{fmtN(us.invoices.sent)} sent · {fmtN(us.invoices.paid)} paid</R>
          <R k="Revenue through Ivy">{money(us.revenueThroughIvy)}</R>
          <R k="Ivy messages this month">
            {us.ivy.messagesThisMonth == null ? muted('Not available')
              : us.ivy.allowance ? `${fmtN(us.ivy.messagesThisMonth)} of ${fmtN(us.ivy.allowance)}` : fmtN(us.ivy.messagesThisMonth)}
          </R>
          <R k="Last used Ivy"><When iso={us.ivy.lastUsedAt}/></R>
          <R k="Services">{fmtN(us.services)}</R>
          <R k="Programs">{fmtN(us.programs)}</R>
          <R k="Helpers">{fmtN(us.helpers)}</R>
        </Section>
      )}

      {acq && (
        <Section title="Acquisition" testId="profile-acquisition">
          <R k="How they heard">{heard.length ? heard.join(', ') : muted('Not answered')}</R>
          {(acq.referralName || (acq.heardFrom || []).includes('referral')) && (
            <R k="Referred by">{acq.referralName || muted('Not answered')}</R>
          )}
          <R k="Signed up with code">
            {acq.signupReferral
              ? <>{acq.signupReferral.code} <span style={{ color: 'var(--muted)' }}>({acq.signupReferral.kind === 'affiliate' ? 'partner' : 'friend'} link)</span></>
              : muted('None')}
          </R>
          <R k="Switching from">{acq.switchFrom ? (L.switchFrom?.[acq.switchFrom] || acq.switchFrom) : muted('Not answered')}</R>
        </Section>
      )}

      <div style={{ fontSize: 11.5, color: 'var(--muted-2)', lineHeight: 1.5 }}>
        {data.privacyNote} Times are in your time zone{localZone ? ` (${localZone})` : ''}.
      </div>
    </div>
  );
}
