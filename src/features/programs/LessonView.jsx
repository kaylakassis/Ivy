// One lesson, full focus: back to the course, the lesson, then "Mark
// complete and next lesson" and previous / next. Used by the member
// route /me/programs/:id/lessons/:itemId and by the owner's preview.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import LessonContent from './LessonContent.jsx';
import { lessonMeta } from './courseUi.jsx';
import { LessonComments } from './CommunityFeed.jsx';

// Loads the course for a member (or the owner previewing) and keeps the
// completed flags and progress in sync after each mark / undo.
export function useCourse(programId) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => api.get(`/me/programs/${programId}`).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message)), [programId]);
  useEffect(() => { setData(null); load(); }, [load]);
  const setDone = async (itemId, done) => {
    if (!data || data.role !== 'member') return null;
    const r = await api.post(`/me/programs/${programId}/progress`, { itemId, done });
    setData((d) => d && ({
      ...d, progress: r.progress,
      lessons: d.lessons.map((l) => (l.id === itemId ? { ...l, completed: r.done } : l)),
      items: (d.items || []).map((l) => (l.id === itemId ? { ...l, completed: r.done } : l)),
    }));
    return r;
  };
  return { data, setData, err, reload: load, setDone };
}

export default function LessonView({ data, itemId, onNavigate, onBack, setDone, preview = false }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { setErr(null); if (typeof window !== 'undefined') window.scrollTo?.(0, 0); }, [itemId]);
  const lessons = data.lessons || [];
  const lesson = lessons.find((l) => l.id === itemId);
  const open = lessons.filter((l) => !l.locked);
  const idx = open.findIndex((l) => l.id === itemId);
  const prev = idx > 0 ? open[idx - 1] : null;
  const next = idx >= 0 && idx < open.length - 1 ? open[idx + 1] : null;
  const mod = lesson?.moduleId ? (data.modules || []).find((m) => m.id === lesson.moduleId) : null;
  const canTrack = !preview && data.role === 'member';

  if (!lesson || lesson.locked) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
        <Icons.Lock size={22} stroke="var(--muted)"/>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{lesson ? 'This lesson is not open yet' : 'Lesson not found'}</div>
        {lesson?.unlocksAt && <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>It unlocks on {new Date(lesson.unlocksAt).toLocaleDateString()}.</div>}
        <button type="button" className="btn btn-outline" onClick={onBack}>Back to the course</button>
      </div>
    );
  }

  const mark = async (done, thenNext) => {
    setBusy(true); setErr(null);
    try {
      if (canTrack) await setDone(lesson.id, done);
      if (thenNext) { if (next) onNavigate(next.id); else onBack(); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const autoComplete = () => { if (canTrack && !lesson.completed) setDone(lesson.id, true).catch(() => {}); };
  const meta = lessonMeta(lesson.type);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820, width: '100%' }}>
      <button type="button" onClick={onBack} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13 }}>
        <Icons.ArrowLeft size={13}/> {data.program?.title || 'Course'}
      </button>
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>
          {mod ? mod.title : meta.label}{idx >= 0 ? ` · ${idx + 1} of ${open.length}` : ''}
        </div>
        <h2 className="page-title" style={{ margin: '4px 0 0', fontSize: 'clamp(22px, 5vw, 28px)', overflowWrap: 'anywhere' }}>{lesson.title}</h2>
        {lesson.completed && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icons.Check size={14} sw={2.2}/> Completed</div>}
      </div>
      <LessonContent item={lesson} onWatched={autoComplete}/>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {lesson.completed ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 160, fontSize: 13.5, color: 'var(--fg-2)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icons.Check size={15} sw={2.2} stroke="var(--ok)"/> You completed this lesson.</span>
            {canTrack && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => mark(false, false)} style={{ fontSize: 13 }}>Mark as not done</button>}
            {next && <button type="button" className="btn btn-primary" onClick={() => onNavigate(next.id)}>Next lesson <Icons.Arrow size={13}/></button>}
          </div>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => mark(true, true)} style={{ justifyContent: 'center', padding: 13, fontSize: 15 }}>
            <Icons.Check size={15} sw={2.2}/> {busy ? 'Saving…' : next ? 'Mark complete and next lesson' : 'Mark complete'}
          </button>
        )}
        {preview && <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>Preview: progress is not saved.</div>}
      </div>
      <nav aria-label="Lessons" style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
        <button type="button" className="btn btn-outline" disabled={!prev} onClick={() => prev && onNavigate(prev.id)} style={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', opacity: prev ? 1 : .5 }}>
          <Icons.ArrowLeft size={13}/> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prev ? prev.title : 'Previous'}</span>
        </button>
        <button type="button" className="btn btn-outline" disabled={!next} onClick={() => next && onNavigate(next.id)} style={{ flex: 1, minWidth: 0, justifyContent: 'flex-end', opacity: next ? 1 : .5 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{next ? next.title : 'Next'}</span> <Icons.Arrow size={13}/>
        </button>
      </nav>
      {/* Lesson discussion: members and the coach, scoped to this lesson.
          Off when the program's community is off; not in the owner preview. */}
      {!preview && data.program?.communityEnabled !== false && data.program?.id && (
        <section aria-label="Lesson discussion" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Discussion</div>
          <LessonComments programId={data.program.id} itemId={lesson.id}/>
        </section>
      )}
    </div>
  );
}
