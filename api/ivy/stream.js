// /api/ivy/stream
//   POST → the same turn as POST /api/ivy, but Ivy's reply streams to the
//          client as Server-Sent Events while the model writes it:
//
//     event: delta   data: { text }       a chunk of the reply, in order
//     event: reset   data: {}             forget the text shown so far (the
//                                         turn went on to call a tool; the
//                                         reply is the next turn's text)
//     event: done    data: { ...payload } the exact body POST /api/ivy returns
//                                         (session, messages, context, mode,
//                                         modeError, usage)
//     event: error   data: { message, ...payload? }
//                                         the reply could not be produced.
//                                         When the provider failed, the same
//                                         honest line the plain endpoint
//                                         returns was saved as Ivy's message
//                                         and the payload is included, so
//                                         the chat ends up identical either
//                                         way. Without a payload, nothing
//                                         further was saved.
//
//   Comment lines (": ...") keep the connection warm through tool loops.
//   Everything that is not the delivery of text (moderation, allowance and
//   daily caps, retries, usage, persistence, pending actions) happens once,
//   in generateReply / beginTurn / finishTurn, exactly as for POST /api/ivy.
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { generateReply } from '../_lib/ivy.js';
import { beginTurn, finishTurn } from '../_lib/ivyTurn.js';
import { badRequest, methodNotAllowed, serverError } from '../_lib/json.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { reportError } from '../_lib/monitoring.js';
import { redact } from '../_lib/logRedact.js';

// Vercel's Node runtime buffers a function's response unless the function
// opts into streaming; maxDuration comes from vercel.json (api/ivy/**).
export const config = { supportsResponseStreaming: true };

// Pings every 10s: tool loops can go 20-30s without a text delta, and idle
// proxies (and WKWebView) drop a silent connection sooner than that.
const PING_MS = 10_000;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  let started = false;
  let ping = null;
  const sse = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const user = await requireUser(req, res);
    if (!user) return;
    // Not paywalled, like POST /api/ivy: the caps inside generateReply are
    // the throttle (see the comment there).
    const workspaceId = await ensureWorkspace(user.id);
    // Same keys as POST /api/ivy, so a client that falls back from one to the
    // other spends the same per-minute budget.
    if (await enforce(req, res, [
      { key: `ivy:ws:${workspaceId}`, max: 20, windowSeconds: 60 },
      { key: `ivy:ip:${getClientIp(req)}`, max: 40, windowSeconds: 60 },
    ])) return;

    const body = await readBody(req);
    const turn = await beginTurn(body, workspaceId);
    if (turn.error) return badRequest(res, turn.error);

    // From here on the response is a stream. Headers go out at once so the
    // client knows the turn was accepted before the model has said a word.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    started = true;
    res.write(': connected\n\n');
    ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* client gone */ } }, PING_MS);

    const reply = await generateReply(turn.text, turn.ctx, turn.history, workspaceId, turn.attachment, user.id, {
      onDelta: (text) => sse('delta', { text }),
      onReset: () => sse('reset', {}),
    });
    const payload = await finishTurn({ ...turn, reply, workspaceId });
    if (reply.failed) sse('error', { message: reply.text, ...payload });
    else sse('done', payload);
    res.end();
  } catch (err) {
    if (!started) return serverError(res, err);
    // Headers are gone, so the failure travels as an event. The owner's
    // message was already saved; the client must not resend it.
    // eslint-disable-next-line no-console
    console.error('[ivy stream] failed after start:', redact(err?.stack || err?.message || String(err)));
    try { reportError(err, { req }); } catch { /* ignore */ }
    try {
      sse('error', { message: 'Ivy took too long to answer that one. Please try again.' });
      res.end();
    } catch { /* connection already closed */ }
  } finally {
    if (ping) clearInterval(ping);
  }
}
