// The course page a member sees (and the owner's "Preview as member"):
// progress, "Continue where you left off", then the lessons grouped by
// module. Locked modules show "Unlocks on <date>"; the API sends no
// content for them, only titles.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';
import { ProgressBar, lessonMeta, fmtDay } from './courseUi.jsx';

// Lessons outside any module first, then each module in order.
export function groupLessons(lessons, modules) {
  const ids = new Set(modules.map((m) => m.id));
  const groups = [];
  const top = lessons.filter((l) => !l.moduleId || !ids.has(l.moduleId));
  if (top.length) groups.push({ module: null, lessons: top });
  for (const m of modules) groups.push({ module: m, lessons: lessons.filter((l) => l.moduleId === m.id) });
  return groups;
}

export function CourseProgress({ progress, lessons, onOpen, preview }) {
  const next = lessons.find((l) => l.id === progress.nextItemId);
  const started = progress.completed > 0;
  const done = progress.total > 0 && progress.completed >= progress.total;
  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.01em' }}>{progress.percent}%</span>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{progress.completed} of {progress.total} lesson{progress.total === 1 ? '' : 's'} complete</span>
      </div>
      <ProgressBar percent={progress.percent} label="Course progress"/>
      {done ? (
        <div style={{ fontSize: 13.5, color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 6 }}><Icons.Check size={15} sw={2}/> You finished every lesson. Nice work.</div>
      ) : next ? (
        <button type="button" className="btn btn-primary" onClick={() => onOpen(next.id)} style={{ justifyContent: 'space-between', gap: 10, padding: '12px 14px', textAlign: 'left' }}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 11.5, opacity: .85, fontWeight: 600 }}>{started ? 'Continue where you left off' : 'Start the course'}</span>
            <span style={{ fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{next.title}</span>
          </span>
          <Icons.Arrow size={16} sw={2}/>
        </button>
      ) : progress.total > 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>The next lessons open soon. We'll let you know.</div>
      ) : null}
      {preview && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Progress is not saved in preview.</div>}
    </div>
  );
}

export default function CourseOutline({ lessons, modules, onOpen, ownerView = false }) {
  const groups = groupLessons(lessons, modules);
  if (!lessons.length && !modules.length) {
    return <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>No lessons yet. Check back soon.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map(({ module: m, lessons: ls }) => (
        <section key={m?.id || 'top'} className="card" style={{ padding: 4, opacity: m?.locked ? .92 : 1 }}>
          {m && (
            <div style={{ padding: '12px 14px 8px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15.5, fontWeight: 600 }}>{m.title}</div>
                {m.description && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{m.description}</div>}
                {m.locked && m.unlocksAt && (
                  <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--fg-2)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icons.Lock size={13}/> Unlocks on {fmtDay(m.unlocksAt)}</div>
                )}
                {ownerView && m.unlockAfterDays ? (
                  <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icons.Clock size={13}/> Opens {m.unlockAfterDays} day{m.unlockAfterDays === 1 ? '' : 's'} after a member joins</div>
                ) : null}
              </div>
              {ls.length > 0 && !m.locked && (
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', paddingTop: 2 }}>{ls.filter((l) => l.completed).length}/{ls.length}</span>
              )}
            </div>
          )}
          {ls.length === 0 && m && <div style={{ padding: '4px 14px 12px', fontSize: 13, color: 'var(--muted)' }}>No lessons in this module yet.</div>}
          {ls.map((l) => <LessonRow key={l.id} lesson={l} onOpen={onOpen} first={!m && l === ls[0]}/>)}
        </section>
      ))}
    </div>
  );
}

function LessonRow({ lesson: l, onOpen, first }) {
  const meta = lessonMeta(l.type);
  const Icon = meta.icon;
  const locked = !!l.locked;
  return (
    <button type="button" disabled={locked} onClick={() => !locked && onOpen(l.id)}
      aria-label={locked ? `${l.title} (locked)` : `${l.title}${l.completed ? ' (completed)' : ''}`}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', textAlign: 'left', borderTop: first ? 'none' : '1px solid var(--border)', cursor: locked ? 'default' : 'pointer', color: 'inherit' }}>
      <span aria-hidden="true" style={{
        width: 30, height: 30, borderRadius: 999, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: l.completed ? 'var(--accent)' : 'var(--accent-soft)', color: l.completed ? 'var(--accent-ink)' : locked ? 'var(--muted)' : 'var(--accent)',
      }}>
        {l.completed ? <Icons.Check size={15} sw={2.4}/> : locked ? <Icons.Lock size={13}/> : <Icon size={14}/>}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14.5, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: locked ? 'var(--muted)' : 'var(--fg)' }}>{l.title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.label}{l.completed ? ' · Done' : ''}</span>
      </span>
      {!locked && <Icons.Arrow size={14} stroke="var(--muted)" style={{ flexShrink: 0 }}/>}
    </button>
  );
}
