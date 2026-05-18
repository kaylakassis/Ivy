// /me/invoices — list of every invoice the user owes or has paid, across
// businesses. Status chip + amount; click "View / pay" → server issues a
// fresh view token and we open the existing public /invoice/:token page.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';
import { fmtMoney as fmtMoneyShared } from '../../lib/money.js';

const STATUS_META = {
  sent:     { label: 'Awaiting payment', color: 'var(--warn)' },
  overdue:  { label: 'Overdue',          color: 'var(--danger)' },
  paid:     { label: 'Paid',             color: 'var(--ok)' },
  voided:   { label: 'Voided',           color: 'var(--muted)' },
  refunded: { label: 'Refunded',         color: 'var(--muted)' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
// Currency-aware wrapper. Client portal shows invoices from many
// businesses — each invoice carries its own currency. Summary tiles
// (monthly spend etc.) are aggregated across mixed currencies; we
// show them in the most-recent invoice's currency, or USD if none.
function fmtMoney(n, currency = 'USD') {
  return fmtMoneyShared(n, currency);
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

  // Sum into the three summary buckets the page header shows. Use paid_at
  // when available (real settlement date) and fall back to issue_date for
  // legacy rows. Anything paid after the first of the current month counts
  // as "this month".
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthLabel = now.toLocaleDateString([], { month: 'long' });

  // Pick the dominant currency across the user's invoices for summary
  // tiles. Cross-currency sums don't strictly make sense (you can't
  // add $50 + €50), but most users have a single dominant currency
  // and the alternative — N tiles per currency — clutters the UI for
  // the 99% case. Show the dominant code; if the user has truly mixed
  // currencies they'll see it on each row anyway.
  const currencyCounts = invoices.reduce((m, i) => {
    const c = (i.currency || 'USD').toUpperCase();
    m[c] = (m[c] || 0) + 1;
    return m;
  }, {});
  const summaryCurrency = Object.entries(currencyCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';

  const totalOwed = invoices
    .filter((i) => i.status === 'sent' || i.status === 'overdue')
    .reduce((s, i) => s + (i.total || 0), 0);
  const monthPaid = invoices
    .filter((i) => i.status === 'paid' && new Date(i.paidAt || i.issueDate) >= monthStart)
    .reduce((s, i) => s + (i.total || 0), 0);
  const lifetimePaid = invoices
    .filter((i) => i.status === 'paid')
    .reduce((s, i) => s + (i.total || 0), 0);

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <h2 style={{
          fontFamily: 'var(--font-display)', fontWeight: 500,
          fontSize: 'clamp(26px, 4vw, 32px)',
          letterSpacing: '-0.03em', margin: '0 0 6px', lineHeight: 1.05,
        }}>Payments</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
          Every invoice across every business that's billed you on THRYVE.
        </p>
      </div>

      {/* Summary tiles */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12,
      }}>
        <SummaryTile
          label={`Spent in ${monthLabel}`}
          value={fmtMoney(monthPaid, summaryCurrency)}
          tone="muted"
          hint={`${invoices.filter((i) => i.status === 'paid' && new Date(i.paidAt || i.issueDate) >= monthStart).length} paid this month`}/>
        <SummaryTile
          label="Lifetime spend"
          value={fmtMoney(lifetimePaid, summaryCurrency)}
          tone="muted"
          hint={`${invoices.filter((i) => i.status === 'paid').length} paid invoice${invoices.filter((i) => i.status === 'paid').length === 1 ? '' : 's'}`}/>
        <SummaryTile
          label="Outstanding"
          value={fmtMoney(totalOwed, summaryCurrency)}
          tone={totalOwed > 0 ? 'warn' : 'ok'}
          hint={totalOwed > 0
            ? `${invoices.filter((i) => i.status === 'sent' || i.status === 'overdue').length} unpaid`
            : "You're all caught up"}/>
      </div>

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
                  {fmtMoney(inv.total, inv.currency)}
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

function SummaryTile({ label, value, tone, hint }) {
  const accent = tone === 'warn' ? 'var(--warn)'
    : tone === 'ok' ? 'var(--ok)'
    : 'var(--fg)';
  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="metric-label">{label}</div>
      <div className="mono-num" style={{
        fontSize: 26, fontWeight: 600, color: accent, letterSpacing: '-0.01em',
      }}>{value}</div>
      {hint && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{hint}</div>
      )}
    </div>
  );
}
