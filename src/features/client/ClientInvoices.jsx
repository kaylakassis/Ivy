// /me/invoices — list of every invoice the user owes or has paid, across
// businesses. Status chip + amount; click "View / pay" → server issues a
// fresh view token and we open the existing public /invoice/:token page.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';

const STATUS_META = {
  sent:    { label: 'Awaiting payment', color: 'var(--warn)' },
  overdue: { label: 'Overdue',          color: 'var(--danger)' },
  paid:    { label: 'Paid',             color: 'var(--ok)' },
  voided:  { label: 'Voided',           color: 'var(--muted)' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function ClientInvoices() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [opening, setOpening]   = useState(null); // invoice id currently being opened

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    api.get('/me/invoices')
      .then((r) => live && setInvoices(r.invoices || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [reloadKey]);

  const open = async (id) => {
    setOpening(id);
    try {
      const r = await api.post('/me/invoices/' + id + '/access-link');
      window.open(r.url, '_blank', 'noopener');
    } catch (err) {
      alert('Could not open invoice: ' + (err.message || 'unknown error'));
    } finally {
      setOpening(null);
    }
  };

  if (loading) return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SkelRowList rows={4}/>
    </div>
  );
  if (error) return (
    <div style={{ padding: 48 }}>
      <div className="card" style={{ padding: 40 }}>
        <EmptyNote icon="Dollar" title="Couldn't load invoices"
          hint={error.message || 'Try refreshing.'}
          action={<button className="btn btn-outline" onClick={() => setReloadKey((n) => n + 1)}>Retry</button>}/>
      </div>
    </div>
  );

  const totalOwed = invoices
    .filter((i) => i.status === 'sent' || i.status === 'overdue')
    .reduce((s, i) => s + (i.total || 0), 0);

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {totalOwed > 0 && (
        <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12, flexShrink: 0,
            background: 'var(--warn)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Dollar size={20}/></div>
          <div style={{ flex: 1 }}>
            <div className="metric-label">Outstanding</div>
            <div className="metric-value" style={{ fontSize: 22, color: 'var(--warn)' }}>{fmtMoney(totalOwed)}</div>
          </div>
        </div>
      )}

      {invoices.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Dollar" title="No invoices yet"
            hint="When a business sends you an invoice, it'll show up here."/>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {invoices.map((inv, i) => {
            const meta = STATUS_META[inv.status] || STATUS_META.sent;
            return (
              <div key={inv.id} style={{
                padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14,
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                flexWrap: 'wrap',
              }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="mono-num" style={{ fontSize: 13, fontWeight: 600 }}>{inv.number}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>·</span>
                    <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{inv.businessName}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                    Issued {fmtDate(inv.issueDate)}
                    {inv.dueDate && <> · Due {fmtDate(inv.dueDate)}</>}
                  </div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 99,
                  background: 'color-mix(in srgb, ' + meta.color + ' 14%, transparent)',
                  color: meta.color, fontSize: 11, fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: meta.color }}/>
                  {meta.label}
                </div>
                <div className="mono-num" style={{ fontSize: 16, fontWeight: 600, minWidth: 90, textAlign: 'right' }}>
                  {fmtMoney(inv.total)}
                </div>
                <button onClick={() => open(inv.id)} disabled={opening === inv.id}
                  className="btn btn-outline" style={{ padding: '6px 12px', fontSize: 12 }}>
                  {opening === inv.id ? 'Opening…' : (inv.status === 'paid' ? 'View' : 'View & pay')}
                  <Icons.Arrow size={11} sw={2}/>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
