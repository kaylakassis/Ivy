// Products / inventory store + the in-person quick-sale call.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useProducts() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Today's POS totals for the in-person summary strip. Refreshes on
  // every sale so the cashier sees the drawer creep up live.
  const [today, setToday] = useState(null);

  const refreshToday = useCallback(async () => {
    try { const r = await api.get('/pos/today'); setToday(r); }
    catch { /* leave whatever's there */ }
  }, []);

  const refresh = useCallback(async () => {
    try { const r = await api.get('/products?all=1'); setProducts(r.products || []); setError(null); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
    refreshToday();
  }, [refreshToday]);
  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (input) => {
    const r = await api.post('/products', input);
    setProducts((p) => [...p, r.product].sort((a, b) => a.name.localeCompare(b.name)));
    return r.product;
  }, []);
  const update = useCallback(async (id, patch) => {
    const r = await api.patch(`/products/${id}`, patch);
    setProducts((p) => p.map((x) => (x.id === id ? r.product : x)));
    return r.product;
  }, []);
  const remove = useCallback(async (id) => {
    await api.del(`/products/${id}`);
    setProducts((p) => p.map((x) => (x.id === id ? { ...x, active: false } : x)));
  }, []);
  const recordSale = useCallback(async (payload, idempotencyKey) => {
    const opts = idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined;
    const r = await api.post('/pos/sale', payload, opts);
    await refresh(); // stock changed
    refreshToday();
    return r;
  }, [refresh, refreshToday]);

  return { products, loading, error, refresh, create, update, remove, recordSale, today, refreshToday };
}
