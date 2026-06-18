// /me/orders - order history across every business this user has
// bought products from. Read-only list; details expandable inline.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ClientOrders() {
  const [orders, setOrders] = useState(null);
  const [err, setErr]       = useState(null);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    let live = true;
    api.get('/me/orders')
      .then((r) => { if (live) setOrders(r.orders || []); })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, []);

  if (orders === null && !err) {
    return <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  }
  if (err) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyNote icon="Gift" title="Couldn't load orders" hint={err.message || 'Try refreshing.'}/>
      </div>
    );
  }

  return (
    <div className="container" style={{ maxWidth: 760, padding: '28px 18px 64px' }}>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: '0 0 4px' }}>Orders</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 0, marginBottom: 18, lineHeight: 1.55 }}>
        Things you've bought from businesses on Ivy OS.
      </p>

      {orders.length === 0 ? (
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Gift" title="No orders yet"
            hint="When you buy something from a business on Ivy OS, it'll show up here."/>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {orders.map((o, i) => {
            const isOpen = !!expanded[o.id];
            return (
              <div key={o.id} style={{
                padding: '14px 18px', borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              }}>
                <button onClick={() => setExpanded((p) => ({ ...p, [o.id]: !isOpen }))}
                  style={{
                    display: 'flex', width: '100%', alignItems: 'center', gap: 12,
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: 0, textAlign: 'left',
                  }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                    background: o.status === 'refunded' ? 'var(--surface-2)' : 'var(--accent-soft)',
                    color: o.status === 'refunded' ? 'var(--muted)' : 'var(--accent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}><Icons.Gift size={16} sw={1.7}/></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{o.businessName}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                      {o.items.length} item{o.items.length === 1 ? '' : 's'}
                      {' · '}{new Date(o.paidAt || o.createdAt).toLocaleDateString()}
                      {o.status === 'refunded' && ' · Refunded'}
                    </div>
                  </div>
                  <div className="mono-num" style={{ fontSize: 14, fontWeight: 600 }}>
                    {money(o.total)}
                  </div>
                </button>

                {isOpen && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
                    {o.items.map((it, j) => (
                      <div key={j} style={{
                        display: 'flex', justifyContent: 'space-between', fontSize: 13,
                        padding: '4px 0', color: 'var(--fg-2)',
                      }}>
                        <span>{it.qty}× {it.name}</span>
                        <span className="mono-num">{money(Number(it.rate || 0) * Number(it.qty || 0))}</span>
                      </div>
                    ))}
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', fontSize: 13,
                      marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)',
                      fontWeight: 600,
                    }}>
                      <span>Total</span>
                      <span className="mono-num">{money(o.total)}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
