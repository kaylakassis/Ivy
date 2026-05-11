// GET/PATCH /api/admin/early-access — super-admin only.
//
// GET:   returns the current gate state (enabled? has-password? when changed?)
// PATCH: { enabled?: boolean, password?: string }
//        • password: empty string clears it (also flips enabled OFF
//          since enabled-without-password would lock everyone out).
//        • enabling without an existing/new password is rejected.
//
// Surface in /admin → Settings.
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import {
  getGateSettings, setGatePassword, setGateEnabled,
} from '../_lib/earlyAccess.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    if (req.method === 'GET') {
      const s = await getGateSettings();
      return ok(res, {
        enabled:     s.enabled,
        hasPassword: s.hasPassword,
        updatedAt:   s.updatedAt,
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);

      // Apply password change first so the subsequent enable check
      // sees the new state. Empty/null clears the password and forces
      // enabled=false inside setGatePassword.
      if ('password' in body) {
        const pw = body.password == null ? '' : String(body.password);
        if (pw && pw.length < 6) return badRequest(res, 'Password must be at least 6 characters');
        if (pw && pw.length > 200) return badRequest(res, 'Password too long');
        await setGatePassword(pw);
      }

      if ('enabled' in body) {
        try { await setGateEnabled(!!body.enabled); }
        catch (err) {
          if (err.code === 'no_password') {
            return badRequest(res, 'Set a password before enabling the gate.');
          }
          throw err;
        }
      }

      const s = await getGateSettings();
      return ok(res, {
        enabled:     s.enabled,
        hasPassword: s.hasPassword,
        updatedAt:   s.updatedAt,
      });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
