// Ivy store. One initial GET pulls sessions + workspace context; clicking a
// session pulls its messages on demand. Sending posts to /api/ivy and the
// server returns both turns at once.
//
// State lives in a provider mounted in AppShell so every consumer
// (the floating IvyDock at the corner + the full-page IvyPro route)
// shares the same sessions, messages, draft, and in-flight request.
// Without the provider each useIvy() call would maintain its own copy
// and a chat started in the dock wouldn't carry into the full-page
// view (and vice versa).
import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../lib/api.js';

const EMPTY_CTX = {
  revenueThisMonth: 0, openInvoices: 0, activeClients: 0,
  upcomingSessions: 0, quietClients: 0,
};

const IvyCtx = createContext(null);

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
  // render. We always call it; we just return the context's value
  // when there is one. The "unused" hook in the provider path is the
  // cost of safety here.
  const fallback = useIvyState();
  return ctx || fallback;
}

function useIvyState() {
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
  const [model, setModel]         = useState(null);     // e.g. 'claude-opus-4-8'
  const [usage, setUsage]         = useState(null);
  const msgCacheRef = useRef(new Map()); // sessionId -> messages[]

  useEffect(() => {
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
        if (r.model) setModel(r.model);
        if (r.usage) setUsage(r.usage);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

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
    if ((!t && !attachment) || thinking) return;
    setError(null);

    // Optimistic append of the user's own bubble. Show a paperclip line
    // when an attachment is included so the chat doesn't look empty.
    const optimisticText = attachment
      ? (t ? `${t}\n\n📎 ${attachment.filename || 'file'}` : `📎 ${attachment.filename || 'file'}`)
      : t;
    const optimistic = { id: 'tmp-' + Date.now(), role: 'me', text: optimisticText, createdAt: new Date().toISOString() };
    setMessages((xs) => [...xs, optimistic]);
    setThinking(true);

    try {
      const r = await api.post('/ivy', {
        text: t,
        sessionId: activeId || undefined,
        attachment: attachment || undefined,
      });
      const realMessages = r.messages || [];
      setMessages((xs) => {
        // Replace optimistic with real pair
        const withoutOptimistic = xs.filter((m) => m.id !== optimistic.id);
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
      setError(e);
      // Drop the optimistic bubble so the user can retry
      setMessages((xs) => xs.filter((m) => m.id !== optimistic.id));
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

  return {
    sessions, activeId, messages, context, briefing,
    loading, thinking, error, mode, modeError, model, usage,
    openSession, newChat, send, removeSession,
  };
}
