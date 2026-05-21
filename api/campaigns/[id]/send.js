// POST /api/campaigns/:id/send
//   body { test: true } → send a single preview to the owner's own email
//   (no status change). Otherwise send the campaign to its audience and
//   mark it sent.
import { sql } from '../../_lib/db.js';
import { requireUser, ensureWorkspace } from '../../_lib/auth.js';
import { requireActiveSubscription } from '../../_lib/subscriptionGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { sendEmail } from '../../_lib/email.js';
import { serializeCampaign, sendCampaign, buildCampaignEmail } from '../../_lib/campaigns.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (!(await requireActiveSubscription(workspaceId, req, res))) return;

    const id = (req.query.id || '').toString();
    const { rows } = await sql`SELECT * FROM email_campaigns WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    const campaign = rows[0];
    if (!campaign) return notFound(res, 'Campaign not found');

    const body = await readBody(req);

    // Test send → one email to the owner, no status change.
    if (body.test) {
      if (!user.email) return badRequest(res, 'Your account has no email to test-send to');
      const { subject, html } = await buildCampaignEmail({ workspaceId, campaign });
      const r = await sendEmail({ to: user.email, subject: `[Test] ${subject}`, html });
      return ok(res, { test: true, sent: true, to: user.email, result: r ? 'ok' : 'ok' });
    }

    if (campaign.status === 'sent') return badRequest(res, 'This campaign was already sent');
    if (!campaign.subject?.trim()) return badRequest(res, 'Add a subject before sending');

    // Mark sending (best-effort guard against a double-click double-send).
    await sql`UPDATE email_campaigns SET status = 'sending', updated_at = NOW()
              WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = 'draft'`;

    let result;
    try {
      result = await sendCampaign({ workspaceId, campaign });
    } catch (err) {
      await sql`UPDATE email_campaigns SET status = 'draft', last_error = ${String(err.message).slice(0, 300)}, updated_at = NOW()
                WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return serverError(res, err);
    }

    const upd = await sql`
      UPDATE email_campaigns SET
        status = 'sent', sent_at = NOW(),
        recipient_count = ${result.recipientCount},
        sent_count = ${result.sent}, failed_count = ${result.failed},
        last_error = NULL, updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;
    return ok(res, { campaign: serializeCampaign(upd.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
