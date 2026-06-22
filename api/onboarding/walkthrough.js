// POST /api/onboarding/walkthrough   { event: 'started' | 'aha_clicked' | 'aha_skipped' }
//
// Lightweight telemetry for the post-onboarding Walkthrough's aha-moment
// step (src/features/onboarding/Walkthrough.jsx). Without this, the
// funnel reads signup→trialStarted→converted but can't say whether the
// "Get my booking link" CTA the aha screen renders is doing any work.
//
// Idempotent per event — first stamp wins, repeats are no-ops, so a
// reloaded tab or a double-click can't skew the count. No PII; we're
// only stamping a timestamp on the owner's own workspace row.
//
// Exempt from the subscription gate: the walkthrough runs at the moment
// an owner finishes onboarding, which can be BEFORE they cross the hard
// paywall on web (the wall fires on the first gated endpoint hit).
// ensureWorkspace is enough.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const VALID_EVENTS = new Set(['started', 'aha_clicked', 'aha_skipped']);

const COLUMN_FOR = {
  started:     'walkthrough_started_at',
  aha_clicked: 'aha_cta_clicked_at',
  aha_skipped: 'aha_cta_skipped_at',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const body = await readBody(req).catch(() => ({}));
    const event = String(body?.event || '');
    if (!VALID_EVENTS.has(event)) return badRequest(res, 'Unknown event');

    // Stamp only on the first occurrence — `column IS NULL` makes the
    // UPDATE a no-op for repeats. Avoids race + reload double-counts.
    const column = COLUMN_FOR[event];
    await sql.query(
      `UPDATE workspaces SET ${column} = NOW()
        WHERE id = $1 AND ${column} IS NULL`,
      [workspaceId],
    );
    return ok(res, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}
