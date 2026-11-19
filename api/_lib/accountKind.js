// Business account or client account.
//
// A business account owns a workspace; a client account owns nothing and
// lives in the client portal. The difference used to be only "does a
// workspace row exist", and any owner endpoint quietly created one for
// whoever asked (ensureWorkspace). So a client whose email was not yet
// confirmed, or whose business had not added them yet, opened the app,
// landed in the business shell, and the first request turned them into a
// business with onboarding and a paywall.
//
// Now the account remembers what it signed up as (users.signup_role):
//   - a client account is never given a workspace by accident
//     (ClientOnlyError, the same shape as the helper guard), and
//   - it reports isClient, so every app build, old or new, sends it to the
//     client portal.
// Starting a business from a client account is one explicit action
// (api/helper/start-business.js). Going the other way, for someone who
// picked "business" by mistake, is convertToClientAccount below: allowed
// only for a business that never had a plan and holds no real data.
import { sql } from './db.js';

export class ClientOnlyError extends Error {
  constructor() {
    super('This is a client account. It does not have a business.');
    this.code = 'client-only';
    this.status = 403;
  }
}

export const isClientSignup = (user) => user?.signup_role === 'client';

// For callers that only have an id (ensureWorkspace).
export async function signupRoleOf(userId) {
  const { rows } = await sql`SELECT signup_role FROM users WHERE id = ${userId}`;
  return rows[0]?.signup_role || null;
}

// ---- what a business holds -------------------------------------------------
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

// Records every new business gets automatically (settings rows). Having
// only these means nobody has used that business.
export const SETUP_ONLY = new Set([
  'calendar_settings', 'workspace_profile', 'finance_settings', 'websites',
  'notification_preferences', 'workspace_settings', 'branding', 'admin_analytics_cache',
]);

export async function workspaceTables() {
  const { rows } = await sql`
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
       AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name`;
  return rows.map((r) => r.table_name).filter((n) => IDENT_RE.test(n));
}

export async function countsFor(workspaceId, tables) {
  if (!tables.length) return {};
  // One query: a COUNT per table. Table names come from the catalog and are
  // checked against IDENT_RE; the workspace id is a bound parameter.
  const parts = tables.map((t) => `SELECT '${t}' AS t, COUNT(*)::int AS n FROM "${t}" WHERE workspace_id = $1`);
  const { rows } = await sql.query(parts.join(' UNION ALL '), [workspaceId]);
  const out = {};
  for (const r of rows) if (r.n > 0) out[r.t] = r.n;
  return out;
}

export const dataRowsOf = (counts) => Object.entries(counts)
  .filter(([t]) => !SETUP_ONLY.has(t))
  .reduce((s, [, n]) => s + n, 0);

export function hasLivePlan(w) {
  const now = Date.now();
  const future = (d) => d && new Date(d).getTime() > now;
  if (w.subscription_status === 'active' && (w.stripe_subscription_id || w.subscription_source === 'apple')) return true;
  if (w.subscription_status === 'trialing' && future(w.trial_ends_at) && (w.stripe_subscription_id || w.subscription_source === 'apple')) return true;
  if (w.subscription_status === 'past_due') return true;
  return false;
}

// Has this business ever had a plan, a trial, or free access? Stricter than
// hasLivePlan: anything that shows a payment relationship ever existed.
function everHadPlan(w) {
  if (hasLivePlan(w)) return true;
  if (w.subscription_status && w.subscription_status !== 'incomplete') return true;
  if (w.stripe_subscription_id || w.subscription_source === 'apple') return true;
  if (w.trial_ends_at || w.comp_until || w.subscription_period_end) return true;
  return false;
}

export const SWITCH_REFUSALS = {
  'no-business': 'This account does not have a business.',
  'several': 'This account has more than one business. Contact support and we will sort it out.',
  'plan': 'This business has or had a plan or trial, so it cannot be switched here. Contact support and we will help.',
  'comped': 'This account has free access set up by Ivy, so it cannot be switched here. Contact support and we will help.',
  'data': 'This business already has clients, bookings or other records, so it cannot be switched here. Contact support and we will help.',
};

// Can this person's business be removed so the account becomes a client
// account? → { ok: true, workspaceId, dataRows } or { ok: false, reason, message }.
// `allowData` (super-admin only, after seeing the counts) skips the
// no-records rule; nothing skips the plan rule.
export async function clientSwitchCheck(userId, { allowData = false } = {}) {
  const u = (await sql`SELECT id, user_type FROM users WHERE id = ${userId}`).rows[0];
  const refuse = (reason) => ({ ok: false, reason, message: SWITCH_REFUSALS[reason] });
  if (!u) return refuse('no-business');
  const { rows } = await sql`SELECT * FROM workspaces WHERE owner_id = ${userId} ORDER BY created_at ASC, id ASC`;
  if (rows.length === 0) return refuse('no-business');
  if (rows.length > 1) return refuse('several');
  const w = rows[0];
  if (u.user_type && u.user_type !== 'regular') return refuse('comped');
  if (everHadPlan(w)) return refuse('plan');
  const counts = await countsFor(w.id, await workspaceTables());
  const dataRows = dataRowsOf(counts);
  if (dataRows > 0 && !allowData) return { ...refuse('data'), dataRows, counts };
  return { ok: true, workspaceId: w.id, dataRows, counts, onboardedAt: w.onboarded_at || null };
}

// Remove the unused business and mark the account as a client account.
// Callers bust their caches and write the audit row.
export async function convertToClientAccount(userId, opts = {}) {
  const check = await clientSwitchCheck(userId, opts);
  if (!check.ok) return check;
  const del = await sql`DELETE FROM workspaces WHERE id = ${check.workspaceId} AND owner_id = ${userId} RETURNING id`;
  if (!del.rows.length) return { ok: false, reason: 'no-business', message: SWITCH_REFUSALS['no-business'] };
  await sql`UPDATE users SET signup_role = 'client' WHERE id = ${userId}`;
  return check;
}
