// API-backed finance store: invoices + dashboard summary.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useInvoices() {
  const [invoices, setInvoices] = useState([]);
  const [summary, setSummary]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  const refreshSummary = useCallback(async () => {
    try {
      const r = await api.get('/finance');
      setSummary(r.summary);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get('/invoices').then((r) => live && setInvoices(r.invoices || [])),
      api.get('/finance').then((r) => live && setSummary(r.summary)),
    ])
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

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
  };
}
