// Client portal: the programs this person has access to, and the
// program itself (content + community). Same renderers the coach sees.
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import CourseOutline, { CourseProgress } from '../programs/CourseOutline.jsx';
import LessonView, { useCourse } from '../programs/LessonView.jsx';
import { ProgressBar } from '../programs/courseUi.jsx';
import { useProgramExtras, memberTabs, TabBar, ProgramTabBody } from '../programs/ProgramTabs.jsx';
import { BadgeCelebration, EngagementStrip, useEngagement } from '../programs/Engagement.jsx';

// "Access until <date>" for a fixed window or a subscription the member has
// already cancelled, "Renews <date>" while a subscription is still live,
// nothing for lifetime access. `prefix` separates it from the text before.
export function accessLine(p, prefix) {
  const fmt = (d) => new Date(d).toLocaleDateString();
  const until = p.accessUntil || p.expiresAt || (p.cancelAtPeriodEnd ? p.currentPeriodEnd : null);
  if (until) return `${prefix}Access until ${fmt(until)}`;
  if (p.currentPeriodEnd) return `${prefix}Renews ${fmt(p.currentPeriodEnd)}`;
  return '';
}

export default function ClientPrograms() {
  const [programs, setPrograms] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.get('/me/programs').then((r) => setPrograms(r.programs || [])).catch((e) => { setErr(e.message); setPrograms([]); }); }, []);
  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 28 }}>Programs</h2>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>Courses, plans and communities you're part of.</div>
      </div>
      {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      {programs === null ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        : programs.length === 0 ? <EmptyNote icon="Gift" title="No programs yet" hint="When a business you work with gives you access to a program, it shows up here."/>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {programs.map((p) => (
              <Link key={p.id} to={`/me/programs/${p.id}`} className="card" style={{ padding: 16, textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>{p.businessName}</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{p.title}</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.description}</div>
                {p.items > 0 && (
                  <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ProgressBar percent={p.progressPercent || 0} label={`${p.title} progress`}/>
                    <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{p.progressPercent || 0}%</span>
                  </div>
                )}
                <div style={{ marginTop: p.items > 0 ? 0 : 'auto', fontSize: 12.5, color: 'var(--fg-2)' }}>{p.items} lesson{p.items === 1 ? '' : 's'}{p.enrollmentStatus === 'past_due' ? ' · payment past due' : ''}{accessLine(p, ' · ')}</div>
              </Link>
            ))}
          </div>
        )}
    </div>
  );
}

export function ClientProgram() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data, err } = useCourse(id); const [tab, setTab] = useState(() => params.get('tab') || 'content');
  const engagement = useEngagement(id, data?.role);
  const [mine, setMine] = useState(null); const [cancelMsg, setCancelMsg] = useState(null);
  const extras = useProgramExtras(id);
  useEffect(() => { api.get('/me/programs').then((r) => setMine((r.programs || []).find((p) => p.id === id) || null)).catch(() => {}); }, [id]);
  const openLesson = (itemId) => navigate(`/me/programs/${id}/lessons/${itemId}`);
  const cancel = async () => {
    if (!window.confirm('Cancel this subscription? You keep access until the end of the period you already paid for.')) return;
    try {
      const r = await api.del(`/me/programs/${id}/subscription`);
      setCancelMsg(`Cancelled. Access continues until ${r.accessUntil ? new Date(r.accessUntil).toLocaleDateString() : 'the end of the current period'}.`);
      setMine((m) => (m ? { ...m, cancelAtPeriodEnd: true, canCancel: false, accessUntil: r.accessUntil || m.currentPeriodEnd } : m));
    } catch (e) { setCancelMsg(e.message); }
  };
  if (err) return <div className="page-pad"><EmptyNote icon="Lock" title="No access" hint={err} action={<Link className="btn btn-outline" to="/me/programs">Back to programs</Link>}/></div>;
  if (!data) return <div className="page-pad" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const { program } = data;
  const lessons = data.lessons || data.items || [];
  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Link to="/me/programs" style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}><Icons.Arrow size={13} style={{ transform: 'rotate(180deg)' }}/> Programs</Link>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>{program.businessName}</div>
        <h2 className="page-title" style={{ margin: '4px 0 0', fontSize: 26 }}>{program.title}</h2>
        {program.description && <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginTop: 6, lineHeight: 1.5 }}>{program.description}</div>}
        {mine && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{accessLine(mine, '') || 'Lifetime access'}{mine.enrollmentStatus === 'past_due' ? ' · payment past due' : ''}</span>
            {mine.canCancel && !cancelMsg && <button type="button" onClick={cancel} style={{ color: 'var(--accent)', fontSize: 12.5 }}>Cancel subscription</button>}
            {cancelMsg && <span style={{ color: 'var(--fg-2)' }}>{cancelMsg}</span>}
          </div>
        )}
      </div>
      {data.role === 'member' && <EngagementStrip data={engagement.data} onOpenCheckins={() => setTab('checkins')}/>}
      {(() => { const tabs = memberTabs({ contentLabel: 'Course', communityEnabled: program.communityEnabled, extras, checkinsDue: engagement.data?.checkins?.due || 0 }); return tabs.length > 1 && <TabBar tabs={tabs} tab={tabs.some(([t]) => t === tab) ? tab : 'content'} setTab={setTab}/>; })()}
      {tab === 'content' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820 }}>
          {data.progress && lessons.length > 0 && <CourseProgress progress={data.progress} lessons={lessons} onOpen={openLesson}/>}
          <CourseOutline lessons={lessons} modules={data.modules || []} onOpen={openLesson}/>
        </div>
      ) : <ProgramTabBody tab={tab} programId={id} role="member" communityEnabled={program.communityEnabled} onCheckinsChange={engagement.reload}/>}
      <BadgeCelebration programId={id}/>
    </div>
  );
}

// /me/programs/:id/lessons/:itemId - one lesson in its own focused view.
export function ClientLesson() {
  const { id, itemId } = useParams();
  const navigate = useNavigate();
  const { data, err, setDone } = useCourse(id);
  if (err) return <div className="page-pad"><EmptyNote icon="Lock" title="No access" hint={err} action={<Link className="btn btn-outline" to="/me/programs">Back to programs</Link>}/></div>;
  if (!data) return <div className="page-pad" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  return (
    <div className="page-pad">
      <LessonView data={data} itemId={itemId} setDone={setDone}
        onNavigate={(next) => navigate(`/me/programs/${id}/lessons/${next}`)} onBack={() => navigate(`/me/programs/${id}`)}/>
      <BadgeCelebration programId={id}/>
    </div>
  );
}
