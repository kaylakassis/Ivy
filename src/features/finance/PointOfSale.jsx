// In-person quick-sale (Finance → Sell). Tap products into a cart, add
// ad-hoc items, settle the sale by:
//   • cash         — pocketed in person; invoice opens paid.
//   • card_on_file — off-session charge of the selected client's
//                    saved Stripe card. Requires a linked client
//                    with a card on file.
//   • link         — mints a pay-link / QR for the buyer to scan.
import React, { useEffect, useState, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import QRCodeModal from '../../components/QRCodeModal.jsx';
import { api } from '../../lib/api.js';
import { useProducts } from './posState.js';

const money = (n) => '$' + Number(n || 0).toFixed(2);

export default function PointOfSale() {
  const { products, loading, recordSale } = useProducts();
  const [cart, setCart] = useState([]); // [{ key, productId?, name, rate, qty, stockQty?, trackStock? }]
  const [clientId, setClientId] = useState('');
  const [clientName, setClientName] = useState('');
  const [payment, setPayment] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { paid } | { payUrl, cardError? }
  const [err, setErr] = useState(null);
  const sellable = products.filter((p) => p.active);

  // Load the workspace's clients once so the picker can offer
  // existing rows + surface which of them have a card on file. Card-on-
  // file is needed for the off-session charge path; without it we hide
  // the third payment button.
  const [clients, setClients] = useState([]);
  useEffect(() => {
    api.get('/clients').then((r) => setClients(r.clients || [])).catch(() => {});
  }, []);
  const selectedClient = useMemo(
    () => clients.find((c) => c.id === clientId) || null,
    [clients, clientId],
  );
  const canCardOnFile = !!(selectedClient && selectedClient.hasCardOnFile);
  // If the operator flips the client away from someone with a card on
  // file while card_on_file is selected, drop back to cash so we don't
  // hit the server with an impossible request.
  useEffect(() => {
    if (payment === 'card_on_file' && !canCardOnFile) setPayment('cash');
  }, [payment, canCardOnFile]);

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
    if (!cart.length) return;
    setBusy(true); setErr(null);
    try {
      // Walk-in resolution: if the operator picked a client, use that.
      // Otherwise fall back to the typed name (cash / link only — the
      // card_on_file button is disabled when no client is selected).
      const resolvedClientName = selectedClient?.name
        || clientName.trim()
        || 'Walk-in';
      const resolvedClientEmail = selectedClient?.email || undefined;
      const r = await recordSale({
        items: cart.map((x) => x.adhoc
          ? { description: x.name || 'Item', quantity: x.qty, rate: Number(x.rate) || 0 }
          : { productId: x.productId, quantity: x.qty }),
        payment,
        clientId: clientId || undefined,
        clientName: resolvedClientName,
        clientEmail: resolvedClientEmail,
      });
      // Decide which result UI to show:
      //   - paid (cash or successful card_on_file) → Toast
      //   - card_on_file declined → fall through to QR with the error
      //   - link → QR
      if (r.paid) {
        setResult({ paid: true, cardCharged: !!r.cardCharged });
      } else {
        setResult({ payUrl: r.payUrl, cardError: r.cardError || null });
      }
      setCart([]); setClientId(''); setClientName('');
    } catch (e) {
      setErr(e.message || 'Sale failed');
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

        {/* Client picker: existing rows (with card-on-file badge) +
            optional free-text name for walk-ins. clientId drives
            card_on_file eligibility; clientName is just labelling. */}
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} style={inp}>
          <option value="">Walk-in — no client linked</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.hasCardOnFile ? `  •  ${c.cardBrand || 'card'} ••${c.cardLast4 || ''}` : ''}
            </option>
          ))}
        </select>
        {!clientId && (
          <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Customer name (optional)" style={inp}/>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { id: 'cash', label: 'Cash / in person', available: true },
            {
              id: 'card_on_file',
              label: canCardOnFile
                ? `Card on file • ${selectedClient.cardBrand || 'card'} ••${selectedClient.cardLast4 || ''}`
                : 'Card on file',
              available: canCardOnFile,
              hint: !selectedClient
                ? 'Pick a client to charge their saved card'
                : !canCardOnFile
                  ? 'This client has no card on file'
                  : null,
            },
            { id: 'link', label: 'Card — pay link / QR', available: true },
          ].map(({ id, label, available, hint }) => (
            <button
              key={id}
              type="button"
              onClick={() => available && setPayment(id)}
              disabled={!available}
              title={hint || undefined}
              style={{
                flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
                cursor: available ? 'pointer' : 'not-allowed',
                border: '1px solid ' + (payment === id ? 'var(--accent)' : 'var(--border)'),
                background: payment === id ? 'var(--accent-soft)' : 'var(--surface-2)',
                color: payment === id ? 'var(--accent)' : (available ? 'var(--fg-2)' : 'var(--muted)'),
                fontWeight: 600,
                opacity: available ? 1 : 0.55,
              }}>{label}</button>
          ))}
        </div>

        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <button className="btn btn-primary" disabled={busy || !cart.length} onClick={checkout} style={{ justifyContent: 'center' }}>
          {busy
            ? 'Processing…'
            : payment === 'cash'
              ? `Charge ${money(total)} (cash)`
              : payment === 'card_on_file'
                ? `Charge ${money(total)} to card on file`
                : `Take payment ${money(total)}`}
        </button>
      </div>

      {result?.paid && (
        <Toast onClose={() => setResult(null)} icon="Check"
          text={result.cardCharged ? 'Charged to card on file — sale recorded.' : 'Paid — sale recorded.'}/>
      )}
      {result?.payUrl && (
        <QRCodeModal url={result.payUrl}
          label={result.cardError ? 'Card declined — show QR instead' : 'Scan to pay'}
          sublabel={result.cardError
            ? `Card-on-file charge failed (${result.cardError}). Customer can still pay via QR.`
            : 'Customer scans with their phone camera to pay this sale.'}
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
