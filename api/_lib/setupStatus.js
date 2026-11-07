// The owner's "Set up your business" checklist, computed for one
// workspace. Shared by GET /api/me/setup-status (the dashboard checklist)
// and the super-admin user profile (Admin > Users > Manage), so both always
// agree on what "done" means.
//
// Two tiers:
//   REQUIRED - minimum to take a real booking.
//   RECOMMENDED - gets the workspace fully ready for business.
import { sql } from './db.js';

export async function computeSetupStatus({ userId, workspaceId, emailVerifiedAt }) {
  // Per-row try/catch. Any single missing table or column degrades to
  // "not done yet" instead of poisoning the whole Promise.all and
  // bricking the dashboard.
  const safe = async (p, fallback) => { try { return await p; } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[setup-status] sub-query failed:', e.message);
    return fallback;
  } };
  // Sample data (clients.source = 'demo' and everything linked to it) never
  // completes a step: the checklist is about the owner's real business.
  const [cs, sv, fs, ws2, cl, bk, inv, shared, onb] = await Promise.all([
    safe(sql`SELECT biz_name, slug, availability FROM calendar_settings WHERE workspace_id = ${workspaceId}`, { rows: [] }),
    safe(sql`SELECT COUNT(*)::int AS n FROM services WHERE workspace_id = ${workspaceId}`, { rows: [{ n: 0 }] }),
    safe(sql`SELECT stripe_secret_encrypted, stripe_connect_user_id, stripe_onboarding_status FROM finance_settings WHERE workspace_id = ${workspaceId}`, { rows: [] }),
    safe(sql`SELECT launched, published_at FROM websites WHERE workspace_id = ${workspaceId}`, { rows: [] }),
    safe(sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${workspaceId} AND (source IS DISTINCT FROM 'demo')`, { rows: [{ n: 0 }] }),
    // Bookings and invoices only need "is there one" (n is 0 or 1), not a
    // count of the whole history: this runs on every dashboard load. The
    // ORDER BY walks the workspace index so the first real row ends it.
    safe(sql`SELECT COUNT(*)::int AS n FROM (
               SELECT 1 FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
                WHERE b.workspace_id = ${workspaceId} AND b.cancelled_at IS NULL AND (c.source IS DISTINCT FROM 'demo')
                ORDER BY b.date LIMIT 1) x`, { rows: [{ n: 0 }] }),
    safe(sql`SELECT COUNT(*)::int AS n FROM (
               SELECT 1 FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
                WHERE i.workspace_id = ${workspaceId} AND i.status <> 'draft' AND (c.source IS DISTINCT FROM 'demo')
                ORDER BY i.created_at DESC LIMIT 1) x`, { rows: [{ n: 0 }] }),
    safe(sql`SELECT booking_link_shared_at, first_booking_celebrated_at FROM workspaces WHERE id = ${workspaceId}`, { rows: [] }),
    // Wizard steps the owner chose "Skip for now" on.
    safe(sql`SELECT onboarding_state->'skippedSteps' AS skipped FROM users WHERE id = ${userId}`, { rows: [] }),
  ]);
  const settings = cs.rows[0] || {};
  const serviceCount = sv.rows[0]?.n || 0;
  // Either flow counts as connected: legacy Standard secret OR
  // completed Express (Account Links) onboarding.
  const fsRow = fs.rows[0] || {};
  const stripeConnected = !!fsRow.stripe_secret_encrypted
    || (!!fsRow.stripe_connect_user_id && fsRow.stripe_onboarding_status === 'complete');
  const websiteRow = ws2.rows[0] || null;
  const websiteLive = !!websiteRow?.launched && !!websiteRow?.published_at;
  const clientCount = cl.rows[0]?.n || 0;
  const bookingCount = bk.rows[0]?.n || 0;
  const invoiceCount = inv.rows[0]?.n || 0;
  // Sticky: once the link was shared or a real booking landed, the step
  // stays done even if that booking is later cancelled.
  const linkShared = !!shared.rows[0]?.booking_link_shared_at;
  const firstBookingLanded = !!shared.rows[0]?.first_booking_celebrated_at;
  const availability = settings.availability || {};
  const hasAvailabilityWindow = Object.values(availability).some(
    (v) => Array.isArray(v) && v.length > 0,
  );
  // Skipping the Hours step leaves the standard weekday hours every new
  // business starts with, so the booking page still has slots. That isn't
  // the owner's real schedule, so the item stays open until they save
  // their hours (PATCH /calendar with availability clears the skip).
  const skippedSteps = Array.isArray(onb.rows[0]?.skipped) ? onb.rows[0].skipped : [];
  const availabilitySkipped = skippedSteps.includes('availability');

  const items = [
    // ── Required: minimum to take a real booking ──
    {
      id: 'verifyEmail',
      label: 'Verify your email',
      done: !!emailVerifiedAt,
      required: true,
      href: '/account',
      why: 'We use it for password resets and to send booking notifications. Without it, those go nowhere.',
    },
    {
      id: 'bizName',
      label: 'Name your business',
      done: !!(settings.biz_name && settings.biz_name.trim()),
      required: true,
      href: '/calendar',
      why: 'Shows on your booking page, invoices, and client emails.',
    },
    {
      id: 'slug',
      label: 'Pick your booking link',
      done: !!(settings.slug && settings.slug.trim()),
      required: true,
      href: '/calendar',
      why: '/book/<your-slug> - the link you share with clients.',
    },
    {
      id: 'service',
      label: 'Add at least one service',
      done: serviceCount > 0,
      required: true,
      // Services are managed under Finance (?section= deep-link) - on
      // mobile the Calendar page has no add-service affordance, so
      // linking there stranded owners on their very next setup step.
      href: '/finance?section=services',
      why: 'Clients book a service, not a generic "appointment". Add what you offer.',
    },
    {
      id: 'availability',
      label: 'Set your weekly availability',
      done: hasAvailabilityWindow && !availabilitySkipped,
      required: true,
      href: '/calendar?availability=1',
      why: hasAvailabilityWindow && availabilitySkipped
        ? 'Your booking page is using standard weekday hours for now. Set the days and times you really work.'
        : 'Without availability windows, your booking page shows zero open slots.',
    },

    // ── Recommended: ready for real business ──
    {
      id: 'stripe',
      label: 'Connect Stripe',
      done: stripeConnected,
      required: false,
      href: '/finance',
      why: "Take card payments + deposits without chasing checks. Works with your Stripe account - or we'll help you create one in a few minutes.",
    },
    {
      id: 'website',
      label: 'Publish your website',
      done: websiteLive,
      required: false,
      href: '/website',
      why: 'A polished, hosted site you can spin up in minutes - services, pricing, contact, all linked to your booking flow.',
    },
    {
      id: 'firstClient',
      label: 'Add your first client',
      done: clientCount > 0,
      required: false,
      href: '/clients?add=1',
      why: 'Either import from a CSV or add a few you already work with - you choose whether to send portal invites.',
    },
    {
      id: 'firstBooking',
      label: 'Share your booking link',
      done: bookingCount > 0 || linkShared || firstBookingLanded,
      required: false,
      href: '/calendar',
      why: 'Copy it into your bio or a text. Once a client books, you\'re in business.',
    },
    {
      id: 'firstInvoice',
      label: 'Send your first invoice',
      done: invoiceCount > 0,
      required: false,
      href: '/finance?section=invoices',
      why: 'Build one in Finance and send it; Ivy can draft it for you. The first one you get paid on is the whole point.',
    },
  ];

  const requiredItems = items.filter((i) => i.required);
  const complete = requiredItems.every((i) => i.done);
  const fullyComplete = items.every((i) => i.done);

  return { complete, fullyComplete, items };
}
