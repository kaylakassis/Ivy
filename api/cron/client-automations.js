// /api/cron/client-automations - hourly.
//
// Sends the owner's client-facing automations (api/_lib/clientAutomations.js):
// birthday messages and "we'd love to see you again" check-ins, for every
// business whose LOCAL time is between 9am and 7pm. Each client is claimed
// (one ledger row per client, kind and period) before anything is sent, so
// a cron event delivered twice, or a manual run alongside the scheduled
// one, still sends once. Sharded and deadline-driven like the other crons
// (api/_lib/cronShard.js): add ?shard=K&shards=N entries to fan out.
import { cronAuthorized } from '../_lib/cronAuth.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { shardFromReq, shardClause, withDeadline } from '../_lib/cronShard.js';
import { runClientAutomations } from '../_lib/clientAutomations.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    await ensureSchemaApplied();
    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'w.id');
    const out = await withDeadline((deadline) => runClientAutomations({ shardFilter, deadline }));
    return ok(res, { shard, shards, ...out });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('client-automations', handler);
