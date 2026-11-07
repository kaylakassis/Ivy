// API-backed finance store: the invoice list (paged) + dashboard summary.
//
// The Finance list loads one page (50) for the current tab from
// GET /api/invoices?cursor= and appends the next page on "Show more".
// Tab counts and money totals come from GET /api/finance over every
// invoice, never from the rows that happen to be loaded. Without ?cursor
// the invoices endpoint still returns its old list (iPhone 1.0.5 and the
// other screens use it).
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../lib/api.js';
import { haptic } from '../../lib/celebrate.js';

const PAGE = 50;
// Tab -> server filter. Archived invoices only show under Archived.
function tabQuery(tab) {
  if (tab === 'archived') return 'archived=only';
  if (tab && tab !== 'all') return `status=${encodeURIComponent(tab)}`;
  return '';
}
const pageUrl = (tab, cursor) => `/invoices?cursor=${encodeURIComponent(cursor || '')}&limit=${PAGE}${tabQuery(tab) ? `&${tabQuery(tab)}` : ''}`;

export function useInvoices({ tab = 'all' } = {}) {
  const [invoices, setList]     = useState([]);
  // An invoice opened by link (?invoice=<id>) that is not on a loaded page.
  const [linked, setLinked]     = useState(null);
  const [summary, setSummary]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError]       = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const reqId = useRef(0);

  // Every local change applies to the list and to a linked invoice alike.
  const setInvoices = useCallback((fn) => {
    setList(fn);
    setLinked((l) => (l ? (fn([l])[0] || null) : l));
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      const r = await api.get('/finance');
      setSummary(r.summary);
    } catch { /* non-fatal */ }
  }, []);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setListLoading(true);
    await Promise.all([
      api.get(pageUrl(tab, '')).then((r) => {
        if (id !== reqId.current) return;
        setList(r.invoices || []);
        setNextCursor(r.nextCursor || null);
        setError(null);
      }),
      api.get('/finance').then((r) => id === reqId.current && setSummary(r.summary)),
    ])
      .catch((e) => id === reqId.current && setError(e))
      .finally(() => { if (id === reqId.current) { setLoading(false); setListLoading(false); } });
  }, [tab]);

  useEffect(() => {
    load();
    return () => { reqId.current += 1; };
  }, [load]);

  // Pull to refresh / back online: reload the first page and the summary.
  const reload = useCallback(() => load(), [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const id = reqId.current;
    setLoadingMore(true);
    try {
      const r = await api.get(pageUrl(tab, nextCursor));
      if (id !== reqId.current) return;
      setList((prev) => {
        const have = new Set(prev.map((i) => i.id));
        return [...prev, ...(r.invoices || []).filter((i) => !have.has(i.id))];
      });
      setNextCursor(r.nextCursor || null);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, tab]);

  // Find an invoice whether or not its page is loaded (deep links).
  const ensureInvoice = useCallback(async (id) => {
    if (!id) return null;
    try {
      const r = await api.get('/invoices/' + encodeURIComponent(id));
      if (r.invoice) setLinked(r.invoice);
      return r.invoice || null;
    } catch { return null; }
  }, []);

  const create = useCallback(async (input) => {
    const r = await api.post('/invoices', input);
    setList((xs) => [r.invoice, ...xs]);
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary]);

  const update = useCallback(async (id, patch) => {
    const r = await api.patch('/invoices/' + id, patch);
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary, setInvoices]);

  const remove = useCallback(async (id) => {
    await api.del('/invoices/' + id);
    setList((xs) => xs.filter((i) => i.id !== id));
    setLinked((l) => (l && l.id === id ? null : l));
    await refreshSummary();
  }, [refreshSummary]);

  const send = useCallback(async (id, clientId) => {
    const r = await api.post('/invoices/send', { id, clientId });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary, setInvoices]);

  // Resend an already-sent invoice. Uses the dedicated endpoint so the
  // recipient sees a "Reminder: ..." subject line and the activity log
  // records "Resent" rather than another "Sent".
  const resend = useCallback(async (id) => {
    const r = await api.post('/invoices/resend', { id });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary, setInvoices]);

  const markPaid = useCallback(async (id, method) => {
    const r = await api.post('/invoices/mark-paid', { id, method });
    haptic('success');
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary, setInvoices]);

  const voidInvoice = useCallback(async (id, { notifyClient = false } = {}) => {
    const r = await api.post('/invoices/void', { id, notifyClient });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r;
  }, [refreshSummary, setInvoices]);

  // Archive (hide) or bring back settled invoices. Nothing is deleted and
  // revenue does not change. Returns { changed, skipped: [{ id, number, why }] }.
  const archive = useCallback(async (ids, archived = true) => {
    const r = await api.post('/invoices/archive', { ids, archived });
    const byId = new Map((r.invoices || []).map((i) => [i.id, i]));
    setInvoices((xs) => xs.map((i) => byId.get(i.id) || i));
    await refreshSummary();
    return r;
  }, [refreshSummary, setInvoices]);

  const refund = useCallback(async (id, { amount, reason } = {}) => {
    const r = await api.post('/invoices/refund', { id, amount, reason });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r;
  }, [refreshSummary, setInvoices]);

  // Owner says the money the client claimed to send never arrived.
  // Clears the "says paid" banner; an optional message goes to the client.
  const clearClaim = useCallback(async (id, message) => {
    const r = await api.post('/invoices/clear-claim', { id, ...(message ? { message } : {}) });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    return r.invoice;
  }, [setInvoices]);

  return {
    invoices, linked, summary, loading, listLoading, error,
    create, update, remove, send, resend, markPaid, void: voidInvoice, refund, clearClaim, archive,
    hasMore: !!nextCursor, loadMore, loadingMore, reload, ensureInvoice,
  };
}
