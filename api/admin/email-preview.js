// POST /api/admin/email-preview  { template, to?, stage? }
//
// Renders a transactional email template using sample merge data and sends
// it to the requester (default: the admin's own email). Lets the operator
// iterate on copy + see how it actually lands in their inbox without
// spinning up throwaway users or waiting for the real send to fire.
//
// What you see is BYTE-IDENTICAL to production: each renderer is the same
// `render*` function the real notify path calls. Edit a single
// subject/heading/body string and the next preview reflects it.
//
// The preview email's subject is prefixed `[PREVIEW] ` so it can't be
// confused with a real send, and the From / List-Unsubscribe headers
// stay as Ivy OS so the preview also tests the From address.
import { requireSuperAdmin } from '../_lib/admin.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { requireUser } from '../_lib/auth.js';
import { sendEmail } from '../_lib/email.js';
import { renderTrialReminder, renderSubscriptionStarted, renderUpcomingRenewal,
         renderWinbackOffer, renderPaymentFailed, renderSubscriptionCancelled } from '../_lib/subscriptionNotify.js';
import { renderSecurityAlert } from '../_lib/securityNotify.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const SAMPLE = {
  firstName: 'Kayla',
  businessName: 'Market Theory Studio',
  amountCents: 4900,
  currency: 'USD',
  // 14 days from now — used wherever a future date is needed.
  futureDate: () => new Date(Date.now() + 14 * 86400000),
  // 7 days ago — used for "trial expired" scenarios.
  pastDate:   () => new Date(Date.now() - 7 * 86400000),
};

// Catalogue surfaced to the admin UI (label, group, optional stage list).
export const PREVIEW_CATALOGUE = [
  { id: 'trial_reminder_7d',       group: 'Trial',        label: 'Trial reminder — 7 days left' },
  { id: 'trial_reminder_1d',       group: 'Trial',        label: 'Trial reminder — 1 day left' },
  { id: 'trial_reminder_expired',  group: 'Trial',        label: 'Trial expired (auto-downgrade)' },
  { id: 'subscription_started',    group: 'Billing',      label: 'Subscription confirmed (first paid)' },
  { id: 'subscription_renewal',    group: 'Billing',      label: 'Upcoming renewal' },
  { id: 'subscription_cancelled',  group: 'Billing',      label: 'Subscription cancelled' },
  { id: 'payment_failed',          group: 'Billing',      label: 'Payment failed / dunning' },
  { id: 'winback_offer',           group: 'Win-back',     label: 'Win-back — 30% off offer' },
  { id: 'security_new_signin',     group: 'Security',     label: 'Security alert — new sign-in' },
  { id: 'security_password_changed', group: 'Security',   label: 'Security alert — password changed' },
  { id: 'security_two_factor_on',  group: 'Security',     label: 'Security alert — 2FA turned on' },
  { id: 'security_two_factor_off', group: 'Security',     label: 'Security alert — 2FA turned off' },
];

function render(template) {
  switch (template) {
    case 'trial_reminder_7d':
      return renderTrialReminder({ stage: '7d',      trialEndsAt: SAMPLE.futureDate(), firstName: SAMPLE.firstName, businessName: SAMPLE.businessName });
    case 'trial_reminder_1d':
      return renderTrialReminder({ stage: '1d',      trialEndsAt: SAMPLE.futureDate(), firstName: SAMPLE.firstName, businessName: SAMPLE.businessName });
    case 'trial_reminder_expired':
      return renderTrialReminder({ stage: 'expired', trialEndsAt: SAMPLE.pastDate(),   firstName: SAMPLE.firstName, businessName: SAMPLE.businessName });
    case 'subscription_started':
      return renderSubscriptionStarted({ periodEnd: SAMPLE.futureDate(), amountCents: SAMPLE.amountCents, currency: SAMPLE.currency, firstName: SAMPLE.firstName, businessName: SAMPLE.businessName });
    case 'subscription_renewal':
      return renderUpcomingRenewal({ periodEnd: SAMPLE.futureDate(), amountCents: SAMPLE.amountCents, currency: SAMPLE.currency, firstName: SAMPLE.firstName, businessName: SAMPLE.businessName });
    case 'subscription_cancelled':
      return renderSubscriptionCancelled({ endsAt: SAMPLE.futureDate(), firstName: SAMPLE.firstName, businessName: SAMPLE.businessName });
    case 'payment_failed':
      return renderPaymentFailed({ amountCents: SAMPLE.amountCents, currency: SAMPLE.currency, nextAttemptAt: new Date(Date.now() + 3 * 86400000), firstName: SAMPLE.firstName, businessName: SAMPLE.businessName });
    case 'winback_offer':
      return renderWinbackOffer({ percentOff: 30, durationMonths: 3, promoCode: 'COMEBACK30-DEMO', expiresAt: new Date(Date.now() + 14 * 86400000), firstName: SAMPLE.firstName, businessName: SAMPLE.businessName });
    case 'security_new_signin':
      return renderSecurityAlert({ kind: 'new_signin',       firstName: SAMPLE.firstName, device: 'Chrome on macOS',  ip: '203.0.113.42', when: new Date().toUTCString() });
    case 'security_password_changed':
      return renderSecurityAlert({ kind: 'password_changed', firstName: SAMPLE.firstName, device: 'Safari on iOS',    ip: '203.0.113.42', when: new Date().toUTCString() });
    case 'security_two_factor_on':
      return renderSecurityAlert({ kind: 'two_factor', enabled: true,  firstName: SAMPLE.firstName, device: 'Chrome on macOS', ip: '203.0.113.42', when: new Date().toUTCString() });
    case 'security_two_factor_off':
      return renderSecurityAlert({ kind: 'two_factor', enabled: false, firstName: SAMPLE.firstName, device: 'Chrome on macOS', ip: '203.0.113.42', when: new Date().toUTCString() });
    default:
      return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  // Super-admin only. requireSuperAdmin honors the x-admin-secret header
  // too, but we ALSO want the logged-in admin's email so we can default
  // `to` to it — call requireUser first.
  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const body = await readBody(req).catch(() => ({}));
    const template = String(body?.template || '').trim();
    if (!template) return badRequest(res, 'template is required');

    const rendered = render(template);
    if (!rendered) return badRequest(res, `Unknown template '${template}'. Use GET /api/admin/email-preview for the list.`);

    const to = (typeof body?.to === 'string' && body.to.includes('@')) ? body.to.trim() : user.email;
    if (!to) return badRequest(res, 'No recipient — set `to` or sign in with an account that has an email.');

    await sendEmail({
      to,
      subject: `[PREVIEW] ${rendered.subject}`,
      html: rendered.html,
    });
    return ok(res, { sent: true, template, to });
  } catch (err) {
    return serverError(res, err);
  }
}
