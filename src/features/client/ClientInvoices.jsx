// /me/invoices — list of every invoice the user owes or has paid, across
// businesses. Status chip + amount; click "View / pay" → server issues a
// fresh view token and we open the existing public /invoice/:token page.
//
// Header above the invoice list deliberately avoids spend metrics
// (lifetime spend, monthly spend). Surfacing money-flowed-out to a
// client framed them as cost-bearers and primed guilt about coming
// back. Instead we show forward-looking + value-already-paid-for
// metrics: next visit, sessions / package / membership remaining,
// and the genuinely-useful Outstanding tile. "Member since" runs
// above the tiles as a quiet longevity signal.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
// businesses — each invoice carries its own currency. Outstanding tile
// aggregates across mixed currencies; we show it in the dominant
// currency, or USD if none.
function fmtMoney(n, currency = 'USD') {
  return fmtMoneyShared(n, currency);
}
// "Member since" — month + year is the right granularity (specific date
// feels surveillance-y, year-only feels meaningless).
function fmtMonthYear(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString([], { month: 'long', year: 'numeric' });
}
// Short date for tile hints — e.g. "Thu Jun 12".
function fmtShortDate(iso) {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
// "2:30 PM" — used in the Next-visit tile so a client at a glance knows
// not just the day but the time.
function fmtTime(startMin) {
  if (startMin == null) return '';
  const h = Math.floor(startMin / 60);
  const m = startMin % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

export default function ClientInvoices() {
  const [data, setData]         = useState(null); // full /me/invoices response
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [opening, setOpening]   = useState(null); // invoice id currently being opened

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    api.get('/me/invoices')
      .then((r) => live && setData(r || {}))
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

  const invoices = data?.invoices || [];

  // Pick the dominant currency across the user's invoices for the
  // Outstanding tile. Cross-currency sums don't strictly make sense,
  // but most users have a single dominant currency; the alternative
  // — N tiles per currency — clutters the UI for the 99% case.
  const currencyCounts = invoices.reduce((m, i) => {
    const c = (i.currency || 'USD').toUpperCase();
    m[c] = (m[c] || 0) + 1;
    return m;
  }, {});
  const summaryCurrency = Object.entries(currencyCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';

  const unpaidInvoices = invoices.filter((i) => i.status === 'sent' || i.status === 'overdue');
  const totalOwed = unpaidInvoices.reduce((s, i) => s + (i.total || 0), 0);

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <h2 style={{
          fontFamily: 'var(--font-display)', fontWeight: 500,
          fontSize: 'clamp(26px, 4vw, 32px)',
          letterSpacing: '-0.03em', margin: '0 0 6px', lineHeight: 1.05,
        }}>Payments</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
          Every invoice across every business that's billed you on Ivy OS.
        </p>
        {data?.joinedAt && (
          <p style={{
            color: 'var(--muted)', fontSize: 12, margin: '8px 0 0',
            fontStyle: 'italic',
          }}>
            Member since {fmtMonthYear(data.joinedAt)}
          </p>
        )}
      </div>

      {/* Three tiles — value-framed, not spend-framed. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12,
      }}>
        <NextVisitTile
          nextBooking={data?.nextBooking}
          lastBookingBizSlug={data?.lastBookingBizSlug}/>
        <WhatYouHaveLeftTile
          pkg={data?.activePackage}
          membership={data?.activeMembership}
          sessionsThisYear={data?.sessionsThisYear || 0}/>
        <SummaryTile
          label="Outstanding"
          value={fmtMoney(totalOwed, summaryCurrency)}
          tone={totalOwed > 0 ? 'warn' : 'ok'}
          hint={totalOwed > 0
            ? `${unpaidInvoices.length} unpaid`
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

// Tile 1 — Next visit. Shows the soonest upcoming booking when there is
// one, or a rebook CTA pointing at the last business the client saw
// when there isn't. Both states render at the same physical size so
// the row doesn't reflow when the answer changes day-to-day.
function NextVisitTile({ nextBooking, lastBookingBizSlug }) {
  if (nextBooking) {
    const dateBit = fmtShortDate(nextBooking.date) || '';
    const timeBit = fmtTime(nextBooking.startMin);
    const hint = [dateBit, timeBit, nextBooking.businessName]
      .filter(Boolean).join(' · ');
    return (
      <SummaryTile
        label="Next visit"
        value={nextBooking.serviceName || 'Booked'}
        tone="ok"
        hint={hint}/>
    );
  }
  if (lastBookingBizSlug) {
    return (
      <SummaryTile
        label="Next visit"
        value="Book your next →"
        hint="Tap to rebook"
        to={`/book/${lastBookingBizSlug}`}/>
    );
  }
  return (
    <SummaryTile
      label="Next visit"
      value="—"
      hint="No upcoming session"/>
  );
}

// Tile 2 — "What you've got left." Fallback chain: active package (the
// strongest rebook nudge — surfaces value already paid for) → active
// membership (reminds them what they're getting) → sessions count this
// year (frames engagement as activity, not expense).
function WhatYouHaveLeftTile({ pkg, membership, sessionsThisYear }) {
  if (pkg) {
    const expiry = pkg.expiresAt ? ` · expires ${fmtShortDate(pkg.expiresAt)}` : '';
    return (
      <SummaryTile
        label="Sessions left"
        value={`${pkg.creditsRemaining}`}
        tone="ok"
        hint={`${pkg.name || 'Package'}${expiry}`}/>
    );
  }
  if (membership) {
    const renews = membership.currentPeriodEnd
      ? ` · renews ${fmtShortDate(membership.currentPeriodEnd)}` : '';
    return (
      <SummaryTile
        label="Membership"
        value={membership.membershipName || 'Active'}
        tone="ok"
        hint={`${membership.businessName || ''}${renews}`}/>
    );
  }
  const year = new Date().getFullYear();
  return (
    <SummaryTile
      label="Sessions"
      value={`${sessionsThisYear}`}
      tone="muted"
      hint={sessionsThisYear === 0 ? 'Let’s get one on the books' : `in ${year}`}/>
  );
}

function SummaryTile({ label, value, tone, hint, to }) {
  const accent = tone === 'warn' ? 'var(--warn)'
    : tone === 'ok' ? 'var(--ok)'
    : 'var(--fg)';
  const content = (
    <>
      <div className="metric-label">{label}</div>
      <div className="mono-num" style={{
        fontSize: 26, fontWeight: 600, color: accent, letterSpacing: '-0.01em',
      }}>{value}</div>
      {hint && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{hint}</div>
      )}
    </>
  );
  const baseStyle = { padding: 16, display: 'flex', flexDirection: 'column', gap: 4 };
  // When `to` is set, the tile becomes a click target. We borrow the
  // .card class so the link inherits the same visual surface; reset
  // text-decoration + color so the inner copy doesn't suddenly turn
  // link-blue.
  if (to) {
    return (
      <Link to={to} className="card" style={{
        ...baseStyle, textDecoration: 'none', color: 'inherit', cursor: 'pointer',
      }}>
        {content}
      </Link>
    );
  }
  return (
    <div className="card" style={baseStyle}>
      {content}
    </div>
  );
}
