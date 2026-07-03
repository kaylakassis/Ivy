// /api/me/nav-prefs
//   GET   → { hiddenNav: [navId, …] } — the owner's hidden sidebar tabs.
//   PATCH → { hiddenNav: [...] } → replace the hidden set.
//
// Per-ACCOUNT UI preference stored in users.ui_prefs.hiddenNav. Read back on
// every request via requireUser's SELECT (rides the /api/auth/me {...user}
// spread), so hiding a tab reaches the sidebar, mobile drawer, bottom nav, and
// command palette. Hiding is cosmetic — the routes still exist for deep links.
import { sql } from '../_lib/db.js';
import { requireUser, invalidateUserCache } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

// The tabs an owner is allowed to hide. Mirrors src/lib/nav.js hideableNav()
// (server can't import the client module). dashboard + ivy are always visible;
// admin is super-admin-only, never a personal-hide target.
const HIDEABLE_NAV_IDS = new Set([
  'clients', 'calendar', 'comms', 'projects', 'finance',
  'campaigns', 'reviews', 'rewards', 'website', 'workflows', 'docs', 'goals',
]);

function readHidden(uiPrefs) {
  const arr = uiPrefs && Array.isArray(uiPrefs.hiddenNav) ? uiPrefs.hiddenNav : [];
  // Only surface ids that are still valid + hideable (defends against stale
  // ids if a tab is ever removed).
  return arr.filter((id) => HIDEABLE_NAV_IDS.has(id));
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && !requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      return ok(res, { hiddenNav: readHidden(user.ui_prefs) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (!Array.isArray(body.hiddenNav)) {
        return badRequest(res, 'hiddenNav must be an array of nav ids');
      }
      // Keep only valid hideable ids; dedupe. Unknown / always-visible / admin
      // ids are silently dropped rather than errored, so a stale client can't
      // wedge itself.
      const hiddenNav = [...new Set(body.hiddenNav.filter((id) => HIDEABLE_NAV_IDS.has(id)))];

      // Merge into the existing ui_prefs bag (don't clobber other keys).
      const { rows } = await sql`SELECT ui_prefs FROM users WHERE id = ${user.id}`;
      const current = (rows[0] && rows[0].ui_prefs) || {};
      const next = { ...current, hiddenNav };
      await sql`UPDATE users SET ui_prefs = ${JSON.stringify(next)}::jsonb WHERE id = ${user.id}`;
      invalidateUserCache(user.id); // 15s hot-cache — bust so the nav updates now
      return ok(res, { hiddenNav });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
