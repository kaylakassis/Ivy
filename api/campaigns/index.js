// /api/campaigns
//   GET  → list campaigns; or ?previewAudience=<aud> → { count } for the
//          composer's live recipient count.
//   POST → create a draft.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { serializeCampaign, VALID_AUDIENCE, resolveAudience } from '../_lib/campaigns.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD'
        && !(await requireActiveSubscription(workspaceId, req, res))) return;

    if (req.method === 'GET') {
      const previewAudience = req.query.previewAudience;
      if (previewAudience) {
        if (!VALID_AUDIENCE(previewAudience)) return badRequest(res, 'Invalid audience');
        const list = await resolveAudience(workspaceId, previewAudience);
        return ok(res, { count: list.length });
      }
      const { rows } = await sql`
        SELECT * FROM email_campaigns WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC LIMIT 200
      `;
      return ok(res, { campaigns: rows.map(serializeCampaign) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const subject  = (body.subject || '').toString().slice(0, 300);
      const text     = (body.body || '').toString().slice(0, 20000);
      const audience = VALID_AUDIENCE(body.audience) ? body.audience : 'all-clients';
      const ins = await sql`
        INSERT INTO email_campaigns (workspace_id, subject, body, audience)
        VALUES (${workspaceId}, ${subject}, ${text}, ${audience})
        RETURNING *
      `;
      return created(res, { campaign: serializeCampaign(ins.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
