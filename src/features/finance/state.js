// API-backed finance store: invoices + dashboard summary.
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../lib/api.js';

// Background refresh cadence while the Finance page is visible. Webhook
// confirmations from Stripe/Square/PayPal land in the DB asynchronously;
// without this poll a freshly-paid invoice would sit as "Sent" on the
// owner's screen until they manually reloaded.
const POLL_MS = 60_000;

export function useInvoices() {
  const [invoices, setInvoices] = useState([]);
  const [summary, setSummary]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  // Pagination state (default page = 1000, server-capped at 5000).
  const [hasMore, setHasMore]   = useState(false);
  const [nextOffset, setNextOffset] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Tracks the latest fetch so out-of-order responses (a slow first
  // fetch finishing after a fast retry) don't overwrite fresh state.
  const fetchSeqRef = useRef(0);
  // Once the user pages past the first 1000 invoices via loadMore,
  // the silent background refresh stops re-fetching the invoice list
  // (which would discard those appended pages). Summary still refreshes.
  const paginatedRef = useRef(false);

  const refreshSummary = useCallback(async () => {
    try {
      const r = await api.get('/finance');
      setSummary(r.summary);
    } catch { /* non-fatal */ }
  }, []);

  // Initial load + background refresh on focus / visibility / interval.
  // The list page is the surface where webhook-driven paid status needs
  // to appear without a manual reload, so we refetch when the user
  // returns to the tab and on a slow poll while it's visible.
  useEffect(() => {
    let live = true;

    const fetchAll = async ({ silent = false } = {}) => {
      const seq = ++fetchSeqRef.current;
      // Background refresh after pagination: refresh summary only.
      // Re-fetching /invoices would drop pages 2+ that loadMore appended.
      const skipInvoices = silent && paginatedRef.current;
      try {
        const [invRes, finRes] = await Promise.all([
          skipInvoices ? Promise.resolve(null) : api.get('/invoices'),
          api.get('/finance'),
        ]);
        if (!live || seq !== fetchSeqRef.current) return;
        if (invRes) {
          setInvoices(invRes.invoices || []);
          setHasMore(!!invRes.hasMore);
          setNextOffset(invRes.nextOffset ?? null);
        }
        setSummary(finRes.summary);
        if (!silent) setError(null);
      } catch (e) {
        if (!live || seq !== fetchSeqRef.current) return;
        if (!silent) setError(e);
      } finally {
        if (live && !silent) setLoading(false);
      }
    };

    fetchAll();

    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') fetchAll({ silent: true });
    };
    const intervalId = setInterval(refreshIfVisible, POLL_MS);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);

    return () => {
      live = false;
      clearInterval(intervalId);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, []);

  const loadMore = useCallback(async () => {
    if (!hasMore || nextOffset == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.get(`/invoices?offset=${nextOffset}`);
      const existing = new Set(invoices.map((i) => i.id));
      const fresh = (r.invoices || []).filter((i) => !existing.has(i.id));
      setInvoices((prev) => [...prev, ...fresh]);
      setHasMore(!!r.hasMore);
      setNextOffset(r.nextOffset ?? null);
      paginatedRef.current = true;
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, nextOffset, loadingMore, invoices]);

  const create = useCallback(async (input) => {
    const r = await api.post('/invoices', input);
    setInvoices((xs) => [r.invoice, ...xs]);
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary]);

  const update = useCallback(async (id, patch) => {
    const r = await api.patch('/invoices/' + id, patch);
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary]);

  const remove = useCallback(async (id) => {
    await api.del('/invoices/' + id);
    setInvoices((xs) => xs.filter((i) => i.id !== id));
    await refreshSummary();
  }, [refreshSummary]);

  const send = useCallback(async (id, clientId) => {
    const r = await api.post('/invoices/send', { id, clientId });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary]);

  // Resend an already-sent invoice. Uses the dedicated endpoint so the
  // recipient sees a "Reminder: ..." subject line and the activity log
  // records "Resent" rather than another "Sent".
  const resend = useCallback(async (id) => {
    const r = await api.post('/invoices/resend', { id });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary]);

  const markPaid = useCallback(async (id, method) => {
    const r = await api.post('/invoices/mark-paid', { id, method });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary]);

  const voidInvoice = useCallback(async (id) => {
    const r = await api.post('/invoices/void', { id });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r.invoice;
  }, [refreshSummary]);

  const refund = useCallback(async (id, { amount, reason } = {}) => {
    const r = await api.post('/invoices/refund', { id, amount, reason });
    setInvoices((xs) => xs.map((i) => i.id === id ? r.invoice : i));
    await refreshSummary();
    return r;
  }, [refreshSummary]);

  return {
    invoices, summary, loading, error,
    create, update, remove, send, resend, markPaid, void: voidInvoice, refund,
    hasMore, loadMore, loadingMore,
  };
}
