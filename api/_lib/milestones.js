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
