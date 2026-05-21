// Finance dashboard + invoices list. Multi-processor settings live in
// PaymentProviderCard near the top of the page.
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useInvoices } from './state.js';
import { fmtMoney as fmtMoneyShared } from '../../lib/money.js';
import InvoiceEditor from './InvoiceEditor.jsx';
import SendInvoiceModal from './SendInvoiceModal.jsx';
import PaymentProviderCard from './PaymentProviderCard.jsx';
import Expenses from './Expenses.jsx';
import Recurring from './Recurring.jsx';
import Time from './Time.jsx';
import Memberships from './Memberships.jsx';
import Quotes from './Quotes.jsx';
import GiftCards from './GiftCards.jsx';
import Products from './Products.jsx';
import PointOfSale from './PointOfSale.jsx';

const STATUS_META = {
  draft:    { label: 'Draft',    color: 'var(--muted)' },
  sent:     { label: 'Sent',     color: 'var(--warn)' },
  paid:     { label: 'Paid',     color: 'var(--ok)' },
  overdue:  { label: 'Overdue',  color: 'var(--danger)' },
  voided:   { label: 'Voided',   color: 'var(--muted-2)' },
  refunded: { label: 'Refunded', color: 'var(--muted-2)' },
};

export default function Finance() {
  const {
    invoices, summary, loading, error,
    create, update, remove, send, resend, markPaid, void: voidInvoice, refund,
    hasMore, loadMore, loadingMore,
  } = useInvoices();

  const [tab, setTab]               = useState('all');
  const [section, setSection]       = useState('invoices'); // 'invoices' | 'recurring' | 'expenses'
  const [openId, setOpenId]         = useState(null);
  const [creatingBusy, setCreating] = useState(false);
  const [sendingId, setSending]     = useState(null);

  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Prompt for year and trigger a CSV download. Used for the Schedule-C
  // summary AND the QuickBooks/Xero importable exports — all three share
  // the year-pick UX, only the URL differs.
  const downloadCSV = (path) => {
    const year = new Date().getFullYear();
    const input = window.prompt('Which year?', year);
    if (!input) return;
    const y = parseInt(input, 10);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      window.alert('Year must be a 4-digit number.');
      return;
    }
    setExportMenuOpen(false);
    // Cookie auth carries because /api is same-origin.
    window.location.href = path + (path.includes('?') ? '&' : '?') + 'year=' + y;
  };

  const counts = useMemo(() => ({
    all:     invoices.length,
    // Fully-optional chain: a summary without counts (defensive against
    // schema drift) falls through to the local recount instead of
    // throwing on .counts.draft of undefined.
    draft:   summary?.counts?.draft   ?? invoices.filter((i) => i.status === 'draft').length,
    sent:    summary?.counts?.sent    ?? invoices.filter((i) => i.status === 'sent').length,
    overdue: summary?.counts?.overdue ?? invoices.filter((i) => i.status === 'overdue').length,
    paid:    summary?.counts?.paid    ?? invoices.filter((i) => i.status === 'paid').length,
    voided:  summary?.counts?.voided  ?? invoices.filter((i) => i.status === 'voided').length,
  }), [summary, invoices]);

  const rows = useMemo(() => {
    if (tab === 'all') return invoices;
    return invoices.filter((i) => i.status === tab);
  }, [invoices, tab]);

  const openInv = invoices.find((i) => i.id === openId) || null;
  const sendingInv = invoices.find((i) => i.id === sendingId) || null;

  const startNew = async (clientId = null) => {
    if (creatingBusy) return;
    setCreating(true);
    try {
      const inv = await create({
        items: [{ id: 'li1', description: '', quantity: 1, rate: 0 }],
        taxRate: 0, discount: 0,
        ...(clientId ? { clientId } : {}),
      });
      setOpenId(inv.id);
    } finally { setCreating(false); }
  };

  // Deep link from ClientDrawer's Invoice button: ?newInvoice=<clientId>
  // → create a fresh draft for that client and open the editor. Strip
  // the param so a refresh doesn't re-create.
  //
  // Cmd+K palette deep-links:
  //   /finance?invoice=<id> → open invoice for read/edit
  //   /finance?quote=<id>   → switch to Quotes tab + open that quote
  const location = useLocation();
  const navigate = useNavigate();
  const consumedRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const cid = params.get('newInvoice');
    const invoiceId = params.get('invoice');
    const quoteId   = params.get('quote');

    if (cid && !consumedRef.current) {
      consumedRef.current = true;
      params.delete('newInvoice');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
      startNew(cid);
      return;
    }
    if (invoiceId) {
      setOpenId(invoiceId);
      params.delete('invoice');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
      return;
    }
    if (quoteId) {
      // Quotes is a SECTION (not a tab — `tab` is invoice-status
      // filter). Switch section so the Quotes component mounts; it
      // reads ?quote on its own and strips it after consumption.
      setSection('quotes');
      // Leave ?quote in the URL — Quotes.jsx consumes + strips it.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  if (loading) return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading finance…</div>;
  if (error) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Dollar" title="Couldn't load finance" hint={error.message || 'Try refreshing.'}/>
        </div>
      </div>
    );
  }

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <StripeErrorBanner search={location.search} navigate={navigate}/>
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Finance</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Send invoices, track payments, watch revenue grow.
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <button className="btn btn-outline" onClick={() => setExportMenuOpen((v) => !v)}
            title="Year-end CSV exports — for taxes or accounting software">
            <Icons.Doc size={13}/> Export ▾
          </button>
          {exportMenuOpen && (
            <>
              {/* Backdrop catches outside clicks. */}
              <div onClick={() => setExportMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 80 }}/>
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 90,
                minWidth: 260, padding: 6,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
              }}>
                <ExportMenuHeader label="Taxes"/>
                <ExportMenuItem
                  label="Schedule C summary"
                  hint="For your CPA"
                  onClick={() => downloadCSV('/api/finance/tax-export')}
                />
                <ExportMenuHeader label="QuickBooks Online"/>
                <ExportMenuItem
                  label="Sales (invoices)"
                  hint="Import as sales transactions"
                  onClick={() => downloadCSV('/api/finance/accounting-export?format=quickbooks&type=invoices')}
                />
                <ExportMenuItem
                  label="Purchases (expenses)"
                  hint="Import as expense bills"
                  onClick={() => downloadCSV('/api/finance/accounting-export?format=quickbooks&type=expenses')}
                />
                <ExportMenuHeader label="Xero"/>
                <ExportMenuItem
                  label="Sales (invoices)"
                  hint="Import as sales invoices"
                  onClick={() => downloadCSV('/api/finance/accounting-export?format=xero&type=invoices')}
                />
                <ExportMenuItem
                  label="Purchases (expenses)"
                  hint="Import as bills"
                  onClick={() => downloadCSV('/api/finance/accounting-export?format=xero&type=expenses')}
                />
              </div>
            </>
          )}
        </div>
        {section === 'invoices' && (
          // Arrow wraps startNew so the click's SyntheticEvent doesn't
          // land as the clientId arg — `...(clientId ? {clientId} : {})`
          // below would otherwise spread the event into the API payload.
          <button className="btn btn-primary" onClick={() => startNew()} disabled={creatingBusy}>
            <Icons.Plus size={13} sw={2}/> {creatingBusy ? 'Creating…' : 'New invoice'}
          </button>
        )}
      </div>

      {/* Section selector: Invoices / Estimates / Recurring / Memberships / Gift cards / Time / Expenses. */}
      <div className="tab-row">
        {[
          { id: 'invoices',    label: 'Invoices' },
          { id: 'pos',         label: 'Sell' },
          { id: 'products',    label: 'Products' },
          { id: 'quotes',      label: 'Estimates' },
          { id: 'recurring',   label: 'Recurring' },
          { id: 'memberships', label: 'Memberships' },
          { id: 'giftcards',   label: 'Gift cards' },
          { id: 'time',        label: 'Time' },
          { id: 'expenses',    label: 'Expenses' },
        ].map(({ id, label }) => (
          <button key={id} onClick={() => setSection(id)} style={{
            padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            background: section === id ? 'var(--surface)' : 'transparent',
            color: section === id ? 'var(--fg)' : 'var(--muted)',
            boxShadow: section === id ? 'var(--shadow-sm)' : 'none',
            whiteSpace: 'nowrap',
          }}>{label}</button>
        ))}
      </div>

      {section === 'expenses' ? (
        <Expenses/>
      ) : section === 'pos' ? (
        <PointOfSale/>
      ) : section === 'products' ? (
        <Products/>
      ) : section === 'quotes' ? (
        <Quotes/>
      ) : section === 'recurring' ? (
        <Recurring/>
      ) : section === 'memberships' ? (
        <Memberships/>
      ) : section === 'giftcards' ? (
        <GiftCards/>
      ) : section === 'time' ? (
        <Time/>
      ) : (
        <InvoicesSection
          invoices={invoices} summary={summary} counts={counts} rows={rows}
          tab={tab} setTab={setTab}
          openInv={openInv} sendingInv={sendingInv}
          setOpenId={setOpenId} setSending={setSending}
          update={update} remove={remove} send={send} resend={resend}
          markPaid={markPaid} voidInvoice={voidInvoice} refund={refund}
          hasMore={hasMore} loadMore={loadMore} loadingMore={loadingMore}
        />
      )}
    </div>
  );
}

function InvoicesSection({
  invoices, summary, counts, rows, tab, setTab, openInv, sendingInv,
  setOpenId, setSending, update, remove, send, resend, markPaid, voidInvoice, refund,
  hasMore, loadMore, loadingMore,
}) {
  return (
    <>
      <PaymentProviderCard/>

      {/* Summary cards */}
      <div className="grid-auto">
        <SummaryCard label="Outstanding" value={fmtMoney(summary?.totalOutstanding)}
          sub={`${counts.sent + counts.overdue} unpaid`}
          icon={<Icons.Clock size={16} sw={1.8}/>}
          tone={summary?.totalOverdue > 0 ? 'warn' : 'neutral'}/>
        <SummaryCard label="Overdue" value={fmtMoney(summary?.totalOverdue)}
          sub={`${counts.overdue} past due`}
          icon={<Icons.Bell size={16} sw={1.8}/>}
          tone={summary?.totalOverdue > 0 ? 'bad' : 'ok'}/>
        <SummaryCard label="Paid this month" value={fmtMoney(summary?.monthPaid)}
          sub={`${fmtMoney(summary?.yearPaid)} this year`}
          icon={<Icons.Trending size={16} sw={1.8}/>}
          tone="ok"/>
        <SummaryCard label="Paid (lifetime)" value={fmtMoney(summary?.totalPaid)}
          sub={`${counts.paid} paid invoice${counts.paid === 1 ? '' : 's'}`}
          icon={<Icons.Dollar size={16} sw={1.8}/>}
          tone="accent"/>
      </div>

      {/* Status tabs */}
      <div className="tab-row">
        {[
          { id: 'all', label: 'All' },
          { id: 'draft', label: 'Drafts' },
          { id: 'sent', label: 'Sent' },
          { id: 'overdue', label: 'Overdue' },
          { id: 'paid', label: 'Paid' },
          { id: 'voided', label: 'Voided' },
        ].map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
            background: tab === id ? 'var(--surface)' : 'transparent',
            color: tab === id ? 'var(--fg)' : 'var(--muted)',
            boxShadow: tab === id ? 'var(--shadow-sm)' : 'none',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {label}
            <span style={{
              fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
              background: tab === id ? 'var(--surface-2)' : 'var(--surface)',
              color: 'var(--muted)', fontWeight: 600,
            }}>{counts[id]}</span>
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="card table-scroll" style={{ overflow: 'auto' }}>
        <div>
          <div style={{
            display: 'grid', gridTemplateColumns: '110px 2fr 110px 130px 130px 130px 40px',
            padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div>Number</div><div>Client</div><div>Status</div><div>Issued</div><div>Due</div>
            <div style={{ textAlign: 'right' }}>Total</div><div/>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 48 }}>
              <EmptyNote
                icon="Dollar"
                title={tab === 'all' ? 'No invoices yet' : `No ${tab}`}
                hint={tab === 'all'
                  ? 'Click "New invoice" to send your first.'
                  : 'Try a different tab.'}
              />
            </div>
          ) : rows.map((i, idx) => (
            <InvoiceRow key={i.id} invoice={i} first={idx === 0} onOpen={() => setOpenId(i.id)}/>
          ))}

          {/* Load more — only when the server reports a page past
              1000 invoices. On filtered tabs the user-facing rows
              might already be a small set; we still surface the
              loader so filters can find matches on later pages. */}
          {hasMore && (
            <div style={{ padding: 16, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                className="btn btn-outline"
                disabled={loadingMore}
                onClick={loadMore}
                style={{ padding: '8px 18px', fontSize: 13 }}>
                {loadingMore ? 'Loading…' : `Load more (${invoices.length} loaded)`}
              </button>
            </div>
          )}
        </div>
      </div>

      {openInv && (
        <InvoiceEditor
          invoice={openInv}
          onClose={() => setOpenId(null)}
          onSave={(patch) => update(openInv.id, patch)}
          onDelete={async () => { await remove(openInv.id); setOpenId(null); }}
          onSend={() => setSending(openInv.id)}
          onResend={async () => { await resend(openInv.id); }}
          onMarkPaid={(method) => markPaid(openInv.id, method)}
          onVoid={() => voidInvoice(openInv.id)}
          onRefund={(args) => refund(openInv.id, args)}
        />
      )}
      {sendingInv && (
        <SendInvoiceModal
          invoice={sendingInv}
          onSend={async (clientId) => { await send(sendingInv.id, clientId); setSending(null); }}
          onClose={() => setSending(null)}
        />
      )}
    </>
  );
}

function InvoiceRow({ invoice, first, onOpen }) {
  const meta = STATUS_META[invoice.status] || STATUS_META.draft;
  return (
    <div onClick={onOpen} style={{
      display: 'grid', gridTemplateColumns: '110px 2fr 110px 130px 130px 130px 40px',
      padding: '14px 20px', alignItems: 'center', cursor: 'pointer',
      borderTop: first ? 'none' : '1px solid var(--border)',
      transition: 'background .1s',
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div className="mono-num" style={{ fontSize: 13, fontWeight: 600 }}>{invoice.number}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {invoice.clientName || <span style={{ color: 'var(--muted-2)' }}>No client yet</span>}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {invoice.clientEmail || (invoice.items?.[0]?.description || '—')}
        </div>
      </div>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 99,
        fontSize: 11, fontWeight: 600,
        background: 'var(--surface-2)', border: '1px solid var(--border)', color: meta.color,
      }}>
        <span style={{ width: 5, height: 5, borderRadius: 99, background: meta.color }}/>{meta.label}
      </span>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
        {invoice.issueDate ? new Date(invoice.issueDate).toLocaleDateString() : '—'}
      </div>
      <div style={{ fontSize: 12.5, color: invoice.status === 'overdue' ? 'var(--danger)' : 'var(--fg-2)' }}>
        {invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : '—'}
      </div>
      <div className="mono-num" style={{ textAlign: 'right', fontSize: 14, fontWeight: 600 }}>
        {fmtMoney(invoice.total, invoice.currency)}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Icons.Arrow size={13} stroke="var(--muted)"/>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, sub, icon, tone = 'neutral' }) {
  const colors = {
    ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--danger)',
    accent: 'var(--accent)', neutral: 'var(--muted)',
  };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, background: 'var(--surface-2)',
          color: colors[tone], flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{icon}</div>
        <div className="metric-label" style={{
          lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{label}</div>
      </div>
      <div className="metric-value" style={{ fontSize: 28 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}

// Owner dashboard formatter. The dashboard summary rolls up multi-
// currency invoices but the workspace usually has a dominant
// currency, so for the summary tiles we default to USD (the column
// default) — invoice rows themselves render with the per-row
// currency via inv.currency. Cross-currency mixing is an
// edge case until a workspace genuinely has dual-currency clients.
function fmtMoney(n, currency = 'USD') {
  if (n == null) return '—';
  return fmtMoneyShared(n, currency);
}

// Tiny dropdown helpers for the Export menu. Inline styles only —
// nothing fancy, just a labeled group + clickable rows.
function ExportMenuHeader({ label }) {
  return (
    <div style={{
      padding: '8px 10px 4px', fontSize: 10.5, fontWeight: 600,
      color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{label}</div>
  );
}

function ExportMenuItem({ label, hint, onClick }) {
  return (
    <button onClick={onClick}
      style={{
        width: '100%', textAlign: 'left', display: 'block',
        padding: '8px 10px', borderRadius: 6,
        background: 'transparent', border: 0, cursor: 'pointer',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ fontSize: 13, fontWeight: 550, color: 'var(--fg)' }}>{label}</div>
      {hint && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{hint}</div>}
    </button>
  );
}

// Stripe-connect bounce-back banner. The /api/finance/stripe-oauth-init
// endpoint redirects here with ?stripeError=<code> when the connect
// flow fails (bad key, mode mismatch, Connect not enabled, etc.).
// We render an actionable banner and strip the query params so a
// refresh doesn't show the same banner forever.
const STRIPE_ERRORS = {
  no_key: {
    title: 'Stripe isn\'t configured on this deploy yet',
    body: 'Set STRIPE_SECRET_KEY in your Vercel project settings — a key starting with sk_live_ (or sk_test_ for testing) from https://dashboard.stripe.com/apikeys. Redeploy after saving.',
  },
  bad_key: {
    title: 'Stripe rejected the API key',
    body: 'STRIPE_SECRET_KEY in Vercel doesn\'t look like a valid Stripe secret key. It must start with sk_live_ or sk_test_. Get the right value from https://dashboard.stripe.com/apikeys and update the env var, then redeploy.',
  },
  connect_not_enabled: {
    title: 'Your Stripe account hasn\'t enabled Connect yet',
    body: 'Visit https://dashboard.stripe.com/connect/accounts/overview (or /test/connect/accounts/overview if you\'re using a test key) and click "Get started" — takes about 2 minutes. Then retry the Connect button.',
  },
  wrong_mode: {
    title: 'Saved Stripe account is from the other mode',
    body: 'A connected-account ID from the other mode (test vs. live) is saved on this workspace. Click Disconnect Stripe below, then reconnect — the new connection will match the current key.',
  },
  unsupported_country: {
    title: 'Stripe rejected the account country',
    body: 'THRYVE currently only supports US accounts. If you\'re outside the US, email hello@getthryve.ai and we\'ll enable your region.',
  },
  unknown: {
    title: 'Couldn\'t start the Stripe connection',
    body: null, // raw message from stripeMsg shown
  },
};
function StripeErrorBanner({ search, navigate }) {
  const params = new URLSearchParams(search);
  const code = params.get('stripeError');
  if (!code) return null;
  const info = STRIPE_ERRORS[code] || STRIPE_ERRORS.unknown;
  const raw = params.get('stripeMsg') || '';
  const dismiss = () => navigate('/finance', { replace: true });
  return (
    <div style={{
      padding: '14px 18px', borderRadius: 12,
      background: 'rgba(214, 88, 80, 0.10)',
      border: '1px solid rgba(214, 88, 80, 0.35)',
      color: 'var(--fg)',
      display: 'flex', alignItems: 'flex-start', gap: 14,
    }}>
      <div style={{
        flexShrink: 0, marginTop: 2,
        width: 22, height: 22, borderRadius: 99,
        background: 'rgba(214, 88, 80, 0.25)', color: 'var(--danger)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, fontSize: 13,
      }}>!</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{info.title}</div>
        {info.body && (
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            {info.body}
          </div>
        )}
        {raw && (
          <details style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
            <summary style={{ cursor: 'pointer' }}>Technical detail</summary>
            <code style={{ display: 'block', marginTop: 4, padding: 8, background: 'var(--surface-2)', borderRadius: 6, wordBreak: 'break-word' }}>
              {raw}
            </code>
          </details>
        )}
      </div>
      <button onClick={dismiss}
        aria-label="Dismiss"
        style={{
          flexShrink: 0, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
          background: 'transparent', color: 'var(--muted)',
          border: '1px solid var(--border)', borderRadius: 6,
        }}>Dismiss</button>
    </div>
  );
}
