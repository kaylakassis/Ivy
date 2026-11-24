// Builds the full account-data export payload (GDPR right-to-portability).
// Shared by api/account/export.js (streamed download) and the emailed-copy
// path so the two never drift. Returns a single JSON-serializable object
// with one key per table, with all encrypted-credential / token columns
// stripped.
import { sql } from './db.js';
import { ensureWorkspace } from './auth.js';
import { myClientIds } from './clientPortal.js';
import { buildClientPortalExport } from './clientExport.js';

// Encrypted-credential blobs and token hashes that must never leave the
// server in a user-facing export, even encrypted (a leaked key + blob
// reproduces live credentials).
const SENSITIVE_KEYS = [
  'stripe_secret_encrypted',
  'stripe_webhook_secret_encrypted',
  'stripe_publishable_key',
  'square_credentials_encrypted',
  'paypal_credentials_encrypted',
  'google_refresh_token_encrypted',
  'twilio_auth_token_encrypted',
  'sms_twilio_auth_token_encrypted',
  'ical_feed_token_hash',
  'review_request_token_hash',
  'invoice_view_token_hash',
  'quote_view_token_hash',
  'sign_token_hash',
  'view_token_hash',
  'password_hash',
  // A gift card's code is stored only as a hash; the hash is a way to test
  // guesses at the code, so it stays on the server.
  'code_hash',
];
// Belt and braces: any column that holds a token hash, present or future,
// is stripped by name shape too, so a new *_token_hash column cannot leak
// into an export before someone remembers to list it above.
const TOKEN_HASH_KEY = /(^|_)token_hash$/i;

function stripSensitive(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const k of SENSITIVE_KEYS) delete out[k];
  for (const k of Object.keys(out)) if (TOKEN_HASH_KEY.test(k)) delete out[k];
  return out;
}
const stripRows = (rows) => (Array.isArray(rows) ? rows.map(stripSensitive) : rows);

// ── The rest of the owner's records ──────────────────────────────────
// An explicit list, on purpose. A table is added here only after its
// columns have been read and it has been decided that the rows are the
// owner's own business records. "Every table that has a workspace_id"
// would also sweep up Ivy's internal records (audit and risk logs, abuse
// reports, billing bookkeeping) and private things other people wrote, so
// that is never done.
//
// Each entry: [key in the file, table, how the rows belong to the workspace,
// columns left out]. Left out everywhere: credential and token-hash columns
// (stripSensitive) and any column that points at another person's Ivy
// sign-in (*_user_id), which is an internal number and nobody's business
// record.
//
// Deliberately NOT exported, because they are not the owner's own records:
//   - what members wrote to each other in a program community, and their
//     private messages (program_posts, program_post_reactions, client_dm_*)
//   - who blocked or muted whom (contact_blocks, *_mutes)
//   - Ivy's own operating records (audit_events, risk_events, abuse_reports,
//     bug_reports, billing_*, ivy_failures, ivy_pending_actions,
//     notifications, screen_visits, exit_answers, referral ledger)
//   - one-time links waiting to be used (cancellation_policy_requests,
//     helper_invites, group_invite_tokens)
const BY_WORKSPACE = 'workspace_id';
export const EXTRA_TABLES = [
  ['workspace_profile',               'workspace_profile',               BY_WORKSPACE],
  ['quotes',                          'quotes',                          BY_WORKSPACE],
  ['recurring_invoices',              'recurring_invoices',              BY_WORKSPACE],
  ['invoice_payments',                'invoice_payments',                BY_WORKSPACE],
  ['autopay_agreements',              'autopay_agreements',              BY_WORKSPACE],
  ['projects',                        'projects',                        BY_WORKSPACE],
  ['products',                        'products',                        BY_WORKSPACE],
  ['orders',                          'orders',                          BY_WORKSPACE],
  ['packages',                        'packages',                        BY_WORKSPACE],
  ['client_packages',                 'client_packages',                 BY_WORKSPACE],
  ['memberships',                     'memberships',                     BY_WORKSPACE],
  ['client_memberships',              'client_memberships',              BY_WORKSPACE],
  ['gift_cards',                      'gift_cards',                      BY_WORKSPACE],
  ['gift_card_redemptions',           'gift_card_redemptions',           BY_WORKSPACE],
  ['workflows',                       'workflows',                       BY_WORKSPACE],
  ['workflow_runs',                   'workflow_runs',                   BY_WORKSPACE],
  ['client_automations',              'client_automations',              BY_WORKSPACE],
  ['client_automation_sends',         'client_automation_sends',         BY_WORKSPACE],
  ['email_campaigns',                 'email_campaigns',                 BY_WORKSPACE],
  ['client_email_optouts',            'client_email_optouts',            BY_WORKSPACE],
  ['reviews',                         'reviews',                         BY_WORKSPACE, ['appeal_resolved_by']],
  ['staff_members',                   'staff_members',                   BY_WORKSPACE],
  ['waitlist_entries',                'waitlist_entries',                BY_WORKSPACE],
  ['waitlist_offers',                 'waitlist_offers',                 BY_WORKSPACE],
  ['cancellation_policy_settings',    'cancellation_policy_settings',    BY_WORKSPACE],
  ['cancellation_policy_versions',    'cancellation_policy_versions',    BY_WORKSPACE],
  ['cancellation_policy_acceptances', 'cancellation_policy_acceptances', BY_WORKSPACE],
  ['group_threads',                   'group_threads',                   BY_WORKSPACE],
  ['group_thread_members',            'group_thread_members',            BY_WORKSPACE],
  ['group_messages',                  'group_messages',                  BY_WORKSPACE],
  ['ivy_memory',                      'ivy_memory',                      BY_WORKSPACE],
  ['ivy_actions',                     'ivy_actions',                     BY_WORKSPACE],
  ['programs',                        'programs',                        BY_WORKSPACE],
  ['program_modules',                 'program_modules',                 BY_WORKSPACE],
  ['program_items',                   'program_items',                   BY_WORKSPACE],
  ['program_cohorts',                 'program_cohorts',                 BY_WORKSPACE],
  ['program_enrollments',             'program_enrollments',             BY_WORKSPACE],
  ['program_progress',                'program_progress',                BY_WORKSPACE],
  ['program_events',                  'program_events',                  BY_WORKSPACE],
  ['program_event_rsvps',             'program_event_rsvps',             BY_WORKSPACE],
  ['program_checkin_forms',           'program_checkin_forms',           BY_WORKSPACE],
  ['program_checkin_responses',       'program_checkin_responses',       BY_WORKSPACE],
  ['program_coupons',                 'program_coupons',                 BY_WORKSPACE],
  ['program_coupon_redemptions',      'program_coupon_redemptions',      BY_WORKSPACE],
  ['program_badges',                  'program_badges',                  BY_WORKSPACE],
  ['program_trials',                  'program_trials',                  BY_WORKSPACE],
  // Shop pages this business runs, and its own listing on any shop page.
  ['shops',                           'shops',                           'owner_workspace_id'],
  ['shop_memberships',                'shop_members',                    BY_WORKSPACE],
];
export const EXPORTED_EXTRA_KEYS = EXTRA_TABLES.map(([key]) => key);

const POINTS_AT_A_SIGN_IN = /(^|_)user_id$/i;
// A second net under the named list above: nothing whose name says it is a
// secret leaves through these tables, whatever is added to them later.
const LOOKS_SECRET = /secret|password|encrypted|token_hash|code_hash/i;
function cleanExtraRow(row, drop = []) {
  const out = stripSensitive(row);
  for (const k of Object.keys(out)) {
    if (POINTS_AT_A_SIGN_IN.test(k) || LOOKS_SECRET.test(k) || drop.includes(k)) delete out[k];
  }
  return out;
}

// Table and column names here come only from the list above, never from a
// request. A table that does not exist yet in a database is simply empty.
async function loadExtraTables(workspaceId) {
  const results = await Promise.all(EXTRA_TABLES.map(([, table, scope]) => sql
    .query(`SELECT * FROM ${table} WHERE ${scope} = $1`, [workspaceId])
    .catch(() => ({ rows: [] }))));
  const out = {};
  EXTRA_TABLES.forEach(([key, , , drop], i) => {
    out[key] = (results[i].rows || []).map((r) => cleanExtraRow(r, drop));
  });
  return out;
}

export async function buildAccountExport(user) {
  const workspaceId = await ensureWorkspace(user.id);

  const [
    profile, workspace, clients, services, calendarSettings, calendarBlocks,
    bookings, messageThreads, messages, documents,
    financeSettings, invoices, tasks, goals,
    rewardSettings, rewardRules, rewardRedemptions,
    ivySessions, ivyMessages, ivyUsage, website, clientFields, expenses, timeEntries,
  ] = await Promise.all([
    sql`SELECT id, email, name, created_at, updated_at, email_verified_at
        FROM users WHERE id = ${user.id}`,
    // Named columns, not "everything": the business row also carries Ivy's
    // own operating notes (review holds and their reasons, complimentary
    // access notes, billing session keys, reminder bookkeeping), which are
    // not the owner's data and must not ride along in a download.
    sql`SELECT id, name, created_at, onboarded_at, business_type,
               subscription_status, subscription_source, trial_ends_at,
               subscription_period_end, cancel_at_period_end, data_deletion_at,
               streak_days, streak_best
          FROM workspaces WHERE id = ${workspaceId}`,
    sql`SELECT * FROM clients          WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM services         WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM calendar_settings WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM calendar_blocks  WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM bookings         WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM message_threads  WHERE workspace_id = ${workspaceId}`,
    sql`SELECT m.* FROM messages m
        JOIN message_threads t ON t.id = m.thread_id
        WHERE t.workspace_id = ${workspaceId}`,
    sql`SELECT * FROM documents        WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM finance_settings WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM invoices         WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM tasks            WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM goals            WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM reward_settings  WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM reward_rules     WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM reward_redemptions WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM ivy_sessions     WHERE workspace_id = ${workspaceId}`,
    sql`SELECT m.* FROM ivy_messages m
        JOIN ivy_sessions s ON s.id = m.session_id
        WHERE s.workspace_id = ${workspaceId}`,
    // Usage counts per day only. The `model` column (which provider model
    // served the day) is internal and never leaves the server; rows that
    // differ only by model are summed into one day.
    sql`SELECT day,
               SUM(request_count)::int          AS request_count,
               SUM(input_tokens)::bigint        AS input_tokens,
               SUM(output_tokens)::bigint       AS output_tokens,
               SUM(cache_read_tokens)::bigint   AS cache_read_tokens,
               SUM(cache_creation_tokens)::bigint AS cache_creation_tokens
          FROM ivy_usage WHERE workspace_id = ${workspaceId}
         GROUP BY day ORDER BY day`,
    sql`SELECT * FROM websites         WHERE workspace_id = ${workspaceId}`,
    // The business's own client fields (clients.custom_fields is keyed by
    // these ids). Tolerates a database without the table yet.
    sql`SELECT id, label, type, options, position, created_at FROM client_field_definitions
         WHERE workspace_id = ${workspaceId} ORDER BY position`.catch(() => ({ rows: [] })),
    // Expense and time tracking were retired (api/_lib/retired.js). What
    // was logged is still the owner's, and this is where they take it away.
    sql`SELECT * FROM expenses     WHERE workspace_id = ${workspaceId} ORDER BY date`.catch(() => ({ rows: [] })),
    sql`SELECT * FROM time_entries WHERE workspace_id = ${workspaceId} ORDER BY started_at`.catch(() => ({ rows: [] })),
  ]);

  // Records where THIS user is a CUSTOMER of other businesses (their portal
  // data) - so a client-only user still gets a complete export.
  const extra = await loadExtraTables(workspaceId);

  const myClients = await myClientIds(user).catch(() => []);
  const myIds = myClients.map((c) => c.clientId);
  let clientPortal = null;
  if (myIds.length) {
    // Other businesses' rows about this person: only the client-safe view
    // (explicit columns; never another business's private notes, payment
    // ids or internal logs). Same builder as the portal's own download.
    const cp = await buildClientPortalExport(user, { memberships: myClients });
    clientPortal = { ...cp, businesses: myClients };
  }

  return {
    ivy_export_version: 1,
    exported_at: new Date().toISOString(),
    user:               stripSensitive(profile.rows[0] || null),
    workspace:          stripSensitive(workspace.rows[0] || null),
    website:            stripSensitive(website.rows[0] || null),
    // user_id links a client to that person's own Ivy sign-in. It is an
    // internal reference to someone else's account, not the owner's data.
    clients:            stripRows(clients.rows).map(({ user_id: _userId, ...c }) => c),
    client_field_definitions: clientFields.rows,
    expenses:           stripRows(expenses.rows),
    time_entries:       stripRows(timeEntries.rows),
    services:           stripRows(services.rows),
    calendar_settings:  stripSensitive(calendarSettings.rows[0] || null),
    calendar_blocks:    stripRows(calendarBlocks.rows),
    bookings:           stripRows(bookings.rows),
    message_threads:    stripRows(messageThreads.rows),
    messages:           stripRows(messages.rows),
    documents:          stripRows(documents.rows),
    finance_settings:   stripSensitive(financeSettings.rows[0] || null),
    invoices:           stripRows(invoices.rows),
    tasks:              stripRows(tasks.rows),
    goals:              stripRows(goals.rows),
    reward_settings:    stripSensitive(rewardSettings.rows[0] || null),
    reward_rules:       stripRows(rewardRules.rows),
    reward_redemptions: stripRows(rewardRedemptions.rows),
    ivy_sessions:       stripRows(ivySessions.rows),
    ivy_messages:       stripRows(ivyMessages.rows),
    ivy_usage:          stripRows(ivyUsage.rows),
    // Everything else the business keeps in Ivy (see EXTRA_TABLES above).
    ...extra,
    client_portal:      clientPortal,
  };
}

export function exportFilename() {
  return `ivy-export-${new Date().toISOString().slice(0, 10)}.json`;
}
