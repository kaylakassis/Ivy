// GET/PATCH /api/admin/launch - super-admin only.
//
// GET:   { launchMode, waitlistCount, couponReady }
// PATCH: { launchMode: 'open' | 'waitlist' }
//        On transition to 'open', lazily ensures the shared waitlist
//        coupon exists so the discount is live before the announcement
//        blast goes out.
//
// Surface in /admin → Settings (alongside the early-access gate).
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { getLaunchMode, setLaunchMode } from '../_lib/earlyAccess.js';
import { ensureWaitlistCoupon } from '../_lib/waitlistCoupon.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

async function snapshot() {
  const [launchMode, countRow, settingsRow] = await Promise.all([
    getLaunchMode(),
    sql`SELECT COUNT(*)::int AS n FROM waitlist_signups`,
    sql`SELECT waitlist_coupon_id FROM app_settings WHERE id = 1`,
  ]);
  return {
    launchMode,
    waitlistCount: countRow.rows[0]?.n || 0,
    couponReady: !!settingsRow.rows[0]?.waitlist_coupon_id,
  };
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    if (req.method === 'GET') {
      return ok(res, await snapshot());
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const mode = body?.launchMode;
      if (mode !== 'open' && mode !== 'waitlist') {
        return badRequest(res, "launchMode must be 'open' or 'waitlist'");
      }

      const actor = await getAdminActor(req);
      await recordAudit(req, { actor, action: 'admin.launch.update', meta: { launchMode: mode } });

      await setLaunchMode(mode);
      // Flipping to 'open' is launch day — make sure the discount coupon
      // exists now so the very first waitlisted checkout can apply it and
      // the announcement can promise it truthfully.
      if (mode === 'open') {
        await ensureWaitlistCoupon();
      }

      return ok(res, await snapshot());
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
