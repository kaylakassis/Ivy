// /api/shops/invite
//   GET  ?token=…                       → what the invite is (public, rate-limited;
//                                         unknown, used and expired links read the same)
//   POST { token, action: 'accept' | 'decline' } → signed-in business owner answers.
//
// Accepting binds the invite to the business the signed-in user OWNS, and
// only when that business has an active plan, trial or comp. An email
// invite can only be accepted by that email's account.
import { requireUser, readSession, normalizeAccountEmail } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { recordWorkspaceAudit } from '../_lib/audit.js';
import { findInvite, inviteInfo, acceptInvite, declineInvite, ownedWorkspaceOf, serializeShop, isUuid, ShopError } from '../_lib/shops.js';
import { loadWorkspaceAccess } from '../_lib/businessAccess.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const DEAD = 'This invite link is not valid any more. Ask the shop to send a new one.';

async function findInviteForUser(inviteId, user) {
  if (!isUuid(inviteId) || !user) return null;
  const ws = await ownedWorkspaceOf(user.id);
  const email = normalizeAccountEmail(user.email);
  const { rows } = await sql.query(
    `SELECT * FROM shop_members WHERE id = $1 AND status = 'invited' AND invite_expires_at > NOW()
       AND (workspace_id = $2 OR (workspace_id IS NULL AND LOWER(invite_email) = $3)) LIMIT 1`,
    [inviteId, ws, email],
  );
  const member = rows[0];
  if (!member) return null;
  const shop = (await sql`SELECT * FROM shops WHERE id = ${member.shop_id} LIMIT 1`).rows[0];
  return shop ? { kind: 'member', shop, member } : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  try {
    await ensureSchemaApplied();
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `shop-invite-token:ip:${ip}`, max: 40, windowSeconds: 10 * 60 }])) return;

    if (req.method === 'GET') {
      const raw = typeof req.query.token === 'string' ? req.query.token : '';
      const found = await findInvite(raw);
      if (!found) return res.status(410).json({ error: DEAD, status: 'dead' });
      const info = await inviteInfo(found);
      // The signed-in person's own situation, so the page can say what
      // happens on Accept before they tap it. Booleans only.
      const session = readSession(req);
      let me = null;
      if (session?.sub) {
        const ws = await ownedWorkspaceOf(session.sub);
        const access = ws ? await loadWorkspaceAccess(ws) : null;
        me = {
          hasBusiness: !!ws,
          planActive: !!access?.active,
          isShopOwner: !!ws && ws === found.shop.owner_workspace_id,
          businessName: access?.businessName || null,
        };
      }
      return ok(res, { ...info, me });
    }

    if (!requireSameOrigin(req, res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const raw = typeof body?.token === 'string' ? body.token : '';
    const action = body?.action === 'decline' ? 'decline' : body?.action === 'accept' ? 'accept' : null;
    if (!action) return badRequest(res, 'action must be accept or decline');
    // From the in-app invite card there is no link: the invite is named by
    // id and must be addressed to the signed-in owner's business or email.
    const found = raw ? await findInvite(raw) : await findInviteForUser(String(body?.inviteId || ''), user);
    if (!found) return res.status(410).json({ error: DEAD, status: 'dead' });
    if (action === 'decline') {
      const out = await declineInvite({ found, user });
      return ok(res, { declined: !!out.ok, shop: { name: found.shop.name } });
    }
    const out = await acceptInvite({ found, user });
    recordWorkspaceAudit(req, { workspaceId: out.member.workspace_id, actor: { id: user.id }, action: 'shop.join', target: found.shop.id, meta: { kind: found.kind } }).catch(() => {});
    return ok(res, {
      joined: true,
      alreadyMember: !!out.alreadyMember,
      shop: serializeShop(out.shop),
      memberId: out.member.id,
    });
  } catch (err) {
    if (err instanceof ShopError) return res.status(err.status).json({ error: err.message, code: err.code || undefined });
    return serverError(res, err);
  }
}
