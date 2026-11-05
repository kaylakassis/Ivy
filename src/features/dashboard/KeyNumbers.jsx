// Key numbers with honest comparisons (api/_lib/dashboardNumbers.js). A
// comparison the server could not make (a business too new to have a last
// month) is null and reads "Not enough data yet", never a misleading 0%.
import React from 'react';
import { Link } from 'react-router-dom';
import { fmtMoney } from './format.js';

function Tile({ label, value, sub, tone, to, loading }) {
  return (
    <Link to={to} className="card" style={{
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 112,
      textDecoration: 'none', color: 'inherit', minWidth: 0,
    }}>
      <span className="metric-label">{label}</span>
      <span className="metric-value" style={{ fontSize: !loading && String(value).length > 10 ? 18 : 28, lineHeight: 1.15, color: loading ? 'var(--muted-2)' : 'var(--fg)' }}>
        {loading ? '-' : value}
      </span>
      <span style={{
        fontSize: 12, lineHeight: 1.4, minHeight: 17,
        color: tone === 'up' ? 'var(--ok)' : tone === 'down' ? 'var(--danger)' : 'var(--muted)',
      }}>{loading ? '' : sub}</span>
    </Link>
  );
}

const NOT_ENOUGH = 'Not enough data yet to compare';

export default function KeyNumbers({ k, currency, loading, businessType }) {
  const money = (n) => fmtMoney(n, currency);
  const rev = k?.revenue;
  let revSub = NOT_ENOUGH, revTone = null;
  if (rev && rev.lastMonthSamePoint != null) {
    if (rev.changePct != null) {
      revTone = rev.changePct >= 0 ? 'up' : 'down';
      revSub = `${rev.changePct >= 0 ? 'Up' : 'Down'} ${Math.abs(rev.changePct)}% vs this time last month (${money(rev.lastMonthSamePoint)})`;
    } else {
      revSub = `This time last month: ${money(rev.lastMonthSamePoint)}`;
    }
  }

  const bw = k?.bookingsWeek;
  const nc = k?.newClients;
  const out = k?.outstanding;
  const rb = k?.rebooking;
  const tiles = [
    { key: 'rev', label: 'Revenue this month', value: money(rev?.thisMonth), sub: revSub, tone: revTone, to: '/finance' },
    businessType !== 'product' && {
      key: 'bw', label: 'Bookings this week', value: String(bw?.thisWeek ?? 0),
      sub: bw?.lastWeek == null ? NOT_ENOUGH : `Last week: ${bw.lastWeek}`, to: '/calendar',
    },
    {
      key: 'nc', label: businessType === 'product' ? 'New customers this month' : 'New clients this month', value: String(nc?.thisMonth ?? 0),
      sub: nc?.lastMonthSamePoint == null ? NOT_ENOUGH : `This time last month: ${nc.lastMonthSamePoint}`, to: '/clients',
    },
    {
      key: 'out', label: 'Outstanding invoices', value: money(out?.total),
      sub: !out?.count ? 'Nothing waiting to be paid'
        : `${out.count} ${out.count === 1 ? 'invoice' : 'invoices'}${out.overdueCount ? `, ${money(out.overdueTotal)} overdue` : ''}`,
      tone: out?.overdueCount ? 'down' : null, to: out?.overdueCount ? '/finance?filter=overdue' : '/finance?section=invoices',
    },
    businessType !== 'product' && {
      key: 'rb', label: 'Rebooking rate', value: rb?.rate == null ? 'Not enough data yet' : `${rb.rate}%`,
      sub: rb?.rate == null
        ? `Shows once ${rb?.minCohort || 5} clients have visited in the last 1 to 4 months`
        : `${rb.rebooked} of ${rb.cohort} clients seen 1 to 4 months ago booked again`,
      to: '/clients',
    },
  ].filter(Boolean);
  return (
    <section aria-label="Key numbers" className="dash-numbers">
      {tiles.map((t) => (
        <Tile key={t.key} label={t.label} value={t.value} sub={t.sub} tone={t.tone} to={t.to} loading={loading || !k}/>
      ))}
    </section>
  );
}
