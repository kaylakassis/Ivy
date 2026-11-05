// Ivy store. One initial GET pulls sessions + workspace context; clicking a
// session pulls its messages on demand. Sending posts to /api/ivy/stream and
// Ivy's reply grows in place as the server streams it (see stream.js); the
// final payload is the same one POST /api/ivy returns, and that plain
// endpoint is the fallback when the stream cannot start.
//
// State lives in a provider mounted in AppShell so every consumer
// (the floating IvyDock at the corner + the full-page IvyPro route)
// shares the same sessions, messages, draft, and in-flight request.
// Without the provider each useIvy() call would maintain its own copy
// and a chat started in the dock wouldn't carry into the full-page
// view (and vice versa).
import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../lib/api.js';
import { streamReply } from './stream.js';
import { recoverTurn } from './recover.js';
import { announceIvyActionsRan } from './openIvy.js';

const EMPTY_CTX = {
  revenueThisMonth: 0, openInvoices: 0, activeClients: 0,
  upcomingSessions: 0, quietClients: 0,
};

const IvyCtx = createContext(null);

// The placeholder for a reply that is still arriving. Chunks are coalesced to
// one state update per frame (a reply can arrive as dozens of pieces a
// second). The bubble is appended on the first chunk, so the thinking dots
// stay until Ivy has actually said something, and carries `streaming: true`
// so the UI can draw the caret and hold back the dots.
function liveBubble(setMessages) {
  const id = 'stream-' + Date.now();
  let text = '';
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const snapshot = text;
    setMessages((xs) => {
      if (!snapshot) return xs.filter((m) => m.id !== id);
      if (xs.some((m) => m.id === id)) return xs.map((m) => (m.id === id ? { ...m, text: snapshot } : m));
      return [...xs, { id, role: 'ivy', text: snapshot, streaming: true, createdAt: new Date().toISOString() }];
    });
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  };
  return {
    id,
    append(chunk) { text += chunk; schedule(); },
    set(whole) { text = whole; schedule(); },
    clear() { text = ''; setMessages((xs) => xs.filter((m) => m.id !== id)); },
  };
}

export function IvyProvider({ children }) {
  const value = useIvyState();
  return <IvyCtx.Provider value={value}>{children}</IvyCtx.Provider>;
}

// Returns the live store when wrapped in <IvyProvider> (the normal
// case - AppShell mounts it). When called outside the provider (a
// dev preview, a refactor that moves a consumer up the tree), we
// fall back to a fresh local store so the consumer renders instead
// of throwing - throwing would propagate through the React tree and
// crash the whole app via the root ErrorBoundary.
export function useIvy() {
  const ctx = useContext(IvyCtx);
  // useIvyState is a hook - must be called unconditionally on every
  // render. We always call it, but with enabled:false whenever the
  // provider's store exists, so the shadow store no longer issues a
  // duplicate GET /api/ivy (the heaviest dashboard query) on every
  // consumer mount. The disabled hook is inert local state.
  const fallback = useIvyState({ enabled: !ctx });
  return ctx || fallback;
}

function useIvyState({ enabled = true } = {}) {
  const [sessions, setSessions]   = useState([]);
  const [activeId, setActiveId]   = useState(null);
  const [messages, setMessages]   = useState([]);
  const [context, setContext]     = useState(EMPTY_CTX);
  const [briefing, setBriefing]   = useState(null);
  const [loading, setLoading]     = useState(true);
  const [thinking, setThinking]   = useState(false);
  const [error, setError]         = useState(null);
  const [mode, setMode]           = useState(null);     // 'live' | 'mock' | null (unknown)
  const [modeError, setModeError] = useState(null);
  const [usage, setUsage]         = useState(null);
  const msgCacheRef = useRef(new Map()); // sessionId -> messages[]

  useEffect(() => {
    if (!enabled) { setLoading(false); return undefined; }
    let live = true;
    // 20s timeout so a slow/hung Ivy context query surfaces as an
    // error + retry instead of an infinite "Loading Ivy…" spinner.
    api.get('/ivy', { timeoutMs: 20000 })
      .then((r) => {
        if (!live) return;
        setSessions(r.sessions || []);
        setContext(r.context || EMPTY_CTX);
        setBriefing(r.briefing || null);
        if (r.mode) setMode(r.mode);
        setModeError(r.modeError || null);
        if (r.usage) setUsage(r.usage);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [enabled]);

  const openSession = useCallback(async (id) => {
    setActiveId(id);
    if (!id) { setMessages([]); return; }
    const cached = msgCacheRef.current.get(id);
    if (cached) { setMessages(cached); return; }
    setMessages([]);
    try {
      const r = await api.get('/ivy/' + id);
      msgCacheRef.current.set(id, r.messages || []);
      setMessages(r.messages || []);
    } catch (e) {
      setError(e);
    }
  }, []);

  const newChat = useCallback(() => {
    setActiveId(null);
    setMessages([]);
  }, []);

  // `text` may be empty when an attachment is supplied - the server treats
  // that as an implicit "analyze this file" prompt.
  const send = useCallback(async (text, attachment = null) => {
    const t = (text || '').trim();
    // attachment: one file { filename, mediaType, base64 } or, for photos,
    // { photos: n, pieces: [...] } (several image pieces from src/lib/ivyImage.js).
    const photoSet = attachment && Array.isArray(attachment.pieces) ? attachment : null;
    if ((!t && !attachment) || thinking) return;
    setError(null);

    // Optimistic append of the user's own bubble. Show a paperclip line
    // when an attachment is included so the chat doesn't look empty.
    const label = photoSet
      ? `📷 ${photoSet.photos === 1 ? '1 photo' : `${photoSet.photos} photos`}`
      : attachment ? `📎 ${attachment.filename || 'file'}` : '';
    const optimisticText = label ? (t ? `${t}\n\n${label}` : label) : t;
    const optimistic = { id: 'tmp-' + Date.now(), role: 'me', text: optimisticText, createdAt: new Date().toISOString() };
    setMessages((xs) => [...xs, optimistic]);
    setThinking(true);

    const payload = {
      text: t,
      sessionId: activeId || undefined,
      ...(photoSet
        ? { attachments: photoSet.pieces, photoCount: photoSet.photos }
        : { attachment: attachment || undefined }),
    };
    // Ivy's bubble while the reply streams: appears with the first chunk and
    // grows from there; gone once the real message replaces it.
    const live = liveBubble(setMessages);
    const startedAt = Date.now();

    try {
      let result;
      try {
        result = await streamReply(payload, { onDelta: live.append, onReset: live.clear, onReplace: live.set });
      } catch (e) {
        live.clear();
        // The stream never started (network, a 5xx, a runtime that cannot
        // stream): one plain request instead. Never after text has shown or
        // after a cut-off: the server may already hold the reply, and a
        // resend would post the owner's message twice. 4xx are deterministic.
        const transient = e?.status === 0 || (e?.status >= 500 && e?.status < 600);
        if (e?.textArrived || e?.cutOff || !transient) throw e;
        result = { event: 'done', payload: await api.post('/ivy', payload) };
      }
      const r = result.payload || {};
      // `error` without the saved turn: nothing to show but the reason.
      if (result.event === 'error' && !Array.isArray(r.messages)) {
        throw Object.assign(new Error(r.message || "Ivy couldn't answer that one. Please try again."), { fromStream: true });
      }
      live.clear();
      const realMessages = r.messages || [];
      setMessages((xs) => {
        // Replace optimistic with real pair
        const withoutOptimistic = xs.filter((m) => m.id !== optimistic.id && m.id !== live.id);
        const next = [...withoutOptimistic, ...realMessages];
        if (r.session) msgCacheRef.current.set(r.session.id, next);
        return next;
      });
      if (r.session) {
        setSessions((xs) => {
          const filtered = xs.filter((s) => s.id !== r.session.id);
          return [r.session, ...filtered];
        });
        if (!activeId) setActiveId(r.session.id);
      }
      if (r.context) setContext(r.context);
      if (r.mode) setMode(r.mode);
      setModeError(r.modeError || null);
      if (r.usage) setUsage(r.usage);
    } catch (e) {
      live.clear();
      // The turn may have finished on the server even though its answer never
      // reached us (a cut-off stream, lost signal, an error after the server
      // started). Saying "try again" then would be false, and a resend could
      // do the work twice, so first reload the chat and show what was saved.
      // A 4xx was refused before anything ran, so there is nothing to find.
      const status = Number(e?.status) || 0;
      if (!(status >= 400 && status < 500)) {
        const rec = await recoverTurn({ api, sessionId: activeId, text: optimisticText, startedAt });
        if (rec) {
          setMessages(rec.messages);
          msgCacheRef.current.set(rec.sessionId, rec.messages);
          if (rec.session) setSessions((xs) => [rec.session, ...xs.filter((s) => s.id !== rec.session.id)]);
          if (!activeId) setActiveId(rec.sessionId);
          setError(rec.replied ? null : new Error(
            (e?.fromStream && e.message) ? e.message
              : "Your message was saved, but Ivy's reply didn't reach the app. If you asked her to change something, check whether it was done before sending it again.",
          ));
          return;
        }
      }
      // A 5xx / gateway timeout (e.g. Vercel killing a slow function → a raw
      // "504 FUNCTION_INVOCATION_TIMEOUT") or a network abort should read as a
      // calm "try again", not a scary deployment error dumped into the chat.
      const serverOrTimeout = e?.status === 0 || (e?.status >= 500 && e?.status < 600);
      setError(serverOrTimeout
        ? new Error('Ivy took too long to answer that one. Please try again.')
        : e);
      // Drop the optimistic bubble (and any partial reply) so the user can
      // retry. The server may have saved the turn anyway, so the next open
      // of this session reloads it instead of trusting the cache.
      live.clear();
      setMessages((xs) => xs.filter((m) => m.id !== optimistic.id && m.id !== live.id));
      if (activeId) msgCacheRef.current.delete(activeId);
    } finally {
      setThinking(false);
    }
  }, [activeId, thinking]);

  const removeSession = useCallback(async (id) => {
    await api.del('/ivy/' + id);
    msgCacheRef.current.delete(id);
    setSessions((xs) => xs.filter((s) => s.id !== id));
    if (activeId === id) { setActiveId(null); setMessages([]); }
  }, [activeId]);

  // One-tap approval for an action Ivy proposed (send a message, send an
  // invoice, change settings…). The server recorded each proposed call in
  // ivy_pending_actions; POST /api/ivy/approve runs the stored call once and
  // returns the chat message recording the outcome. The model never runs
  // these itself, so text hidden in client data cannot approve anything.
  // The card is cleared first so it cannot be double-tapped; the server also
  // refuses a second run (409).
  const appendServerMessage = useCallback((msg) => {
    if (!msg) return;
    setMessages((xs) => {
      const next = [...xs, msg];
      if (activeId) msgCacheRef.current.set(activeId, next);
      return next;
    });
  }, [activeId]);

  const settlePending = useCallback(async (messageId, ids, method) => {
    setMessages((xs) => xs.map((m) => (m.id === messageId ? { ...m, pendingActions: null } : m)));
    setError(null);
    for (const id of ids) {
      if (!id) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = method === 'approve'
          ? await api.post('/ivy/approve', { id })
          : await api.del('/ivy/approve', { id });
        // `outcome` arrives instead of `message` when the action ran but the
        // chat note could not be saved: still show what happened.
        appendServerMessage(r?.message || (r?.outcome
          ? { id: 'outcome-' + id, role: 'ivy', text: r.outcome, createdAt: new Date().toISOString() }
          : null));
        // Let open screens (the Website editor) pick up what just changed.
        if (method === 'approve') announceIvyActionsRan((r?.message?.actions || []).map((x) => x?.tool));
      } catch (e) {
        if (method === 'approve') {
          // A lost connection or a server error can arrive after the action
          // already ran. Reload the chat so the owner sees the saved outcome
          // ("Done. ...") instead of an error that reads as "not done".
          const status = Number(e?.status) || 0;
          let reloaded = false;
          if (activeId && !(status >= 400 && status < 500)) {
            try {
              const r = await api.get('/ivy/' + activeId);
              if (Array.isArray(r?.messages)) {
                msgCacheRef.current.set(activeId, r.messages);
                setMessages(r.messages);
                reloaded = true;
              }
            } catch { /* still offline: fall through to the error */ }
          }
          if (!reloaded) {
            setError(status === 409
              ? new Error(e.message || 'That action already ran or has expired.')
              : status >= 400 && status < 500 ? e
                : new Error("Couldn't confirm whether that ran. Open this chat again in a moment to see the result before approving again."));
          }
        }
      }
    }
  }, [appendServerMessage, activeId]);

  const pendingIdsFor = useCallback((messageId, pendingId) => {
    if (pendingId) return [pendingId];
    const m = messages.find((x) => x.id === messageId);
    return (m?.pendingActions || []).map((a) => a.id).filter(Boolean);
  }, [messages]);

  const approvePending = useCallback((messageId, pendingId) => (
    settlePending(messageId, pendingIdsFor(messageId, pendingId), 'approve')
  ), [settlePending, pendingIdsFor]);

  const dismissPending = useCallback((messageId, pendingId) => (
    settlePending(messageId, pendingIdsFor(messageId, pendingId), 'dismiss')
  ), [settlePending, pendingIdsFor]);

  return {
    sessions, activeId, messages, context, briefing,
    loading, thinking, error, mode, modeError, usage,
    openSession, newChat, send, removeSession,
    approvePending, dismissPending,
  };
}
