// In-person quick-sale (Finance → Sell). Tap products into a cart, add
// ad-hoc items, take cash or issue a pay-link (QR) — inventory updates
// on completion.
import React, { useState, useRef } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import QRCodeModal from '../../components/QRCodeModal.jsx';
import { useProducts } from './posState.js';

const money = (n) => '$' + Number(n || 0).toFixed(2);

export default function PointOfSale() {
  const { products, loading, recordSale } = useProducts();
  const [cart, setCart] = useState([]); // [{ key, productId?, name, rate, qty, stockQty?, trackStock? }]
  const [clientName, setClientName] = useState('');
  const [payment, setPayment] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { paid } | { payUrl }
  const [err, setErr] = useState(null);
  // Stable idempotency key for the in-flight sale. Generated once when a
  // checkout begins and reused for any retry of the SAME cart (double-click
  // or timeout-then-retry), so the server dedupes instead of charging /
  // decrementing stock twice. Cleared after a successful sale.
  const saleKeyRef = useRef(null);
  const sellable = products.filter((p) => p.active);

  const addProduct = (p) => setCart((c) => {
    const i = c.findIndex((x) => x.productId === p.id);
    if (i >= 0) return c.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x));
    return [...c, { key: p.id, productId: p.id, name: p.name, rate: Number(p.price), qty: 1, stockQty: p.stockQty, trackStock: p.trackStock }];
  });
  const addAdhoc = () => setCart((c) => [...c, { key: `adhoc_${Date.now()}`, name: '', rate: 0, qty: 1, adhoc: true }]);
  const setLine = (key, patch) => setCart((c) => c.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const removeLine = (key) => setCart((c) => c.filter((x) => x.key !== key));
  const total = cart.reduce((s, x) => s + (Number(x.rate) || 0) * (Number(x.qty) || 0), 0);

  const checkout = async () => {
    if (!cart.length || busy) return; // re-entry guard for rapid double-clicks
    // Reuse the existing key on a retry of the same cart; mint one otherwise.
    if (!saleKeyRef.current) saleKeyRef.current = crypto.randomUUID();
    const idempotencyKey = saleKeyRef.current;
    setBusy(true); setErr(null);
    try {
      const r = await recordSale({
        items: cart.map((x) => x.adhoc
          ? { description: x.name || 'Item', quantity: x.qty, rate: Number(x.rate) || 0 }
          : { productId: x.productId, quantity: x.qty }),
        payment,
        clientName: clientName.trim() || 'Walk-in',
      }, idempotencyKey);
      setResult(r.paid ? { paid: true } : { payUrl: r.payUrl });
      setCart([]); setClientName('');
      saleKeyRef.current = null; // success — next sale gets a fresh key
    } catch (e) {
      setErr(e.message || 'Sale failed'); // keep the key so a retry dedupes
    } finally { setBusy(false); }
  };

  if (loading) return <div style={{ color: 'var(--muted)', fontSize: 13, padding: 12 }}>Loading…</div>;

  return (
    <div className="split-2" style={{ alignItems: 'start' }}>
      {/* Product picker */}
      <div className="card" style={{ padding: 16 }}>
        <div className="metric-label" style={{ marginBottom: 10 }}>Tap to add</div>
        {sellable.length === 0 ? (
          <EmptyNote icon="Gift" title="No products" hint="Add products in the Products tab to sell them here."/>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
            {sellable.map((p) => {
              const out = p.trackStock && p.stockQty <= 0;
              return (
                <button key={p.id} onClick={() => addProduct(p)} disabled={out} style={{
                  textAlign: 'left', padding: 12, borderRadius: 10, cursor: out ? 'not-allowed' : 'pointer',
                  border: '1px solid var(--border)', background: 'var(--surface-2)', opacity: out ? 0.5 : 1,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--accent)', marginTop: 4 }}>{money(p.price)}</div>
                  {p.trackStock && <div style={{ fontSize: 10.5, color: out ? 'var(--danger)' : 'var(--muted)', marginTop: 2 }}>{out ? 'Out of stock' : `${p.stockQty} left`}</div>}
                </button>
              );
            })}
          </div>
        )}
        <button className="btn btn-ghost" onClick={addAdhoc} style={{ marginTop: 10, fontSize: 12.5 }}>
          <Icons.Plus size={12}/> Custom item
        </button>
      </div>

      {/* Cart / checkout */}
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="metric-label">Sale</div>
        {cart.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0' }}>Tap products to start a sale.</div>
        ) : cart.map((x) => (
          <div key={x.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {x.adhoc ? (
              <input value={x.name} onChange={(e) => setLine(x.key, { name: e.target.value })} placeholder="Item"
                style={{ ...inp, flex: 1 }}/>
            ) : <span style={{ flex: 1, fontSize: 13.5 }}>{x.name}</span>}
            {x.adhoc && (
              <input type="number" min="0" step="0.01" value={x.rate} onChange={(e) => setLine(x.key, { rate: e.target.value })}
                style={{ ...inp, width: 70 }}/>
            )}
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <button className="btn btn-ghost" style={{ padding: 4 }} onClick={() => setLine(x.key, { qty: Math.max(1, x.qty - 1) })}>−</button>
              <span style={{ minWidth: 20, textAlign: 'center', fontSize: 13 }}>{x.qty}</span>
              <button className="btn btn-ghost" style={{ padding: 4 }} onClick={() => setLine(x.key, { qty: x.qty + 1 })}>+</button>
            </div>
            <span style={{ width: 64, textAlign: 'right', fontSize: 13, fontWeight: 600 }}>{money((Number(x.rate) || 0) * x.qty)}</span>
            <button className="btn btn-ghost" style={{ padding: 4, color: 'var(--danger)' }} onClick={() => removeLine(x.key)}><Icons.X size={13}/></button>
          </div>
        ))}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 700 }}>
          <span>Total</span><span>{money(total)}</span>
        </div>

        <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Customer name (optional)" style={inp}/>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['cash', 'Cash / in person'], ['link', 'Card — pay link / QR']].map(([id, label]) => (
            <button key={id} onClick={() => setPayment(id)} style={{
              flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer',
              border: '1px solid ' + (payment === id ? 'var(--accent)' : 'var(--border)'),
              background: payment === id ? 'var(--accent-soft)' : 'var(--surface-2)',
              color: payment === id ? 'var(--accent)' : 'var(--fg-2)', fontWeight: 600,
            }}>{label}</button>
          ))}
        </div>

        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <button className="btn btn-primary" disabled={busy || !cart.length} onClick={checkout} style={{ justifyContent: 'center' }}>
          {busy ? 'Processing…' : payment === 'cash' ? `Charge ${money(total)} (cash)` : `Take payment ${money(total)}`}
        </button>
      </div>

      {result?.paid && (
        <Toast onClose={() => setResult(null)} icon="Check" text="Paid — sale recorded."/>
      )}
      {result?.payUrl && (
        <QRCodeModal url={result.payUrl} label="Scan to pay"
          sublabel="Customer scans with their phone camera to pay this sale."
          onClose={() => setResult(null)}/>
      )}
    </div>
  );
}

function Toast({ icon, text, onClose }) {
  const Icon = Icons[icon] || Icons.Check;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ padding: 28, textAlign: 'center', maxWidth: 320 }}>
        <div style={{ width: 48, height: 48, borderRadius: 99, background: 'var(--ok)', color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
          <Icon size={24} sw={2.4}/>
        </div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{text}</div>
        <button className="btn btn-primary" onClick={onClose} style={{ marginTop: 16 }}>Done</button>
      </div>
    </div>
  );
}

const inp = { padding: '8px 10px', fontSize: 13.5, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface-2)', color: 'var(--fg)', outline: 'none', boxSizing: 'border-box' };
