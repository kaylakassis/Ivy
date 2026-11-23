// The owner's home. It does one job: today.
//   1. Greeting + a one-line summary of the day + quick actions
//      (New booking, New client, New invoice), then the Ask Ivy box.
//   2. At most ONE prompt (the next set-up step, switching, 2-step,
//      an automation Ivy noticed, notifications, invite a friend). It
//      also waits its turn behind the billing strip and the email
//      reminder at the top of the screen (src/lib/promptQueue.js).
//   3. Today (next appointment with Message / Start / Complete, money in
//      today and this week) beside "Needs your attention" (up to three
//      things, each one tap from the fix).
//   4. A link to Progress, where the numbers, this week with Ivy, recent
//      activity and goals and tasks now live (Progress.jsx).
// One API call (/api/dashboard) feeds everything above except the setup
// status; skeletons hold the layout while it loads.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { readCache, writeCache } from '../../lib/deviceCache.js';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SkelBlock } from '../../components/Skeleton.jsx';
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
import NotifyPrompt from '../../components/NotifyPrompt.jsx';
import TodayCard, { pickNext } from './TodayCard.jsx';
import AttentionCard from './AttentionCard.jsx';
import AskIvyCard from './AskIvyCard.jsx';
import { fmtTime } from './format.js';
import { FLAGS } from '../../lib/featureFlags.js';
import { usePromptSlot, PROMPT_RANK } from '../../lib/promptQueue.js';
import { usePullRefresh } from '../../lib/pullRefresh.js';
import { checkPartnerRatingWin } from '../../lib/ratingPrompt.js';
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

// Set-up, one step at a time: the next thing to do, why it matters, and
// one button that goes there. First the steps the booking page needs, then
// (one by one) the optional ones. No list to read through.
function SetupCard({ status, offerSample, onHide, onChanged }) {
  const [sampleBusy, setSampleBusy] = useState(false);
  const required = status.items.filter((i) => i.required);
  const recommended = status.items.filter((i) => !i.required);
  const phase = status.complete ? 'recommended' : 'required';
  const group = phase === 'required' ? required : recommended;
  const done = group.filter((i) => i.done).length;
  const next = group.find((i) => !i.done);
  if (!next) return null;
  const pct = Math.round((done / Math.max(1, group.length)) * 100);
  const tone = phase === 'required' ? 'var(--accent)' : 'var(--ok)';
  const addSample = async () => {
    setSampleBusy(true);
    try { await api.post('/onboarding/sample-data'); onChanged?.(); } catch { /* leave as is */ }
    finally { setSampleBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="setup-h" data-home-prompt="setup" style={{
      padding: 16, borderColor: tone,
      background: phase === 'required' ? 'color-mix(in srgb, var(--accent-soft) 45%, var(--surface))' : 'var(--surface)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--fg-2)', fontWeight: 600 }}>
        <span>{phase === 'required' ? `Getting set up: step ${done + 1} of ${group.length}` : `You're ready for bookings. Extra ${done + 1} of ${group.length}`}</span>
        <div aria-hidden style={{ flex: 1, height: 5, borderRadius: 99, background: 'var(--border)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: tone, transition: 'width .25s ease' }}/>
        </div>
      </div>
      <h3 id="setup-h" style={{ margin: '10px 0 0', fontSize: 16, fontWeight: 700 }}>{next.label}</h3>
      {next.why && <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 3, lineHeight: 1.5 }}>{next.why}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Link to={next.href} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: 13, textDecoration: 'none' }}>
          Do this now <Icons.Arrow size={11} sw={2}/>
        </Link>
        {offerSample && phase === 'required' && (
          <button type="button" onClick={addSample} disabled={sampleBusy} className="btn btn-ghost"
            title="One sample client, booking and invoice. Remove it any time."
            style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--accent)' }}>
            {sampleBusy ? 'Adding…' : 'See it with sample data'}
          </button>
        )}
        <div style={{ flex: 1 }}/>
        <button type="button" onClick={onHide} className="btn btn-ghost" style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--muted)' }}
          title="Hide for 7 days. It comes back if anything changes.">
          Hide for now
        </button>
      </div>
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
  ];
  // (Ask Ivy is the box right under this band: AskIvyCard.)
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
    </>
  );
}

// ── one prompt at a time ───────────────────────────────────────────────
// Home shows at most one thing that asks the owner to do something. In
// order: "your booking page is ready", the next required set-up step,
// bringing clients over, 2-step verification, an automation Ivy noticed,
// the next optional set-up step, then the quiet ones (sample data is on,
// turn on notifications, invite a friend). It also waits behind the
// billing strip and the email reminder at the top of the screen. Once the
// owner hides one, nothing else takes its place on this visit.
function HomePrompt({ data, setup, empty, onChanged }) {
  const [setupHidden, setSetupHidden] = useState(() => isDismissed());
  const [quiet, setQuiet] = useState(false);
  const [tail, setTail] = useState({ sample: false, notify: false, invite: false });
  const onSample = useCallback((v) => setTail((t) => (t.sample === !!v ? t : { ...t, sample: !!v })), []);
  const onNotify = useCallback((v) => setTail((t) => (t.notify === !!v ? t : { ...t, notify: !!v })), []);
  const onInvite = useCallback((v) => setTail((t) => (t.invite === !!v ? t : { ...t, invite: !!v })), []);

  const showReady = !!data?.firstWin?.showReady;
  const setupOpen = !!setup && Array.isArray(setup.items) && setup.items.length > 0
    && !setup.fullyComplete && !setupHidden && !showReady;
  const required = setupOpen && !setup.complete;
  let pick = 'tail';
  if (!data || quiet) pick = null;
  else if (showReady) pick = 'ready';
  else if (required) pick = 'setup';
  else if (data.switchPrompt && !switchDismissed()) pick = 'switch';
  else if (data.twoStepPrompt) pick = 'twoStep';
  else if (data.workflowSuggestion) pick = 'workflow';
  else if (setupOpen) pick = 'setup';
  const wants = pick === 'tail' ? (tail.sample || tail.notify || tail.invite) : !!pick;
  const mine = usePromptSlot('home', wants, pick === 'ready' || required ? PROMPT_RANK.homeRequired : PROMPT_RANK.home);

  if (!pick) return null;
  if (pick === 'tail') {
    // These decide for themselves whether they have anything to say, so
    // they stay mounted (hidden) while something else has the turn.
    return (
      <div hidden={!mine} data-home-prompt="quiet" style={{ display: mine ? 'flex' : 'none', flexDirection: 'column' }}>
        <SampleDataCard empty={false} onChanged={onChanged} onShowChange={onSample}/>
        {!tail.sample && <NotifyPrompt onShowChange={onNotify}/>}
        {!tail.sample && !tail.notify && FLAGS.referrals && <InviteFriendCard onShowChange={onInvite}/>}
      </div>
    );
  }
  if (!mine) return null;
  if (pick === 'ready') return <FirstWinReadyCard show onDone={onChanged}/>;
  if (pick === 'setup') {
    return (
      <SetupCard status={setup} offerSample={empty} onChanged={onChanged}
        onHide={() => { dismissForAWeek(); setSetupHidden(true); setQuiet(true); }}/>
    );
  }
  if (pick === 'switch') return <SwitchingCard show onImported={onChanged}/>;
  if (pick === 'twoStep') return <TwoStepCard show/>;
  return <WorkflowSuggestionCard suggestion={data.workflowSuggestion} onChanged={onChanged}/>;
}

export default function Dashboard() {
  const [data, setData] = useState(() => readCache('dashboard'));
  const [loadErr, setLoadErr] = useState(null);
  const [loading, setLoading] = useState(() => !readCache('dashboard'));
  const { ctx } = useUserContext();
  const setup = useSetupStatus();
  const location = useLocation();

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
  useIntervalWhenVisible(loadDashboard, 30000);
  // iPhone app: a week with the accountability partner on and three items
  // cleared is a win worth asking for a rating on (src/lib/ratingPrompt.js).
  const partnerChecked = useRef(false);
  useEffect(() => {
    if (!isNative() || partnerChecked.current || !data?.attention?.partnerOn || !ctx?.isOwner) return;
    partnerChecked.current = true;
    checkPartnerRatingWin({ role: 'owner', pathname: '/dashboard' }).catch(() => {});
  }, [data?.attention?.partnerOn, ctx?.isOwner]);

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
  // A business with no real clients or bookings yet.
  const empty = !!data && Number(data.metrics?.clients || 0) === 0 && Number(data.metrics?.booked || 0) === 0;
  const showReady = !!data?.firstWin?.showReady;
  // The set-up steps still to do. While any are left, the "finish set-up"
  // row is left out of "Needs your attention" (the prompt above says it).
  const setupOpen = !!setup && Array.isArray(setup.items) && setup.items.length > 0 && !setup.fullyComplete && !showReady;
  const setupFirst = setupOpen && !setup.complete;

  // Goals and tasks moved to Progress. Old links, the iPhone app's
  // notifications and Ivy's daily message still point at Home's #goals.
  if (location.hash === '#goals') return <Navigate to={`/progress${location.search || ''}#goals`} replace/>;

  if (offlineView) {
    return (
      <div>
        <HeroBand data={null} offline/>
        <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <OfflineTodayCard snapshot={offlineSnapshot}/>
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
        <AskIvyCard/>
        <FirstWinMoment celebrations={data?.firstWin?.celebrations}/>
        <HomePrompt data={data} setup={setup} empty={empty} onChanged={loadDashboard}/>

        {loading && !data ? <DashboardSkeleton/> : (
          <div className="dash-top">
            <TodayCard today={data?.today || []} money={data?.money} currency={currency} onChanged={loadDashboard}/>
            <AttentionCard attention={data?.attention} hideKeys={setupOpen || showReady ? ['setup'] : []} onChanged={loadDashboard}/>
          </div>
        )}

        <Link to="/progress" className="card" data-home-progress style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', textDecoration: 'none', color: 'inherit',
        }}>
          <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-2)', color: 'var(--fg-2)' }}>
            <Icons.Trending size={16}/>
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>See your progress</span>
            <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', marginTop: 1 }}>Your numbers, this week, goals and tasks</span>
          </span>
          <Icons.Arrow size={13} stroke="var(--muted)" sw={1.8}/>
        </Link>
      </div>
      <SuccessToast text={streakToast} onDone={() => setStreakToast(null)}/>
    </div>
  );
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
          Ivy asks for a 6-digit code when you sign in, so a stolen password is not enough to get into your business.
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
