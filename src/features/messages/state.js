// API-backed messages store. Threads + per-thread message arrays.
//
// "Realtime" pattern: tab-visibility-gated polling. The thread list
// refreshes every 15s while the tab is foreground; an open thread
// refreshes every 5s. Both pause when the tab is hidden, so a
// backgrounded tab doesn't ping the server for nothing.
//
// True WebSocket / SSE realtime would need a persistent connection
// layer (Pusher / Ably / Redis pub-sub) — Vercel serverless functions
// don't hold long connections cheaply. Polling is the pragmatic
// 95%-of-UX win without the infrastructure investment.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { useIntervalWhenVisible } from '../../lib/useIntervalWhenVisible.js';

export function useThreads() {
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const refresh = useCallback(async () => {
    const r = await api.get('/messages');
    setThreads(r.threads || []);
    return r.threads;
  }, []);

  useEffect(() => {
    let live = true;
    api.get('/messages')
      .then((r) => live && setThreads(r.threads || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  // Background refresh: poll while the tab is foregrounded so the
  // inbox list shows new threads + updated previews + unread counts
  // without the user needing to refresh. Silent on failure — a
  // network blip shouldn't surface as an error to the user; their
  // existing state stays valid.
  const silentRefresh = useCallback(async () => {
    try {
      const r = await api.get('/messages');
      setThreads(r.threads || []);
    } catch { /* keep current state on transient failure */ }
  }, []);
  useIntervalWhenVisible(silentRefresh, 15000);

  const startThread = useCallback(async (clientId) => {
    const r = await api.post('/messages', { clientId });
    setThreads((ts) => {
      // Replace if exists, otherwise prepend.
      const exists = ts.some((t) => t.id === r.thread.id);
      return exists ? ts.map((t) => t.id === r.thread.id ? r.thread : t) : [r.thread, ...ts];
    });
    return r.thread;
  }, []);

  const updateThread = useCallback((id, patch) => {
    setThreads((ts) => ts.map((t) => t.id === id ? { ...t, ...patch } : t));
  }, []);

  const setMode = useCallback(async (id, mode) => {
    const r = await api.patch('/messages/' + id, { mode });
    updateThread(id, r.thread);
    return r.thread;
  }, [updateThread]);

  return { threads, loading, error, refresh, startThread, updateThread, setMode };
}

export function useThread(threadId) {
  const [thread, setThread]     = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  const refresh = useCallback(async () => {
    if (!threadId) return null;
    const r = await api.get('/messages/' + threadId);
    setThread(r.thread);
    setMessages(r.messages || []);
    return r;
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      setThread(null);
      setMessages([]);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api.get('/messages/' + threadId)
      .then((r) => {
        if (!live) return;
        setThread(r.thread);
        setMessages(r.messages || []);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [threadId]);

  // Active-thread polling: 5s while the user is looking at this
  // thread. Tighter than the inbox-list cadence (15s) because the
  // open thread is where the user expects "live" behavior — a
  // client's reply should appear within seconds, not minutes.
  // Merges incoming messages by id so an optimistic local send
  // doesn't get duplicated when the server's version arrives.
  const silentTick = useCallback(async () => {
    if (!threadId) return;
    try {
      const r = await api.get('/messages/' + threadId);
      setThread(r.thread);
      setMessages((existing) => {
        const seen = new Set(existing.map((m) => m.id));
        const merged = [...existing];
        for (const m of (r.messages || [])) {
          if (!seen.has(m.id)) merged.push(m);
        }
        // Order by createdAt so a late-arriving in-flight message
        // doesn't end up at the bottom of the wrong spot.
        merged.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        return merged;
      });
    } catch { /* keep current state on transient failure */ }
  }, [threadId]);
  useIntervalWhenVisible(silentTick, 5000, !!threadId);

  const send = useCallback(async (text, attachments, channel) => {
    if (!threadId) return null;
    const trimmed = (text || '').trim();
    const atts = Array.isArray(attachments) ? attachments : [];
    if (!trimmed && atts.length === 0) return null;
    const r = await api.post('/messages/' + threadId, { text: trimmed, attachments: atts, channel });
    setMessages((m) => [...m, r.message]);
    setThread((t) => t ? {
      ...t,
      lastMessageAt: r.message.createdAt,
      lastPreview: (trimmed || (atts.some((a) => (a.type || '').startsWith('audio/')) ? '🎙️ Voice message' : 'Attachment')).slice(0, 200),
    } : t);
    return r; // { message, smsSent?, smsReason? }
  }, [threadId]);

  return { thread, messages, loading, error, refresh, send };
}
