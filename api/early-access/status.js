// GET /api/early-access/status — public, no auth.
// Returns { enabled, unlocked } so the frontend knows whether to
// render the gate screen at all (enabled) and whether the current
// session has already supplied the right password (unlocked).
import { getGateSettings, isGateUnlocked } from '../_lib/earlyAccess.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const settings = await getGateSettings();
    if (!settings.enabled) {
      return ok(res, { enabled: false, unlocked: true });
    }
    const unlocked = await isGateUnlocked(req);
    return ok(res, { enabled: true, unlocked });
  } catch (err) {
    return serverError(res, err);
  }
}
