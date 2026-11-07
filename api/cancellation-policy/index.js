// /api/cancellation-policy  (owner only)
//   GET → { policy (current version or null), versions: [...], settings,
//           services: [{ id, name, deposit..., lateCancelFee, windowHours, noShowFee }],
//           cardPayments: bool,
//           businessName, businessCategory, packages: { any, useOn } }
//         The last three only pre-fill "Help me write it" (see
//         src/features/finance/policyGenerator.js policyOptionsFromIvy).
//   PUT → body { text?, requireAcceptance?, showOnBookingPage?, showInSiteFooter?,
//                refundDepositOutsideWindow? }
//         Saving new text adds a version (old ones are kept). The switch
//         cannot be turned on while there is no policy text.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { recordWorkspaceAudit } from '../_lib/audit.js';
import { serializeService } from '../_lib/calendar.js';
import {
  getCurrentPolicy, listPolicyVersions, getPolicySettings, updateCancellationPolicy, MAX_POLICY_CHARS,
  policyWriterContext,
} from '../_lib/cancellationPolicy.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

async function loadState(workspaceId) {
  const [policy, versions, settings, svc, fs, biz] = await Promise.all([
    getCurrentPolicy(workspaceId),
    listPolicyVersions(workspaceId),
    getPolicySettings(workspaceId),
    sql`SELECT * FROM services WHERE workspace_id = ${workspaceId} AND visibility <> 'only_me' ORDER BY display_order, created_at LIMIT 200`,
    sql`SELECT payment_provider, stripe_connect_user_id, stripe_secret_encrypted, currency
          FROM finance_settings WHERE workspace_id = ${workspaceId} LIMIT 1`,
    policyWriterContext(workspaceId),
  ]);
  const f = fs.rows[0] || {};
  return {
    ...biz,
    policy,
    versions: versions.map((v) => ({ id: v.id, version: v.version, createdAt: v.createdAt, text: v.text })),
    settings,
    maxChars: MAX_POLICY_CHARS,
    currency: String(f.currency || 'USD').toUpperCase(),
    // Late-cancel / no-show fees can be charged automatically only to a
    // card saved through Stripe.
    cardPayments: (f.payment_provider || 'stripe') === 'stripe' && !!(f.stripe_connect_user_id || f.stripe_secret_encrypted),
    services: svc.rows.map((r) => {
      const s = serializeService(r);
      return {
        id: s.id, name: s.name, price: s.price,
        depositType: s.depositType, depositAmount: s.depositAmount,
        lateCancelFee: s.cancellationFeeAmount, windowHours: s.cancellationWindowHours,
        noShowFee: s.noShowFeeAmount,
      };
    }),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PUT') return methodNotAllowed(res, ['GET', 'PUT']);
  if (req.method !== 'GET' && !requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') return ok(res, await loadState(workspaceId));

    if (await enforce(req, res, [{ key: `cpolicy-save:ws:${workspaceId}`, max: 60, windowSeconds: 3600 }])) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return badRequest(res, 'Nothing to save');

    const out = await updateCancellationPolicy({ workspaceId, userId: user.id, body });
    if (out.error) return badRequest(res, out.error);
    const { createdVersion, after, changed } = out;
    if (createdVersion || changed.length) {
      recordWorkspaceAudit(req, {
        workspaceId, actor: user,
        action: 'cancellation_policy.update',
        target: { kind: 'cancellation_policy', id: createdVersion?.id || workspaceId },
        meta: {
          ...(createdVersion ? { version: createdVersion.version, sha256: createdVersion.sha256 } : {}),
          ...(changed.length ? { settings: Object.fromEntries(changed.map((k) => [k, after[k]])) } : {}),
        },
      });
    }
    return ok(res, { ...(await loadState(workspaceId)), createdVersion: createdVersion ? createdVersion.version : null });
  } catch (err) {
    return serverError(res, err);
  }
}
