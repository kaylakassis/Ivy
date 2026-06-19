// Paywall modal - UNSKIPPABLE hard wall when the workspace's subscription
// isn't active. Replaces the previous soft wall that let owners route to
// /me and keep working in the free client portal.
//
// Affordances (always rendered, in this order):
//   • Subscribe        - POSTs /api/billing/checkout, redirects to Stripe.
//   • Start free trial - only shown for owners who haven't trialed yet.
//   • Manage billing   - POSTs /api/billing/portal, opens Stripe Customer
//                        Portal so a card update or reactivation doesn't
//                        require a second support touch.
//   • Export my data   - anchor GET /api/account/export. The portability
//                        promise: owners can always retrieve their data,
//                        even when locked out of the app.
//   • Log out          - escape that doesn't compromise the wall.
//
// isClient carve-out: an owner who's ALSO a client of another Ivy OS
// business gets one labeled link "Go to {business} as a client" → /me.
// Solo owners (isClient === false) get no /me link at all.
//
// Post-checkout: Stripe redirects to /?subscribed=1&session_id=cs_...
// We POST /api/billing/sync to fetch the subscription state directly (so
// the wall drops even before the webhook has landed) and fall back to
// polling /api/me if that misses.
import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { isIos } from '../../lib/platform.js';
import { getIapOfferings, purchaseIapPackage, restoreIapPurchases, identifyIapUser } from '../../lib/iap.js';
import { IVY_PRICE, STACK_TOTAL, IVY_PRICE_ANNUAL, ANNUAL_SAVINGS, ANNUAL_MONTHLY_EQUIV, TRIAL_DAYS } from '../../lib/pricing.js';

// Real, truthful conversion proof - mirrors the marketing pricing page.
// We deliberately do NOT fabricate star ratings or user counts (Ivy OS
// has no review corpus to quote); the stack-replacement savings is a
// concrete claim we can stand behind.
const MONTHLY_SAVINGS = Math.max(0, STACK_TOTAL - IVY_PRICE);

// The benefit list - each row is a real capability gated behind the wall.
const PERKS = [
  'Unlimited clients, bookings & invoices',
  'Take card payments through your own Stripe',
  'Documents + legally-binding e-signatures',
  'Client messaging, all in one inbox',
  'Your own booking site + custom domain',
];

export default function Paywall({ ctx, onRefresh }) {
  const sub = ctx?.subscription || null;
  const [busy, setBusy]   = useState(null); // 'trial' | 'subscribe' | 'portal' | 'logout' | 'syncing' | null
  const [err, setErr]     = useState(null);
  const [winback, setWinback] = useState(null); // {percentOff, durationMonths, promoCode, expiresAt}
  // Billing period. Monthly is the honest default; annual is the
  // highlighted LTV option (2 months free). Flows into the checkout call.
  const [plan, setPlan]   = useState('monthly'); // 'monthly' | 'annual'
  // Multi-step trust-building "priming" flow shown only for trial-eligible
  // users (and never during a win-back, where we want one strong claim
  // screen). Step 1: "$0 today". Step 2: "we'll remind you before it ends".
  // Step 3: the existing plan card + commit CTA. Non-trial paths (winback,
  // reactivation, expired) skip the priming entirely.
  const [primingStep, setPrimingStep] = useState(1);
  const [params, setParams] = useSearchParams();
  const synced = useRef(false);
  const winbackTried = useRef(false);

  // Owners who are ALSO clients of another business get one labeled link
  // out - the wall stays unskippable from THEIR perspective (they can't
  // dodge it for their own workspace), but their access to other
  // businesses' client portals isn't collateral damage.
  const clientOnlyBusiness = ctx?.isClient && ctx?.memberships?.length
    ? ctx.memberships[0]
    : null;

  // After Stripe Checkout success, hit /sync to flip the row before the
  // webhook arrives. Only runs once per mount even if the modal re-renders.
  useEffect(() => {
    const subscribed = params.get('subscribed');
    const sessionId  = params.get('session_id');
    if (subscribed !== '1' || !sessionId || synced.current) return;
    synced.current = true;
    setBusy('syncing'); setErr(null);
    (async () => {
      try {
        await api.post('/billing/sync', { sessionId });
        await onRefresh();
      } catch (e) {
        // Webhook will eventually catch up - start a short poll loop.
        await pollForActive(onRefresh, 6, 1500);
      }
      // Clean the success/cancel params so a refresh doesn't re-run sync.
      const next = new URLSearchParams(params);
      next.delete('subscribed');
      next.delete('session_id');
      setParams(next, { replace: true });
      setBusy(null);
    })();
  }, [params, onRefresh, setParams]);

  const cancelled = params.get('subscribed') === 'cancelled';

  // Abandoned-cart win-back: the moment an owner bails out of Stripe
  // checkout and returns to the wall, ask the server for their one-time
  // discount and surface it inline. ensureWinbackOffer is idempotent +
  // one-per-workspace, so cancelling repeatedly can't farm coupons.
  // Runs once per mount.
  useEffect(() => {
    if (!cancelled || winbackTried.current) return;
    winbackTried.current = true;
    api.post('/billing/winback-offer', {})
      .then((r) => {
        // Only render the offer when the numeric terms are actually
        // present - guards against a malformed eligible:true response
        // rendering "NaN% off" / "$NaN/mo".
        if (r?.eligible
            && Number.isFinite(r.percentOff) && r.percentOff > 0
            && Number.isFinite(r.durationMonths) && r.durationMonths > 0) {
          setWinback(r);
        }
      })
      .catch(() => { /* no offer is a fine outcome - fall back to the plain banner */ });
  }, [cancelled]);

  const subscribe = async () => {
    setBusy('subscribe'); setErr(null);
    // iOS in-app purchase branch. Apple requires that subscriptions sold
    // INSIDE the app go through StoreKit - we can't redirect to a Stripe
    // checkout URL from within the WebView without violating App Store
    // Review Guideline 3.1.1. So on iOS we run the StoreKit purchase
    // sheet via RevenueCat instead; on success, RC's webhook
    // (/api/billing/revenuecat-webhook) flips subscription_status to
    // 'active', and we poll /api/me to pick up the change - same
    // pattern as Stripe post-checkout.
    if (isIos()) {
      try {
        // Tie the RC customer to this workspace BEFORE buying so the
        // resulting webhook carries our workspace id as app_user_id.
        if (ctx?.workspace?.id) await identifyIapUser(ctx.workspace.id);
        const offerings = await getIapOfferings();
        // Match by package type so the user's toggle (monthly vs annual)
        // picks the right Apple product.
        const wantedType = plan === 'annual' ? 'ANNUAL' : 'MONTHLY';
        const pkg = offerings.find((o) => o.period === wantedType) || offerings[0];
        if (!pkg) {
          setErr('In-app purchase isn\'t available right now. Please try again in a moment.');
          setBusy(null);
          return;
        }
        const result = await purchaseIapPackage(pkg);
        if (result.userCancelled) { setBusy(null); return; }
        if (!result.ok) { setErr(result.error || 'Purchase failed'); setBusy(null); return; }
        // Webhook → DB flip takes a beat. Poll /api/me up to ~6s; same
        // pattern as the Stripe post-checkout sync. onRefresh re-fetches
        // /api/me, which drops the wall once subscription_status is active.
        setBusy('syncing');
        let active = false;
        for (let i = 0; i < 6 && !active; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const me = await api.get('/me').catch(() => null);
          if (me?.subscription?.isActive) active = true;
        }
        await onRefresh?.();
        setBusy(null);
      } catch (e) {
        setErr(e?.message || 'Could not start purchase');
        setBusy(null);
      }
      return;
    }
    try {
      // winback is a monthly-only offer (checkout.js scopes the coupon to
      // monthly), so the toggle is hidden while it's showing - `plan`
      // stays 'monthly' in that case.
      const r = await api.post('/billing/checkout', { plan });
      if (!r.url) throw new Error('No checkout URL returned');
      window.location.href = r.url;
    } catch (e) {
      setErr(e.message || 'Could not start checkout');
      setBusy(null);
    }
  };

  // Apple-required affordance: "Restore purchases" so a user who
  // re-installs Ivy OS on a new device can recover their entitlements
  // without contacting support. Only shown in the iOS build.
  const restorePurchases = async () => {
    setBusy('restore'); setErr(null);
    try {
      if (ctx?.workspace?.id) await identifyIapUser(ctx.workspace.id);
      const r = await restoreIapPurchases();
      if (!r.ok) { setErr(r.error || 'Restore failed'); setBusy(null); return; }
      // Give RC's webhook a moment to land, then refresh.
      await new Promise((res) => setTimeout(res, 1500));
      await onRefresh?.();
      setBusy(null);
      if (!r.hasActive) setErr('No active purchases found on this Apple ID.');
    } catch (e) {
      setErr(e?.message || 'Restore failed');
      setBusy(null);
    }
  };

  const openBillingPortal = async () => {
    setBusy('portal'); setErr(null);
    try {
      const r = await api.post('/billing/portal', {});
      if (!r.url) throw new Error('No portal URL returned');
      window.location.href = r.url;
    } catch (e) {
      // Common case: no stripe_customer_id yet (owner never reached
      // checkout). Surface the helpful message rather than the raw error.
      setErr(e.message || 'Could not open billing portal');
      setBusy(null);
    }
  };

  const logout = async () => {
    setBusy('logout'); setErr(null);
    try {
      await api.post('/auth/logout', {});
    } catch {
      // Best-effort: if the logout call fails, still clear locally.
    }
    window.location.href = '/signin';
  };

  // Distinguish trial-expired from never-trialed so the copy matches.
  // A 'trialing' status that isn't active means the trial window has
  // lapsed. (daysRemaining is null - not 0 - for an expired trial, so
  // the old `=== 0` check never fired and this copy was dead.)
  const trialExpired = sub?.status === 'trialing' && !sub?.isActive;
  const everTrialed  = !!sub?.trialEndsAt;
  const wasPaid      = sub?.status === 'cancelled' || sub?.status === 'past_due';
  // The trial CTA only makes sense for owners who've never trialed; for
  // everyone else the wall leads straight to Subscribe.
  const canTrial = !everTrialed;
  const syncing  = busy === 'syncing';
  // Price string for the subscribe CTAs, reflecting the selected period.
  const priceLabel = plan === 'annual' ? `$${IVY_PRICE_ANNUAL}/yr` : `$${IVY_PRICE}/mo`;

  // Show the 2 trust-building "priming" screens only for trial-eligible
  // owners; win-back / reactivation / expired flows jump straight to the
  // plan card (one strong claim, not three).
  const showPriming = canTrial && !winback && !syncing && primingStep < 3;

  const heading = syncing      ? 'Confirming your subscription…'
                : wasPaid       ? 'Pick up where you left off'
                : trialExpired  ? 'Your free trial has ended'
                : canTrial      ? `Start your ${TRIAL_DAYS}-day free trial`
                :                 'Subscribe to keep going';

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="paywall-title" style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(10, 12, 8, 0.62)',
      backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
    }}>
      <div className="card" style={{
        width: '100%', maxWidth: 430, maxHeight: '94vh',
        display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden',
        boxShadow: '0 30px 70px rgba(0,0,0,0.32)',
      }}>
        {/* ─── HERO BAND ─────────────────────────────────────────────
            Mirrors the top-earner format (bold icon + benefit headline
            over a colored band) but uses Ivy OS's accent tint, so it
            reads on-brand in both Calm + Bold themes. */}
        <div style={{
          padding: '26px 28px 22px',
          background: 'linear-gradient(160deg, var(--accent-soft), var(--accent-tint))',
          borderBottom: '1px solid var(--border)',
          textAlign: 'center',
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, margin: '0 auto 14px',
            background: 'var(--accent)', color: 'var(--accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: 'var(--shadow)',
          }}><Icons.Trending size={24}/></div>
          <h2 id="paywall-title" style={{
            margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500,
            fontSize: 25, lineHeight: 1.15, letterSpacing: '-0.02em', color: 'var(--fg)',
          }}>{heading}</h2>
          {!syncing && (
            <p style={{ margin: '8px auto 0', maxWidth: 320, color: 'var(--fg-2)', fontSize: 13.5, lineHeight: 1.5 }}>
              Everything you run your business on - clients, calendar, invoices,
              documents, messaging - in one place.
            </p>
          )}
        </div>

        {/* ─── BODY (scrolls if the viewport is short) ──────────────── */}
        <div style={{
          padding: '20px 24px 22px',
          display: 'flex', flexDirection: 'column', gap: 14,
          overflowY: 'auto',
        }}>
          {syncing ? (
            <p style={{ margin: '6px 0', color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.55, textAlign: 'center' }}>
              Stripe just confirmed your payment. We're refreshing your
              account - this usually takes a couple of seconds.
            </p>
          ) : showPriming ? (
            <PrimingStep step={primingStep} setStep={setPrimingStep} canTrial={canTrial}/>
          ) : (
            <>
              {/* Truthful savings proof - the refs' "social proof / save
                  X%" slot, filled with a claim we can stand behind. */}
              {MONTHLY_SAVINGS > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '9px 12px', borderRadius: 10,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.4,
                }}>
                  <Icons.Spark size={15} stroke="var(--accent)"/>
                  <span>
                    Replaces <strong style={{ color: 'var(--fg)' }}>${STACK_TOTAL}/mo</strong> of
                    stitched-together tools - <strong style={{ color: 'var(--ok)' }}>save ${MONTHLY_SAVINGS}/mo</strong>.
                  </span>
                </div>
              )}

              {/* Benefit list */}
              <ul style={{
                margin: 0, padding: 0, listStyle: 'none',
                display: 'flex', flexDirection: 'column', gap: 9,
                fontSize: 13.5, color: 'var(--fg-2)',
              }}>
                {PERKS.map((p) => (
                  <li key={p} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                      flex: '0 0 auto', width: 18, height: 18, borderRadius: 99,
                      background: 'var(--accent-soft)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Icons.Check size={11} sw={2.6} stroke="var(--accent)"/>
                    </span>
                    {p}
                  </li>
                ))}
              </ul>

              {/* ─── BILLING PERIOD TOGGLE ───────────────────────────
                  Monthly (honest default) vs Annual (highlighted LTV
                  option - 2 months free). Hidden while a monthly-only
                  win-back offer is showing. */}
              {!winback && (
                <div role="tablist" aria-label="Billing period" style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 2,
                }}>
                  {[
                    { key: 'monthly', label: 'Monthly', sub: `$${IVY_PRICE}/mo` },
                    { key: 'annual',  label: 'Annual',  sub: `$${IVY_PRICE_ANNUAL}/yr`, tag: '2 months free' },
                  ].map((opt) => {
                    const active = plan === opt.key;
                    return (
                      <button key={opt.key} type="button" role="tab" aria-selected={active}
                        onClick={() => setPlan(opt.key)} disabled={busy != null}
                        style={{
                          position: 'relative', textAlign: 'left', cursor: 'pointer',
                          padding: '10px 12px', borderRadius: 12,
                          border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                          background: active ? 'var(--accent-soft)' : 'var(--surface)',
                        }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{opt.label}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{opt.sub}</div>
                        {opt.tag && (
                          <span style={{
                            position: 'absolute', top: -9, right: 8,
                            padding: '1px 7px', borderRadius: 99,
                            background: 'var(--ok)', color: '#fff',
                            fontSize: 9.5, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
                          }}>{opt.tag}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* ─── PLAN CARD (highlighted "best offer" style) ──────
                  Reflects the selected billing period. The badge + accent
                  border match the refs' featured-plan treatment. */}
              <div style={{
                position: 'relative', marginTop: 2,
                padding: '16px 16px 14px', borderRadius: 14,
                border: '2px solid var(--accent)', background: 'var(--surface)',
              }}>
                <div style={{
                  position: 'absolute', top: -10, right: 14,
                  padding: '2px 10px', borderRadius: 99,
                  background: 'var(--accent)', color: 'var(--accent-ink)',
                  fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                }}>{canTrial ? `${TRIAL_DAYS} days free` : (plan === 'annual' ? '2 months free' : 'Full access')}</div>

                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', flex: 1 }}>Active</span>
                  <span style={{
                    fontFamily: 'var(--font-num)', fontSize: 28, fontWeight: 600,
                    color: 'var(--fg)', letterSpacing: '-0.02em',
                  }}>${plan === 'annual' ? IVY_PRICE_ANNUAL : IVY_PRICE}</span>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>{plan === 'annual' ? '/yr' : '/mo'}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--muted)' }}>
                  {plan === 'annual'
                    ? (canTrial
                        ? `Free for ${TRIAL_DAYS} days, then $${IVY_PRICE_ANNUAL}/yr (~$${ANNUAL_MONTHLY_EQUIV}/mo) - save $${ANNUAL_SAVINGS}/yr. Cancel anytime.`
                        : `$${IVY_PRICE_ANNUAL}/yr (~$${ANNUAL_MONTHLY_EQUIV}/mo) · save $${ANNUAL_SAVINGS}/yr vs monthly. Cancel anytime.`)
                    : (canTrial
                        ? `Free for ${TRIAL_DAYS} days, then $${IVY_PRICE}/mo. Cancel anytime.`
                        : `$${IVY_PRICE}/mo · one plan, no per-seat fees. Cancel anytime.`)}
                </div>
              </div>

              {/* Abandoned-cart win-back: when checkout was cancelled AND
                  the server handed us a one-time discount, the plain
                  "cancelled" note is replaced by the offer. Subscribing
                  from here is auto-discounted server-side (checkout.js
                  reads the stamped coupon) - no code entry needed. */}
              {cancelled && winback && (
                <div style={{
                  padding: '12px 14px', borderRadius: 12,
                  background: 'linear-gradient(160deg, var(--accent-soft), var(--accent-tint))',
                  border: '1px solid var(--accent)',
                }}>
                  <div style={{
                    fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 16,
                    letterSpacing: '-0.01em', color: 'var(--fg)',
                  }}>
                    Wait - {winback.percentOff}% off your first {winback.durationMonths} months
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.45 }}>
                    That's <strong style={{ color: 'var(--fg)' }}>
                      ${(IVY_PRICE * (1 - winback.percentOff / 100)).toFixed(2)}/mo
                    </strong> for {winback.durationMonths} months. The discount applies automatically at
                    checkout{winback.promoCode ? <> - or use code <strong>{winback.promoCode}</strong></> : null}.
                    {winback.expiresAt && (
                      <span style={{ color: 'var(--muted)' }}> Expires {new Date(winback.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.</span>
                    )}
                  </div>
                </div>
              )}

              {cancelled && !winback && (
                <div style={{
                  padding: '8px 12px', borderRadius: 8,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  color: 'var(--fg-2)', fontSize: 12.5,
                }}>Checkout was cancelled - try again whenever you're ready.</div>
              )}

              {err && (
                <div style={{
                  padding: '8px 12px', borderRadius: 8,
                  background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
                  color: 'var(--danger)', fontSize: 12.5,
                }}>{err}</div>
              )}

              {/* ─── PRIMARY CTA ─────────────────────────────────────
                  One dominant button, like every top-earner. For owners
                  who can still trial, the trial is primary (lowest
                  friction) with subscribe as a quiet secondary. */}
              {canTrial && !winback ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* Card-backed trial: this starts the free trial AND collects
                      the card (Stripe trial-with-card on web, Apple intro offer
                      on iOS) via the same commit flow as a paid subscribe. */}
                  <button onClick={subscribe} disabled={busy != null}
                    className="btn btn-primary"
                    style={{ justifyContent: 'center', padding: '14px 16px', fontSize: 15 }}>
                    {busy ? 'Starting…' : `Start ${TRIAL_DAYS}-day free trial`}
                    {!busy && <Icons.Arrow size={14} sw={2.2}/>}
                  </button>
                </div>
              ) : (
                <button onClick={subscribe} disabled={busy != null}
                  className="btn btn-primary"
                  style={{ justifyContent: 'center', padding: '14px 16px', fontSize: 15 }}>
                  {busy === 'subscribe' ? 'Redirecting…'
                    : winback ? `Claim ${winback.percentOff}% off - $${(IVY_PRICE * (1 - winback.percentOff / 100)).toFixed(2)}/mo`
                    : `Subscribe - ${priceLabel}`}
                  {busy !== 'subscribe' && <Icons.Arrow size={14} sw={2.2}/>}
                </button>
              )}

              {/* Reassurance microcopy - the refs' "No payment now ·
                  Cancel anytime" trust line. "No payment now" only shows
                  when it's literally true (no-card trial). */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 6, fontSize: 11.5, color: 'var(--muted)',
              }}>
                <Icons.Check size={12} sw={2.4} stroke="var(--ok)"/>
                {canTrial ? 'No payment due today · Cancel anytime' : 'Secure checkout · Cancel anytime'}
              </div>

              {/* ─── Secondary affordances - the entire hard-wall escape
                  surface. Manage billing only when a Stripe customer
                  exists; Export hits the ungated data-portability GET;
                  Log out clears the session. */}
              <div style={{
                display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
                gap: 4, marginTop: 2, paddingTop: 12, borderTop: '1px solid var(--border)',
                fontSize: 12.5,
              }}>
                {ctx?.hasBillingRecord && !isIos() && (
                  <>
                    <button onClick={openBillingPortal} disabled={busy != null}
                      className="btn btn-ghost"
                      style={{ padding: '5px 9px', color: 'var(--muted)' }}>
                      {busy === 'portal' ? 'Opening…' : 'Manage billing'}
                    </button>
                    <span aria-hidden="true" style={{ color: 'var(--muted-2)', alignSelf: 'center' }}>·</span>
                  </>
                )}
                {/* App Store Review Guideline 3.1.1 requires a visible
                    Restore Purchases affordance on every IAP-using screen.
                    Only rendered in the iOS build. */}
                {isIos() && (
                  <>
                    <button onClick={restorePurchases} disabled={busy != null}
                      className="btn btn-ghost"
                      style={{ padding: '5px 9px', color: 'var(--muted)' }}>
                      {busy === 'restore' ? 'Restoring…' : 'Restore purchases'}
                    </button>
                    <span aria-hidden="true" style={{ color: 'var(--muted-2)', alignSelf: 'center' }}>·</span>
                  </>
                )}
                <a href="/api/account/export" download
                  className="btn btn-ghost"
                  style={{ padding: '5px 9px', color: 'var(--muted)', textDecoration: 'none' }}>
                  Export my data
                </a>
                <span aria-hidden="true" style={{ color: 'var(--muted-2)', alignSelf: 'center' }}>·</span>
                <button onClick={logout} disabled={busy != null}
                  className="btn btn-ghost"
                  style={{ padding: '5px 9px', color: 'var(--muted)' }}>
                  {busy === 'logout' ? 'Signing out…' : 'Log out'}
                </button>
              </div>

              {/* isClient carve-out: one labeled link to the OTHER
                  business's portal - never a generic /me link. */}
              {clientOnlyBusiness && (
                <a href="/me"
                  className="btn btn-ghost"
                  style={{
                    alignSelf: 'center', fontSize: 12.5, color: 'var(--muted)',
                    textDecoration: 'none',
                  }}>
                  Go to {clientOnlyBusiness.businessName} as a client →
                </a>
              )}

              {/* Trust line - every top-earner closes with Terms/Privacy. */}
              <div style={{
                textAlign: 'center', fontSize: 11, color: 'var(--muted-2)', marginTop: 2,
              }}>
                <a href="/terms" style={{ color: 'inherit', textDecoration: 'underline' }}>Terms</a>
                {'  ·  '}
                <a href="/privacy" style={{ color: 'inherit', textDecoration: 'underline' }}>Privacy</a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Two trust-building screens shown BEFORE the plan card for trial-eligible
// owners. Pattern from the funnel teardown video / Cali-style paywalls:
// (1) emphasize "$0 today" so the user knows they aren't being charged now;
// (2) tell them we'll remind them before the trial ends, framing the
// payment-method requirement as low-risk; (3) is the existing plan card,
// rendered by the parent when primingStep === 3. Each priming screen is a
// single big card + one "Continue" CTA, so the cognitive load is one
// decision at a time. Skipped entirely for win-back / lapsed users (the
// parent gates with `canTrial && !winback`).
function PrimingStep({ step, setStep, canTrial }) {
  if (!canTrial) return null;
  const screens = [
    {
      icon: 'Spark',
      title: `Free for ${TRIAL_DAYS} days. $0 charged today.`,
      body: `Add your card to unlock everything - bookings, invoices, messaging, your website. You won't be billed until the ${TRIAL_DAYS}-day trial ends, so cancel anytime before then and you'll never pay a cent.`,
      cta: 'Continue',
    },
    {
      icon: 'Bell',
      title: "We'll remind you before the trial ends.",
      body: `Two days before your trial wraps up, we'll send a heads-up email so you can decide. No surprise charges. Cancel in one tap from your account, anytime.`,
      cta: 'See the plan',
    },
  ];
  const s = screens[Math.max(0, Math.min(step - 1, screens.length - 1))];
  const Icon = Icons[s.icon] || Icons.Check;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '8px 0' }}>
      {/* Step pip indicator: two filled dots for the priming screens + one
          outline dot representing the upcoming plan card. */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 6 }}>
        {[1, 2, 3].map((n) => (
          <span key={n} style={{
            width: 8, height: 8, borderRadius: 99,
            background: n === step ? 'var(--accent)' : 'var(--surface-2)',
            border: '1px solid var(--border)',
          }}/>
        ))}
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 14, padding: '24px 18px', textAlign: 'center',
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: 14,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 99,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={22} sw={2}/>
        </div>
        <div style={{
          fontFamily: 'var(--font-display)', fontWeight: 500,
          fontSize: 20, lineHeight: 1.2, letterSpacing: '-0.015em',
          color: 'var(--fg)',
        }}>{s.title}</div>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>{s.body}</p>
      </div>
      <button onClick={() => setStep(step + 1)}
        className="btn btn-primary"
        style={{ justifyContent: 'center', padding: '13px 16px', fontSize: 15 }}>
        {s.cta} <Icons.Arrow size={14} sw={2.2}/>
      </button>
      {step > 1 && (
        <button onClick={() => setStep(step - 1)}
          className="btn btn-ghost"
          style={{ justifyContent: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
          Back
        </button>
      )}
    </div>
  );
}

// Refresh + recheck up to `attempts` times. Resolves once isActive becomes
// true or attempts run out - caller decides what to do with the timeout.
async function pollForActive(refresh, attempts, intervalMs) {
  for (let i = 0; i < attempts; i++) {
    const r = await refresh();
    if (r?.subscription?.isActive) return true;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return false;
}
