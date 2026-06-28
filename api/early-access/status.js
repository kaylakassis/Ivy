// GET /api/early-access/status — public, no auth.
// Returns the combined gate + launch state the frontend needs on first
// paint to decide what to render:
//   enabled        - the standalone early-access password gate is on
//   unlocked       - this session satisfies the early-access gate
//   launchMode     - 'open' | 'waitlist' (controlled launch switch)
//   hasBetaPassword- a bypass/early-access password is configured, so the
//                    waitlist screen can offer a "beta access code" field
//   bypassed       - this session carries a valid bypass cookie, so even
//                    in waitlist mode it should see the normal app/signup
import { getGateSettings, isGateUnlocked, getLaunchMode, hasBypassCookie } from '../_lib/earlyAccess.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const [settings, launchMode, bypassed] = await Promise.all([
      getGateSettings(),
      getLaunchMode(),
      hasBypassCookie(req),
    ]);
    const unlocked = settings.enabled ? await isGateUnlocked(req) : true;
    return ok(res, {
      enabled: settings.enabled,
      unlocked,
      launchMode,
      hasBetaPassword: settings.hasPassword,
      bypassed,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
