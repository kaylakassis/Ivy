// GET /api/me/setup-status — returns the owner's onboarding completion
// state. Drives the "Set up your business" checklist on /dashboard.
//
// Two tiers:
//   REQUIRED — minimum to take a real booking. Checklist won't dismiss
//              the "you still have setup to do" framing while any of
//              these are open.
//   RECOMMENDED — gets the workspace fully ready for business: Stripe
//              for card payments, a website for marketing, a real
//              client to actually use the system, a tagline. Counted
//              separately so the checklist can show real progress
//              after required is done without nagging.
//
// Response:
//   {
//     complete: boolean,                 // every required item is done
//     fullyComplete: boolean,            // every item (required + rec) is done
//     items: [
//       { id, label, done, required, href, why }
//     ]
//   }
//
// Returns an empty list for client-only users (the checklist is purely
// owner-side onboarding).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const ws = await sql`SELECT id FROM workspaces WHERE owner_id = ${user.id} LIMIT 1`;
    if (ws.rows.length === 0) {
      // Not an owner — checklist doesn't apply.
      return ok(res, { complete: true, fullyComplete: true, items: [] });
    }
    const workspaceId = ws.rows[0].id;

    // One round-trip per row, parallelized. Keeps the dashboard load fast
    // even when the user has thousands of clients/bookings.
    const [cs, sv, fs, ws2, cl, bk] = await Promise.all([
      sql`SELECT biz_name, slug, availability, tagline
            FROM calendar_settings WHERE workspace_id = ${workspaceId}`,
      sql`SELECT COUNT(*)::int AS n FROM services WHERE workspace_id = ${workspaceId}`,
      sql`SELECT stripe_secret_encrypted, stripe_connect_user_id, stripe_onboarding_status
            FROM finance_settings WHERE workspace_id = ${workspaceId}`,
      sql`SELECT launched, published_at FROM websites WHERE workspace_id = ${workspaceId}`,
      sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${workspaceId}`,
      sql`SELECT COUNT(*)::int AS n FROM bookings WHERE workspace_id = ${workspaceId} AND cancelled_at IS NULL`,
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
    const availability = settings.availability || {};
    const hasAvailabilityWindow = Object.values(availability).some(
      (v) => Array.isArray(v) && v.length > 0,
    );

    const items = [
      // ── Required: minimum to take a real booking ──
      {
        id: 'verifyEmail',
        label: 'Verify your email',
        done: !!user.email_verified_at,
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
        why: '/book/<your-slug> — the link you share with clients.',
      },
      {
        id: 'service',
        label: 'Add at least one service',
        done: serviceCount > 0,
        required: true,
        href: '/calendar',
        why: 'Clients book a service, not a generic "appointment". Add what you offer.',
      },
      {
        id: 'availability',
        label: 'Set your weekly availability',
        done: hasAvailabilityWindow,
        required: true,
        href: '/calendar',
        why: 'Without availability windows, your booking page shows zero open slots.',
      },

      // ── Recommended: ready for real business ──
      {
        id: 'stripe',
        label: 'Connect Stripe',
        done: stripeConnected,
        required: false,
        href: '/finance',
        why: 'Take card payments + deposits without chasing checks. Connects your existing Stripe account.',
      },
      {
        id: 'website',
        label: 'Publish your website',
        done: websiteLive,
        required: false,
        href: '/website',
        why: 'A polished, hosted site you can spin up in minutes — services, pricing, contact, all linked to your booking flow.',
      },
      {
        id: 'firstClient',
        label: 'Add your first client',
        done: clientCount > 0,
        required: false,
        href: '/clients?add=1',
        why: 'Either import from a CSV or add a few you already work with — they get a "claim your portal" invite automatically.',
      },
      {
        id: 'firstBooking',
        label: 'Take your first booking',
        done: bookingCount > 0,
        required: false,
        href: '/calendar',
        why: 'Add one yourself or share your booking link. Once a real booking lands, you\'re in business.',
      },
      {
        id: 'tagline',
        label: 'Write a tagline',
        done: !!(settings.tagline && settings.tagline.trim()),
        required: false,
        href: '/calendar',
        why: 'One short line above your services on the booking page — what you do, who for.',
      },
    ];

    const requiredItems = items.filter((i) => i.required);
    const complete = requiredItems.every((i) => i.done);
    const fullyComplete = items.every((i) => i.done);

    return ok(res, { complete, fullyComplete, items });
  } catch (err) {
    return serverError(res, err);
  }
}
