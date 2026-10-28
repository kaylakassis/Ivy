// /api/ivy
//   GET  → list sessions + workspace context (the "what Ivy sees" panel)
//   POST → send a message. If body.sessionId is missing, a new session is
//          created from the first message's title. Server generates the reply
//          and persists both turns, then returns them in one JSON body.
//          POST /api/ivy/stream is the same turn with the reply streamed;
//          the shared pipeline lives in api/_lib/ivyTurn.js.

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  serializeSession, workspaceContext, buildBriefing, generateReply, getDailyUsage,
} from '../_lib/ivy.js';
import { beginTurn, finishTurn } from '../_lib/ivyTurn.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    // Ivy is intentionally NOT paywalled - every signed-in owner gets up
    // to DAILY_REQUEST_CAP (200) messages/day from the moment they sign
    // up, including while still on the paywall. The cap inside
    // generateReply is the real throttle; gating with the subscription
    // check would 402 the chat bubble for brand-new owners who haven't
    // started their trial yet (the exact moment Ivy can be most
    // persuasive about converting them).
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const safe = async (p, fallback) => { try { return await p; } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[ivy GET] sub-query failed:', e.message);
        return fallback;
      } };
      const sessions = await safe(sql`
        SELECT * FROM ivy_sessions WHERE workspace_id = ${workspaceId}
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 100
      `, { rows: [] });
      const context = await safe(workspaceContext(workspaceId), {});
      // Proactive "here's your day" the UI greets the owner with. Best-effort:
      // a briefing failure must never break loading the chat.
      const briefing = await safe(buildBriefing(workspaceId), null);
      // Cheap env-var probe so the UI can show a "mock mode" warning even
      // before the user has sent their first message. Doesn't actually
      // call the provider - that happens on POST.
      const hasKey = !!process.env.ANTHROPIC_API_KEY;
      // Fallback must match getDailyUsage's real shape - the usage meter
      // reads usage.outputTokens.toLocaleString() and would TypeError on
      // the old { used, limit } placeholder.
      const usage = await safe(getDailyUsage(workspaceId), { requests: 0, outputTokens: 0, requestCap: 0, outputTokenCap: 0, monthMessages: 0, monthAllowance: 0, monthResetsAt: null });
      return ok(res, {
        sessions: sessions.rows.map((r) => serializeSession(r)),
        context,
        briefing,
        mode: hasKey ? 'live' : 'mock',
        modeError: hasKey ? null : 'no-api-key',
        usage,
      });
    }

    if (req.method === 'POST') {
      // Per-minute throttle on the expensive path (each POST can fan out
      // to several DB reads + up to 8 provider calls). The daily token cap
      // inside generateReply is the budget ceiling; this stops a tight loop
      // from hammering the endpoint. Super-admins bypass (see enforce()).
      if (await enforce(req, res, [
        { key: `ivy:ws:${workspaceId}`, max: 20, windowSeconds: 60 },
        { key: `ivy:ip:${getClientIp(req)}`, max: 40, windowSeconds: 60 },
      ])) return;

      const body = await readBody(req);
      const turn = await beginTurn(body, workspaceId);
      if (turn.error) return badRequest(res, turn.error);

      const reply = await generateReply(turn.text, turn.ctx, turn.history, workspaceId, turn.attachment, user.id);
      return ok(res, await finishTurn({ ...turn, reply, workspaceId }));
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
