// Owner: "Preview as member". Renders the exact member screens (course
// outline and lesson view) from the member API, which answers the owner
// with everything unlocked. "Day 1" mode shows the drip schedule the way a
// brand-new member sees it. Progress is never saved from here.
import React, { useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import CourseOutline, { CourseProgress } from './CourseOutline.jsx';
import LessonView, { useCourse } from './LessonView.jsx';

function asNewMember(data) {
  const now = Date.now();
  const modules = data.modules.map((m) => {
    if (!m.unlockAfterDays) return { ...m, locked: false, unlocksAt: null };
    return { ...m, locked: true, unlocksAt: new Date(now + m.unlockAfterDays * 86400_000).toISOString() };
  });
  const locked = new Map(modules.filter((m) => m.locked).map((m) => [m.id, m.unlocksAt]));
  const lessons = data.lessons.map((l) => (locked.has(l.moduleId) ? { id: l.id, type: l.type, title: l.title, moduleId: l.moduleId, locked: true, unlocksAt: locked.get(l.moduleId) } : l));
  const first = lessons.find((l) => !l.locked);
  return { ...data, modules, lessons, progress: { ...data.progress, nextItemId: first?.id || null } };
}

export default function CoursePreview({ programId, onClose }) {
  const { data: raw, err } = useCourse(programId);
  const [lessonId, setLessonId] = useState(null);
  const [day1, setDay1] = useState(false);
  const data = useMemo(() => {
    if (!raw) return null;
    const base = { ...raw, lessons: raw.lessons.map((l) => ({ ...l, completed: false })), progress: { completed: 0, total: raw.lessons.length, percent: 0, nextItemId: raw.lessons[0]?.id || null } };
    return day1 ? asNewMember(base) : base;
  }, [raw, day1]);
  const hasDrip = !!raw?.modules?.some((m) => m.unlockAfterDays);

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'var(--accent-soft)', borderColor: 'var(--accent-tint)' }}>
        <Icons.Eye size={16} stroke="var(--accent)"/>
        <span style={{ flex: 1, minWidth: 180, fontSize: 13.5 }}><b>Member preview.</b> This is exactly what members see.</span>
        {hasDrip && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={day1} onChange={(e) => { setDay1(e.target.checked); setLessonId(null); }}/> As a new member (day 1)
          </label>
        )}
        <button type="button" className="btn btn-primary" onClick={onClose} style={{ minHeight: 34, padding: '6px 12px', fontSize: 13 }}>Exit preview</button>
      </div>
      {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      {!data ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        : lessonId ? (
          <LessonView data={data} itemId={lessonId} preview onNavigate={setLessonId} onBack={() => setLessonId(null)} setDone={async () => null}/>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>{data.program.businessName}</div>
              <h2 className="page-title" style={{ margin: '4px 0 0', fontSize: 26 }}>{data.program.title}</h2>
              {data.program.description && <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginTop: 6, lineHeight: 1.5 }}>{data.program.description}</div>}
            </div>
            <CourseProgress progress={data.progress} lessons={data.lessons} onOpen={setLessonId} preview/>
            <CourseOutline lessons={data.lessons} modules={data.modules} onOpen={setLessonId}/>
          </div>
        )}
    </div>
  );
}
