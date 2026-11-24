// GET  /api/admin/legal-notice           how many people would get the notice, and how many already have
// POST /api/admin/legal-notice {confirm} send it (super admin only)
//
// The "we updated our Terms of Service and Privacy Policy" email for
// existing users (api/_lib/legalNotice.js). Nothing is sent until an admin
// presses the button, and nobody is ever sent it twice. A large list is
// worked through across presses: the answer says how many are left.
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { readBody } from '../_lib/body.js';
import { recordAudit } from '../_lib/audit.js';
import { countLegalNoticeRecipients, countLegalNoticeSent, sendLegalNotices, legalNoticeVersion, renderLegalNotice } from '../_lib/legalNotice.js';
import { LEGAL_EFFECTIVE_LABEL } from '../_lib/legal.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    if (req.method === 'GET') {
      const [waiting, alreadySent] = await Promise.all([countLegalNoticeRecipients(), countLegalNoticeSent()]);
      const sample = renderLegalNotice({ firstName: 'Alex' });
      return ok(res, { version: legalNoticeVersion(), effective: LEGAL_EFFECTIVE_LABEL, waiting, alreadySent, subject: sample.subject, previewLines: sample.lines });
    }
    const body = await readBody(req);
    if (body?.confirm !== true) return badRequest(res, 'Confirm before sending.');
    const out = await sendLegalNotices({ budgetMs: 40000 });
    const actor = await getAdminActor(req);
    await recordAudit(req, { actor, action: 'legal_notice_sent', meta: { version: legalNoticeVersion(), ...out } });
    return ok(res, { ok: true, ...out, alreadySent: await countLegalNoticeSent() });
  } catch (err) {
    return serverError(res, err);
  }
}
