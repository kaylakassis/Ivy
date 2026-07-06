// First-win milestones. The first booking and the first payment are the
// emotional turning points for a new owner - the moment the app stops being
// "setup" and starts being "this works." We drop a one-time celebratory
// notification into their feed (and push, if subscribed) so the win is
// acknowledged instead of passing silently.
//
// Gated by a COUNT so each milestone fires exactly once; the notification tag
// also dedupes if two events ever race. Best-effort throughout - a milestone
// must never break the booking/payment it's celebrating.
import { sql } from './db.js';
import { notifyOwnerSafe } from './push.js';

export async function celebrateFirstBooking(workspaceId) {
  try {
    if (!workspaceId) return;
    // Exclude cancelled and sample/demo bookings so the milestone fires on the
    // first REAL booking, not on demo data the owner dropped in to look around.
    const { rows } = await sql`
      SELECT COUNT(*)::int AS n
        FROM bookings b
        LEFT JOIN clients c ON c.id = b.client_id
       WHERE b.workspace_id = ${workspaceId}
         AND b.cancelled_at IS NULL
         AND (c.source IS DISTINCT FROM 'demo')
    `;
    if (Number(rows[0]?.n) !== 1) return;
    await notifyOwnerSafe({
      workspaceId, type: 'bookings',
      payload: {
        title: '🎉 Your first booking!',
        body: "Someone just booked you. This is how it starts - nice work.",
        url: '/calendar',
        tag: 'milestone-first-booking',
      },
    });
  } catch { /* never break the booking */ }
}

export async function celebrateFirstPayment(workspaceId) {
  try {
    if (!workspaceId) return;
    const { rows } = await sql`
      SELECT COUNT(*)::int AS n FROM invoices
       WHERE workspace_id = ${workspaceId} AND status = 'paid'
    `;
    if (Number(rows[0]?.n) !== 1) return;
    await notifyOwnerSafe({
      workspaceId, type: 'invoices',
      payload: {
        title: '💰 You got paid!',
        body: 'Your first payment just landed. Onwards.',
        url: '/finance',
        tag: 'milestone-first-payment',
      },
    });
  } catch { /* never break the payment */ }
}

export async function celebrateFirstClient(workspaceId) {
  try {
    if (!workspaceId) return;
    // Excludes the sample/demo client so poking at demo data doesn't burn it.
    const { rows } = await sql`
      SELECT COUNT(*)::int AS n FROM clients
       WHERE workspace_id = ${workspaceId} AND (source IS DISTINCT FROM 'demo')
    `;
    if (Number(rows[0]?.n) !== 1) return;
    await notifyOwnerSafe({
      workspaceId, type: 'support',
      payload: {
        title: '🌱 Your first client!',
        body: "That's the start of your book of business. Nice work.",
        url: '/clients',
        tag: 'milestone-first-client',
      },
    });
  } catch { /* never break client creation */ }
}

export async function celebrateFirstReview(workspaceId) {
  try {
    if (!workspaceId) return;
    const { rows } = await sql`SELECT COUNT(*)::int AS n FROM reviews WHERE workspace_id = ${workspaceId}`;
    if (Number(rows[0]?.n) !== 1) return;
    await notifyOwnerSafe({
      workspaceId, type: 'support',
      payload: {
        title: '⭐ Your first review!',
        body: 'Social proof that wins the next client. It shows on your booking page now.',
        url: '/reviews',
        tag: 'milestone-first-review',
      },
    });
  } catch { /* never break review submit */ }
}

// ── Repeat / mid-journey milestones ──────────────────────────────────────────
// The firsts above are the "this works" moment for a NEW owner. These keep an
// ESTABLISHED owner getting celebratory feed activity past their firsts. Each
// tier's notification tag embeds the threshold (e.g. milestone-bookings-25), so
// tag-coalescing fires it exactly once, ever - no separate fired-log table.
// Count-based tiers use exact-equality (the count increments one at a time at
// the call site, same as the firsts); the revenue tier uses >= because a single
// payment can jump several tiers at once.
const BOOKING_MILESTONES = [10, 25, 50, 100, 250, 500, 1000];
const REVIEW_MILESTONES  = [5, 10, 25, 50, 100];
const MONTH_REVENUE_MILESTONES = [1000, 5000, 10000, 25000, 50000];

// Fired alongside celebrateFirstBooking when a completed (non-demo) booking
// count lands exactly on a tier.
export async function celebrateBookingMilestones(workspaceId) {
  try {
    if (!workspaceId) return;
    const { rows } = await sql`
      SELECT COUNT(*)::int AS n
        FROM bookings b
        LEFT JOIN clients c ON c.id = b.client_id
       WHERE b.workspace_id = ${workspaceId}
         AND b.cancelled_at IS NULL
         AND (c.source IS DISTINCT FROM 'demo')`;
    const n = Number(rows[0]?.n);
    if (!BOOKING_MILESTONES.includes(n)) return;
    await notifyOwnerSafe({
      workspaceId, type: 'bookings',
      payload: {
        title: `🎉 ${n.toLocaleString()} bookings!`,
        body: `That's ${n.toLocaleString()} sessions on the books. The momentum is real.`,
        url: '/calendar',
        tag: `milestone-bookings-${n}`,
      },
    });
  } catch { /* never break the booking */ }
}

export async function celebrateReviewMilestones(workspaceId) {
  try {
    if (!workspaceId) return;
    const { rows } = await sql`SELECT COUNT(*)::int AS n FROM reviews WHERE workspace_id = ${workspaceId}`;
    const n = Number(rows[0]?.n);
    if (!REVIEW_MILESTONES.includes(n)) return;
    await notifyOwnerSafe({
      workspaceId, type: 'support',
      payload: {
        title: `⭐ ${n} reviews!`,
        body: `${n} clients have vouched for you. That's the proof that closes the next booking.`,
        url: '/reviews',
        tag: `milestone-reviews-${n}`,
      },
    });
  } catch { /* never break review submit */ }
}

// Fired after celebrateFirstPayment: the first time ANY calendar month's paid
// revenue reaches a tier. We look at the best month ever (max over months) so a
// mid-month payment that crosses the line fires immediately, and only surface
// the single HIGHEST newly-reached tier so a big jump is one celebration, not
// three. Tag dedup means each tier fires once in the workspace's lifetime.
export async function celebrateRevenueMonthMilestone(workspaceId) {
  try {
    if (!workspaceId) return;
    const { rows } = await sql`
      SELECT COALESCE(MAX(m), 0)::numeric AS best FROM (
        SELECT SUM(total - COALESCE(refunded_amount, 0)) AS m
          FROM invoices
         WHERE workspace_id = ${workspaceId} AND status = 'paid' AND paid_at IS NOT NULL
         GROUP BY date_trunc('month', paid_at)
      ) t`;
    const best = Number(rows[0]?.best || 0);
    const reached = MONTH_REVENUE_MILESTONES.filter((t) => best >= t);
    if (reached.length === 0) return;
    const top = reached[reached.length - 1];
    await notifyOwnerSafe({
      workspaceId, type: 'invoices',
      payload: {
        title: `💰 Your first $${top.toLocaleString()} month!`,
        body: `You crossed $${top.toLocaleString()} collected in a single month. That's a real business.`,
        url: '/finance',
        tag: `milestone-revenue-month-${top}`,
      },
    });
  } catch { /* never break the payment */ }
}
