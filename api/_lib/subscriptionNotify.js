// Subscription lifecycle emails (to workspace owners). Fires from the
// platform-side billing webhook (api/webhooks/billing.js):
//   • subscribed       → on checkout.session.completed (mode=subscription)
//   • upcomingRenewal  → on invoice.upcoming (Stripe fires 3 days ahead)
//   • paymentFailed    → on invoice.payment_failed
//   • cancelled        → on customer.subscription.deleted
//
// All are owner-facing only; the workspace's owner_id is the prefs
// subject (type='billing'). Critical info - payment-failure especially -
// will still fire even when muted because past_due workspaces lose
// features and need to know.
//
// Copy intent: each email speaks to the owner about THEIR business
// (`{{business_name}}`), reminds them what they'll lose, and gives one
// obvious next step. Merge fields are filled here at send-time (never
// shipped as literal `{{ ... }}` to the recipient).
import { sql } from './db.js';
import { sendEmailToUser, emailShell } from './email.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';
import { workspaceTimeZone } from './calendar.js';
import { notifyOwnerSafe } from './push.js';

const PLAN_NAME = 'Ivy OS Pro';

function fmtMoneyCents(cents, currency = 'USD') {
  if (cents == null) return '';
  const n = Number(cents) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function fmtDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function firstName(name) {
  return (name || '').split(/\s+/)[0] || 'there';
}

async function loadOwner(workspaceId) {
  const { rows } = await sql`
    SELECT w.owner_id, u.email, u.name, cs.biz_name
    FROM workspaces w
    LEFT JOIN users u ON u.id = w.owner_id
    LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
    WHERE w.id = ${workspaceId}
  `;
  return rows[0] || null;
}

function billingUrl() { return `${appUrl()}/account?tab=billing`; }
function dashboardUrl() { return `${appUrl()}/`; }

// ─────────────────────────────────────────────────────────────────────
// Trial reminder sequence (cron: api/cron/trial-reminders.js)
// ─────────────────────────────────────────────────────────────────────

// Pure renderer. Both the notify path and the admin preview endpoint
// call this — the preview an operator sees is byte-identical to the
// production send.
export function renderTrialReminder({ stage, trialEndsAt, firstName: fnRaw, businessName }) {
  const fnPlain = fnRaw || 'there';
  const fn = escapeHtml(fnPlain);
  const biz = escapeHtml(businessName || 'your business');
  const endDate = fmtDate(trialEndsAt);

  let subject, preheader, heading, body, ctaText;
  if (stage === '7d') {
    subject = `You've got 7 days left — here's what you've built, ${fnPlain}`;
    preheader = `Keep your clients, data, and Ivy before your trial ends.`;
    heading = 'You\'ve got 7 days left';
    body = `<p>Hi ${fn},</p>
      <p>You're one week out from the end of your Ivy OS trial — and you've already set up the kind of system most owners overpay for and scatter across multiple disconnected tools.</p>
      <p>Right now, inside <strong>${biz}</strong>, you have:</p>
      <ul style="padding-left:20px;margin:14px 0;">
        <li>Your client list, pipeline, and history in one place</li>
        <li>Bookings and reminders running automatically</li>
        <li>Ivy, your AI coach, learning your business</li>
        <li>Financials and reporting tracking every dollar</li>
      </ul>
      <p>When your trial ends on <strong>${endDate}</strong>, you keep your account — but the business features above pause until you choose a plan. Lock everything in now and don't lose a beat.</p>`;
    ctaText = 'Choose my plan →';
  } else if (stage === '2d') {
    // The heads-up promised on the paywall: ~2 days out, so the owner has time
    // to decide with no surprise charges.
    subject = 'Your Ivy OS trial ends in 2 days';
    preheader = `A quick heads-up so there are no surprises, ${fnPlain}.`;
    heading = 'Your trial ends in 2 days';
    body = `<p>Hi ${fn},</p>
      <p>Just so it's not a surprise: your Ivy OS trial ends in <strong>2 days, on ${endDate}</strong>.</p>
      <p>If you're getting value from <strong>${biz}</strong>, pick a plan and everything keeps running without a break. If it's not for you, no charge — cancel in one tap from your account, anytime.</p>
      <p>Either way, you're in control. We just didn't want the date to sneak up on you.</p>`;
    ctaText = 'Choose my plan →';
  } else if (stage === '1d') {
    subject = 'Your Ivy OS trial ends tomorrow';
    preheader = `One step to keep ${businessName || 'your business'} running.`;
    heading = 'Your trial ends tomorrow';
    body = `<p>Hi ${fn},</p>
      <p>Quick heads-up: your trial ends <strong>tomorrow, ${endDate}</strong>.</p>
      <p>After that, <strong>${biz}</strong> moves to a free account and your business tools — client management, scheduling, Ivy, financials, and reporting — switch off until you pick a plan. Your data stays safe and waiting, but the automations stop.</p>
      <p>You've already done the hard part of setting it up. Don't let it go quiet.</p>`;
    ctaText = 'Keep everything — subscribe →';
  } else if (stage === 'expired') {
    subject = 'Your Ivy OS trial has ended';
    preheader = `Your account and data are safe — reactivate whenever you're ready.`;
    heading = 'Your trial has ended';
    body = `<p>Hi ${fn},</p>
      <p>Your Ivy OS trial has ended, and <strong>${biz}</strong> has moved to a free Client account. Nothing was deleted — your clients, bookings, documents, and history are all still here.</p>
      <p>To switch your business tools back on, you'll want to reactivate:</p>
      <ul style="padding-left:20px;margin:14px 0;">
        <li>Unlimited client management</li>
        <li>Scheduling, reminders, and your booking page</li>
        <li>Ivy, your AI business coach</li>
        <li>Financial tracking, invoicing, and reports</li>
        <li>Website builder and campaign tools</li>
      </ul>
      <p>It picks up right where you left off. Questions? Just reply.</p>`;
    ctaText = `Reactivate ${PLAN_NAME} →`;
  } else {
    return null;
  }

  const html = emailShell({
    heading, body, preheader,
    ctaText, ctaUrl: billingUrl(),
    footer: `No long-term contract. Cancel anytime. — The Ivy OS Team`,
  });
  return { subject, html, preheader };
}

// Short push copy per stage, so a trialing owner who lives in the installed PWA
// and ignores email still gets the heads-up before their tools switch off.
// Returns null for a stage with no email (keeps push + email in lockstep).
function trialPushPayload(stage) {
  const map = {
    '7d': { title: '7 days left on your trial', body: 'Lock in your plan before the trial ends — keep everything running.' },
    '2d': { title: 'Your trial ends in 2 days', body: 'A couple of days left. Pick a plan to keep your business tools on — no surprise charges.' },
    '1d': { title: 'Your trial ends tomorrow', body: 'Last day to keep your client tools, scheduling, and Ivy switched on.' },
    'expired': { title: 'Your trial has ended', body: 'Your data is safe. Reactivate to switch your business tools back on.' },
  };
  return map[stage] || null;
}

export async function notifyTrialReminder({ workspaceId, stage, trialEndsAt }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const rendered = renderTrialReminder({
      stage, trialEndsAt,
      firstName: firstName(o.name), businessName: o.biz_name,
    });
    if (!rendered) return;
    await sendEmailToUser({
      userId: o.owner_id, type: 'billing',
      to: o.email, subject: rendered.subject, html: rendered.html,
    });
    // Push + bell alongside the email (mirrors subscription-dunning's billing
    // push, type 'payments' so it rides the owner's payments opt-out). Deep-links
    // to billing so one tap goes straight to picking a plan.
    const push = trialPushPayload(stage);
    if (push) {
      await notifyOwnerSafe({
        workspaceId, type: 'payments',
        payload: { ...push, url: '/account?tab=billing', tag: `trial-reminder-${stage}` },
      });
    }
  } catch (err) {
    console.error('[subscriptionNotify.trialReminder] failed:', err.message);
    reportError(err, { extra: { workspaceId, stage } });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Dormant-owner re-engagement (usage churn, not billing churn)
// ─────────────────────────────────────────────────────────────────────
// Fired by api/cron/owner-reengage.js for a subscribed/trialing owner who
// stopped logging in. Leads with what's concretely waiting for them (upcoming
// sessions + money to collect) so the pull is "pick up where you left off,"
// not "we miss you." Email (type 'reports', respects opt-out) + push/feed.
export async function notifyDormantOwner({ workspaceId }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const tz = await workspaceTimeZone(workspaceId);
    const [upRes, invRes] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM bookings
            WHERE workspace_id = ${workspaceId} AND cancelled_at IS NULL
              AND date >= (NOW() AT TIME ZONE ${tz})::date
              AND date <  (NOW() AT TIME ZONE ${tz})::date + 7`,
      sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::numeric AS owed FROM invoices
            WHERE workspace_id = ${workspaceId} AND status IN ('sent', 'overdue')`,
    ]);
    const upcoming = Number(upRes.rows[0]?.n || 0);
    const unpaidN = Number(invRes.rows[0]?.n || 0);
    const owed = Number(invRes.rows[0]?.owed || 0);

    const biz = escapeHtml(o.biz_name || 'your business');
    const bits = [];
    if (upcoming > 0) bits.push(`<strong>${upcoming}</strong> session${upcoming === 1 ? '' : 's'} coming up this week`);
    if (unpaidN > 0) bits.push(`<strong>${unpaidN}</strong> unpaid invoice${unpaidN === 1 ? '' : 's'}${owed > 0 ? ` ($${Math.round(owed).toLocaleString()} to collect)` : ''}`);
    // Only worth reaching out if there's something concrete to return to.
    if (bits.length === 0) return;
    const waiting = bits.length === 2 ? `${bits[0]} and ${bits[1]}` : bits[0];

    const html = emailShell({
      heading: `You've got things waiting at ${biz}`,
      body: `<p>Hi ${escapeHtml(firstName(o.name))},</p>
        <p>It's been a little while. Here's what's waiting for you: ${waiting}.</p>
        <p>Ivy can knock most of it out for you, just pick up where you left off.</p>`,
      ctaText: 'Open my dashboard',
      ctaUrl: `${appUrl()}/dashboard`,
      footer: `You're getting this because your ${PLAN_NAME} account has been quiet. Manage email preferences from Account → Notifications.`,
    });
    await sendEmailToUser({
      userId: o.owner_id, type: 'reports',
      to: o.email, subject: `A few things are waiting for you at ${o.biz_name || 'your business'}`, html,
    });
    // Push + bell, so it lands even without an open tab.
    notifyOwnerSafe({
      workspaceId,
      payload: {
        title: 'Things are waiting for you',
        body: bits.length === 2
          ? `${upcoming} session${upcoming === 1 ? '' : 's'} this week · ${unpaidN} unpaid invoice${unpaidN === 1 ? '' : 's'}`
          : (upcoming > 0 ? `${upcoming} session${upcoming === 1 ? '' : 's'} coming up` : `${unpaidN} unpaid invoice${unpaidN === 1 ? '' : 's'} to collect`),
        url: '/dashboard',
        tag: 'owner-reengage',
      },
    });
  } catch (err) {
    console.error('[subscriptionNotify.dormantOwner] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Subscription confirmed (first paid)
// ─────────────────────────────────────────────────────────────────────

export function renderSubscriptionStarted({ periodEnd, amountCents, currency, firstName: fnRaw, businessName }) {
  const fn = escapeHtml(fnRaw || 'there');
  const biz = escapeHtml(businessName || 'your business');
  const amount = amountCents != null ? fmtMoneyCents(amountCents, currency) : '';
  const renewLine = periodEnd
    ? `<p>Your next bill is on <strong>${fmtDate(periodEnd)}</strong>${amount ? ` for <strong>${amount}</strong>` : ''}.</p>`
    : '';
  const preheader = `Here's how to get the most out of it this week.`;
  const html = emailShell({
    heading: `You're in — welcome to ${PLAN_NAME}`,
    preheader,
    body: `<p>Hi ${fn},</p>
      <p>You're officially on <strong>${PLAN_NAME}</strong>. Thanks for trusting Ivy OS to run <strong>${biz}</strong>${amount ? ` — here's your receipt for <strong>${amount}</strong>` : ''}, and you're all set.</p>
      ${renewLine}
      <p>If you want a fast win this week, start here:</p>
      <ol style="padding-left:20px;margin:14px 0;">
        <li><strong>Connect your calendar</strong> so bookings sync automatically</li>
        <li><strong>Ask Ivy</strong> one thing you're stuck on — she's trained on your business now</li>
        <li><strong>Send your booking link</strong> to a client and watch the flow end-to-end</li>
      </ol>
      <p>Need anything? Reply to this email — a real person reads it.</p>`,
    ctaText: 'Open my dashboard →',
    ctaUrl: dashboardUrl(),
    footer: `— The Ivy OS Team`,
  });
  return { subject: `You're in — welcome to ${PLAN_NAME}`, html, preheader };
}

export async function notifySubscriptionStarted({ workspaceId, periodEnd, amountCents, currency }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const rendered = renderSubscriptionStarted({
      periodEnd, amountCents, currency,
      firstName: firstName(o.name), businessName: o.biz_name,
    });
    await sendEmailToUser({
      userId: o.owner_id, type: 'billing',
      to: o.email, subject: rendered.subject, html: rendered.html,
    });
  } catch (err) {
    console.error('[subscriptionNotify.started] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Referral reward earned (refer a friend, you both get a free week)
// ─────────────────────────────────────────────────────────────────────

// variant: 'referrer' (their referral subscribed) or 'referred' (welcome
// gift for signing up through a friend). Both get one free week as a Stripe
// balance credit; this just tells them.
export function renderReferralReward({ variant, weeks = 1, firstName: fnRaw, businessName }) {
  const fn = escapeHtml(fnRaw || 'there');
  const biz = escapeHtml(businessName || 'your business');
  const wk = weeks === 1 ? 'a free week' : `${weeks} free weeks`;

  if (variant === 'referred') {
    const preheader = `Your first week is on us — welcome to ${PLAN_NAME}.`;
    const html = emailShell({
      heading: `Welcome — your first week's on us`,
      preheader,
      body: `<p>Hi ${fn},</p>
        <p>Thanks for joining <strong>${PLAN_NAME}</strong> through a friend's invite. As a welcome gift, we've credited you <strong>${wk}</strong> — it comes straight off your next invoice, nothing to do.</p>
        <p>Now go make running <strong>${biz}</strong> feel easy. Ask Ivy anything to get started.</p>`,
      ctaText: 'Open my dashboard →',
      ctaUrl: dashboardUrl(),
      footer: `— The Ivy OS Team`,
    });
    return { subject: `Welcome to ${PLAN_NAME} — your first week's on us`, html, preheader };
  }

  // referrer
  const preheader = `Someone you referred subscribed — you earned ${wk}.`;
  const html = emailShell({
    heading: `You earned ${wk} 🎉`,
    preheader,
    body: `<p>Hi ${fn},</p>
      <p>Great news — someone you referred just subscribed to <strong>${PLAN_NAME}</strong>. You've earned <strong>${wk}</strong>, credited to your account so your next invoice is waived.</p>
      <p>Keep sharing your link and keep earning — you both get a free week every time.</p>`,
    ctaText: 'See my referrals →',
    ctaUrl: `${appUrl()}/referrals`,
    footer: `— The Ivy OS Team`,
  });
  return { subject: `You earned ${wk} — thanks for the referral`, html, preheader };
}

export async function notifyReferralReward({ workspaceId, variant, weeks = 1 }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const rendered = renderReferralReward({
      variant, weeks,
      firstName: firstName(o.name), businessName: o.biz_name,
    });
    await sendEmailToUser({
      userId: o.owner_id, type: 'billing',
      to: o.email, subject: rendered.subject, html: rendered.html,
    });
    const wk = weeks === 1 ? 'a free week' : `${weeks} free weeks`;
    await notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: {
        title: variant === 'referred' ? '🎉 Your first week is on us' : `🎉 You earned ${wk}`,
        body: variant === 'referred'
          ? 'Welcome gift credited to your account.'
          : 'Someone you referred subscribed. Credit applied to your next invoice.',
        url: variant === 'referred' ? '/' : '/referrals',
        tag: `referral-reward-${variant}-${workspaceId}`,
      },
    });
  } catch (err) {
    console.error('[subscriptionNotify.referralReward] failed:', err.message);
    reportError(err, { extra: { workspaceId, variant } });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Upcoming renewal (Stripe invoice.upcoming, ~3 days out)
// ─────────────────────────────────────────────────────────────────────

export function renderUpcomingRenewal({ periodEnd, amountCents, currency, firstName: fnRaw, businessName }) {
  const fn = escapeHtml(fnRaw || 'there');
  const biz = escapeHtml(businessName || 'your business');
  const amount = amountCents != null ? fmtMoneyCents(amountCents, currency) : '';
  const renewDate = fmtDate(periodEnd);
  const preheader = `No action needed — just a quick heads-up.`;
  const html = emailShell({
    heading: `Your plan renews on ${renewDate}`,
    preheader,
    body: `<p>Hi ${fn},</p>
      <p>A friendly heads-up: your <strong>${PLAN_NAME}</strong> plan renews on <strong>${renewDate}</strong>${amount ? ` for <strong>${amount}</strong>` : ''}, billed to your card on file. No action needed — this is just so there are no surprises.</p>
      <p>Since your last renewal, <strong>${biz}</strong> has kept its bookings, clients, Ivy automations, and reporting running without a break — and it'll keep going.</p>
      <p>Need to update your card or change plans? You can do it anytime.</p>`,
    ctaText: 'Manage subscription',
    ctaUrl: billingUrl(),
    footer: `— The Ivy OS Team`,
  });
  return { subject: `Your Ivy OS plan renews on ${renewDate}`, html, preheader };
}

export async function notifyUpcomingRenewal({ workspaceId, periodEnd, amountCents, currency }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const rendered = renderUpcomingRenewal({
      periodEnd, amountCents, currency,
      firstName: firstName(o.name), businessName: o.biz_name,
    });
    await sendEmailToUser({
      userId: o.owner_id, type: 'billing',
      to: o.email, subject: rendered.subject, html: rendered.html,
    });
  } catch (err) {
    console.error('[subscriptionNotify.upcoming] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Win-back offer (one-time, after lapse)
// ─────────────────────────────────────────────────────────────────────

export function renderWinbackOffer({
  percentOff, durationMonths, promoCode, expiresAt, firstName: fnRaw, businessName,
}) {
  const fn = escapeHtml(fnRaw || 'there');
  const biz = escapeHtml(businessName || 'your business');
  const months = durationMonths || 3;
  const preheader = `Your account's still here. So is the offer.`;
  const html = emailShell({
    heading: `Come back to Ivy OS — ${percentOff}% off your next ${months} months`,
    preheader,
    body: `<p>Hi ${fn},</p>
      <p>We saved your spot. Everything you built in <strong>${biz}</strong> — clients, history, settings, Ivy's knowledge of your business — is exactly where you left it.</p>
      <p>To make coming back easy, here's <strong>${percentOff}% off your first ${months} months</strong> when you reactivate:</p>
      <div style="margin:18px 0;padding:14px 18px;border-radius:10px;background:#1D2022;border:1px solid #383D41;text-align:center;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:18px;letter-spacing:0.12em;font-weight:600;color:#CFFF50;">${escapeHtml(promoCode)}</div>
      <p>Apply the code at checkout. Offer expires <strong>${fmtDate(expiresAt)}</strong>, and you can cancel anytime.</p>`,
    ctaText: 'Claim my offer →',
    ctaUrl: `${appUrl()}/account?tab=billing&winback=1`,
    footer: `This is a one-time offer — once it expires it doesn't come back. — The Ivy OS Team`,
  });
  return {
    subject: `Come back to Ivy OS — ${percentOff}% off your next ${months} months`,
    html, preheader,
  };
}

export async function notifyWinbackOffer({
  workspaceId, percentOff, durationMonths, promoCode, expiresAt,
}) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const rendered = renderWinbackOffer({
      percentOff, durationMonths, promoCode, expiresAt,
      firstName: firstName(o.name), businessName: o.biz_name,
    });
    await sendEmailToUser({
      userId: o.owner_id, type: 'billing',
      to: o.email, subject: rendered.subject, html: rendered.html,
    });
  } catch (err) {
    console.error('[subscriptionNotify.winback] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Payment failed / dunning (critical — bypasses prefs)
// ─────────────────────────────────────────────────────────────────────

export function renderPaymentFailed({ amountCents, currency, nextAttemptAt, firstName: fnRaw, businessName }) {
  const fn = escapeHtml(fnRaw || 'there');
  const biz = escapeHtml(businessName || 'your business');
  const amount = amountCents != null ? fmtMoneyCents(amountCents, currency) : 'your subscription';
  const retryLine = nextAttemptAt
    ? `<p>Your account is still active for now. We'll automatically try again on <strong>${fmtDate(nextAttemptAt)}</strong>, but the fastest fix is to update your payment method.</p>`
    : `<p>Your account is still active for now, but the fastest fix is to update your payment method.</p>`;
  const preheader = `Update your card to keep ${businessName || 'your business'} active.`;
  const html = emailShell({
    heading: `Action needed: your payment didn't go through`,
    preheader,
    body: `<p>Hi ${fn},</p>
      <p>We tried to process your <strong>${amount}</strong> payment for Ivy OS and it didn't go through — usually an expired card or a temporary bank hold.</p>
      ${retryLine}
      <p>If the retry fails too, your business features in <strong>${biz}</strong> will pause until the balance is settled — so it's worth two minutes now. If you've already updated your card, you can ignore this.</p>`,
    ctaText: 'Update payment method',
    ctaUrl: billingUrl(),
    footer: `Critical billing notice — sent regardless of your preferences so you don't miss it. — The Ivy OS Team`,
  });
  return { subject: `Action needed: your Ivy OS payment didn't go through`, html, preheader };
}

export async function notifyPaymentFailed({ workspaceId, amountCents, currency, nextAttemptAt }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const rendered = renderPaymentFailed({
      amountCents, currency, nextAttemptAt,
      firstName: firstName(o.name), businessName: o.biz_name,
    });
    // Critical billing notice: no `type` → bypasses billing opt-out so a
    // past_due owner can't accidentally suppress the warning that keeps
    // them from getting locked out.
    await sendEmailToUser({
      userId: o.owner_id, type: undefined,
      to: o.email, subject: rendered.subject, html: rendered.html,
    });
  } catch (err) {
    console.error('[subscriptionNotify.failed] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Subscription cancelled (deletion at period end)
// ─────────────────────────────────────────────────────────────────────

export function renderSubscriptionCancelled({ endsAt, firstName: fnRaw, businessName }) {
  const fn = escapeHtml(fnRaw || 'there');
  const biz = escapeHtml(businessName || 'your business');
  const accessUntil = endsAt
    ? `<li>You keep <strong>full access until ${fmtDate(endsAt)}</strong> (the end of your paid period)</li>`
    : `<li>Your workspace has moved to the free account immediately</li>`;
  const preheader = endsAt ? `You keep full access until ${fmtDate(endsAt)}.` : `Your account is safe — reactivate any time.`;
  const html = emailShell({
    heading: `Your subscription is cancelled — what happens next`,
    preheader,
    body: `<p>Hi ${fn},</p>
      <p>Your Ivy OS subscription is cancelled. We're sorry to see you go — but a few things to make this painless:</p>
      <ul style="padding-left:20px;margin:14px 0;">
        ${accessUntil}
        <li>After that, <strong>${biz}</strong> moves to a free account; <strong>nothing is deleted</strong></li>
        <li>You can reactivate anytime and pick up exactly where you left off</li>
      </ul>
      <p>If something wasn't working — Ivy, a missing feature, pricing — just reply and tell me. I read every one, and it genuinely shapes what we build next.</p>`,
    ctaText: 'Changed your mind? Reactivate →',
    ctaUrl: billingUrl(),
    footer: `— The Ivy OS Team`,
  });
  return { subject: `Your Ivy OS subscription is cancelled — what happens next`, html, preheader };
}

export async function notifySubscriptionCancelled({ workspaceId, endsAt }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const rendered = renderSubscriptionCancelled({
      endsAt, firstName: firstName(o.name), businessName: o.biz_name,
    });
    await sendEmailToUser({
      userId: o.owner_id, type: 'billing',
      to: o.email, subject: rendered.subject, html: rendered.html,
    });
  } catch (err) {
    console.error('[subscriptionNotify.cancelled] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}
