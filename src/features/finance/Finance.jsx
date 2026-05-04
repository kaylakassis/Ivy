// Finance dashboard + invoices list. Online card collection via Stripe lives
// in the StripeConnectCard near the top of the page.
import React, { useState, useEffect, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useInvoices } from './state.js';
import InvoiceEditor from './InvoiceEditor.jsx';
import SendInvoiceModal from './SendInvoiceModal.jsx';
import StripeConnectCard from './StripeConnectCard.jsx';

const STATUS_META = {
  draft:    { label: 'Draft',    color: 'var(--muted)' },
  sent:     { label: 'Sent',     color: 'var(--warn)' },
  paid:     { label: 'Paid',     color: 'var(--ok)' },
  overdue:  { label: 'Overdue',  color: 'var(--danger)' },
  voided:   { label: 'Voided',   color: 'var(--muted-2)' },
};

export default function Finance() {
  const {
    invoices, summary, loading, error,
    create, update, remove, send, markPaid, void: voidInvoice,
  } = useInvoices();

  const [tab, setTab]               = useState('all');
  const [openId, setOpenId]         = useState(null);
  const [creatingBusy, setCreating] = useState(false);
  const [sendingId, setSending]     = useState(null);

  const counts = useMemo(() => ({
    all:     invoices.length,
    draft:   summary?.counts.draft   ?? invoices.filter((i) => i.status === 'draft').length,
    sent:    summary?.counts.sent    ?? invoices.filter((i) => i.status === 'sent').length,
    overdue: summary?.counts.overdue ?? invoices.filter((i) => i.status === 'overdue').length,
    paid:    summary?.counts.paid    ?? invoices.filter((i) => i.status === 'paid').length,
    voided:  summary?.counts.voided  ?? invoices.filter((i) => i.status === 'voided').length,
  }), [summary, invoices]);

  const rows = useMemo(() => {
    if (tab === 'all') return invoices;
    return invoices.filter((i) => i.status === tab);
  }, [invoices, tab]);

  const openInv = invoices.find((i) => i.id === openId) || null;
  const sendingInv = invoices.find((i) => i.id === sendingId) || null;

  const startNew = async () => {
    if (creatingBusy) return;
    setCreating(true);
    try {
      const inv = await create({
        items: [{ id: 'li1', description: '', quantity: 1, rate: 0 }],
        taxRate: 0, discount: 0,
      });
      setOpenId(inv.id);
    } finally { setCreating(false); }
  };

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
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Finance</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Send invoices, track payments, watch revenue grow.
          </div>
        </div>
        <button className="btn btn-primary" onClick={startNew} disabled={creatingBusy}>
          <Icons.Plus size={13} sw={2}/> {creatingBusy ? 'Creating…' : 'New invoice'}
        </button>
      </div>

      <StripeConnectCard/>

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
      <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 4, borderRadius: 10, alignSelf: 'flex-start' }}>
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
        </div>
      </div>

      {openInv && (
        <InvoiceEditor
          invoice={openInv}
          onClose={() => setOpenId(null)}
          onSave={(patch) => update(openInv.id, patch)}
          onDelete={async () => { await remove(openInv.id); setOpenId(null); }}
          onSend={() => setSending(openInv.id)}
          onMarkPaid={(method) => markPaid(openInv.id, method)}
          onVoid={() => voidInvoice(openInv.id)}
        />
      )}
      {sendingInv && (
        <SendInvoiceModal
          invoice={sendingInv}
          onSend={async (clientId) => { await send(sendingInv.id, clientId); setSending(null); }}
          onClose={() => setSending(null)}
        />
      )}
    </div>
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
        {fmtMoney(invoice.total)}
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

function fmtMoney(n) {
  if (n == null) return '—';
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
