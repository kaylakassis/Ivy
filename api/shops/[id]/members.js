// /api/shops/:id/members  (shop owner only)
//   POST   { email }                       → invite a pro by email
//   PATCH  { items: [{ id, displayOrder?, featured?, title? }] } → roster order / featured / title
//   DELETE { memberId }                    → remove a member (or cancel their invite)
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { enforce } from '../../_lib/rate-limit.js';
import { recordWorkspaceAudit } from '../../_lib/audit.js';
import {
  loadOwnedShop, inviteMember, updateRoster, removeMember, serializeMember, ShopError, SHOP_INVITE_TTL_DAYS,
} from '../../_lib/shops.js';
import { created, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return methodNotAllowed(res, ['POST', 'PATCH', 'DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const shop = await loadOwnedShop(String(req.query.id || ''), workspaceId);
    if (!shop) return notFound(res, 'Shop page not found');
    const body = await readBody(req);

    if (req.method === 'POST') {
      // Invites send email: cap per shop and per owner.
      if (await enforce(req, res, [
        { key: `shop-invite:ws:${workspaceId}`, max: 40, windowSeconds: 24 * 3600 },
        { key: `shop-invite:shop:${shop.id}`, max: 30, windowSeconds: 24 * 3600 },
      ])) return;
      const out = await inviteMember({ shop, email: body?.email, inviterUser: user });
      recordWorkspaceAudit(req, { workspaceId, actor: { id: user.id }, action: 'shop.invite', target: shop.id, meta: { memberId: out.member.id } }).catch(() => {});
      return created(res, {
        member: serializeMember(out.member, { owner: true }),
        sent: out.sent,
        reason: out.reason,
        hasAccount: out.hasAccount,
        expiresAt: out.expiresAt,
        ttlDays: SHOP_INVITE_TTL_DAYS,
      });
    }
    if (req.method === 'PATCH') {
      const members = await updateRoster({ shop, items: body?.items });
      return ok(res, { members: members.map((m) => serializeMember(m, { owner: true })) });
    }
    const out = await removeMember({ shop, memberId: String(body?.memberId || req.query.memberId || '') });
    recordWorkspaceAudit(req, { workspaceId, actor: { id: user.id }, action: 'shop.remove_member', target: shop.id, meta: { memberId: body?.memberId || null } }).catch(() => {});
    return ok(res, out);
  } catch (err) {
    if (err instanceof ShopError) return res.status(err.status).json({ error: err.message, code: err.code || undefined });
    return serverError(res, err);
  }
}
