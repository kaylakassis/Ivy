// GET /api/finance/stripe-oauth-init
//
// Owner-only. Kicks off the Stripe Connect onboarding flow using the
// modern Account Links (Express) pattern:
//
//   1. Find or create an Express connected account for the workspace
//      (we keep the acct_xxx id forever; resuming onboarding reuses it).
//   2. Mint a one-time Account Link that takes the owner to a
//      Stripe-hosted onboarding form.
//   3. 302 to that link.
//
// On return, Stripe redirects to /api/finance/stripe-oauth-callback,
// which marks the row as connected once charges_enabled flips true.
//
// Why this instead of /oauth/authorize:
//   • No "Standard OAuth" toggle in the dashboard required.
//   • No redirect URI registration in the dashboard required.
//   • Owners don't need a pre-existing Stripe account.
//   • Stripe is gradually retiring Standard OAuth for new platforms.
//
// Required env:
//   STRIPE_SECRET_KEY  sk_xxx — your platform secret (Vercel Stripe
//                      integration sets this automatically; falls back to
//                      THRYVE_STRIPE_SECRET / STRIPE_PLATFORM_SECRET).
//   APP_URL            used to build refresh + return URLs.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { appUrl } from '../_lib/tokens.js';
import {
  platformStripeSecret, createConnectedAccount, createAccountLink,
} from '../_lib/stripe.js';
import { badRequest, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  // Track which step failed so the error response is actionable.
  // Owner-auth-gated endpoint, so leaking detail is fine.
  let step = 'init';
  try {
    step = 'auth';
    // requireUser 401-JSONs on missing session — but this endpoint is
    // reached via a top-level <a href> click, so a raw JSON response
    // would just appear in the address bar. Sniff the cookie first;
    // if there's no session, redirect to /signin so the user lands
    // somewhere useful.
    if (!req.headers.cookie || !/(?:^|;\s*)thryve_session=/.test(req.headers.cookie)) {
      const dest = encodeURIComponent('/finance');
      res.writeHead(302, { Location: `/signin?next=${dest}` });
      res.end();
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    step = 'workspace';
    const workspaceId = await ensureWorkspace(user.id);

    step = 'platform-key';
    const platformKey = platformStripeSecret();
    if (!platformKey) {
      // Top-level navigation lands here — bounce back to /finance (or
      // /onboarding if they came from the wizard) with an error code
      // in the query string so the React app can render a proper
      // banner instead of a raw API page.
      const base = req.query.from === 'onboarding' ? '/onboarding' : '/finance';
      const sep = req.query.from === 'onboarding' ? '?' : '?';
      res.writeHead(302, { Location: `${base}${sep}stripeError=no_key` });
      res.end();
      return;
    }

    step = 'select-existing';
    // Reuse an existing acct if the owner has been here before but
    // didn't finish onboarding. Acct rows persist across attempts.
    const existing = await sql`
      SELECT stripe_connect_user_id
        FROM finance_settings
       WHERE workspace_id = ${workspaceId}
    `;
    let accountId = existing.rows[0]?.stripe_connect_user_id || null;

    if (!accountId) {
      step = 'create-account';
      const acct = await createConnectedAccount({
        secretKey: platformKey,
        email:     user.email || undefined,
        country:   'US',
      });
      accountId = acct.id;

      step = 'persist-account';
      // Persist immediately so a refresh / redirect / closed tab during
      // onboarding doesn't orphan the acct on Stripe's side.
      await sql`
        INSERT INTO finance_settings (
          workspace_id, stripe_connect_user_id, stripe_onboarding_status
        ) VALUES (${workspaceId}, ${accountId}, 'pending')
        ON CONFLICT (workspace_id) DO UPDATE SET
          stripe_connect_user_id   = EXCLUDED.stripe_connect_user_id,
          stripe_onboarding_status = 'pending'
      `;
    }

    step = 'create-link';
    // Build the onboarding link. refresh_url brings them back here if
    // the link expires; return_url is where Stripe sends them when the
    // form is submitted (whether or not it's actually complete — we
    // re-check status server-side in the callback).
    //
    // `?from=onboarding` is propagated through both URLs so the
    // callback can route a wizard user back to /onboarding instead of
    // /finance — preventing the "I clicked Connect Stripe mid-wizard
    // and got dumped onto the dashboard" UX trap.
    const base = appUrl();
    const fromParam = req.query.from === 'onboarding' ? '?from=onboarding' : '';
    const link = await createAccountLink({
      secretKey:  platformKey,
      accountId,
      refreshUrl: `${base}/api/finance/stripe-oauth-init${fromParam}`,
      returnUrl:  `${base}/api/finance/stripe-oauth-callback${fromParam}`,
      type:       'account_onboarding',
    });

    res.writeHead(302, { Location: link.url });
    res.end();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[stripe-oauth-init] step=${step} failed:`, err);

    // Translate known Stripe gotchas into a short error code that the
    // /finance page can map to a proper UI banner. Top-level navigation
    // lands HERE on failure, so a raw JSON response is the wrong UX —
    // bounce back to /finance with the code in the query string instead.
    const raw = (err.message || String(err)).toLowerCase();
    let code = 'unknown';
    if (raw.includes('signed up for connect') || raw.includes('apply for connect')) {
      code = 'connect_not_enabled';
    } else if (raw.includes('no such account')) {
      code = 'wrong_mode';
    } else if (raw.includes('invalid api key') || raw.includes('no api key')) {
      code = 'bad_key';
    } else if (raw.includes('country')) {
      code = 'unsupported_country';
    }

    const basePath = req.query.from === 'onboarding' ? '/onboarding' : '/finance';
    const dest = basePath
      + '?stripeError=' + encodeURIComponent(code)
      + '&stripeStep=' + encodeURIComponent(step)
      + '&stripeMsg=' + encodeURIComponent((err.message || String(err)).slice(0, 240));
    res.writeHead(302, { Location: dest });
    res.end();
  }
}
