// GET /api/me/setup-status — returns the owner's onboarding completion
// state. Drives the "Set up your business" checklist on /dashboard,
// which hides itself once every required step is done.
//
// Items reported:
//   verifyEmail   (required) — users.email_verified_at IS NOT NULL
//   bizName       (required) — calendar_settings.biz_name
//   slug          (required) — calendar_settings.slug
//   service       (required) — at least one row in services for this ws
//   availability  (required) — at least one weekday window
//   stripe        (optional) — finance_settings.stripe_secret_encrypted
//   tagline       (optional) — calendar_settings.tagline
//
// Response shape:
//   {
//     complete: boolean,
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
      return ok(res, { complete: true, items: [] });
    }
    const workspaceId = ws.rows[0].id;

    const [cs, sv, fs] = await Promise.all([
      sql`SELECT biz_name, slug, availability, tagline
            FROM calendar_settings WHERE workspace_id = ${workspaceId}`,
      sql`SELECT COUNT(*)::int AS n FROM services WHERE workspace_id = ${workspaceId}`,
      sql`SELECT stripe_secret_encrypted FROM finance_settings WHERE workspace_id = ${workspaceId}`,
    ]);
    const settings = cs.rows[0] || {};
    const serviceCount = sv.rows[0]?.n || 0;
    const stripeConnected = !!fs.rows[0]?.stripe_secret_encrypted;
    const availability = settings.availability || {};
    const hasAvailabilityWindow = Object.values(availability).some(
      (v) => Array.isArray(v) && v.length > 0,
    );

    const items = [
      {
        id: 'verifyEmail',
        label: 'Verify your email',
        done: !!user.email_verified_at,
        required: true,
        href: '/account',
        why: "We use it for password resets and to send booking notifications. Without it, those go nowhere.",
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
        why: 'thryve-pink.vercel.app/book/<your-slug> — the link you share with clients.',
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
      {
        id: 'stripe',
        label: 'Connect Stripe (optional)',
        done: stripeConnected,
        required: false,
        href: '/finance',
        why: "Needed to accept card payments and deposits. You can skip and collect manually if you prefer.",
      },
      {
        id: 'tagline',
        label: 'Add a tagline (optional)',
        done: !!(settings.tagline && settings.tagline.trim()),
        required: false,
        href: '/calendar',
        why: 'One short line above your services on the booking page — what you do, who for.',
      },
    ];

    const requiredItems = items.filter((i) => i.required);
    const complete = requiredItems.every((i) => i.done);

    return ok(res, { complete, items });
  } catch (err) {
    return serverError(res, err);
  }
}
