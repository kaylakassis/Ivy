// POST /api/referrals/attach   body: { code }
//
// Lets an owner who signed up WITHOUT a ?ref= link (the iPhone app has
// no link to click, and some people type the address by hand) attach a
// friend's referral code afterwards, so both still get their free week
// when the owner subscribes.
//
// Guarded so it cannot be gamed (api/_lib/referrals.js attachReferralCode):
//   - no referral on the account yet (one per person, ever)
//   - the owner has not made a payment yet
//   - not their own code
//   - the account is less than 30 days old
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { attachReferralCode } from '../_lib/referrals.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const result = await attachReferralCode(user.id, body?.code);
    if (!result.ok) return badRequest(res, result.error || 'That code could not be added.', { reason: result.reason });
    return ok(res, { attached: true, code: result.code });
  } catch (err) {
    return serverError(res, err);
  }
}
