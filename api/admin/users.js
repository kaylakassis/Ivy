// GET  /api/admin/users?q=&type=&page=
//   Lists every user with classification, role (owner/client-only/both),
//   subscription state, and signup time. Search by email/name. Paginated.
//
// POST /api/admin/users  { email, name?, password?, userType, sendInvite? }
//   Creates a user from the admin side. If `userType` is 'sponsored', also
//   ensures a workspace + flips that workspace into a synthetic 'active'
//   subscription so the paywall stays out of their way. If 'business-trial'
//   or 'business-active', sets the workspace's subscription_status to match
//   ('trialing' / 'active' respectively); both still need user_type='regular'
//   under the hood (they're billing states, not user types). If 'affiliate',
//   also creates an affiliates row with the supplied or generated code.
//   Sends a welcome email with a sign-in link by default.
//
// Body shape for POST is documented inline below.
import { randomBytes } from 'node:crypto';
import { sql } from '../_lib/db.js';
import { hashPassword, validEmail } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { TRIAL_DAYS } from '../_lib/billing.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { createToken, KIND_RESET, KIND_VERIFY, appUrl } from '../_lib/tokens.js';
import { recordAudit } from '../_lib/audit.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { isWorkspaceActive } from '../_lib/clientPortal.js';
import { claimSignupPerks } from '../_lib/signupPerks.js';
import { missingCountSql } from '../_lib/onboardingAnswers.js';

const PAGE_SIZE = 50;

// Fixed ORDER BY choices only; the request picks a key, never SQL text.
// "_asc" variants put "Never" first, which is how you find people who
// never came back.
const SORTS = {
  '':                'u.created_at DESC',
  joined_asc:        'u.created_at ASC',
  revenue:           'COALESCE(wr.total, 0) DESC, u.created_at DESC',
  last_login:        'u.last_login_at DESC NULLS LAST, u.created_at DESC',
  last_login_asc:    'u.last_login_at ASC NULLS FIRST, u.created_at DESC',
  last_active:       'GREATEST(u.last_active_at, u.last_login_at) DESC NULLS LAST, u.created_at DESC',
  last_active_asc:   'GREATEST(u.last_active_at, u.last_login_at) ASC NULLS FIRST, u.created_at DESC',
};
// Internally we surface 'business-trial' / 'business-active' as creation
// shortcuts even though they're not stored on users.user_type. They
// translate into the workspace's subscription_status. 'beta' IS a real
// user_type (like 'sponsored') and bypasses the paywall via
// workspaceGate + clientPortal.
const CREATE_TYPES = new Set(['regular', 'sponsored', 'beta', 'affiliate', 'business-trial', 'business-active']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    if (req.method === 'GET') return listUsers(req, res);
    if (req.method === 'POST') return createUser(req, res);
    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

async function listUsers(req, res) {
  const q       = (req.query.q || '').toString().trim().toLowerCase();
  const filter  = (req.query.type || '').toString().trim();
  const page    = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const offset  = (page - 1) * PAGE_SIZE;

  // SQL with optional WHERE clauses. We hand-build the params array so
  // we can keep the indexed search efficient even on large tables.
  const where = ['u.deleted_at IS NULL'];
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    where.push(`(LOWER(u.email) LIKE $${params.length} OR LOWER(COALESCE(u.name, '')) LIKE $${params.length})`);
  }
  if (filter === 'sponsored' || filter === 'beta' || filter === 'affiliate' || filter === 'regular') {
    params.push(filter);
    where.push(`u.user_type = $${params.length}`);
  } else if (filter === 'business-active') {
    where.push(`EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id AND w.subscription_status = 'active')`);
  } else if (filter === 'business-trial') {
    where.push(`EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id AND w.subscription_status = 'trialing' AND w.trial_ends_at > NOW())`);
  } else if (filter === 'client-only') {
    where.push(`NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)`);
    where.push(`EXISTS    (SELECT 1 FROM clients c WHERE c.user_id = u.id)`);
  } else if (filter === 'testers') {
    // Everyone analytics leave out: beta, sponsored, super admins, comped,
    // and accounts flagged as test accounts (the admin_real_users view).
    where.push(`NOT EXISTS (SELECT 1 FROM admin_real_users ru WHERE ru.id = u.id)`);
  } else if (filter === 'real') {
    where.push(`EXISTS (SELECT 1 FROM admin_real_users ru WHERE ru.id = u.id)`);
  } else if (filter === 'helper') {
    where.push(`EXISTS (SELECT 1 FROM staff_members sm WHERE sm.user_id = u.id)`);
  } else if (filter === 'missing-answers') {
    // Owners whose business (the oldest one, the one the app uses) is
    // missing at least one required onboarding answer. Non-owners drop
    // out because the subquery is NULL for them.
    where.push(`(SELECT ${missingCountSql('wpf')}
                   FROM workspaces wf
                   LEFT JOIN workspace_profile wpf ON wpf.workspace_id = wf.id
                  WHERE wf.owner_id = u.id
                  ORDER BY wf.created_at ASC, wf.id ASC
                  LIMIT 1) > 0`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortKey = String(req.query.sort || '');
  const sortSql = Object.prototype.hasOwnProperty.call(SORTS, sortKey) ? SORTS[sortKey] : SORTS[''];

  params.push(PAGE_SIZE, offset);
  const queryText = `
    SELECT
      u.id, u.email, u.name, u.user_type,
      u.created_at, u.email_verified_at, u.last_login_at,
      GREATEST(u.last_active_at, u.last_login_at) AS last_active_at,
      w.id   AS workspace_id,
      w.subscription_status,
      w.trial_ends_at,
      w.subscription_period_end,
      w.comp_until,
      w.data_deletion_at,
      w.data_purged_at,
      COALESCE(w.workspace_count, 0)::int AS workspace_count,
      EXISTS (SELECT 1 FROM clients c WHERE c.user_id = u.id) AS is_client,
      EXISTS (SELECT 1 FROM staff_members sm WHERE sm.user_id = u.id) AS is_helper,
      u.is_tester,
      NOT EXISTS (SELECT 1 FROM admin_real_users ru WHERE ru.id = u.id) AS excluded_from_analytics,
      af.code AS affiliate_code,
      wr.total AS rev_total, wr.invoices AS rev_invoices, wr.store_orders AS rev_store_orders,
      wr.programs AS rev_programs, wr.packages AS rev_packages, wr.gift_cards AS rev_gift_cards,
      wr.booking_payments AS rev_booking_payments, wr.invoice_currencies AS rev_invoice_currencies,
      CASE WHEN w.id IS NULL THEN NULL ELSE ${missingCountSql('wp')} END AS answers_missing
    FROM users u
    -- One row per person: their oldest business (the one the app uses).
    -- A plain join listed someone twice when two workspaces existed for
    -- them (a signup race); workspace_count shows that case instead.
    LEFT JOIN LATERAL (
      SELECT ws.*, COUNT(*) OVER () AS workspace_count
        FROM workspaces ws
       WHERE ws.owner_id = u.id
       ORDER BY ws.created_at ASC, ws.id ASC
       LIMIT 1
    ) w ON TRUE
    LEFT JOIN affiliates af ON af.user_id = u.id
    LEFT JOIN workspace_revenue wr ON wr.workspace_id = w.id
    LEFT JOIN workspace_profile wp ON wp.workspace_id = w.id
    ${whereSql}
    ORDER BY ${sortSql}
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const totalText = `SELECT COUNT(*)::int AS n FROM users u ${whereSql}`;
  const totalParams = params.slice(0, params.length - 2);

  const [r, t] = await Promise.all([
    sql.query(queryText, params),
    sql.query(totalText, totalParams),
  ]);

  const users = r.rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    userType: row.user_type,
    createdAt: row.created_at,
    emailVerifiedAt: row.email_verified_at,
    lastLoginAt: row.last_login_at,
    lastActiveAt: row.last_active_at,
    workspaceCount: row.workspace_count || 0,
    // Required onboarding answers still missing (0-5); null without a business.
    onboardingAnswersMissing: row.answers_missing == null ? null : Number(row.answers_missing),
    workspace: row.workspace_id ? {
      id: row.workspace_id,
      status: row.subscription_status,
      trialEndsAt: row.trial_ends_at,
      periodEndsAt: row.subscription_period_end,
      comped: !!(row.comp_until && new Date(row.comp_until) > new Date()),
      // Same predicate as the paywall + the client-facing archive, so
      // the operator sees "Archived" exactly when clients do.
      active: isWorkspaceActive(row),
      // 7-day retention after a paid subscription ends (data-retention cron).
      dataDeletionAt: (!isWorkspaceActive(row) && row.data_deletion_at) ? row.data_deletion_at : null,
      dataPurgedAt: row.data_purged_at || null,
    } : null,
    isClient: !!row.is_client,
    // Helper at someone else's business (api/_lib/helpers.js).
    isHelper: !!row.is_helper,
    affiliateCode: row.affiliate_code,
    // Combined classification used by the admin UI.
    classification: classify(row),
    // Flagged by the operator as a test account (Manage → Mark as test
    // account), or excluded automatically (beta, sponsored, super admin,
    // comped). Excluded accounts never count in Admin → Overview.
    isTester: !!row.is_tester,
    excludedFromAnalytics: !!row.excluded_from_analytics,
    // Revenue this business has collected through Ivy (workspace_revenue
    // view). Operator-only; see Privacy Policy "Business totals".
    revenue: row.workspace_id ? {
      total: Number(row.rev_total || 0),
      invoices: Number(row.rev_invoices || 0),
      storeOrders: Number(row.rev_store_orders || 0),
      programs: Number(row.rev_programs || 0),
      packages: Number(row.rev_packages || 0),
      giftCards: Number(row.rev_gift_cards || 0),
      bookingPayments: Number(row.rev_booking_payments || 0),
      mixedCurrencies: Number(row.rev_invoice_currencies || 0) > 1,
    } : null,
  }));

  return ok(res, {
    users,
    page,
    pageSize: PAGE_SIZE,
    total: t.rows[0]?.n || 0,
  });
}

function classify(row) {
  if (row.user_type === 'sponsored') return 'Sponsored';
  if (row.user_type === 'beta')      return 'Beta';
  if (row.user_type === 'affiliate') return 'Affiliate';
  if (row.subscription_status === 'active') return 'Business-Active';
  if (row.subscription_status === 'trialing'
    && row.trial_ends_at && new Date(row.trial_ends_at) > new Date()) return 'Business-Trial';
  if (row.workspace_id) return 'Business-Inactive';
  if (row.is_helper) return 'Helper';
  if (row.is_client) return 'Client-only';
  return 'Unclaimed';
}

async function createUser(req, res) {
  const body = await readBody(req);
  const email = (body.email || '').toString().toLowerCase().trim();
  const name  = body.name ? String(body.name).trim().slice(0, 200) : null;
  const userType = (body.userType || 'regular').toString();
  const code = body.code ? String(body.code).trim().toUpperCase() : null;
  const password = body.password ? String(body.password) : null;
  const sendInvite = body.sendInvite !== false;

  if (!validEmail(email)) return badRequest(res, 'Invalid email');
  if (!CREATE_TYPES.has(userType)) return badRequest(res, 'Unknown userType');

  const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.rows.length > 0) {
    return badRequest(res, 'A user with that email already exists. Edit them instead.');
  }

  // Generate a random password if not supplied so we never store NULL.
  // The user can reset via the link we email them anyway.
  // CSPRNG, not Math.random(): the fallback password is a real credential
  // until the invitee sets their own.
  const pw = password || randomBytes(16).toString('base64url') + 'A1!';
  const password_hash = await hashPassword(pw);

  const dbUserType = (userType === 'sponsored' || userType === 'beta' || userType === 'affiliate') ? userType : 'regular';
  const ins = await sql`
    INSERT INTO users (email, password_hash, name, user_type, email_verified_at)
    VALUES (${email}, ${password_hash}, ${name}, ${dbUserType}, NOW())
    RETURNING id, email, name, user_type, created_at
  `;
  const user = ins.rows[0];

  // Workspace + subscription wiring per type.
  let workspaceId = null;
  if (userType === 'sponsored') {
    const w = await sql`
      INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, subscription_period_end, onboarded_at)
      VALUES (${user.id}, 'active', NULL, NOW() + INTERVAL '100 years', NULL)
      RETURNING id
    `;
    workspaceId = w.rows[0].id;
  } else if (userType === 'beta') {
    // Beta: full app access, no card, no subscription. Same shape as
    // sponsored - the user_type alone bypasses the paywall (see
    // workspaceGate + clientPortal). Workspace row gets the same
    // always-active shape as a safety net in case any read-path
    // check skips the user_type bypass.
    const w = await sql`
      INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, subscription_period_end, onboarded_at)
      VALUES (${user.id}, 'active', NULL, NOW() + INTERVAL '100 years', NULL)
      RETURNING id
    `;
    workspaceId = w.rows[0].id;
  } else if (userType === 'business-trial') {
    const w = await sql`
      INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at)
      VALUES (${user.id}, 'trialing', NOW() + (${TRIAL_DAYS}::int || ' days')::interval)
      RETURNING id
    `;
    workspaceId = w.rows[0].id;
  } else if (userType === 'business-active') {
    const w = await sql`
      INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end)
      VALUES (${user.id}, 'active', NOW() + INTERVAL '1 month')
      RETURNING id
    `;
    workspaceId = w.rows[0].id;
  } else if (userType === 'affiliate') {
    // Affiliates also get a workspace so they can use the app like a
    // regular owner; their primary value is the referral code.
    const w = await sql`
      INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at)
      VALUES (${user.id}, 'trialing', NOW() + (${TRIAL_DAYS}::int || ' days')::interval)
      RETURNING id
    `;
    workspaceId = w.rows[0].id;
    const finalCode = code && /^[A-Z0-9_-]{3,40}$/.test(code) ? code : await generateUniqueCode();
    await sql`
      INSERT INTO affiliates (user_id, code, display_name)
      VALUES (${user.id}, ${finalCode}, ${name})
    `;
  }

  // An admin-created account is verified on creation, so whatever was
  // waiting on this address (a comp invite, the waitlist discount) is
  // granted now, exactly as email verification grants it. Never throws.
  if (workspaceId) await claimSignupPerks(user.id);

  // Auto-claim any pre-existing clients rows tied to this email so the
  // signup-flow auto-link works for admin-created users too.
  await sql`UPDATE clients SET user_id = ${user.id} WHERE email = ${email} AND user_id IS NULL`;

  if (sendInvite) {
    try {
      // Reset-link instead of plain sign-in: lets the user pick their
      // own password without us ever transmitting the random one.
      const raw = await createToken({ userId: user.id, kind: KIND_RESET, ttlMinutes: 60 * 24 * 3 });
      const link = `${appUrl()}/reset-password?token=${encodeURIComponent(raw)}`;
      await sendEmail({
        to: email,
        subject: subjectFor(userType),
        html: emailShell({
          heading: headingFor(userType, name),
          body: bodyFor(userType, name),
          ctaText: 'Set my password',
          ctaUrl: link,
          footer: `If you weren't expecting this, you can ignore this email - your account stays put until you set a password.`,
        }),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[admin/users] invite email failed:', err.message);
    }
  }

  const actor = await getAdminActor(req);
  await recordAudit(req, {
    actor,
    targetUserId: user.id,
    action: 'user.create',
    meta: { userType, sendInvite, email },
  });

  return created(res, {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      userType: user.user_type,
      classification: classifyByCreate(userType),
      workspaceId,
    },
  });
}

function classifyByCreate(t) {
  if (t === 'sponsored')        return 'Sponsored';
  if (t === 'beta')             return 'Beta';
  if (t === 'affiliate')        return 'Affiliate';
  if (t === 'business-trial')   return 'Business-Trial';
  if (t === 'business-active')  return 'Business-Active';
  return 'Unclaimed';
}

async function generateUniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    const r = await sql`SELECT 1 FROM affiliates WHERE code = ${code}`;
    if (r.rows.length === 0) return code;
  }
  // Improbable: 8 collisions on 8 random 8-char codes from 36^8 space.
  // Fall back with a timestamp suffix.
  return `Ivy-${Date.now().toString(36).toUpperCase()}`;
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function subjectFor(type) {
  switch (type) {
    case 'sponsored':       return "You've got a sponsored Ivy account";
    case 'beta':            return "You're invited to the Ivy beta";
    case 'affiliate':       return "Welcome to the Ivy affiliate program";
    case 'business-trial':  return "Your Ivy account is ready - 14-day trial activated";
    case 'business-active': return "Your Ivy account is ready";
    default:                return 'Welcome to Ivy';
  }
}
function headingFor(type, name) {
  // Raw text: emailShell escapes the heading itself.
  return name ? `Hi ${name.split(' ')[0]},` : 'Hi,';
}
function bodyFor(type, name) {
  switch (type) {
    case 'sponsored':
      return `<p>You've been given full access to Ivy - no subscription
        needed. Treat it like the paid version: the calendar, clients,
        invoicing, AI assistant, all of it. Set your password below and
        you're in.</p>`;
    case 'beta':
      return `<p>You've been invited to the <strong>Ivy beta</strong>: early
        access to the full app with no subscription and no card needed. You
        get the same toolset paying customers do (clients, calendar, invoicing,
        documents, messaging, Ivy your AI assistant, the whole thing), free for
        the duration of the beta.</p>
        <p>In return, we'd love your honest feedback as you use it: what
        works, what's broken, what's missing. Just reply to any Ivy email
        and it reaches a real person.</p>
        <p>Set your password below to get started.</p>`;
    case 'affiliate':
      return `<p>Welcome to the Ivy affiliate program. You've got a
        referral code that earns you credit on every business that signs
        up through it. Set your password and the code will be waiting for
        you in your account.</p>`;
    case 'business-trial':
      return `<p>Your Ivy account is set up. You're on a 14-day full-
        access trial - long enough to actually run a couple weeks of
        bookings and see if the numbers move. Set your password to get in.</p>`;
    case 'business-active':
      return `<p>Your Ivy account is set up and active. Pick a
        password below and you're ready to use the app.</p>`;
    default:
      return `<p>Welcome to Ivy. Set your password to start using the
        app.</p>`;
  }
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
