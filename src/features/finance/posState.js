// Products / inventory store + the in-person quick-sale call.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useProducts() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try { const r = await api.get('/products?all=1'); setProducts(r.products || []); setError(null); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, []);
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
    return r;
  }, [refresh]);

  return { products, loading, error, refresh, create, update, remove, recordSale };
}
