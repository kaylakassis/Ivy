// GET /api/admin/marketing-list[?q=&page=][&format=csv]
//
// Admin > Marketing list: everyone who opted in to Ivy's tips, product
// news and offers (the optional box at sign-up, or the switch in their
// settings) and has not withdrawn. Withdrawing (settings switch, the
// unsubscribe link in a marketing email, "unsubscribe from all") clears
// users.marketing_consent_at, which drops them from this list.
//
// Columns: name, email, account type (owner / client / helper, can be
// several), opted in at + where, business name and state when they own a
// business, plan status.
//
// JSON: { total, page, pageSize, people: [...] } with ?q= searching name,
// email and business name. ?format=csv streams every matching row as a
// CSV download (cells encoded by csvCell, so a name like "=HYPERLINK(...)"
// is neutralised), and the export is written to the audit log.
//
// Super-admin only (requireSuperAdmin), same-origin, GET only.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { csvRow } from '../_lib/csv.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

const PAGE_SIZE = 50;
const CSV_CHUNK = 2000;
const MAX_Q = 120;

// Opted in, not withdrawn, account still live. The marketing email
// category being muted counts as withdrawn too (an older app switch).
const WHERE = `
      u.marketing_consent_at IS NOT NULL
  AND u.deleted_at IS NULL
  AND COALESCE(u.notification_prefs->>'email_marketing', 'true') <> 'false'`;

const SEARCH = `
  AND ($1::text IS NULL
       OR LOWER(u.email) LIKE $1 ESCAPE '\\'
       OR LOWER(COALESCE(u.name, '')) LIKE $1 ESCAPE '\\'
       OR LOWER(COALESCE(b.biz_name, '')) LIKE $1 ESCAPE '\\')`;

// The oldest business the person owns (the one the app uses), with its
// name, state and plan fields; NULLs for clients and helpers.
const FROM = `
  FROM users u
  LEFT JOIN LATERAL (
    SELECT w.id, w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until,
           COALESCE(NULLIF(btrim(cs.biz_name), ''), NULLIF(btrim(w.name), '')) AS biz_name,
           wp.location_state
      FROM workspaces w
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
      LEFT JOIN workspace_profile wp ON wp.workspace_id = w.id
     WHERE w.owner_id = u.id
     ORDER BY w.created_at ASC, w.id ASC
     LIMIT 1
  ) b ON TRUE`;

const SELECT = `
  SELECT u.id, u.name, u.email, u.user_type, u.marketing_consent_at, u.marketing_consent_source,
         b.id AS workspace_id, b.biz_name, b.location_state,
         b.subscription_status, b.trial_ends_at, b.subscription_period_end, b.comp_until,
         EXISTS (SELECT 1 FROM clients c WHERE c.user_id = u.id) AS is_client,
         EXISTS (SELECT 1 FROM staff_members s WHERE s.user_id = u.id AND s.active = TRUE AND s.revoked_at IS NULL) AS is_helper`;

function likeParam(q) {
  const t = String(q || '').trim().toLowerCase().slice(0, MAX_Q);
  if (!t) return null;
  return `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const SOURCE_WORDS = {
  signup: 'Sign-up', helper_invite: 'Helper invite', settings: 'Settings', admin: 'Admin',
};

export function planStatusWords(r, now = Date.now()) {
  if (!r.workspace_id) return '';
  if (r.comp_until && new Date(r.comp_until).getTime() > now) return 'Comped';
  if (['beta', 'sponsored'].includes(r.user_type)) return r.user_type === 'beta' ? 'Beta' : 'Sponsored';
  switch (r.subscription_status) {
    case 'active': return 'Paying';
    case 'trialing':
      return r.trial_ends_at && new Date(r.trial_ends_at).getTime() < now ? 'Trial ended' : 'On trial';
    case 'past_due': return 'Payment overdue';
    case 'suspended': return 'Suspended';
    case 'canceled': return 'Cancelled';
    case 'incomplete': return 'No plan yet';
    default: return r.subscription_status || 'No plan yet';
  }
}

function accountTypes(r) {
  const t = [];
  if (r.workspace_id) t.push('owner');
  if (r.is_client) t.push('client');
  if (r.is_helper) t.push('helper');
  return t;
}

function shape(r) {
  return {
    id: r.id,
    name: r.name || null,
    email: r.email,
    accountTypes: accountTypes(r),
    optedInAt: r.marketing_consent_at ? new Date(r.marketing_consent_at).toISOString() : null,
    source: r.marketing_consent_source || null,
    sourceLabel: SOURCE_WORDS[r.marketing_consent_source] || r.marketing_consent_source || null,
    businessName: r.biz_name || null,
    state: r.location_state || null,
    planStatus: planStatusWords(r),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const like = likeParam(req.query?.q);

    if (String(req.query?.format || '') === 'csv') {
      const actor = await getAdminActor(req);
      await recordAudit(req, { actor, action: 'admin.export', meta: { kind: 'marketing_list', q: like ? 'filtered' : 'all' } });
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ivy-marketing-list-${stamp}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200);
      res.write(csvRow('Name', 'Email', 'Account type', 'Opted in at', 'Opted in from', 'Business', 'State', 'Plan status') + '\n');
      for (let offset = 0; ; offset += CSV_CHUNK) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await sql.query(
          `${SELECT} ${FROM} WHERE ${WHERE} ${SEARCH}
            ORDER BY u.marketing_consent_at DESC, u.id
            LIMIT ${CSV_CHUNK} OFFSET $2`,
          [like, offset],
        );
        if (rows.length === 0) break;
        res.write(rows.map((r) => {
          const p = shape(r);
          return csvRow(p.name, p.email, p.accountTypes.join(' + '), p.optedInAt, p.sourceLabel,
            p.businessName, p.state, p.planStatus);
        }).join('\n') + '\n');
        if (rows.length < CSV_CHUNK) break;
      }
      return res.end();
    }

    const page = Math.max(1, Math.min(10_000, parseInt(req.query?.page, 10) || 1));
    const [list, count] = await Promise.all([
      sql.query(
        `${SELECT} ${FROM} WHERE ${WHERE} ${SEARCH}
          ORDER BY u.marketing_consent_at DESC, u.id
          LIMIT ${PAGE_SIZE} OFFSET $2`,
        [like, (page - 1) * PAGE_SIZE],
      ),
      sql.query(`SELECT COUNT(*)::int AS n ${FROM} WHERE ${WHERE} ${SEARCH}`, [like]),
    ]);
    return ok(res, {
      total: count.rows[0]?.n || 0,
      page, pageSize: PAGE_SIZE,
      people: list.rows.map(shape),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
