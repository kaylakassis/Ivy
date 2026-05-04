// Ivy Pro store. One initial GET pulls sessions + workspace context; clicking a
// session pulls its messages on demand. Sending posts to /api/ivy and the
// server returns both turns at once.
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../lib/api.js';

const EMPTY_CTX = {
  revenueThisMonth: 0, openInvoices: 0, activeClients: 0,
  upcomingSessions: 0, quietClients: 0,
};

export function useIvy() {
  const [sessions, setSessions]   = useState([]);
  const [activeId, setActiveId]   = useState(null);
  const [messages, setMessages]   = useState([]);
  const [context, setContext]     = useState(EMPTY_CTX);
  const [loading, setLoading]     = useState(true);
  const [thinking, setThinking]   = useState(false);
  const [error, setError]         = useState(null);
  const [mode, setMode]           = useState(null);     // 'live' | 'mock' | null (unknown)
  const [modeError, setModeError] = useState(null);
  const [usage, setUsage]         = useState(null);
  const msgCacheRef = useRef(new Map()); // sessionId -> messages[]

  useEffect(() => {
    let live = true;
    api.get('/ivy')
      .then((r) => {
        if (!live) return;
        setSessions(r.sessions || []);
        setContext(r.context || EMPTY_CTX);
        if (r.mode) setMode(r.mode);
        setModeError(r.modeError || null);
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

  // `text` may be empty when an attachment is supplied — the server treats
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
    sessions, activeId, messages, context,
    loading, thinking, error, mode, modeError, usage,
    openSession, newChat, send, removeSession,
  };
}
