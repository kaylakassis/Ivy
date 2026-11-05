// After a send goes wrong on the way back (the stream was cut off, the app
// lost signal, the server answered with an error after it had started), the
// server may well have finished the turn: Ivy's tools ran and her reply was
// saved. Showing "please try again" then is false, and a resend can do the
// work twice. Instead the chat is reloaded from the server and the owner
// sees what was actually saved.
//
// Pure helpers plus one loop that takes the api object, so the logic can be
// tested without a browser.

// The title the server gives a new chat (beginTurn in api/_lib/ivyTurn.js).
export function sessionTitleFor(text) {
  return String(text || '').trim().slice(0, 60).replace(/\s+/g, ' ');
}

// For a chat that was new when the message went out: the newest session with
// that title created around the time of the send (clocks may differ a little).
export function pickNewSession(sessions, text, startedAt) {
  const title = sessionTitleFor(text);
  const since = Number(startedAt || 0) - 5 * 60 * 1000;
  let best = null;
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || (s.title || '') !== title) continue;
    const at = Date.parse(s.createdAt || '') || 0;
    if (at < since) continue;
    if (!best || at > (Date.parse(best.createdAt || '') || 0)) best = s;
  }
  return best;
}

// In a chat's saved messages, finds the owner's message that was just sent
// (the newest 'me' message starting with its text, saved around the time of
// the send, so an earlier identical question is never mistaken for it) and
// Ivy's reply after it. Returns { found: bool, reply: message|null }.
export function findSavedReply(messages, text, startedAt = 0) {
  const list = Array.isArray(messages) ? messages : [];
  const want = String(text || '').trim();
  const since = startedAt ? Number(startedAt) - 5 * 60 * 1000 : 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.role !== 'me') continue;
    if (want && !String(m.text || '').trim().startsWith(want)) continue;
    if (since && (Date.parse(m.createdAt || '') || 0) < since) return { found: false, reply: null };
    const reply = list.slice(i + 1).find((x) => x?.role === 'ivy') || null;
    return { found: true, reply };
  }
  return { found: false, reply: null };
}

// Polls the server until Ivy's saved reply to `text` shows up, or gives up.
// Returns { sessionId, session, messages, replied } or null when the owner's
// message is not on the server at all.
export async function recoverTurn({ api, sessionId, text, startedAt, tries = 8, waitMs = 4000, sleep }) {
  const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let id = sessionId || null;
  let last = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await pause(waitMs);
    try {
      if (!id) {
        const r = await api.get('/ivy', { timeoutMs: 15000 });
        const s = pickNewSession(r?.sessions, text, startedAt);
        if (!s) continue;
        id = s.id;
      }
      const r = await api.get('/ivy/' + id, { timeoutMs: 15000 });
      const messages = r?.messages || [];
      const hit = findSavedReply(messages, text, startedAt);
      if (!hit.found) continue;
      last = { sessionId: id, session: r?.session || null, messages, replied: !!hit.reply };
      if (hit.reply) return last;
    } catch {
      // Still offline or the server is busy: try again after the pause.
    }
  }
  return last;
}
