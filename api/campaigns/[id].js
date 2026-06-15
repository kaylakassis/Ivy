// /api/campaigns/:id  — GET one, PATCH a draft, DELETE.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { serializeCampaign, VALID_AUDIENCE } from '../_lib/campaigns.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const id = (req.query.id || '').toString();
    const { rows } = await sql`SELECT * FROM email_campaigns WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    const campaign = rows[0];
    if (!campaign) return notFound(res, 'Campaign not found');

    if (req.method === 'GET') return ok(res, { campaign: serializeCampaign(campaign) });

    if (req.method === 'PATCH') {
      if (campaign.status !== 'draft') return badRequest(res, 'Only draft campaigns can be edited');
      const body = await readBody(req);
      const subject  = 'subject' in body ? (body.subject || '').toString().slice(0, 300) : campaign.subject;
      const text     = 'body' in body ? (body.body || '').toString().slice(0, 20000) : campaign.body;
      const audience = 'audience' in body
        ? (VALID_AUDIENCE(body.audience) ? body.audience : campaign.audience)
        : campaign.audience;
      const upd = await sql`
        UPDATE email_campaigns SET subject = ${subject}, body = ${text}, audience = ${audience}, updated_at = NOW()
        WHERE id = ${id} AND workspace_id = ${workspaceId} RETURNING *
      `;
      return ok(res, { campaign: serializeCampaign(upd.rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM email_campaigns WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
