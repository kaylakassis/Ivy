// Programs: shared helpers for the owner API, the client portal and checkout.
import { sql } from './db.js';
import { myClientIds, ids } from './clientPortal.js';
import { mapSubStatus } from './memberships.js';
import { notifyClientSubscriptionPastDue } from './clientSubscriptionNotify.js';
import { notifyPurchaseRefunded, clientContact } from './purchaseRefundNotify.js';
import { notifyOwnerSafe } from './push.js';

export const BILLING = new Set(['one_time', 'month', 'year']);

// Ids arrive from the URL; anything that is not a UUID would make Postgres
// throw (a 500) instead of the 404 the caller should see.
export const isUuid = (s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(s || ''));
export const ITEM_TYPES = new Set(['pdf', 'post', 'video']);
export const POST_KINDS = new Set(['post', 'win', 'question']);

export function serializeProgram(r, extra = {}) {
  return {
    id: r.id, title: r.title, description: r.description || '', coverUrl: r.cover_url || null,
    priceCents: Number(r.price_cents) || 0, billing: r.billing, accessDays: r.access_days == null ? null : Number(r.access_days), communityEnabled: !!r.community_enabled,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, ...extra,
  };
}
export function serializeItem(r) {
  return {
    id: r.id, type: r.type, title: r.title, body: r.body || '', fileUrl: r.file_url || null,
    fileName: r.file_name || null, youtubeId: r.youtube_id || null, position: r.position,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export function serializeEnrollment(r) {
  return {
    id: r.id, programId: r.program_id, clientId: r.client_id, clientName: r.client_name || null,
    clientEmail: r.client_email || null, source: r.source, status: r.status, billing: r.billing,
    priceCents: Number(r.price_cents) || 0, currentPeriodEnd: r.current_period_end, expiresAt: r.expires_at || null, grantedAt: r.granted_at,
    cancelledAt: r.cancelled_at, stripeSubscriptionId: r.stripe_subscription_id || null,
    cancelAtPeriodEnd: !!r.cancel_at_period_end,
    // Refunds: cumulative cents sent back so far, and whether the purchase
    // can be refunded from Ivy at all (a one-time purchase that was paid
    // online; subscriptions and manual grants cannot).
    refundedCents: Number(r.refunded_cents || 0),
    refundable: r.source === 'purchase' && r.billing === 'one_time' && !!r.stripe_payment_intent && !r.stripe_subscription_id
      && Number(r.refunded_cents || 0) < Number(r.price_cents || 0),
  };
}
export function serializePost(r) {
  return {
    id: r.id, parentId: r.parent_id || null, kind: r.kind, body: r.body, authorName: r.author_name,
    isOwner: !!r.is_owner, mine: !!r.mine, createdAt: r.created_at,
  };
}

// Accepts a full YouTube URL (watch, youtu.be, shorts, embed) or a bare id.
export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(u.hostname)) return null;
    if (u.hostname === 'youtu.be') return /^[A-Za-z0-9_-]{11}$/.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null;
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/\/(embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
    return m ? m[2] : null;
  } catch { return null; }
}

export function cleanProgramInput(body, partial = false) {
  const out = {}; const errors = [];
  if (!partial || body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title) errors.push('Give the program a title.');
    if (title.length > 140) errors.push('Title is too long (140 characters max).');
    out.title = title;
  }
  if (!partial || body.description !== undefined) out.description = String(body.description || '').trim().slice(0, 5000);
  if (!partial || body.coverUrl !== undefined) out.cover_url = body.coverUrl ? String(body.coverUrl).slice(0, 1000) : null;
  if (!partial || body.priceCents !== undefined) {
    const cents = Math.round(Number(body.priceCents));
    if (!Number.isFinite(cents) || cents < 0 || cents > 100_000_00) errors.push('Price must be between 0 and 100,000.');
    out.price_cents = cents;
  }
  if (!partial || body.billing !== undefined) {
    const b = String(body.billing || 'one_time');
    if (!BILLING.has(b)) errors.push('Billing must be one-time, monthly or yearly.');
    out.billing = b;
  }
  if (!partial || body.communityEnabled !== undefined) out.community_enabled = body.communityEnabled !== false;
  if (!partial || body.accessDays !== undefined) {
    const d = body.accessDays == null || body.accessDays === '' ? null : Math.round(Number(body.accessDays));
    if (d != null && (!Number.isFinite(d) || d < 1 || d > 3650)) errors.push('Access length must be between 1 and 3650 days, or blank for forever.');
    out.access_days = d;
  }
  if (partial && body.status !== undefined) {
    const st = String(body.status);
    if (!['draft', 'published'].includes(st)) errors.push('Status must be draft or published.');
    out.status = st;
  }
  return { ok: errors.length === 0, errors, value: out };
}

// Who is this user to this program? 'owner' (the workspace owner),
// 'member' (a client with an active enrollment) or null.
export async function programAccess(user, programId, ownerWorkspaceId = null) {
  const p = (await sql`SELECT * FROM programs WHERE id = ${programId}`).rows[0];
  if (!p) return { role: null, program: null };
  if (ownerWorkspaceId && p.workspace_id === ownerWorkspaceId) return { role: 'owner', program: p, clientId: null };
  const mine = await myClientIds(user);
  const myIds = ids(mine);
  if (myIds.length) {
    const e = (await sql.query(
      `SELECT client_id FROM program_enrollments
        WHERE program_id = $1 AND client_id = ANY($2) AND status IN ('active','past_due') AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
      [programId, myIds],
    )).rows[0];
    if (e) return { role: 'member', program: p, clientId: e.client_id };
  }
  return { role: null, program: p, clientId: null };
}

export async function activeMemberCount(programId) {
  const r = await sql`SELECT COUNT(*)::int AS n FROM program_enrollments WHERE program_id = ${programId} AND status IN ('active','past_due')`;
  return r.rows[0]?.n || 0;
}

// Grants or refreshes access for a client. Idempotent on the Stripe ids.
// Returns { id, previousStatus } (previousStatus null on a fresh insert).
export async function grantEnrollment({ programId, workspaceId, clientId, source, billing, priceCents, stripeSubscriptionId = null, stripeSessionId = null, stripePaymentIntent = null, status = 'active', currentPeriodEnd = null, expiresAt = null, cancelAtPeriodEnd = false }) {
  const existing = await sql`
    SELECT id, status FROM program_enrollments
     WHERE program_id = ${programId} AND client_id = ${clientId}
       AND (${stripeSubscriptionId}::text IS NULL OR stripe_subscription_id = ${stripeSubscriptionId} OR stripe_subscription_id IS NULL)
     ORDER BY granted_at DESC LIMIT 1`;
  if (existing.rows[0]) {
    await sql`
      UPDATE program_enrollments SET status = ${status}, source = ${source}, billing = ${billing}, price_cents = ${priceCents},
        stripe_subscription_id = COALESCE(${stripeSubscriptionId}, stripe_subscription_id),
        stripe_session_id = COALESCE(${stripeSessionId}, stripe_session_id),
        stripe_payment_intent = COALESCE(${stripePaymentIntent}, stripe_payment_intent),
        cancel_at_period_end = ${!!cancelAtPeriodEnd},
        refunded_cents = 0,
        current_period_end = ${currentPeriodEnd}, expires_at = ${expiresAt}, cancelled_at = CASE WHEN ${status} = 'cancelled' THEN NOW() ELSE NULL END, updated_at = NOW()
       WHERE id = ${existing.rows[0].id}`;
    return { id: existing.rows[0].id, previousStatus: existing.rows[0].status };
  }
  const ins = await sql`
    INSERT INTO program_enrollments (program_id, workspace_id, client_id, source, billing, price_cents, stripe_subscription_id, stripe_session_id, stripe_payment_intent, status, current_period_end, expires_at, cancel_at_period_end, cancelled_at)
    VALUES (${programId}, ${workspaceId}, ${clientId}, ${source}, ${billing}, ${priceCents}, ${stripeSubscriptionId}, ${stripeSessionId}, ${stripePaymentIntent}, ${status}, ${currentPeriodEnd}, ${expiresAt}, ${!!cancelAtPeriodEnd}, CASE WHEN ${status} = 'cancelled' THEN NOW() ELSE NULL END)
    ON CONFLICT DO NOTHING RETURNING id`;
  return { id: ins.rows[0]?.id || null, previousStatus: null };
}

// Webhook: a connected-account subscription with metadata.purpose='program'.
// Mirrors the Stripe state (same status mapping as memberships: paused and
// unpaid are past_due, anything unknown is not entitled) including
// cancel_at_period_end, so the portal can say "Access until <date>". A
// transition into past_due tells the owner and the client once.
export async function applyProgramSubscription({ workspaceId, sub }) {
  const md = sub?.metadata || {};
  if (md.purpose !== 'program' || !md.program_id || !md.client_id) return 'ignored';
  if (md.workspace_id && md.workspace_id !== workspaceId) return 'mismatch';
  const p = (await sql`SELECT id, title, billing, price_cents FROM programs WHERE id = ${md.program_id} AND workspace_id = ${workspaceId}`).rows[0];
  const c = (await sql`SELECT id FROM clients WHERE id = ${md.client_id} AND workspace_id = ${workspaceId}`).rows[0];
  if (!p || !c) return 'missing';
  const mapped = mapSubStatus(sub.status);
  const status = mapped === 'incomplete' ? 'cancelled' : mapped;
  const cpe = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
  const r = await grantEnrollment({
    programId: p.id, workspaceId, clientId: c.id, source: 'subscription', billing: p.billing, priceCents: p.price_cents,
    stripeSubscriptionId: sub.id, status, currentPeriodEnd: cpe, cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  });
  if (status === 'past_due' && r.previousStatus !== 'past_due') {
    notifyClientSubscriptionPastDue({ workspaceId, clientId: c.id, kind: 'program', label: p.title }).catch(() => {});
  }
  return 'applied';
}

// Refund of a one-time program purchase: from the payment dashboard
// (charge.refunded) or from Ivy's Refund button (purchaseRefunds.js hands
// in a synthetic charge with the new cumulative amount). A full refund
// closes the enrollment; a partial refund leaves access alone. The charge
// is matched by the PaymentIntent stamped at grant time, falling back to
// the metadata the provider copies from payment_intent_data onto the charge.
//
// charge.amount_refunded is CUMULATIVE, recorded on refunded_cents with a
// guarded UPDATE, so a re-delivery, the provider's echo of an in-app
// refund, or two racing requests apply once; only a genuinely new delta
// tells the owner and emails the client.
// Returns 'revoked' | 'partial' | 'not-found' | 'already-cancelled' | 'already-recorded'.
export async function revokeProgramPurchaseForRefund({ workspaceId, charge }) {
  const pi = typeof charge?.payment_intent === 'string' ? charge.payment_intent : charge?.payment_intent?.id || null;
  const md = charge?.metadata || {};
  let e = null;
  if (pi) {
    e = (await sql`
      SELECT e.id, e.status, e.client_id, e.price_cents, e.refunded_cents, p.title
        FROM program_enrollments e JOIN programs p ON p.id = e.program_id
       WHERE e.workspace_id = ${workspaceId} AND e.stripe_payment_intent = ${pi} LIMIT 1`).rows[0] || null;
  }
  if (!e && md.purpose === 'program' && md.program_id && md.client_id) {
    e = (await sql`
      SELECT e.id, e.status, e.client_id, e.price_cents, e.refunded_cents, p.title
        FROM program_enrollments e JOIN programs p ON p.id = e.program_id
       WHERE e.workspace_id = ${workspaceId} AND e.program_id = ${md.program_id} AND e.client_id = ${md.client_id}
         AND e.source = 'purchase' ORDER BY e.granted_at DESC LIMIT 1`).rows[0] || null;
  }
  if (!e) return 'not-found';
  const chargedCents = Math.max(0, Math.round(Number(charge.amount || 0)));
  const refundedCents = Math.max(0, Math.round(Number(charge.amount_refunded || 0)));
  const fully = chargedCents > 0 && refundedCents >= chargedCents;
  if (fully && e.status === 'cancelled') return 'already-cancelled';
  const already = Number(e.refunded_cents || 0);
  if (refundedCents <= already) return 'already-recorded';
  const upd = await sql`
    UPDATE program_enrollments SET
      refunded_cents = ${refundedCents},
      status         = CASE WHEN ${fully} THEN 'cancelled' ELSE status END,
      cancelled_at   = CASE WHEN ${fully} THEN NOW() ELSE cancelled_at END,
      updated_at     = NOW()
     WHERE id = ${e.id} AND workspace_id = ${workspaceId} AND refunded_cents = ${already}
     RETURNING id`;
  if (upd.rows.length === 0) return 'already-recorded';
  const delta = refundedCents - already;
  const basis = chargedCents || Number(e.price_cents || 0);
  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: fully ? 'Program purchase refunded' : 'Program purchase partly refunded',
      body: `${e.title}: $${(delta / 100).toFixed(2)} refunded${fully ? '; the client\'s access has ended.' : '; the client keeps access.'}`,
      url: '/programs', tag: `program-refund-${e.id}`,
    },
  });
  const buyer = await clientContact({ workspaceId, clientId: e.client_id }).catch(() => null);
  if (buyer?.email) {
    await notifyPurchaseRefunded({
      workspaceId, kind: 'program', label: e.title, amountCents: delta,
      remainingCents: Math.max(0, basis - refundedCents), fully,
      clientId: buyer.id, to: buyer.email, name: buyer.name,
    });
  }
  return fully ? 'revoked' : 'partial';
}

// One-time access window → expiry timestamp (null = forever).
export function expiryFor(program, from = new Date()) {
  if (!program?.access_days || program.billing !== 'one_time') return null;
  return new Date(from.getTime() + Number(program.access_days) * 86400_000).toISOString();
}

// Nightly sweep: one-time access that has run out. Subscriptions are
// closed by the Stripe webhook, so only expires_at is handled here.
export async function expireProgramAccess() {
  const r = await sql`
    UPDATE program_enrollments SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
     WHERE status IN ('active','past_due') AND expires_at IS NOT NULL AND expires_at <= NOW()
     RETURNING id`;
  return r.rows.length;
}
