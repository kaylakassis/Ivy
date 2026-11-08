// /api/shops/:id
//   GET    → owner: the shop, its roster and counts per member.
//            member: the shop, their own listing and their own counts.
//            Anyone else: 404 (never a hint that the shop exists).
//   PATCH  → owner: edit details, address, hours, photos, amenities, settings.
//   DELETE → owner: delete the shop page (members are simply no longer listed).
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { recordWorkspaceAudit } from '../../_lib/audit.js';
import {
  loadShopForWorkspace, updateShop, deleteShop, serializeShop, serializeMember, shopStats, memberStats, ShopError,
} from '../../_lib/shops.js';
import { sql } from '../../_lib/db.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!['GET', 'PATCH', 'DELETE'].includes(req.method)) return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const id = String(req.query.id || '');
    const found = await loadShopForWorkspace(id, workspaceId);
    if (!found) return notFound(res, 'Shop page not found');
    const { shop, member, members } = found;
    const isOwner = shop.owner_workspace_id === workspaceId;

    if (req.method === 'GET') {
      if (isOwner) {
        const stats = await shopStats(shop);
        const mine = await ownServices(workspaceId);
        // Counts are attached to each roster row by the owner's own view,
        // keyed by member id so no workspace id leaves the server.
        const roster = members.map((m) => ({
          ...serializeMember(m, { owner: true }),
          stats: m.workspace_id ? (stats.byWorkspace[m.workspace_id] || { total: 0, last30: 0, upcoming: 0 }) : null,
          // The owner may pick which of THEIR OWN services show; for other
          // members this stays with the member.
          services: m.workspace_id === workspaceId ? mine : undefined,
        }));
        return ok(res, {
          role: 'owner',
          shop: serializeShop(shop, { owner: true }),
          members: roster,
          stats: { pageViews: stats.pageViews, total: stats.total, last30: stats.last30 },
        });
      }
      // Member view: own listing only.
      return ok(res, {
        role: 'member',
        shop: serializeShop(shop),
        me: member ? serializeMember(member) : null,
        myStats: member?.status === 'active' ? await memberStats(shop.id, workspaceId) : null,
        services: await ownServices(workspaceId),
        teamNames: members.filter((m) => m.status === 'active' && m.biz_name).map((m) => m.biz_name),
      });
    }

    if (!isOwner) return notFound(res, 'Shop page not found');
    if (req.method === 'DELETE') {
      await deleteShop({ shop });
      recordWorkspaceAudit(req, { workspaceId, actor: { id: user.id }, action: 'shop.delete', target: shop.id, meta: { slug: shop.slug } }).catch(() => {});
      return ok(res, { deleted: true });
    }
    const body = await readBody(req);
    const updated = await updateShop({ shop, body });
    recordWorkspaceAudit(req, { workspaceId, actor: { id: user.id }, action: 'shop.update', target: shop.id, meta: { fields: Object.keys(body || {}).slice(0, 20) } }).catch(() => {});
    return ok(res, { shop: serializeShop(updated, { owner: true }) });
  } catch (err) {
    if (err instanceof ShopError) return res.status(err.status).json({ error: err.message, code: err.code || undefined });
    return serverError(res, err);
  }
}

// The caller's OWN services (to pick which show on the shop). Never
// another workspace's.
async function ownServices(workspaceId) {
  const { rows } = await sql`
    SELECT id, name, price, duration_minutes, visibility FROM services
     WHERE workspace_id = ${workspaceId} AND visibility <> 'only_me' ORDER BY display_order, created_at`;
  return rows.map((r) => ({ id: r.id, name: r.name, price: Number(r.price || 0), durationMinutes: r.duration_minutes, visibility: r.visibility || 'public' }));
}
