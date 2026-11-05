// /me/invoices - "Payments": everything money-related across every
// business the person is a client of, in one place.
//   To pay      open invoices first, each with a Pay button
//   Packages    sessions left, Book a session
//   Memberships memberships and program subscriptions, with Cancel/Manage
//   Saved cards one per business (save, replace, remove)
//   Receipts    paid invoices and shop orders, newest first
//
// The old /me/billing (cards + memberships) and /me/orders (shop orders)
// pages now redirect here (#cards, #receipts) so links in emails and the
// 1.0.4 app keep working.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { usePullRefresh } from '../../lib/pullRefresh.js';
import { PackageCard, RedeemPackageModal } from './ClientPackages.jsx';
import { accessLine } from './ClientPrograms.jsx';
import {
  fmtDay, fmtDate, fmtMoney, SectionTitle, BusinessAvatar, ErrorNote, SkelCards, EmptyCard, actionBtn,
} from './portalUi.jsx';

function intervalLabel(i) {
  return ({ week: 'a week', month: 'a month', quarter: 'every 3 months', year: 'a year' })[i] || 'a month';
}
const capitalize = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

export default function ClientInvoices() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [state, setState] = useState(null); // loaded data
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [redeeming, setRedeeming] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    const soft = (p, fb) => p.catch(() => fb);
    const [inv, pk, ms, progs, pm, orders] = await Promise.all([
      api.get('/me/invoices'),
      // include=recent: active packages plus ones used up or expired
      // lately, so the card can say "Used up" and offer Buy again.
      soft(api.get('/me/packages?include=recent'), { packages: [] }),
      soft(api.get('/me/memberships'), { memberships: [] }),
      soft(api.get('/me/programs'), { programs: [] }),
      soft(api.get('/me/payment-methods'), { cards: [] }),
      soft(api.get('/me/orders'), { orders: [] }),
    ]);
    setState({
      invoices: inv.invoices || [],
      packages: pk.packages || [],
      memberships: ms.memberships || [],
      programs: (progs.programs || []).filter((p) => p.enrollmentBilling === 'subscription' || p.canCancel || p.currentPeriodEnd),
      cards: pm.cards || [],
      orders: orders.orders || [],
    });
  }, []);

  useEffect(() => {
    let live = true;
    setError(null);
    load().catch((e) => live && setError(e));
    return () => { live = false; };
  }, [reloadKey, load]);
  usePullRefresh(() => load().catch(() => {}));

  // Jump to #packages / #cards / #receipts once the page has content.
  useEffect(() => {
    if (!state || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }, [state, location.hash]);

  // Card-saving return (?save=ok|cancel), shown briefly then cleared.
  const saveStatus = params.get('save');
  useEffect(() => {
    if (!saveStatus) return undefined;
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      next.delete('save');
      setParams(next, { replace: true });
    }, 5000);
    return () => clearTimeout(t);
  }, [saveStatus, params, setParams]);

  const openInvoice = async (id) => {
    setOpening(id); setActionErr(null);
    try {
      const r = await api.post('/me/invoices/' + id + '/access-link');
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      setActionErr(e.message || 'Could not open the invoice. Please try again.');
    } finally {
      setOpening(null);
    }
  };
  const run = async (fn) => {
    setBusy(true); setActionErr(null);
    try { await fn(); } catch (e) { setActionErr(e.message || 'Something went wrong. Please try again.'); } finally { setBusy(false); }
  };
  const saveCard = (clientId) => run(async () => {
    const r = await api.post('/me/payment-methods', { clientId });
    window.location.href = r.url;
  });
  const removeCard = (c) => {
    if (!window.confirm(`Remove the ${capitalize(c.brand) || 'card'} ending in ${c.last4} saved with ${c.businessName}?`)) return;
    run(async () => { await api.del('/me/payment-methods/' + encodeURIComponent(c.clientId)); await load(); });
  };
  const cancelMembership = (m) => {
    if (!window.confirm(`Cancel your ${m.membershipName} membership with ${m.businessName}? You keep access until the end of the time you have paid for.`)) return;
    run(async () => { await api.del('/me/memberships/' + encodeURIComponent(m.id)); await load(); });
  };

  if (error) {
    return (
      <div className="page-pad"><div className="portal-page">
        <EmptyCard icon="Dollar" title="We couldn't load your payments"
          hint="Check your connection and try again."
          action={<button className="btn btn-primary" onClick={() => setReloadKey((n) => n + 1)} style={actionBtn}>Try again</button>}/>
      </div></div>
    );
  }
  if (!state) {
    return <div className="page-pad"><div className="portal-page"><SkelCards rows={3}/></div></div>;
  }

  // Only invoices with money actually owed. A void or refunded invoice is
  // never here (it shows under receipts with "Nothing owed").
  const open = state.invoices
    .filter((i) => (i.status === 'sent' || i.status === 'overdue') && !(i.amountDue === 0 && Number(i.total) > 0))
    .sort((a, b) => (a.status === 'overdue' ? 0 : 1) - (b.status === 'overdue' ? 0 : 1) || String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
  const receipts = [
    ...state.invoices.filter((i) => i.status === 'paid' || i.status === 'refunded' || i.status === 'voided')
      .map((i) => ({ kind: 'invoice', id: i.id, at: i.paidAt || i.issueDate, inv: i })),
    ...state.orders.map((o) => ({ kind: 'order', id: o.id, at: o.paidAt || o.createdAt, order: o })),
  ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const subs = [...state.memberships.map((m) => ({ kind: 'membership', m })), ...state.programs.map((p) => ({ kind: 'program', p }))];
  const nothingAtAll = state.invoices.length === 0 && state.packages.length === 0 && subs.length === 0 && state.orders.length === 0;

  return (
    <div className="page-pad"><div className="portal-page">
      {saveStatus === 'ok' && <Banner tone="ok">Card saved. You're all set.</Banner>}
      {saveStatus === 'cancel' && <Banner>Card not saved. You can try again any time.</Banner>}
      <ErrorNote>{actionErr}</ErrorNote>

      {nothingAtAll ? (
        <EmptyCard icon="Dollar" title="Nothing to pay"
          hint="When a business sends you an invoice or you buy a package, it will show up here."
          action={<Link to="/me/bookings" className="btn btn-outline" style={actionBtn}>See your bookings</Link>}/>
      ) : (
        <section aria-label="To pay">
          <SectionTitle>To pay</SectionTitle>
          {open.length === 0 ? (
            <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                background: 'color-mix(in srgb, var(--ok) 14%, var(--surface))', color: 'var(--ok)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><Icons.Check size={18} sw={2}/></div>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>You're all paid up</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {open.map((inv) => <OpenInvoice key={inv.id} inv={inv} opening={opening === inv.id} onPay={() => openInvoice(inv.id)}/>)}
            </div>
          )}
        </section>
      )}

      {state.packages.length > 0 && (
        <section aria-label="Packages">
          <SectionTitle id="packages">Packages</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {state.packages.map((p) => <PackageCard key={p.id} pkg={p} onBook={setRedeeming}/>)}
          </div>
        </section>
      )}

      {subs.length > 0 && (
        <section aria-label="Memberships">
          <SectionTitle id="memberships">Memberships</SectionTitle>
          <div className="card" style={{ overflow: 'hidden' }}>
            {subs.map((s, i) => (s.kind === 'membership'
              ? <MembershipRow key={'m' + s.m.id} m={s.m} first={i === 0} busy={busy} onCancel={() => cancelMembership(s.m)}/>
              : <ProgramSubRow key={'p' + s.p.id} p={s.p} first={i === 0}/>))}
          </div>
        </section>
      )}

      {state.cards.length > 0 && (
        <section aria-label="Saved cards">
          <SectionTitle id="cards">Saved cards</SectionTitle>
          <div style={{ fontSize: 13, color: 'var(--muted)', margin: '-2px 2px 10px', lineHeight: 1.5 }}>
            Each card is kept with one business only. It pays that business in one tap and covers any late-cancellation fee.
          </div>
          <div className="card" style={{ overflow: 'hidden' }}>
            {state.cards.map((c, i) => (
              <div key={c.clientId} style={{
                padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              }}>
                <BusinessAvatar name={c.businessName} size={36}/>
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{c.businessName}</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
                    {c.hasCard
                      ? `${capitalize(c.brand) || 'Card'} ending in ${c.last4}${c.expMonth ? `, expires ${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}` : ''}`
                      : 'No card saved'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {c.hasCard ? (
                    <>
                      <button className="btn btn-outline" disabled={busy} onClick={() => saveCard(c.clientId)} style={actionBtn}>Replace</button>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => removeCard(c)} style={{ ...actionBtn, color: 'var(--danger)' }}>Remove</button>
                    </>
                  ) : (
                    <button className="btn btn-outline" disabled={busy} onClick={() => saveCard(c.clientId)} style={actionBtn}>
                      <Icons.Plus size={13} sw={2}/> Save a card
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {receipts.length > 0 && (
        <section aria-label="Receipts">
          <SectionTitle id="receipts">Receipts</SectionTitle>
          <Receipts items={receipts} opening={opening} onOpen={openInvoice}/>
        </section>
      )}

      {redeeming && (
        <RedeemPackageModal pkg={redeeming} onClose={() => setRedeeming(null)}
          onBooked={() => { setRedeeming(null); load().catch(() => {}); }}/>
      )}
    </div></div>
  );
}

function Banner({ tone, children }) {
  return (
    <div role="status" style={{
      padding: '11px 14px', borderRadius: 12, fontSize: 13.5,
      background: tone === 'ok' ? 'color-mix(in srgb, var(--ok) 10%, var(--surface))' : 'var(--surface-2)',
      border: `1px solid ${tone === 'ok' ? 'color-mix(in srgb, var(--ok) 45%, var(--border))' : 'var(--border)'}`,
      color: tone === 'ok' ? 'var(--ok)' : 'var(--fg-2)',
    }}>{children}</div>
  );
}

function OpenInvoice({ inv, opening, onPay }) {
  const overdue = inv.status === 'overdue';
  const due = inv.amountDue > 0 ? inv.amountDue : inv.total;
  const paidSoFar = inv.netPaid ?? inv.paidAmount;
  const partly = paidSoFar > 0 && inv.amountDue > 0 && inv.amountDue < inv.total;
  return (
    <div className="card" style={{ padding: 16, borderColor: overdue ? 'color-mix(in srgb, var(--danger) 45%, var(--border))' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 170px', minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 650, overflowWrap: 'anywhere' }}>{inv.businessName}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
            Invoice {inv.number}{inv.dueDate ? ` · due ${fmtDay(inv.dueDate)}` : ''}
          </div>
          {overdue && <div style={{ fontSize: 13, color: 'var(--danger)', fontWeight: 600, marginTop: 4 }}>Overdue</div>}
          {partly && <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 4 }}>{fmtMoney(paidSoFar, inv.currency)} paid so far</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="mono-num" style={{ fontSize: 20, fontWeight: 650 }}>{fmtMoney(due, inv.currency)}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={onPay} disabled={opening} className="btn btn-primary" style={{ ...actionBtn, flex: '1 1 auto', maxWidth: 260 }}>
          {opening ? 'Opening…' : `Pay ${fmtMoney(due, inv.currency)}`}
        </button>
      </div>
    </div>
  );
}

function MembershipRow({ m, first, busy, onCancel }) {
  let status = '';
  if (m.status === 'past_due') status = 'Payment did not go through. Please update your card.';
  else if (m.status === 'incomplete') status = 'Waiting for your first payment';
  else if (m.cancelAtPeriodEnd && m.currentPeriodEnd) status = `Ends ${fmtDate(m.currentPeriodEnd)}`;
  else if (m.currentPeriodEnd) status = `Renews ${fmtDate(m.currentPeriodEnd)}`;
  return (
    <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderTop: first ? 'none' : '1px solid var(--border)' }}>
      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{m.membershipName}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
          {m.businessName} · {fmtMoney((m.priceCents || 0) / 100)} {intervalLabel(m.interval)}
        </div>
        {status && <div style={{ fontSize: 13, color: m.status === 'past_due' ? 'var(--danger)' : 'var(--fg-2)', marginTop: 2 }}>{status}</div>}
      </div>
      {!m.cancelAtPeriodEnd && m.status !== 'cancelled' && (
        <button className="btn btn-ghost" disabled={busy} onClick={onCancel} style={{ ...actionBtn, color: 'var(--danger)' }}>
          Cancel membership
        </button>
      )}
    </div>
  );
}

function ProgramSubRow({ p, first }) {
  const line = accessLine(p, '');
  return (
    <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderTop: first ? 'none' : '1px solid var(--border)' }}>
      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{p.title}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
          Program from {p.businessName}{p.priceCents ? ` · ${fmtMoney(p.priceCents / 100)}` : ''}
        </div>
        {(line || p.enrollmentStatus === 'past_due') && (
          <div style={{ fontSize: 13, color: p.enrollmentStatus === 'past_due' ? 'var(--danger)' : 'var(--fg-2)', marginTop: 2 }}>
            {p.enrollmentStatus === 'past_due' ? 'Payment did not go through' : line}
          </div>
        )}
      </div>
      <Link to={`/me/programs/${p.id}`} className="btn btn-outline" style={actionBtn}>Manage</Link>
    </div>
  );
}

const RECEIPT_STATUS = { paid: 'Paid', refunded: 'Refunded', voided: 'Voided' };

// One short line under a settled invoice so a refund or a void is never
// read as money owed.
function receiptNote(inv) {
  const refunded = Number(inv.refundedAmount || 0);
  if (inv.status === 'voided') return 'Voided. Nothing owed.';
  if (inv.status === 'refunded') return `Refunded in full${inv.refundedAt ? ` on ${fmtDate(inv.refundedAt)}` : ''}. Nothing owed.`;
  if (inv.status === 'paid' && refunded > 0) return `${fmtMoney(refunded, inv.currency)} refunded. Nothing owed.`;
  return null;
}

function Receipts({ items, opening, onOpen }) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState({});
  const shown = showAll ? items : items.slice(0, 8);
  return (
    <>
      <div className="card" style={{ overflow: 'hidden' }}>
        {shown.map((r, i) => {
          const border = i === 0 ? 'none' : '1px solid var(--border)';
          if (r.kind === 'invoice') {
            const inv = r.inv;
            return (
              <div key={'i' + r.id} style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 12, borderTop: border }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{inv.businessName}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
                    {RECEIPT_STATUS[inv.status] || 'Paid'} · {fmtDate(r.at)} · Invoice {inv.number}
                  </div>
                  {receiptNote(inv) && (
                    <div data-testid="receipt-note" style={{ fontSize: 12.5, color: 'var(--fg-2)', marginTop: 2 }}>{receiptNote(inv)}</div>
                  )}
                </div>
                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <span className="mono-num" style={{ fontSize: 14.5, fontWeight: 600, textDecoration: inv.status === 'voided' || inv.status === 'refunded' ? 'line-through' : 'none' }}>
                    {fmtMoney(inv.total, inv.currency)}
                  </span>
                  <button onClick={() => onOpen(inv.id)} disabled={opening === inv.id}
                    style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    {opening === inv.id ? 'Opening…' : 'View'}
                  </button>
                </div>
              </div>
            );
          }
          const o = r.order;
          const isOpen = !!expanded[o.id];
          return (
            <div key={'o' + r.id} style={{ padding: '13px 16px', borderTop: border }}>
              <button onClick={() => setExpanded((p) => ({ ...p, [o.id]: !isOpen }))} aria-expanded={isOpen}
                style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 12, background: 'transparent', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{o.businessName}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
                    {o.status === 'refunded' ? 'Refunded' : 'Order'} · {fmtDate(r.at)} · {o.items.length} item{o.items.length === 1 ? '' : 's'}
                  </div>
                </div>
                <span className="mono-num" style={{ fontSize: 14.5, fontWeight: 600 }}>{fmtMoney(o.total)}</span>
                <Icons.ArrowDown size={13} stroke="var(--muted)" style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }}/>
              </button>
              {isOpen && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
                  {o.items.map((it, j) => (
                    <div key={j} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13.5, padding: '3px 0', color: 'var(--fg-2)' }}>
                      <span style={{ overflowWrap: 'anywhere' }}>{it.qty} x {it.name}</span>
                      <span className="mono-num">{fmtMoney(Number(it.rate || 0) * Number(it.qty || 0))}</span>
                    </div>
                  ))}
                  {o.tax > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, padding: '3px 0', color: 'var(--muted)' }}>
                      <span>Tax</span><span className="mono-num">{fmtMoney(o.tax)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {items.length > 8 && (
        <button className="btn btn-ghost" onClick={() => setShowAll((v) => !v)} style={{ ...actionBtn, marginTop: 8 }}>
          {showAll ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}
