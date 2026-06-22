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
import { renderWelcome } from '../_lib/welcome-content.js';
import { renderWeeklyRecap } from '../_lib/weeklyRecap.js';
import * as R from '../_lib/emailRenderers.js';
import { appUrl } from '../_lib/tokens.js';
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

// Catalogue surfaced to the admin UI (label, group). Listed in the order
// they appear in the picker.
export const PREVIEW_CATALOGUE = [
  // Auth + account
  { id: 'verify_email',              group: 'Account',     label: 'Verify your email' },
  { id: 'password_reset',            group: 'Account',     label: 'Password reset' },
  { id: 'account_deletion_request',  group: 'Account',     label: 'Account deletion request' },
  { id: 'account_restored',          group: 'Account',     label: 'Account restored (welcome back)' },
  { id: 'data_export_ready',         group: 'Account',     label: 'Data export ready (attachment)' },
  { id: 'data_export_too_big',       group: 'Account',     label: 'Data export ready (too big, link)' },

  // Welcome
  { id: 'welcome_owner',             group: 'Welcome',     label: 'Welcome — business owner' },
  { id: 'welcome_client',            group: 'Welcome',     label: 'Welcome — client' },

  // Reports (owner-facing recaps)
  { id: 'weekly_recap',              group: 'Reports',     label: 'Weekly business recap (Monday digest)' },

  // Admin invites
  { id: 'admin_invite_sponsored',       group: 'Admin invites', label: 'Admin invite — Sponsored' },
  { id: 'admin_invite_beta',            group: 'Admin invites', label: 'Admin invite — Beta' },
  { id: 'admin_invite_business_trial',  group: 'Admin invites', label: 'Admin invite — Business Trial' },
  { id: 'admin_invite_business_active', group: 'Admin invites', label: 'Admin invite — Business Active' },
  { id: 'admin_invite_affiliate',       group: 'Admin invites', label: 'Admin invite — Affiliate' },
  { id: 'admin_deliverability_test',    group: 'Admin invites', label: 'Deliverability test (DKIM/SPF/DMARC)' },

  // Platform funnel (already extracted)
  { id: 'trial_reminder_7d',       group: 'Trial',        label: 'Trial reminder — 7 days left' },
  { id: 'trial_reminder_1d',       group: 'Trial',        label: 'Trial reminder — 1 day left' },
  { id: 'trial_reminder_expired',  group: 'Trial',        label: 'Trial expired (auto-downgrade)' },
  { id: 'subscription_started',    group: 'Billing',      label: 'Subscription confirmed (first paid)' },
  { id: 'subscription_renewal',    group: 'Billing',      label: 'Upcoming renewal' },
  { id: 'subscription_cancelled',  group: 'Billing',      label: 'Subscription cancelled' },
  { id: 'payment_failed',          group: 'Billing',      label: 'Payment failed / dunning' },
  { id: 'winback_offer',           group: 'Win-back',     label: 'Win-back — 30% off offer' },

  // Security
  { id: 'security_new_signin',     group: 'Security',     label: 'Security alert — new sign-in' },
  { id: 'security_password_changed', group: 'Security',   label: 'Security alert — password changed' },
  { id: 'security_two_factor_on',  group: 'Security',     label: 'Security alert — 2FA turned on' },
  { id: 'security_two_factor_off', group: 'Security',     label: 'Security alert — 2FA turned off' },

  // End-customer (white-labeled with workspace branding)
  { id: 'booking_confirmation_client', group: 'End-customer', label: 'Booking confirmation (to client)' },
  { id: 'booking_reminder',            group: 'End-customer', label: 'Booking reminder (to client)' },
  { id: 'booking_cancellation_client', group: 'End-customer', label: 'Booking cancelled (to client)' },
  { id: 'invoice_sent',                group: 'End-customer', label: 'Invoice sent' },
  { id: 'invoice_paid_receipt',        group: 'End-customer', label: 'Invoice paid — receipt' },
  { id: 'invoice_due_soon',            group: 'End-customer', label: 'Invoice due soon (3-day heads-up)' },
  { id: 'invoice_overdue',             group: 'End-customer', label: 'Invoice overdue reminder' },
  { id: 'lead_instant_reply',          group: 'End-customer', label: 'Lead instant auto-reply' },
  { id: 'review_request',              group: 'End-customer', label: 'Review request (post-service)' },
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
      // Mirror the live behavior: when WINBACK_PROMO_CODE is set, the
      // real win-back email shows that exact code. Preview should too,
      // so what the operator sees in their inbox matches production.
      return renderWinbackOffer({
        percentOff: 30, durationMonths: 3,
        promoCode: process.env.WINBACK_PROMO_CODE || 'COMEBACK30-DEMO',
        expiresAt: new Date(Date.now() + 14 * 86400000),
        firstName: SAMPLE.firstName, businessName: SAMPLE.businessName,
      });
    case 'security_new_signin':
      return renderSecurityAlert({ kind: 'new_signin',       firstName: SAMPLE.firstName, device: 'Chrome on macOS',  ip: '203.0.113.42', when: new Date().toUTCString() });
    case 'security_password_changed':
      return renderSecurityAlert({ kind: 'password_changed', firstName: SAMPLE.firstName, device: 'Safari on iOS',    ip: '203.0.113.42', when: new Date().toUTCString() });
    case 'security_two_factor_on':
      return renderSecurityAlert({ kind: 'two_factor', enabled: true,  firstName: SAMPLE.firstName, device: 'Chrome on macOS', ip: '203.0.113.42', when: new Date().toUTCString() });
    case 'security_two_factor_off':
      return renderSecurityAlert({ kind: 'two_factor', enabled: false, firstName: SAMPLE.firstName, device: 'Chrome on macOS', ip: '203.0.113.42', when: new Date().toUTCString() });

    // Auth + account
    case 'verify_email':              return R.renderVerifyEmail({ firstName: SAMPLE.firstName });
    case 'password_reset':            return R.renderPasswordReset({ firstName: SAMPLE.firstName });
    case 'account_deletion_request':  return R.renderAccountDeletionRequest({ firstName: SAMPLE.firstName });
    case 'account_restored':          return R.renderAccountRestored({ firstName: SAMPLE.firstName });
    case 'data_export_ready':         return R.renderDataExportReady({ firstName: SAMPLE.firstName, attached: true, filename: 'ivy-export-2026-06-22.json', sizeMb: '3.2' });
    case 'data_export_too_big':       return R.renderDataExportReady({ firstName: SAMPLE.firstName, attached: false, sizeMb: '24.5' });

    // Welcome (renderer lives in welcome-content.js; both variants
    // return { subject, html } so they slot in directly).
    case 'welcome_owner':             return renderWelcome({ name: SAMPLE.firstName, appUrl: appUrl(), variant: 'owner' });
    case 'welcome_client':            return renderWelcome({ name: SAMPLE.firstName, appUrl: appUrl(), variant: 'client' });

    // Weekly recap (real renderer; preview feeds plausible sample stats).
    case 'weekly_recap':
      return renderWeeklyRecap({
        firstName: SAMPLE.firstName, businessName: SAMPLE.businessName,
        range: { from: new Date(Date.now() - 7 * 86400000), to: new Date() },
        stats: {
          newClients: 3, completedBookings: 8, upcomingBookings: 5,
          revenuePaid: 2140, overdueInvoiceCount: 2, overdueInvoiceTotal: 380,
        },
      });

    // Admin invites
    case 'admin_invite_sponsored':       return R.renderAdminInviteSponsored({ firstName: SAMPLE.firstName, name: SAMPLE.firstName });
    case 'admin_invite_beta':            return R.renderAdminInviteBeta({ firstName: SAMPLE.firstName, name: SAMPLE.firstName });
    case 'admin_invite_business_trial':  return R.renderAdminInviteBusinessTrial({ firstName: SAMPLE.firstName, name: SAMPLE.firstName });
    case 'admin_invite_business_active': return R.renderAdminInviteBusinessActive({ firstName: SAMPLE.firstName, name: SAMPLE.firstName });
    case 'admin_invite_affiliate':       return R.renderAdminInviteAffiliate({ firstName: SAMPLE.firstName, name: SAMPLE.firstName });
    case 'admin_deliverability_test':    return R.renderAdminDeliverabilityTest();

    // End-customer (white-labeled — render with SAMPLE_BRANDING so the
    // owner can see how the per-workspace shell looks in their own inbox).
    case 'booking_confirmation_client':
      return R.renderBookingConfirmationClient({
        clientName: 'Casey Roberts', businessName: R.SAMPLE_BRANDING.businessName,
        serviceName: '60-min consultation',
        dateLabel: 'Tuesday, July 8, 2026', timeLabel: '10:00 AM – 11:00 AM',
        locationAddress: '25389 Madison Ave, Suite C-101, Murrieta CA 92562',
        notes: 'Please bring intake form.',
      });
    case 'booking_reminder':
      return R.renderBookingReminder({
        clientName: 'Casey Roberts', businessName: R.SAMPLE_BRANDING.businessName,
        serviceName: '60-min consultation',
        dateLabel: 'Tomorrow, July 8', timeLabel: '10:00 AM – 11:00 AM',
        locationAddress: '25389 Madison Ave, Suite C-101, Murrieta CA 92562',
        when: 'tomorrow',
      });
    case 'booking_cancellation_client':
      return R.renderBookingCancellationClient({
        clientName: 'Casey Roberts', businessName: R.SAMPLE_BRANDING.businessName,
        serviceName: '60-min consultation', dateLabel: 'Tuesday, July 8, 2026',
      });
    case 'invoice_sent':
      return R.renderInvoiceSent({
        clientName: 'Casey Roberts', businessName: R.SAMPLE_BRANDING.businessName,
        number: 'INV-1042', total: 240, dueDate: new Date(Date.now() + 14 * 86400000),
        items: [
          { description: 'Strategy session (60 min)', quantity: 1, rate: 150 },
          { description: 'Follow-up notes (PDF)',     quantity: 1, rate: 75  },
          { description: 'Tax', quantity: 1, rate: 15 },
        ],
      });
    case 'invoice_paid_receipt':
      return R.renderInvoicePaidReceipt({
        clientName: 'Casey Roberts', businessName: R.SAMPLE_BRANDING.businessName,
        number: 'INV-1042', amount: 240, method: 'card',
      });
    case 'invoice_due_soon':
      return R.renderInvoiceDueSoon({
        clientName: 'Casey Roberts', businessName: R.SAMPLE_BRANDING.businessName,
        number: 'INV-1042', total: 240, dueDate: new Date(Date.now() + 3 * 86400000), daysUntilDue: 3,
      });
    case 'invoice_overdue':
      return R.renderInvoiceOverdue({
        clientName: 'Casey Roberts', businessName: R.SAMPLE_BRANDING.businessName,
        number: 'INV-1042', total: 240, dueDate: new Date(Date.now() - 5 * 86400000), daysOverdue: 5,
      });
    case 'lead_instant_reply':
      return R.renderLeadInstantReply({
        leadName: 'Casey Roberts', businessName: R.SAMPLE_BRANDING.businessName, bookingSlug: 'market-theory',
      });
    case 'review_request':
      return R.renderReviewRequest({
        clientName: 'Casey Roberts', businessName: R.SAMPLE_BRANDING.businessName, serviceName: '60-min consultation',
      });

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
