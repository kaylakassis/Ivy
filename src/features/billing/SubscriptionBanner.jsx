// Top-of-app banner that warns owners about a subscription state needing
// attention. Three triggers:
//   • Trial with ≤ 5 days remaining → "Trial ends in N days" + Subscribe
//   • past_due any time             → "Card declined" + Update card (portal)
//   • suspended                     → "Account suspended" + Update card
//                                     (the dunning cron flips here after
//                                     14 days past_due - at that point
//                                     write actions return 402; banner
//                                     stays visible until card updated)
//
// Renders nothing otherwise (active sub with healthy headroom, cancelled
// subs already get the full Paywall, and client-only users have no biz).
//
// Action buttons share the Paywall's plumbing - checkout for new subs,
// portal for existing customers.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { useUserContext } from '../../lib/userContext.jsx';
import { api } from '../../lib/api.js';

const TRIAL_WARN_DAYS = 5;

export default function SubscriptionBanner() {
  const { ctx } = useUserContext();
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const sub = ctx?.subscription;
  if (!ctx?.isOwner || !sub) return null;

  const inTrial    = sub.status === 'trialing';
  const trialEndingSoon = inTrial && sub.daysRemaining != null && sub.daysRemaining <= TRIAL_WARN_DAYS;
  const pastDue    = sub.status === 'past_due';
  const suspended  = sub.status === 'suspended';
  const endingSoon = !!sub.cancelAtPeriodEnd && sub.isActive && sub.daysRemaining != null && sub.daysRemaining <= 7;
  if (!trialEndingSoon && !pastDue && !suspended && !endingSoon) return null;

  const subscribe = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/billing/checkout', {});
      if (!r.url) throw new Error('No checkout URL returned');
      window.location.href = r.url;
    } catch (e) { setErr(e.message || 'Could not start checkout'); setBusy(false); }
  };

  const openPortal = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/billing/portal', {});
      if (!r.url) throw new Error('No portal URL returned');
      window.location.href = r.url;
    } catch (e) { setErr(e.message || 'Could not open billing portal'); setBusy(false); }
  };

  if (suspended) {
    // Hard stop. Write actions return 402 from requireActiveSubscription
    // until the card is updated and Stripe retries successfully.
    return (
      <Banner tone="danger" icon="Lock"
        body={<>
          <strong>Account suspended.</strong>{' '}
          <span style={{ color: 'var(--fg-2)' }}>
            Your subscription is past due. Update your card to restore access - your data is safe.
          </span>
        </>}
        action={<Action busy={busy} err={err} onClick={openPortal} label="Update card"/>}
      />
    );
  }

  if (pastDue) {
    return (
      <Banner tone="warn" icon="Bell"
        body={<>
          <strong>Card declined.</strong>{' '}
          <span style={{ color: 'var(--fg-2)' }}>
            Stripe will keep retrying - update your card to avoid losing access.
          </span>
        </>}
        action={<Action busy={busy} err={err} onClick={openPortal} label="Update card"/>}
      />
    );
  }

  if (endingSoon) {
    const when = sub.daysRemaining === 0 ? 'today' : sub.daysRemaining === 1 ? 'tomorrow' : `in ${sub.daysRemaining} days`;
    return (
      <Banner tone="warn" icon="Clock"
        body={<>
          <strong>Your plan ends {when}.</strong>{' '}
          <span style={{ color: 'var(--fg-2)' }}>
            After that your booking page, website and client portal are archived, and your data is permanently deleted 7 days later unless you resubscribe.
          </span>
        </>}
        action={<Action busy={busy} err={err} onClick={openPortal} label={sub.source === 'apple' ? 'Manage in the App Store' : 'Keep my plan'}/>}
      />
    );
  }

  // trialEndingSoon
  return (
    <Banner tone="accent" icon="Clock"
      body={<>
        <strong>
          {sub.daysRemaining === 0
            ? 'Your free trial ends today.'
            : sub.daysRemaining === 1
              ? 'Your free trial ends tomorrow.'
              : `Your free trial ends in ${sub.daysRemaining} days.`}
        </strong>{' '}
        <span style={{ color: 'var(--fg-2)' }}>
          Subscribe to keep everything running. After the trial, your booking page, website and client portal are archived until you do.
        </span>
      </>}
      action={<Action busy={busy} err={err} onClick={subscribe} label="Subscribe"/>}
    />
  );
}

function Banner({ tone, icon, body, action }) {
  const Icon = Icons[icon] || Icons.Bell;
  const bg     = tone === 'danger' ? 'rgba(155, 44, 44, 0.10)'
              : tone === 'warn'   ? 'rgba(214, 158, 46, 0.10)'
              : 'var(--accent-soft)';
  const border = tone === 'danger' ? 'rgba(155, 44, 44, 0.30)'
              : tone === 'warn'   ? 'rgba(214, 158, 46, 0.30)'
              : 'var(--accent-tint)';
  const fg     = tone === 'danger' ? 'var(--danger)'
              : tone === 'warn'   ? 'var(--warn)'
              : 'var(--accent)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 24px',
      background: bg,
      borderBottom: '1px solid ' + border,
      color: fg, fontSize: 13,
    }}>
      {Icon && <Icon size={15} sw={1.7}/>}
      <div style={{ flex: 1, minWidth: 0 }}>{body}</div>
      {action}
    </div>
  );
}

function Action({ busy, err, onClick, label }) {
  if (err) return <span style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>;
  return (
    <button onClick={onClick} disabled={busy} className="btn btn-outline"
      style={{ padding: '5px 12px', fontSize: 12, opacity: busy ? 0.6 : 1 }}>
      {busy ? 'Loading…' : label}
    </button>
  );
}
