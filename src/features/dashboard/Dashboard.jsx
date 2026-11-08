// The owner's home (1.0.6 redesign). Owner-first order:
//   1. Greeting + a one-line summary of the day + quick actions
//      (New booking, New client, New invoice, Ask Ivy).
//   2. Today (next appointment with Message / Start / Complete, money in
//      today and this week) beside "Needs your attention" (the
//      accountability partner's list, each row one tap from the fix).
//   3. One setup card (required steps first, plus "bring your clients
//      over" and sample data), which disappears when setup is done.
//   4. Key numbers with honest comparisons.
//   5. At most one promotional card (switching, 2-step, an automation Ivy
//      noticed, notifications, invite a friend), each still dismissible.
//   6. This week with Ivy, recent activity, goals and tasks.
// One API call (/api/dashboard) feeds everything above except the setup
// status; skeletons hold the layout while it loads.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { readCache, writeCache } from '../../lib/deviceCache.js';
import { Link, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SkelBlock } from '../../components/Skeleton.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { GoalsAndTasks } from '../goals/Goals.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { useUserContext } from '../../lib/userContext.jsx';
import { useIntervalWhenVisible } from '../../lib/useIntervalWhenVisible.js';
import { fireConfetti } from '../../lib/celebrate.js';
import SuccessToast from '../../components/SuccessToast.jsx';
import InviteFriendCard from './InviteFriendCard.jsx';
import SampleDataCard from './SampleDataCard.jsx';
import SwitchingCard, { dismissed as switchDismissed } from './SwitchingCard.jsx';
import WorkflowSuggestionCard from './WorkflowSuggestionCard.jsx';
import { FirstWinReadyCard, FirstWinMoment } from './FirstWinCards.jsx';
import ImportClientsModal from '../clients/ImportClientsModal.jsx';
import NotifyPrompt from '../../components/NotifyPrompt.jsx';
import TodayCard, { pickNext } from './TodayCard.jsx';
import AttentionCard from './AttentionCard.jsx';
import KeyNumbers from './KeyNumbers.jsx';
import { fmtMoney, fmtTime } from './format.js';
import { FLAGS } from '../../lib/featureFlags.js';
import { usePullRefresh } from '../../lib/pullRefresh.js';
import { isNative } from '../../lib/platform.js';
import { localISODate } from '../../lib/dateOnly.js';
import { saveSnapshot } from '../../lib/snapshot.js';
import { useOffline, useSnapshot } from '../../lib/useOffline.js';
import { OFFLINE_MESSAGE } from '../../lib/offline.js';
import OfflineTodayCard from '../../components/offline/OfflineTodayCard.jsx';

// ── setup card ─────────────────────────────────────────────────────────
// Dismissable via "Hide for now" for 7 days (re-shows after, or when a new
// item flips back to incomplete).
const DISMISS_KEY = 'ivy.setupChecklist.hideUntil';
const DISMISS_DAYS = 7;
function isDismissed() {
  try {
    const v = localStorage.getItem(DISMISS_KEY);
    return !!v && Date.now() < Number(v);
  } catch { return false; }
}
function dismissForAWeek() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 86400e3)); } catch { /* ignore */ }
}

// The owner's setup status (/api/me/setup-status), kept current when they
// come back to the tab after finishing a step elsewhere.
function useSetupStatus() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const emailVerifiedAt = user?.email_verified_at || null;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try { const r = await api.get('/me/setup-status'); if (!cancelled) setData(r); } catch { /* hide silently */ }
    };
    load();
    const onFocus = () => load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [emailVerifiedAt]);
  return data;
}

function ChecklistRow({ item }) {
  return (
    <Link to={item.href} style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', borderRadius: 8,
      background: 'var(--surface)', border: '1px solid var(--border-strong)', textDecoration: 'none', color: 'inherit',
    }}>
      <span style={{
        width: 18, height: 18, borderRadius: 99, flexShrink: 0, marginTop: 1,
        background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
      }}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 550 }}>{item.label}</div>
        {item.why && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{item.why}</div>}
      </div>
      <Icons.Arrow size={12} stroke="var(--muted)" sw={1.8} style={{ alignSelf: 'center', flexShrink: 0 }}/>
    </Link>
  );
}

function ActionRow({ icon, label, why, button, onClick, busy }) {
  const Icon = Icons[icon] || Icons.Spark;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8,
      background: 'var(--surface)', border: '1px solid var(--border-strong)', flexWrap: 'wrap',
    }}>
      <span style={{ width: 18, display: 'inline-flex', justifyContent: 'center', color: 'var(--accent)' }}><Icon size={15}/></span>
      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 550 }}>{label}</div>
        {why && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{why}</div>}
      </div>
      <button type="button" className="btn btn-outline" disabled={busy} onClick={onClick} style={{ padding: '6px 11px', fontSize: 12.5 }}>
        {button}
      </button>
    </div>
  );
}

// One card for everything "getting set up": the required steps (or, once
// those are done, the recommended ones), bringing clients over from
// another app, and trying the app with sample data.
function SetupCard({ status, switchPrompt, offerSample, onHide, onChanged }) {
  const [open, setOpen] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);
  const required = status.items.filter((i) => i.required);
  const recommended = status.items.filter((i) => !i.required);
  const phase = status.complete ? 'recommended' : 'required';
  const group = phase === 'required' ? required : recommended;
  const done = group.filter((i) => i.done).length;
  const left = group.filter((i) => !i.done);
  const next = left[0];
  const pct = Math.round((done / Math.max(1, group.length)) * 100);
  const tone = phase === 'required' ? 'var(--accent)' : 'var(--ok)';
  const addSample = async () => {
    setSampleBusy(true);
    try { await api.post('/onboarding/sample-data'); onChanged?.(); } catch { /* leave as is */ }
    finally { setSampleBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="setup-h" style={{
      padding: 18, borderColor: tone,
      background: phase === 'required' ? 'color-mix(in srgb, var(--accent-soft) 45%, var(--surface))' : 'var(--surface)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0, background: tone,
          color: phase === 'required' ? 'var(--accent-ink)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Check size={16} sw={2.4}/></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 id="setup-h" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
              {phase === 'required' ? 'Finish setting up your business' : "You're ready for bookings. A few extras"}
            </h3>
            <span style={{ fontSize: 11, fontWeight: 650, padding: '2px 8px', borderRadius: 99, background: tone, color: phase === 'required' ? 'var(--accent-ink)' : '#fff' }}>
              {done}/{group.length}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginTop: 3, lineHeight: 1.5 }}>
            {phase === 'required' ? 'A few quick steps and your booking page can take bookings.' : 'Optional, but each one helps you get paid and found.'}
            {next && <> Up next: <strong>{next.label.charAt(0).toLowerCase() + next.label.slice(1)}</strong>.</>}
          </div>
          <div style={{ height: 6, borderRadius: 99, background: 'var(--border)', overflow: 'hidden', margin: '10px 0 12px' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: tone, transition: 'width .25s ease' }}/>
          </div>
          {open && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {left.map((item) => <ChecklistRow key={item.id} item={item}/>)}
              {switchPrompt && (
                <ActionRow icon="Users" label="Switching from another app?" button="Bring them over"
                  why="Bring your clients and upcoming appointments over in a few minutes. Nobody gets a message unless you say so."
                  onClick={() => setImportOpen(true)}/>
              )}
              {offerSample && (
                <ActionRow icon="Spark" label="See it with sample data" button={sampleBusy ? 'Adding…' : 'Add sample data'} busy={sampleBusy}
                  why="One sample client, booking and invoice. Remove it any time." onClick={addSample}/>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {next && (
              <Link to={next.href} className="btn btn-primary" style={{ padding: '7px 14px', fontSize: 12.5, textDecoration: 'none' }}>
                {next.label} <Icons.Arrow size={11} sw={2}/>
              </Link>
            )}
            <button type="button" onClick={() => setOpen((o) => !o)} className="btn btn-ghost" style={{ padding: '7px 10px', fontSize: 12.5, color: 'var(--muted)' }}>
              {open ? 'Hide steps' : 'Show all steps'}
            </button>
            <div style={{ flex: 1 }}/>
            <button type="button" onClick={onHide} className="btn btn-ghost" style={{ padding: '7px 10px', fontSize: 12.5, color: 'var(--muted)' }}
              title="Hide for 7 days. It comes back if anything changes.">
              Hide for now
            </button>
          </div>
        </div>
      </div>
      {importOpen && <ImportClientsModal onClose={() => setImportOpen(false)} onComplete={() => onChanged?.()}/>}
    </section>
  );
}

// ── hero ───────────────────────────────────────────────────────────────
function summaryLine(data, setupFirst) {
  if (!data) return 'Here is your day.';
  const today = data.today || [];
  const next = pickNext(today);
  const n = today.length;
  const parts = [];
  if (n === 0) parts.push('Nothing on the calendar today.');
  else parts.push(`${n} ${n === 1 ? 'appointment' : 'appointments'} today${next ? `, next at ${fmtTime(next.startMin)}` : ', all done'}.`);
  const a = data.attention;
  if (a && !a.snoozedToday) {
    const k = (a.items || []).filter((i) => i.key !== 'setup').length;
    if (k > 0) parts.push(`${k} ${k === 1 ? 'thing needs' : 'things need'} you.`);
    else if (setupFirst) parts.push("A few setup steps and your booking page is ready.");
    else parts.push("You're all caught up.");
  }
  return parts.join(' ');
}

function HeroBand({ data, setupFirst = false, offline = false }) {
  const hour = new Date().getHours();
  const nav = useNavigate();
  const { user } = useAuth();
  const first = (user?.name || '').trim().split(/\s+/)[0] || '';
  const timeOfDay = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const greet = first ? `${timeOfDay}, ${first}` : timeOfDay;
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  const streak = data?.streak;
  const actions = [
    { label: 'New booking', icon: 'Calendar', to: '/calendar?newBooking=new' },
    { label: 'New client', icon: 'Users', to: '/clients?add=1' },
    { label: 'New invoice', icon: 'Dollar', to: '/finance?newInvoice=new' },
    { label: 'Ask Ivy', icon: 'Spark', to: '/ivy', primary: true },
  ];
  return (
    <div className="hero-band" style={{
      display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap',
      padding: '22px 32px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: '0.04em' }}>{dateStr}</span>
          {streak?.days >= 2 && (
            <span title={streak.best > streak.days ? `Days in a row you've shown up. Personal best: ${streak.best}` : "Days in a row you've shown up"}
              style={{ fontSize: 11.5, fontWeight: 650, padding: '2px 9px', borderRadius: 99, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              🔥 {streak.days}-day streak
            </span>
          )}
        </div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 34 }}>{greet}.</h2>
        <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--fg-2)', maxWidth: 620, minHeight: 20 }}>
          {offline ? 'Here is what Ivy saved on this phone.' : summaryLine(data, setupFirst)}
        </p>
      </div>
      {/* Offline (iPhone app): these all need the server, so they wait, with
          the reason said plainly instead of a spinner. */}
      <nav aria-label="Quick actions" className="dash-actions" style={offline ? { opacity: 0.55 } : undefined}>
        {actions.map((a) => {
          const Icon = Icons[a.icon];
          return (
            <button key={a.label} type="button" className={a.primary ? 'btn btn-primary' : 'btn btn-outline'} onClick={() => nav(a.to)}
              disabled={offline} title={offline ? OFFLINE_MESSAGE : undefined}>
              <Icon size={14}/>{a.label}
            </button>
          );
        })}
      </nav>
      {offline && <div role="status" style={{ flexBasis: '100%', fontSize: 12.5, color: 'var(--muted)', marginTop: -6 }}>{OFFLINE_MESSAGE}</div>}
    </div>
  );
}

// ── skeleton (first load, nothing cached) ──────────────────────────────
function DashboardSkeleton() {
  return (
    <>
      <div className="dash-top">
        <SkelBlock height={220}/>
        <SkelBlock height={220}/>
      </div>
      <div className="dash-numbers">
        {Array.from({ length: 5 }, (_, i) => <SkelBlock key={i} height={112}/>)}
      </div>
    </>
  );
}

// ── one promotional card at a time ─────────────────────────────────────
function PromoSlot({ data, setupVisible, onChanged }) {
  const [notifyShowing, setNotifyShowing] = useState(false);
  const onNotify = useCallback((v) => setNotifyShowing(!!v), []);
  if (!data) return null;
  if (data.switchPrompt && !setupVisible && !switchDismissed()) return <SwitchingCard show onImported={onChanged}/>;
  if (data.twoStepPrompt) return <TwoStepCard show/>;
  if (data.workflowSuggestion) return <WorkflowSuggestionCard suggestion={data.workflowSuggestion} onChanged={onChanged}/>;
  return (
    <>
      <NotifyPrompt onShowChange={onNotify}/>
      {!notifyShowing && FLAGS.referrals && <InviteFriendCard/>}
    </>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(() => readCache('dashboard'));
  const [loadErr, setLoadErr] = useState(null);
  const [loading, setLoading] = useState(() => !readCache('dashboard'));
  const { ctx } = useUserContext();
  const businessType = ctx?.owns?.businessType || 'both';
  const setup = useSetupStatus();
  const [setupHidden, setSetupHidden] = useState(() => isDismissed());

  // iPhone app with no signal: today's card from the copy saved on the phone.
  const offline = useOffline();
  const offlineView = isNative() && offline;
  const offlineSnapshot = useSnapshot('bookings');

  const loadDashboard = useCallback(async () => {
    try {
      const r = await api.get('/dashboard'); setData(r); setLoadErr(null); writeCache('dashboard', r);
      // iPhone app: today's and tomorrow's appointments for use without signal.
      const today = localISODate();
      saveSnapshot('bookings', [...(r.today || []), ...(r.tomorrow || [])], { today, tomorrow: localISODate(new Date(Date.now() + 86400e3)) });
    }
    catch (e) {
      // A failed fetch must NOT masquerade as an empty business; keep
      // showing what we had and only surface the error when there is none.
      setLoadErr(e?.message || 'Could not load');
    }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadDashboard(); }, [loadDashboard]);
  usePullRefresh(loadDashboard);
  useEffect(() => {
    if (loading || window.location.hash !== '#goals') return undefined;
    const t = setTimeout(() => document.getElementById('goals')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    return () => clearTimeout(t);
  }, [loading]);
  useIntervalWhenVisible(loadDashboard, 30000);

  const [streakToast, setStreakToast] = useState(null);
  const celebratedMs = useRef(null);
  useEffect(() => {
    const ms = data?.streak?.milestone;
    if (ms && celebratedMs.current !== ms) {
      celebratedMs.current = ms;
      fireConfetti();
      setStreakToast(`🔥 ${ms}-day streak!`);
    }
  }, [data?.streak?.milestone]);

  const currency = data?.currency || 'USD';
  const activity = data?.activity || [];
  // A business with no real clients or bookings yet.
  const empty = !!data && Number(data.metrics?.clients || 0) === 0 && Number(data.metrics?.booked || 0) === 0;
  const showReady = !!data?.firstWin?.showReady;
  const setupVisible = !!setup && Array.isArray(setup.items) && setup.items.length > 0
    && !setup.fullyComplete && !setupHidden && !showReady;
  const setupFirst = setupVisible && !setup.complete;
  const setupCard = setupVisible && (
    <SetupCard status={setup} switchPrompt={!!data?.switchPrompt} offerSample={empty}
      onHide={() => { dismissForAWeek(); setSetupHidden(true); }} onChanged={loadDashboard}/>
  );

  if (offlineView) {
    return (
      <div>
        <HeroBand data={null} offline/>
        <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <OfflineTodayCard snapshot={offlineSnapshot}/>
          {data?.keyNumbers && <KeyNumbers k={data.keyNumbers} currency={currency} loading={false} businessType={businessType}/>}
        </div>
      </div>
    );
  }

  if (loadErr && !data && !loading) {
    return (
      <div>
        <HeroBand data={null}/>
        <div className="page-pad">
          <div className="card" style={{ padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 6 }}>Couldn't load your dashboard</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.55 }}>
              Your data is safe. This is usually a connection blip.
            </div>
            <button type="button" className="btn btn-primary" style={{ padding: '9px 20px' }}
              onClick={() => { setLoadErr(null); loadDashboard(); }}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <HeroBand data={data} setupFirst={setupFirst}/>
      <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <FirstWinMoment celebrations={data?.firstWin?.celebrations}/>
        <FirstWinReadyCard show={showReady} onDone={loadDashboard}/>
        {setupFirst && setupCard}

        {loading && !data ? <DashboardSkeleton/> : (
          <>
            <div className="dash-top">
              <TodayCard today={data?.today || []} money={data?.money} currency={currency} onChanged={loadDashboard}/>
              <AttentionCard attention={data?.attention} hideKeys={setupVisible ? ['setup'] : []} onChanged={loadDashboard}/>
            </div>
            <KeyNumbers k={data?.keyNumbers} currency={currency} loading={false} businessType={businessType}/>
          </>
        )}

        {!setupFirst && setupCard}
        <SampleDataCard empty={false} onChanged={loadDashboard}/>
        <PromoSlot data={data} setupVisible={setupVisible} onChanged={loadDashboard}/>

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
      <SuccessToast text={streakToast} onDone={() => setStreakToast(null)}/>
    </div>
  );
}

// "This week with Ivy": the last 7 days in the same numbers the Monday
// recap email carries. Money and new clients now live in Key numbers, so
// this card keeps what only it says: sessions completed, what Ivy did, and
// the time that saved.
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
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <span className="metric-label">This week with Ivy</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Last 7 days</span>
      </div>
      {bits.length > 0 && <div style={{ fontSize: 14, fontWeight: 600, marginBottom: rows.length ? 10 : 0 }}>{bits.join(' · ')}</div>}
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

// "Turn on 2-step verification": shown once the owner has used Ivy for a few
// days or connected card payments (server decides), until 2-step is on or
// the owner dismisses it (saved on the account, so gone on every device).
function TwoStepCard({ show }) {
  const [gone, setGone] = useState(false);
  if (!show || gone) return null;
  const dismiss = () => {
    setGone(true);
    api.post('/me/two-step-prompt', { dismiss: true }).catch(() => { /* hidden for this visit anyway */ });
  };
  return (
    <div className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', flexWrap: 'wrap' }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)', color: 'var(--accent)' }}>
        <Icons.Lock size={16}/>
      </span>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>Turn on 2-step verification</div>
        <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 3, lineHeight: 1.5 }}>
          Ivy asks for a 6-digit code when you sign in, so a stolen password is not enough to get into your business. Email codes need no extra app.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
        <button type="button" onClick={dismiss} className="btn btn-ghost" style={{ padding: '7px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
          Dismiss
        </button>
        <Link to="/account?tab=security" className="btn btn-primary" style={{ padding: '7px 14px', fontSize: 12.5, textDecoration: 'none' }}>
          Turn on <Icons.Arrow size={11} sw={2}/>
        </Link>
      </div>
    </div>
  );
}
