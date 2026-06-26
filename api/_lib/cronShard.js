// Cron helpers — sharding + deadline-driven batch loops.
//
// Why this exists: every cron in api/cron/* hits one of two scaling
// walls long before it runs out of *real* candidates.
//
//   1. MAX_PER_RUN caps. Most crons set a per-run LIMIT (1000 / 1500 /
//      2000 …) to bound work in case a misconfig produces a candidate
//      flood. At low scale these are safety rails. At 100K+ active
//      workspaces they become DROP rails — the cron silently skips
//      everything past the cap and never catches up. The fix is
//      processing the candidate set in repeated batches inside one
//      invocation until either it's empty or we approach the 300s
//      function timeout. That's `withDeadline` here.
//
//   2. Single-runner throughput. Even with deadline loops, one cron
//      invocation tops out at the Resend / Twilio / DB write throughput
//      a single process can sustain (~8 emails/sec). Past that the only
//      lever is horizontal: add more concurrent cron entries that each
//      handle a disjoint slice of the candidate set keyed on
//      workspace_id hash. That's `shardFromReq` + `shardClause` here.
//
// Both are OPT-IN. A cron that hasn't been updated keeps working
// exactly as before. A cron that adopts only `withDeadline` keeps
// scanning the whole candidate set (no hash filter). A cron that adopts
// both can be replicated in vercel.json with `?shard=0&shards=4`,
// `?shard=1&shards=4`, … to fan out N-way without any code change.
//
// Usage:
//   const { shard, shards } = shardFromReq(req);
//   const filter = shardClause({ shard, shards }, 'w.id');
//   await withDeadline(async (deadline) => {
//     while (Date.now() < deadline) {
//       const batch = await sql.query(
//         `SELECT … FROM workspaces w WHERE … ${filter} LIMIT 200`,
//       );
//       if (batch.rows.length === 0) break;
//       // …process batch…
//     }
//   });

// Read & validate ?shard=K&shards=N from the cron request. Defaults to
// {shard: 0, shards: 1} which means "process every candidate" — preserves
// the historical behavior of every cron entry in vercel.json that doesn't
// carry params.
export function shardFromReq(req) {
  const q = req?.query || {};
  // Cap at 64 shards — defends against typos like ?shards=10000 that
  // would create a vanishingly small bucket per shard.
  const shards = clampInt(q.shards, 1, 64, 1);
  // shard must be in [0, shards-1]; clamp protects the query from
  // producing zero rows when an operator typos `?shard=4&shards=4`.
  const shard  = clampInt(q.shard, 0, Math.max(0, shards - 1), 0);
  return { shard, shards };
}

function clampInt(raw, lo, hi, dflt) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// SQL fragment that filters a candidate set to the rows whose
// workspace_id falls in this shard's hash bucket. Returns a non-empty
// string ALWAYS starting with ` AND `, suitable for concatenation into
// an existing WHERE clause; returns the empty string when unsharded so
// the cron's SQL is unchanged from the historical form.
//
// `columnRef` is the SQL expression for the workspace_id column in the
// caller's query (e.g. 'w.id', 'workspace_id', 'r.workspace_id'). It is
// interpolated as literal SQL — DO NOT pass user-controlled input. The
// shard/shards integers ARE caller-supplied (via query string) but
// already validated by shardFromReq, so the literal embed below is safe.
//
// The `((x % N + N) % N)` dance: Postgres `%` on `hashtext()` can
// return negative bucket ids when hashtext is negative; the offset
// re-normalizes to [0, N) so shard 0 actually matches the hash-zero
// rows instead of accidentally matching the hash-negative rows.
export function shardClause({ shards, shard }, columnRef = 'workspace_id') {
  if (!Number.isInteger(shards) || shards <= 1) return '';
  if (!Number.isInteger(shard) || shard < 0 || shard >= shards) return '';
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(columnRef)) {
    throw new Error(`shardClause: unsafe columnRef ${JSON.stringify(columnRef)}`);
  }
  return ` AND ((hashtext(${columnRef}::text) % ${shards} + ${shards}) % ${shards}) = ${shard}`;
}

// Run `fn(deadlineMs)` once with a deadline timestamp passed in. The
// deadline is `Date.now() + budgetMs - SAFETY_MARGIN_MS`, so a cron that
// runs at the 300s Vercel ceiling should call `withDeadline(fn, {
// budgetMs: 300_000 })` and `fn` should bail out of its batch loop as
// soon as `Date.now() >= deadline`.
//
// Why pass the deadline instead of providing a cancellation token: the
// loops we're driving already break naturally on an empty result set
// and on per-batch errors; the only missing piece is "have I been
// running too long?" — which is a single `Date.now()` check per batch
// rather than a Promise.race + AbortController harness.
//
// SAFETY_MARGIN_MS is how much of the function budget we reserve for
// the final batch to finish + the response to flush. 30 seconds is
// generous; if a single batch reliably finishes in <5s the caller can
// override `safetyMs`.
const DEFAULT_BUDGET_MS = 270_000;   // 4m30s of a 5m Vercel cron budget
const DEFAULT_SAFETY_MS = 30_000;    // leave 30s for the final batch + response

export async function withDeadline(fn, { budgetMs = DEFAULT_BUDGET_MS, safetyMs = DEFAULT_SAFETY_MS } = {}) {
  // hardcoded ceiling: don't let a caller accidentally set a budget
  // bigger than Vercel's 300s function max.
  const budget = Math.max(1_000, Math.min(290_000, budgetMs));
  const safety = Math.max(0,     Math.min(60_000,  safetyMs));
  const deadline = Date.now() + Math.max(1_000, budget - safety);
  return fn(deadline);
}

// Termination-reason helper. Each cron's response includes one of these
// strings so the admin cron-health view can see WHY a run stopped:
//   'empty'    — candidate set drained, healthy steady state
//   'deadline' — function approaching Vercel's 300s cap, work still
//                pending. Operator should add a shard entry to vercel.json.
//   'cap'      — safety per-run ceiling hit (a paranoia rail). Almost
//                certainly indicates a runaway loop or a misconfigured
//                cron — investigate before adding capacity.
//
// Usage at the bottom of a cron handler:
//   const terminatedBy = terminationReason({
//     emptied: !more,
//     hitCap:  sent >= SAFETY_PER_RUN,
//   });
//   return ok(res, { ..., terminatedBy });
//
// trackCron's extractMetrics picks up the string into the metrics JSONB
// automatically — no further plumbing needed.
export function terminationReason({ emptied, hitCap }) {
  if (emptied) return 'empty';
  if (hitCap)  return 'cap';
  return 'deadline';
}
