// Subscription lifecycle emails (to workspace owners). Fires from the
// platform-side billing webhook (api/webhooks/billing.js):
//   • subscribed       → on checkout.session.completed (mode=subscription)
//   • upcomingRenewal  → on invoice.upcoming (Stripe fires 3 days ahead)
//   • paymentFailed    → on invoice.payment_failed
//   • cancelled        → on customer.subscription.deleted
//
// All are owner-facing only; the workspace's owner_id is the prefs
// subject (type='billing'). Critical info — payment-failure especially —
// will still fire even when muted because past_due workspaces lose
// features and need to know.
import { sql } from './db.js';
import { sendEmailToUser, emailShell } from './email.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';

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

export async function notifySubscriptionStarted({ workspaceId, periodEnd, amountCents, currency }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const greeting = o.name ? `Hi ${o.name.split(/\s+/)[0]},` : 'Hi,';
    const renewLine = periodEnd ? `<p>Your next bill is on <strong>${fmtDate(periodEnd)}</strong>${amountCents ? ` for <strong>${fmtMoneyCents(amountCents, currency)}</strong>` : ''}.</p>` : '';
    const html = emailShell({
      heading: 'You\'re subscribed',
      body: `<p>${greeting}</p>
        <p>Thanks for subscribing to THRYVE. Your account is fully unlocked${o.biz_name ? ` for <strong>${o.biz_name}</strong>` : ''}.</p>
        ${renewLine}
        <p>You can manage your subscription anytime from your account.</p>`,
      ctaText: 'Manage subscription',
      ctaUrl: `${appUrl()}/account?tab=billing`,
      footer: 'Need help? Reply to this email and our team will get back to you.',
    });
    await sendEmailToUser({
      userId: o.owner_id, type: 'billing',
      to: o.email, subject: 'Welcome to THRYVE — subscription confirmed', html,
    });
  } catch (err) {
    console.error('[subscriptionNotify.started] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}

export async function notifyUpcomingRenewal({ workspaceId, periodEnd, amountCents, currency }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const greeting = o.name ? `Hi ${o.name.split(/\s+/)[0]},` : 'Hi,';
    const html = emailShell({
      heading: 'Your subscription renews soon',
      body: `<p>${greeting}</p>
        <p>This is a heads-up that your THRYVE subscription renews on
        <strong>${fmtDate(periodEnd)}</strong>${amountCents ? ` for <strong>${fmtMoneyCents(amountCents, currency)}</strong>` : ''}.</p>
        <p>No action needed if everything's still good — we'll bill the card on file. To change your plan or update your payment method, head to your billing page.</p>`,
      ctaText: 'Manage billing',
      ctaUrl: `${appUrl()}/account?tab=billing`,
      footer: `Don't want these reminders? Adjust your email preferences from /account.`,
    });
    await sendEmailToUser({
      userId: o.owner_id, type: 'billing',
      to: o.email, subject: `Heads up — your subscription renews ${fmtDate(periodEnd)}`, html,
    });
  } catch (err) {
    console.error('[subscriptionNotify.upcoming] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}

export async function notifyPaymentFailed({ workspaceId, amountCents, currency, nextAttemptAt }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const greeting = o.name ? `Hi ${o.name.split(/\s+/)[0]},` : 'Hi,';
    const next = nextAttemptAt ? `<p>Stripe will retry on <strong>${fmtDate(nextAttemptAt)}</strong> automatically.</p>` : '';
    const html = emailShell({
      heading: 'Your subscription payment failed',
      body: `<p>${greeting}</p>
        <p>We couldn't charge your card for your THRYVE subscription${amountCents ? ` (${fmtMoneyCents(amountCents, currency)})` : ''}.
        Your account is now <strong>past due</strong> — please update your payment method to keep things running.</p>
        ${next}`,
      ctaText: 'Update payment method',
      ctaUrl: `${appUrl()}/account?tab=billing`,
      footer: 'Critical billing notice — this email is sent regardless of your preferences so you don\'t miss it.',
    });
    // Critical billing notice: bypass `billing` opt-out so past_due
    // owners can't accidentally suppress the warning that keeps them
    // from getting locked out. Use sendEmail directly via the wrapper
    // with no `type`.
    await sendEmailToUser({
      userId: o.owner_id,
      type: undefined, // bypass prefs — too important to skip
      to: o.email, subject: 'Action needed: your THRYVE subscription payment failed', html,
    });
  } catch (err) {
    console.error('[subscriptionNotify.failed] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}

export async function notifySubscriptionCancelled({ workspaceId, endsAt }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return;
    const greeting = o.name ? `Hi ${o.name.split(/\s+/)[0]},` : 'Hi,';
    const endLine = endsAt
      ? `<p>You'll still have access to paid features until <strong>${fmtDate(endsAt)}</strong>. After that, your workspace switches to the free tier.</p>`
      : `<p>Your workspace has moved to the free tier.</p>`;
    const html = emailShell({
      heading: 'Your subscription was cancelled',
      body: `<p>${greeting}</p>
        <p>We've cancelled your THRYVE subscription. No further charges.</p>
        ${endLine}
        <p>Changed your mind? You can resubscribe anytime — your data is still here.</p>`,
      ctaText: 'Resubscribe',
      ctaUrl: `${appUrl()}/account?tab=billing`,
      footer: 'We\'d love feedback on what went wrong — just reply to this email.',
    });
    await sendEmailToUser({
      userId: o.owner_id, type: 'billing',
      to: o.email, subject: 'Your THRYVE subscription was cancelled', html,
    });
  } catch (err) {
    console.error('[subscriptionNotify.cancelled] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
  }
}
