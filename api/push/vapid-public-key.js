// GET /api/push/vapid-public-key - returns the public VAPID key the
// browser needs to call PushManager.subscribe(). Public by design;
// the private key never leaves the server.
import { publicVapidKey } from '../_lib/push.js';
import { methodNotAllowed, ok, badRequest } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const key = publicVapidKey();
  if (!key) return badRequest(res, 'Push notifications are not configured on this deployment.');
  return ok(res, { publicKey: key });
}
