// Engagement on a program page: the member's streak, points and badges
// strip, the "check-in due" and "starts on" notes, a small celebration when
// a badge is earned, and the Leaderboard tab (member and coach views).
// Names and photos only: the API never sends an email or phone number.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fireConfetti, haptic } from '../../lib/celebrate.js';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import SuccessToast from '../../components/SuccessToast.jsx';
import { Avatar, Toggle } from './communityUi.jsx';

const fmtDay = (iso) => {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

// ── badge celebration ────────────────────────────────────────────────
// Anything that learns about new badges calls celebrateBadges(); the one
// <BadgeCelebration/> on the page shows a toast (and a small burst for the
// big ones) and tells the server they were seen, so each fires once.
export function celebrateBadges(programId, badges) {
  if (!badges?.length || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('ivy:program-badges', { detail: { programId, badges } }));
}

export function BadgeCelebration({ programId }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    const on = (e) => {
      if (e.detail?.programId !== programId) return;
      const list = e.detail.badges || [];
      if (!list.length) return;
      const top = list[list.length - 1];
      setText(list.length === 1 ? `${top.emoji} Badge earned: ${top.label}` : `${top.emoji} ${list.length} new badges, including ${top.label}`);
      if (typeof navigator === 'undefined' || navigator.userActivation?.hasBeenActive !== false) haptic('success');
      if (list.some((b) => b.badge === 'complete_100' || b.badge === 'streak_30' || b.badge === 'streak_7')) fireConfetti({ count: 60 });
      api.post(`/programs/${programId}/engagement`, { action: 'seen-badges' }).catch(() => {});
    };
    window.addEventListener('ivy:program-badges', on);
    return () => window.removeEventListener('ivy:program-badges', on);
  }, [programId]);
  const done = useCallback(() => setText(null), []);
  return <SuccessToast text={text} icon="Trophy" duration={4200} onDone={done}/>;
}

// The member's summary for this program (null while loading / for owners).
export function useEngagement(programId, role) {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    if (role !== 'member') return;
    api.get(`/programs/${programId}/engagement`).then((r) => {
      if (r.role !== 'member') return;
      setData(r);
      if (r.newBadges?.length) celebrateBadges(programId, r.newBadges);
    }).catch(() => {});
  }, [programId, role]);
  useEffect(() => { load(); }, [load]);
  return { data, reload: load };
}

// ── strip on the member's program page ───────────────────────────────
export function EngagementStrip({ data, onOpenCheckins }) {
  if (!data) return null;
  const s = data.streak || { current: 0, best: 0, unit: 'day' };
  const unit = s.unit === 'week' ? 'week' : 'day';
  const due = data.checkins?.due || 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {data.cohort && !data.cohort.started && (
        <div className="card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5 }}>
          <span style={{ flexShrink: 0, display: 'inline-flex' }}><Icons.Calendar size={16} stroke="var(--accent)"/></span>
          <span><b>Starts on {fmtDay(data.cohort.startDate || data.cohort.startsAt)}</b> with {data.cohort.name}. Welcome content is open now; the rest opens on the start date.</span>
        </div>
      )}
      {due > 0 && (
        <button type="button" onClick={onOpenCheckins} className="card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, textAlign: 'left', borderColor: 'var(--accent)' }}>
          <span style={{ flexShrink: 0, display: 'inline-flex' }}><Icons.Check size={16} stroke="var(--accent)"/></span>
          <span style={{ flex: 1 }}><b>Check-in due.</b> {due === 1 ? 'One check-in is waiting for you.' : `${due} check-ins are waiting for you.`}</span>
          <Icons.Arrow size={14} stroke="var(--muted)"/>
        </button>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip title={s.current ? `${s.current}-${unit} streak` : `No streak yet`} hint={s.best > s.current ? `Best: ${s.best} ${unit}s` : s.current ? (s.activeNow ? 'Keep it going' : `Show up this ${unit} to keep it`) : `Finish a lesson, post or check in`} icon="🔥" muted={!s.current}/>
        <Chip title={`${data.points?.week || 0} points`} hint="this week" icon="✨" muted={!data.points?.week}/>
        {(data.badges || []).length > 0 && (
          <div className="card" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6, minHeight: 46 }} aria-label="Badges">
            {data.badges.map((b) => <span key={b.badge} title={b.label} aria-label={b.label} style={{ fontSize: 18 }}>{b.emoji}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ title, hint, icon, muted }) {
  return (
    <div className="card" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, minHeight: 46 }}>
      <span aria-hidden="true" style={{ fontSize: 18, filter: muted ? 'grayscale(1)' : 'none', opacity: muted ? 0.6 : 1 }}>{icon}</span>
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
        <span style={{ fontSize: 13.5, fontWeight: 650 }}>{title}</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{hint}</span>
      </span>
    </div>
  );
}

// ── leaderboard tab ──────────────────────────────────────────────────
const PERIODS = [['week', 'This week'], ['month', 'This month'], ['all', 'All time']];
const BADGE_EMOJI = { complete_25: '🌱', complete_50: '🌿', complete_75: '🌳', complete_100: '🏁', first_post: '💬', streak_7: '🔥', streak_30: '⭐' };

export function Leaderboard({ programId, role }) {
  const [period, setPeriod] = useState('week');
  const [data, setData] = useState(null);
  const [me, setMe] = useState(null);
  const [err, setErr] = useState(null);
  const isOwner = role === 'owner';
  const load = useCallback(() => {
    api.get(`/programs/${programId}/engagement?view=leaderboard&period=${period}`).then(setData).catch((e) => setErr(e.message));
  }, [programId, period]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get(`/programs/${programId}/engagement`).then(setMe).catch(() => {}); }, [programId]);
  const patch = async (body) => {
    setErr(null);
    try { const r = await api.patch(`/programs/${programId}/engagement`, body); setMe((m) => ({ ...m, ...r })); load(); }
    catch (e) { setErr(e.message); }
  };
  if (!data) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{err || 'Loading…'}</div>;
  if (!isOwner && data.enabled === false) return <EmptyNote icon="Trophy" title="No leaderboard here" hint="The coach has the leaderboard switched off for this program."/>;
  const rows = data.rows || [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 }}>
      {isOwner && me && (
        <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Toggle checked={me.leaderboardEnabled} onChange={(v) => patch({ leaderboardEnabled: v })} label="Show a leaderboard to members"
            hint="Members earn points for finishing lessons, posting, replying, live sessions and check-ins. Anyone can hide themselves."/>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--fg-2)' }}>Streaks count</span>
            <select className="input" value={me.streakMode} onChange={(e) => patch({ streakMode: e.target.value })} style={{ width: 'auto', padding: '6px 10px' }} aria-label="Streak mode">
              <option value="daily">days in a row</option>
              <option value="weekly">weeks in a row</option>
            </select>
          </label>
          {!me.leaderboardEnabled && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Only you can see this preview right now.</div>}
        </div>
      )}
      <div role="tablist" aria-label="Period" style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, alignSelf: 'flex-start' }}>
        {PERIODS.map(([p, l]) => (
          <button key={p} type="button" role="tab" aria-selected={period === p} onClick={() => setPeriod(p)} style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 550, whiteSpace: 'nowrap', background: period === p ? 'var(--surface-2)' : 'transparent', color: period === p ? 'var(--fg)' : 'var(--muted)' }}>{l}</button>
        ))}
      </div>
      {!isOwner && data.me && (
        <div className="card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 700, minWidth: 44, textAlign: 'center', color: 'var(--accent)' }}>{data.me.rank ? `#${data.me.rank}` : <Icons.Trophy size={20}/>}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Your place</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{data.me.points ? `${data.me.points} points ${PERIODS.find((x) => x[0] === period)[1].toLowerCase()}` : 'No points yet. Finish a lesson to get on the board.'}{data.me.hidden ? ' · hidden from the list' : ''}</div>
          </div>
        </div>
      )}
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      {rows.length === 0 ? (
        <EmptyNote icon="Trophy" title="Nobody on the board yet" hint={period === 'week' ? 'Points from this week show up here.' : 'Points show up here as members take part.'}/>
      ) : (
        <div className="card">
          {rows.map((x, i) => (
            <div key={x.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: i ? '1px solid var(--border)' : 'none', background: x.isMe ? 'var(--accent-soft)' : 'transparent' }}>
              <span style={{ width: 28, textAlign: 'center', fontWeight: 700, fontSize: 14, color: x.rank <= 3 ? 'var(--accent)' : 'var(--muted)' }}>{x.rank}</span>
              <Avatar name={x.name} url={x.avatarUrl} size={34}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}{x.isMe ? <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (you)</span> : null}</div>
                {x.badges?.length > 0 && <div style={{ fontSize: 13, letterSpacing: 2 }} aria-label="Badges">{x.badges.map((b) => BADGE_EMOJI[b] || '🏅').join('')}</div>}
              </div>
              <span style={{ fontSize: 14, fontWeight: 650, whiteSpace: 'nowrap' }}>{x.points} <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--muted)' }}>pts</span></span>
            </div>
          ))}
        </div>
      )}
      {!isOwner && me && (
        <Toggle checked={!!me.hideFromLeaderboard} onChange={(v) => patch({ hideFromLeaderboard: v })} label="Hide me from the leaderboard" hint="You keep earning points and badges; you just are not listed."/>
      )}
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>Points: lesson 10 · new post 3 · reply 1 · reaction received 1 (up to 20 a day) · live session 5 · check-in 5 · module finished 25 · program finished 100.</div>
    </div>
  );
}
