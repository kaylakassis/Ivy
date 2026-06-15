// Paywall modal — UNSKIPPABLE hard wall when the workspace's subscription
// isn't active. Replaces the previous soft wall that let owners route to
// /me and keep working in the free client portal.
//
// Affordances (always rendered, in this order):
//   • Subscribe        — POSTs /api/billing/checkout, redirects to Stripe.
//   • Start free trial — only shown for owners who haven't trialed yet.
//   • Manage billing   — POSTs /api/billing/portal, opens Stripe Customer
//                        Portal so a card update or reactivation doesn't
//                        require a second support touch.
//   • Export my data   — anchor GET /api/account/export. The portability
//                        promise: owners can always retrieve their data,
//                        even when locked out of the app.
//   • Log out          — escape that doesn't compromise the wall.
//
// isClient carve-out: an owner who's ALSO a client of another THRYVE
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
import { THRYVE_PRICE, STACK_TOTAL } from '../../lib/pricing.js';

// Real, truthful conversion proof — mirrors the marketing pricing page.
// We deliberately do NOT fabricate star ratings or user counts (THRYVE
// has no review corpus to quote); the stack-replacement savings is a
// concrete claim we can stand behind.
const MONTHLY_SAVINGS = Math.max(0, STACK_TOTAL - THRYVE_PRICE);

// The benefit list — each row is a real capability gated behind the wall.
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
  const [params, setParams] = useSearchParams();
  const synced = useRef(false);
  const winbackTried = useRef(false);

  // Owners who are ALSO clients of another business get one labeled link
  // out — the wall stays unskippable from THEIR perspective (they can't
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
        // Webhook will eventually catch up — start a short poll loop.
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
        // present — guards against a malformed eligible:true response
        // rendering "NaN% off" / "$NaN/mo".
        if (r?.eligible
            && Number.isFinite(r.percentOff) && r.percentOff > 0
            && Number.isFinite(r.durationMonths) && r.durationMonths > 0) {
          setWinback(r);
        }
      })
      .catch(() => { /* no offer is a fine outcome — fall back to the plain banner */ });
  }, [cancelled]);

  const startTrial = async () => {
    setBusy('trial'); setErr(null);
    try {
      await api.post('/billing/start-trial', {});
      await onRefresh();
    } catch (e) {
      setErr(e.message || 'Could not start trial');
    } finally {
      setBusy(null);
    }
  };

  const subscribe = async () => {
    setBusy('subscribe'); setErr(null);
    try {
      const r = await api.post('/billing/checkout', {});
      if (!r.url) throw new Error('No checkout URL returned');
      window.location.href = r.url;
    } catch (e) {
      setErr(e.message || 'Could not start checkout');
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
  // lapsed. (daysRemaining is null — not 0 — for an expired trial, so
  // the old `=== 0` check never fired and this copy was dead.)
  const trialExpired = sub?.status === 'trialing' && !sub?.isActive;
  const everTrialed  = !!sub?.trialEndsAt;
  const wasPaid      = sub?.status === 'cancelled' || sub?.status === 'past_due';
  // The trial CTA only makes sense for owners who've never trialed; for
  // everyone else the wall leads straight to Subscribe.
  const canTrial = !everTrialed;
  const syncing  = busy === 'syncing';

  const heading = syncing      ? 'Confirming your subscription…'
                : wasPaid       ? 'Pick up where you left off'
                : trialExpired  ? 'Your free trial has ended'
                : canTrial      ? 'Start your 28-day free trial'
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
            over a colored band) but uses THRYVE's accent tint, so it
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
              Everything you run your business on — clients, calendar, invoices,
              documents, messaging — in one place.
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
              account — this usually takes a couple of seconds.
            </p>
          ) : (
            <>
              {/* Truthful savings proof — the refs' "social proof / save
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
                    stitched-together tools — <strong style={{ color: 'var(--ok)' }}>save ${MONTHLY_SAVINGS}/mo</strong>.
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

              {/* ─── PLAN CARD (highlighted "best offer" style) ──────
                  Single real plan — no fabricated Monthly/Annual toggle.
                  The badge + accent border match the refs' featured-plan
                  treatment. */}
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
                }}>{canTrial ? '28 days free' : 'Full access'}</div>

                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', flex: 1 }}>THRYVING</span>
                  <span style={{
                    fontFamily: 'var(--font-num)', fontSize: 28, fontWeight: 600,
                    color: 'var(--fg)', letterSpacing: '-0.02em',
                  }}>${THRYVE_PRICE}</span>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>/mo</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--muted)' }}>
                  {canTrial
                    ? `Free for 28 days, then $${THRYVE_PRICE}/mo. Cancel anytime.`
                    : `$${THRYVE_PRICE}/mo · one plan, no per-seat fees. Cancel anytime.`}
                </div>
              </div>

              {/* Abandoned-cart win-back: when checkout was cancelled AND
                  the server handed us a one-time discount, the plain
                  "cancelled" note is replaced by the offer. Subscribing
                  from here is auto-discounted server-side (checkout.js
                  reads the stamped coupon) — no code entry needed. */}
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
                    Wait — {winback.percentOff}% off your first {winback.durationMonths} months
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.45 }}>
                    That's <strong style={{ color: 'var(--fg)' }}>
                      ${(THRYVE_PRICE * (1 - winback.percentOff / 100)).toFixed(2)}/mo
                    </strong> for {winback.durationMonths} months. The discount applies automatically at
                    checkout{winback.promoCode ? <> — or use code <strong>{winback.promoCode}</strong></> : null}.
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
                }}>Checkout was cancelled — try again whenever you're ready.</div>
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
                  <button onClick={startTrial} disabled={busy != null}
                    className="btn btn-primary"
                    style={{ justifyContent: 'center', padding: '14px 16px', fontSize: 15 }}>
                    {busy === 'trial' ? 'Starting…' : 'Start 28-day free trial'}
                    {busy !== 'trial' && <Icons.Arrow size={14} sw={2.2}/>}
                  </button>
                  <button onClick={subscribe} disabled={busy != null}
                    className="btn btn-ghost"
                    style={{ justifyContent: 'center', fontSize: 13, color: 'var(--muted)' }}>
                    {busy === 'subscribe' ? 'Redirecting…' : `or subscribe now — $${THRYVE_PRICE}/mo`}
                  </button>
                </div>
              ) : (
                <button onClick={subscribe} disabled={busy != null}
                  className="btn btn-primary"
                  style={{ justifyContent: 'center', padding: '14px 16px', fontSize: 15 }}>
                  {busy === 'subscribe' ? 'Redirecting…'
                    : winback ? `Claim ${winback.percentOff}% off — $${(THRYVE_PRICE * (1 - winback.percentOff / 100)).toFixed(2)}/mo`
                    : `Subscribe — $${THRYVE_PRICE}/mo`}
                  {busy !== 'subscribe' && <Icons.Arrow size={14} sw={2.2}/>}
                </button>
              )}

              {/* Reassurance microcopy — the refs' "No payment now ·
                  Cancel anytime" trust line. "No payment now" only shows
                  when it's literally true (no-card trial). */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 6, fontSize: 11.5, color: 'var(--muted)',
              }}>
                <Icons.Check size={12} sw={2.4} stroke="var(--ok)"/>
                {canTrial ? 'No payment due today · Cancel anytime' : 'Secure checkout · Cancel anytime'}
              </div>

              {/* ─── Secondary affordances — the entire hard-wall escape
                  surface. Manage billing only when a Stripe customer
                  exists; Export hits the ungated data-portability GET;
                  Log out clears the session. */}
              <div style={{
                display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
                gap: 4, marginTop: 2, paddingTop: 12, borderTop: '1px solid var(--border)',
                fontSize: 12.5,
              }}>
                {ctx?.hasBillingRecord && (
                  <>
                    <button onClick={openBillingPortal} disabled={busy != null}
                      className="btn btn-ghost"
                      style={{ padding: '5px 9px', color: 'var(--muted)' }}>
                      {busy === 'portal' ? 'Opening…' : 'Manage billing'}
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
                  business's portal — never a generic /me link. */}
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

              {/* Trust line — every top-earner closes with Terms/Privacy. */}
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

// Refresh + recheck up to `attempts` times. Resolves once isActive becomes
// true or attempts run out — caller decides what to do with the timeout.
async function pollForActive(refresh, attempts, intervalMs) {
  for (let i = 0; i < attempts; i++) {
    const r = await refresh();
    if (r?.subscription?.isActive) return true;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return false;
}
