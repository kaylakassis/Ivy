// GET /api/finance/stripe-diagnostic
//
// Super-admin only. Probes Stripe configuration end-to-end so we can
// confirm Connect is set up correctly without going through the full
// onboarding flow. Returns a structured pass/fail per check, so
// "what's broken?" becomes a one-click answer instead of a
// console-log scavenger hunt.
//
// Checks:
//   1. STRIPE_SECRET_KEY present + non-empty
//   2. Key mode (test vs live) detected from the prefix
//   3. /v1/account on the platform itself responds — confirms the
//      key is valid and not revoked
//   4. /v1/account/capabilities — confirms Connect is enabled
//   5. The workspace's stripe_connect_user_id (if any) is fetchable
//   6. /v1/account_links can be minted for a throwaway test acct
//      (only when there's no existing connected acct — we don't
//      want to spam acct creation on every probe).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { platformStripeSecret, fetchAccountSummary } from '../_lib/stripe.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const checks = [];
    const pass = (name, detail) => checks.push({ name, ok: true, detail });
    const fail = (name, detail) => checks.push({ name, ok: false, detail });

    // 1. Key present
    const key = platformStripeSecret();
    if (!key) {
      fail('STRIPE_SECRET_KEY present', 'Not set in any of: STRIPE_SECRET_KEY, THRYVE_STRIPE_SECRET, STRIPE_PLATFORM_SECRET');
      return ok(res, { checks });
    }
    pass('STRIPE_SECRET_KEY present', `Length ${key.length}, prefix ${key.slice(0, 7)}…`);

    // 2. Mode detection
    const mode = key.startsWith('sk_live_') ? 'live'
      : key.startsWith('sk_test_') ? 'test'
      : 'unknown';
    if (mode === 'unknown') {
      fail('Key mode', `Expected sk_live_… or sk_test_…, got "${key.slice(0, 8)}…"`);
    } else {
      pass('Key mode', mode);
    }

    // 3. Platform account fetch — proves the key is valid
    let platformAcct = null;
    try {
      platformAcct = await fetchAccountSummary(key);
      pass('Platform account fetch', `id=${platformAcct.id}, label=${platformAcct.label}`);
    } catch (err) {
      fail('Platform account fetch', `${err.message} (status ${err.status || '?'})`);
      return ok(res, { checks });
    }

    // 4. Connect capabilities — confirms the platform is set up for Connect
    try {
      const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
      const r = await fetch('https://api.stripe.com/v1/accounts?limit=1', { headers });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const m = body?.error?.message || `HTTP ${r.status}`;
        // The classic "Connect not enabled" error message.
        if (/sign up for Connect/i.test(m) || /Connect/i.test(m)) {
          fail('Stripe Connect enabled', `${m} — enable Connect at https://dashboard.stripe.com/${mode === 'test' ? 'test/' : ''}connect/accounts/overview`);
        } else {
          fail('Stripe Connect enabled', m);
        }
      } else {
        const count = Array.isArray(body.data) ? body.data.length : 0;
        pass('Stripe Connect enabled', `${count} existing connected account(s) found`);
      }
    } catch (err) {
      fail('Stripe Connect enabled', err.message);
    }

    // 5. Workspace's existing connected acct (if any)
    const fs = await sql`
      SELECT stripe_connect_user_id, stripe_onboarding_status
        FROM finance_settings WHERE workspace_id = ${workspaceId}
    `;
    const acctId = fs.rows[0]?.stripe_connect_user_id;
    if (acctId) {
      try {
        const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
        const r = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(acctId)}`, { headers });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          fail('Existing connected account valid',
            `${body?.error?.message || `HTTP ${r.status}`} — acct=${acctId} (likely created in the OTHER mode). Disconnect Stripe in /finance to clear and reconnect.`);
        } else {
          pass('Existing connected account valid', `acct=${body.id}, details_submitted=${!!body.details_submitted}, charges_enabled=${!!body.charges_enabled}, livemode=${!!body.livemode}, status=${fs.rows[0].stripe_onboarding_status || 'null'}`);
        }
      } catch (err) {
        fail('Existing connected account valid', err.message);
      }
    } else {
      pass('Existing connected account valid', 'None — fresh workspace, will create on first Connect click');
    }

    // 6. /v1/account_links smoke test — only when there's already an
    //    acct we can use; we don't want to create test accounts on
    //    every probe. Skipped if no acct exists yet.
    if (acctId) {
      try {
        const headers = {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        };
        const body = new URLSearchParams({
          account: acctId,
          refresh_url: 'https://example.com/refresh',
          return_url: 'https://example.com/return',
          type: 'account_onboarding',
        }).toString();
        const r = await fetch('https://api.stripe.com/v1/account_links', { method: 'POST', headers, body });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          fail('Account Link mint', `${j?.error?.message || `HTTP ${r.status}`}`);
        } else {
          pass('Account Link mint', 'OK');
        }
      } catch (err) {
        fail('Account Link mint', err.message);
      }
    }

    return ok(res, { mode, platformAcct, checks });
  } catch (err) {
    return serverError(res, err);
  }
}
