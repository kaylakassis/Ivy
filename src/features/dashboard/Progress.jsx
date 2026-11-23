// Progress: how the business is doing, away from the day-to-day.
//
// Home answers "what needs me today?" and nothing else. Everything that is
// about looking back or looking ahead lives here instead: the key numbers,
// this week with Ivy, recent activity, and goals and tasks. Same single
// API call as Home (/api/dashboard), shared through the device cache so
// opening this page from Home shows the numbers at once.
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SkelBlock } from '../../components/Skeleton.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { GoalsAndTasks } from '../goals/Goals.jsx';
import { api } from '../../lib/api.js';
import { readCache, writeCache } from '../../lib/deviceCache.js';
import { useUserContext } from '../../lib/userContext.jsx';
import { usePullRefresh } from '../../lib/pullRefresh.js';
import KeyNumbers from './KeyNumbers.jsx';
import SampleDataCard from './SampleDataCard.jsx';
import { fmtMoney } from './format.js';
import { payoffParts } from './payoff.js';

export default function Progress() {
  const [data, setData] = useState(() => readCache('dashboard'));
  const [loading, setLoading] = useState(() => !readCache('dashboard'));
  const [loadErr, setLoadErr] = useState(null);
  const { ctx } = useUserContext();
  const businessType = ctx?.owns?.businessType || 'both';

  const load = useCallback(async () => {
    try { const r = await api.get('/dashboard'); setData(r); setLoadErr(null); writeCache('dashboard', r); }
    catch (e) { setLoadErr(e?.message || 'Could not load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  usePullRefresh(load);
  // Links to a task or to the goals block land on it (#goals).
  useEffect(() => {
    if (loading || window.location.hash !== '#goals') return undefined;
    const t = setTimeout(() => document.getElementById('goals')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    return () => clearTimeout(t);
  }, [loading]);

  const currency = data?.currency || 'USD';
  const activity = data?.activity || [];
  const empty = !!data && Number(data.metrics?.clients || 0) === 0 && Number(data.metrics?.booked || 0) === 0;

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <Link to="/dashboard" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', textDecoration: 'none', marginBottom: 8 }}>
          <Icons.Arrow size={12} sw={1.9} style={{ transform: 'rotate(180deg)' }}/> Home
        </Link>
        <h2 className="page-title" style={{ margin: 0 }}>Progress</h2>
        <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--fg-2)' }}>Your numbers, this week, and your goals and tasks.</p>
      </div>

      {loadErr && !data && !loading ? (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 6 }}>Couldn't load your numbers</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Your data is safe. This is usually a connection blip.</div>
          <button type="button" className="btn btn-primary" onClick={() => { setLoadErr(null); setLoading(true); load(); }}>Try again</button>
        </div>
      ) : loading && !data ? (
        <div className="dash-numbers">
          {Array.from({ length: 5 }, (_, i) => <SkelBlock key={i} height={112}/>)}
        </div>
      ) : (
        <KeyNumbers k={data?.keyNumbers} currency={currency} loading={false} businessType={businessType}/>
      )}

      <SampleDataCard empty={empty} onChanged={load}/>

      {data?.week && <ThisWeekCard week={data.week} currency={currency}/>}

      <div className="card" style={{ padding: 20 }}>
        <div className="metric-label" style={{ marginBottom: 10 }}>Recent activity</div>
        {activity.length === 0 ? (
          <EmptyNote icon="Clock" title="Nothing yet" hint="Payments and bookings will appear here."/>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {activity.slice(0, 6).map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: 99, background: a.kind === 'payment' ? 'var(--ok)' : 'var(--accent)', flexShrink: 0 }}/>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.text}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{relTime(a.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div id="goals" style={{ scrollMarginTop: 80 }}>
        <div className="metric-label" style={{ marginBottom: 12 }}>Goals & tasks</div>
        <GoalsAndTasks/>
      </div>
    </div>
  );
}

// "This week with Ivy": the last 7 days in the same numbers the Monday
// recap email carries: sessions completed, what Ivy did, and the time that
// saved.
function fmtTimeSaved(minutes) {
  const m = Math.round(Number(minutes || 0));
  if (m < 90) return `about ${m} ${m === 1 ? 'minute' : 'minutes'}`;
  const h = Math.round((m / 60) * 10) / 10;
  return `about ${h} ${h === 1 ? 'hour' : 'hours'}`;
}
function ThisWeekCard({ week, currency }) {
  const rows = Array.isArray(week.ivyRows) ? week.ivyRows : [];
  const bits = [
    week.completedBookings > 0 && `${week.completedBookings} ${week.completedBookings === 1 ? 'session' : 'sessions'} completed`,
    week.bookingsTaken > 0 && `${week.bookingsTaken} new ${week.bookingsTaken === 1 ? 'booking' : 'bookings'}`,
    week.revenuePaid > 0 && `${fmtMoney(week.revenuePaid, currency)} collected`,
  ].filter(Boolean);
  if (!bits.length && !rows.length && !week.ivyTasks) return null;
  const payoff = payoffParts(week, currency);
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <span className="metric-label">This week with Ivy</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Last 7 days</span>
      </div>
      {bits.length > 0 && <div style={{ fontSize: 14, fontWeight: 600, marginBottom: rows.length ? 10 : 0 }}>{bits.join(' · ')}</div>}
      {payoff?.detail && (
        <div data-payoff style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: rows.length ? 10 : 0 }}>
          {payoff.headline}. {payoff.detail}.
        </div>
      )}
      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((text) => (
            <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <Icons.Check size={13} sw={2.4} stroke="var(--ok)"/>
              <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
            </div>
          ))}
        </div>
      )}
      {week.ivyTasks > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Time saved: {fmtTimeSaved(week.timeSavedMinutes)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Estimate: {week.minutesPerTask} minutes per task Ivy handled, across {week.ivyTasks} {week.ivyTasks === 1 ? 'task' : 'tasks'} (Ivy actions, automations and reminders).
          </div>
        </div>
      )}
    </div>
  );
}

function relTime(ts) {
  const d = Date.now() - new Date(ts).getTime();
  const mins = Math.round(d / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}
