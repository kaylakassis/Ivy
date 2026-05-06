// API-backed messages store. Threads + per-thread message arrays.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

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

  const send = useCallback(async (text, attachments) => {
    if (!threadId) return null;
    const trimmed = (text || '').trim();
    const atts = Array.isArray(attachments) ? attachments : [];
    if (!trimmed && atts.length === 0) return null;
    const r = await api.post('/messages/' + threadId, { text: trimmed, attachments: atts });
    setMessages((m) => [...m, r.message]);
    setThread((t) => t ? {
      ...t,
      lastMessageAt: r.message.createdAt,
      lastPreview: (trimmed || (atts.some((a) => (a.type || '').startsWith('audio/')) ? '🎙️ Voice message' : 'Attachment')).slice(0, 200),
    } : t);
    return r.message;
  }, [threadId]);

  return { thread, messages, loading, error, refresh, send };
}
