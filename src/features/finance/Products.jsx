// Retail products / inventory manager (Finance → Products).
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useProducts } from './posState.js';

const LOW_STOCK = 3;
const blank = { name: '', sku: '', price: '', cost: '', category: '', trackStock: true, stockQty: '0' };

export default function Products() {
  const { products, loading, create, update, remove } = useProducts();
  const [editing, setEditing] = useState(null); // product id or 'new'
  const active = products.filter((p) => p.active);
  const archived = products.filter((p) => !p.active);

  if (loading) return <div style={{ color: 'var(--muted)', fontSize: 13, padding: 12 }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <p style={{ flex: 1, margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
          Retail items you sell in person or add to invoices. Stock counts down on each sale.
        </p>
        <button className="btn btn-primary" onClick={() => setEditing('new')} style={{ fontSize: 12.5 }}>
          <Icons.Plus size={13}/> Add product
        </button>
      </div>

      {editing === 'new' && (
        <ProductForm initial={blank} onCancel={() => setEditing(null)}
          onSave={async (v) => { await create(v); setEditing(null); }}/>
      )}

      {active.length === 0 && editing !== 'new' ? (
        <div className="card" style={{ padding: 32 }}>
          <EmptyNote icon="Gift" title="No products yet" hint="Add your first retail item to sell it at checkout."/>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {active.map((p) => editing === p.id ? (
            <ProductForm key={p.id} initial={toForm(p)} onCancel={() => setEditing(null)}
              onSave={async (v) => { await update(p.id, v); setEditing(null); }}/>
          ) : (
            <div key={p.id} className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  ${Number(p.price).toFixed(2)}{p.sku ? ` · ${p.sku}` : ''}{p.category ? ` · ${p.category}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {p.trackStock ? (
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: p.stockQty <= LOW_STOCK ? 'var(--danger)' : 'var(--fg-2)' }}>
                    {p.stockQty} in stock{p.stockQty <= LOW_STOCK ? ' · low' : ''}
                  </span>
                ) : <span style={{ fontSize: 12, color: 'var(--muted)' }}>untracked</span>}
              </div>
              <button className="btn btn-ghost" onClick={() => setEditing(p.id)} style={{ padding: 6 }}><Icons.Edit size={14}/></button>
              <button className="btn btn-ghost" onClick={() => { if (confirm(`Archive ${p.name}?`)) remove(p.id); }} style={{ padding: 6, color: 'var(--danger)' }}><Icons.Trash size={14}/></button>
            </div>
          ))}
          {archived.length > 0 && (
            <details style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
              <summary style={{ cursor: 'pointer' }}>Archived ({archived.length})</summary>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {archived.map((p) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', opacity: 0.7 }}>
                    <span style={{ flex: 1 }}>{p.name}</span>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => update(p.id, { active: true })}>Restore</button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function toForm(p) {
  return { name: p.name, sku: p.sku || '', price: String(p.price), cost: p.cost == null ? '' : String(p.cost),
    category: p.category || '', trackStock: p.trackStock, stockQty: String(p.stockQty) };
}

function ProductForm({ initial, onSave, onCancel }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    if (!v.name.trim()) return;
    setBusy(true);
    try {
      await onSave({
        name: v.name.trim(), sku: v.sku.trim(), price: Number(v.price) || 0,
        cost: v.cost === '' ? null : Number(v.cost) || 0, category: v.category.trim(),
        trackStock: v.trackStock, stockQty: Math.max(0, Math.floor(Number(v.stockQty) || 0)),
      });
    } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
        <input placeholder="Product name" value={v.name} onChange={set('name')} style={inp}/>
        <input placeholder="SKU (optional)" value={v.sku} onChange={set('sku')} style={inp}/>
        <input placeholder="Price" type="number" min="0" step="0.01" value={v.price} onChange={set('price')} style={inp}/>
        <input placeholder="Cost (optional)" type="number" min="0" step="0.01" value={v.cost} onChange={set('cost')} style={inp}/>
        <input placeholder="Category (optional)" value={v.category} onChange={set('category')} style={inp}/>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--fg-2)' }}>
          <input type="checkbox" checked={v.trackStock} onChange={(e) => setV((s) => ({ ...s, trackStock: e.target.checked }))}/>
          Track stock
        </label>
        {v.trackStock && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--fg-2)' }}>
            On hand <input type="number" min="0" step="1" value={v.stockQty} onChange={set('stockQty')} style={{ ...inp, width: 80 }}/>
          </label>
        )}
        <div style={{ flex: 1 }}/>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy} style={{ fontSize: 12.5 }}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !v.name.trim()} style={{ fontSize: 12.5 }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

const inp = { padding: '8px 10px', fontSize: 13.5, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface-2)', color: 'var(--fg)', outline: 'none', boxSizing: 'border-box' };
