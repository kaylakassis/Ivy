// Goals & Tasks: header, stats, two columns (Tasks | Goals).
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import SuccessToast from '../../components/SuccessToast.jsx';
import { fireConfetti } from '../../lib/celebrate.js';
import { useGoals } from './state.js';
import { api } from '../../lib/api.js';

const GOAL_TYPES = [
  { id: 'revenue',  label: 'Revenue ($)',     unit: '$',     hint: 'Tracks paid invoices this month.' },
  { id: 'clients',  label: 'Active clients',  unit: '',      hint: 'Tracks clients with stage = active.' },
  { id: 'sessions', label: 'Sessions booked', unit: '',      hint: 'Tracks bookings dated this month.' },
  { id: 'custom',   label: 'Custom (manual)', unit: '',      hint: 'You update progress manually.' },
];

export default function Goals() {
  const {
    tasks, goals, loading, error,
    createTask, updateTask, removeTask, toggleTask,
    createGoal, updateGoal, removeGoal,
  } = useGoals();

  if (loading) return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading goals & tasks…</div>;
  if (error) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Check" title="Couldn't load" hint={error.message || 'Try refreshing.'}/>
        </div>
      </div>
    );
  }

  const openTasks = tasks.filter((t) => !t.done);
  const overdueCount = openTasks.filter((t) => t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10)).length;
  const completedThisWeek = tasks.filter((t) => {
    if (!t.completedAt) return false;
    const days = (Date.now() - new Date(t.completedAt).getTime()) / 86400e3;
    return days < 7;
  }).length;

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Goals & Tasks</h2>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
          Tasks track today; goals track the destination. Revenue, client, and session goals update live from your data.
        </div>
      </div>

      {/* Tiny stats row */}
      <div className="grid-auto-sm">
        <Stat label="Open tasks"            value={openTasks.length}     sub={`${tasks.length - openTasks.length} done`}/>
        <Stat label="Overdue"               value={overdueCount}         sub="Tasks past due"
          tone={overdueCount > 0 ? 'bad' : 'ok'}/>
        <Stat label="Completed this week"   value={completedThisWeek}    sub="Last 7 days"/>
      </div>

      <div className="split-2">
        <TasksPane tasks={tasks}
          onCreate={createTask} onToggle={toggleTask}
          onUpdate={updateTask} onRemove={removeTask}/>
        <GoalsPane goals={goals}
          onCreate={createGoal} onUpdate={updateGoal} onRemove={removeGoal}/>
      </div>
    </div>
  );
}

// ---------- TASKS ----------
function TasksPane({ tasks, onCreate, onToggle, onUpdate, onRemove }) {
  const [tab, setTab] = useState('open');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftDue, setDraftDue] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    if (tab === 'open') return tasks.filter((t) => !t.done);
    if (tab === 'done') return tasks.filter((t) => t.done);
    return tasks;
  }, [tasks, tab]);

  const add = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await onCreate({ title: draft.trim(), dueDate: draftDue || null });
      setDraft(''); setDraftDue(''); setAdding(false);
    } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="metric-label" style={{ flex: 1 }}>Tasks</div>
        <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
          {[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: '4px 10px', borderRadius: 6, border: 0,
              fontSize: 11.5, fontWeight: 550, cursor: 'pointer',
              background: tab === id ? 'var(--surface)' : 'transparent',
              color: tab === id ? 'var(--fg)' : 'var(--muted)',
              boxShadow: tab === id ? 'var(--shadow-sm)' : 'none',
            }}>{label}</button>
          ))}
        </div>
        {!adding && (
          <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setAdding(true)} title="Add task">
            <Icons.Plus size={14} sw={2}/>
          </button>
        )}
      </div>

      {adding && (
        <div style={{
          padding: 10, borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="What needs doing?"
            autoFocus style={inputS}/>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="date" value={draftDue} onChange={(e) => setDraftDue(e.target.value)} style={{ ...inputS, width: 160 }}/>
            <div style={{ flex: 1 }}/>
            <button className="btn btn-ghost" onClick={() => { setAdding(false); setDraft(''); setDraftDue(''); }}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={add} disabled={busy || !draft.trim()}>
              {busy ? '…' : 'Add task'}
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyNote icon="Check"
          title={tab === 'open' ? 'All clear' : 'Nothing here'}
          hint={tab === 'open' ? 'Add a task to get started.' : 'Try a different tab.'}/>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((t) => (
            <TaskRow key={t.id} task={t} onToggle={onToggle} onUpdate={onUpdate} onRemove={onRemove}/>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, onToggle, onUpdate, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);

  useEffect(() => { setDraft(task.title); }, [task.id, task.title]);

  const save = async () => {
    const v = draft.trim();
    setEditing(false);
    if (v && v !== task.title) await onUpdate(task.id, { title: v });
    else setDraft(task.title);
  };

  const isOverdue = !task.done && task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10);
  const dueLabel = task.dueDate ? formatDue(task.dueDate, task.done) : '';
  const progress = Number(task.progress || 0);
  const isSmart = task.type && task.type !== 'generic';
  const readyToTick = isSmart && !task.done && progress >= 100;

  return (
    <div className={readyToTick ? 'glow-ready' : ''} style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '8px 10px', borderRadius: 10,
      background: task.done ? 'transparent' : 'var(--surface-2)',
      border: '1px solid ' + (task.done ? 'transparent' : 'var(--border)'),
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => onToggle(task)}
          title={readyToTick ? 'Ready - tap to mark done' : ''}
          style={{
            width: 20, height: 20, flexShrink: 0,
            borderRadius: 6,
            border: '1.5px solid ' + (task.done ? 'var(--accent)' : readyToTick ? 'var(--ok)' : 'var(--border-strong)'),
            background: task.done ? 'var(--accent)' : 'transparent',
            color: 'var(--accent-ink)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          {task.done && <Icons.Check size={12} sw={2.4}/>}
        </button>

        {editing ? (
          <input value={draft} autoFocus onChange={(e) => setDraft(e.target.value)}
            onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setDraft(task.title); setEditing(false); } }}
            style={{ ...inputS, flex: 1 }}/>
        ) : (
          <div
            onClick={() => !task.done && setEditing(true)}
            onKeyDown={(e) => {
              if (task.done) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); }
            }}
            role={task.done ? undefined : 'button'}
            tabIndex={task.done ? undefined : 0}
            aria-label={task.done ? undefined : 'Edit task'}
            style={{
              flex: 1, fontSize: 13.5, cursor: task.done ? 'default' : 'text',
              textDecoration: task.done ? 'line-through' : 'none',
              color: task.done ? 'var(--muted)' : 'var(--fg)',
              outline: 'none',
            }}>
            {task.title}
            {task.completedAuto && <span style={chipS} title="Auto-completed by app activity">auto</span>}
            {readyToTick && <span style={{ ...chipS, background: 'transparent', color: 'var(--ok)', border: '1px solid var(--ok)' }} title="App data shows this is done">ready</span>}
          </div>
        )}

        {dueLabel && (
          <span style={{
            fontSize: 11, color: isOverdue ? 'var(--danger)' : 'var(--muted)',
            fontWeight: isOverdue ? 600 : 400, whiteSpace: 'nowrap',
          }}>{dueLabel}</span>
        )}
        <button className="btn btn-ghost" onClick={() => onRemove(task.id)} style={{ padding: 4, color: 'var(--muted)' }}>
          <Icons.X size={12}/>
        </button>
      </div>

      <div style={{
        height: 4, borderRadius: 99,
        background: 'var(--surface)', overflow: 'hidden',
      }}>
        <div style={{
          width: `${progress}%`, height: '100%',
          background: progress >= 100 ? 'var(--ok)' : 'var(--accent)',
          transition: 'width .3s ease',
        }}/>
      </div>
    </div>
  );
}

function formatDue(iso, done) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(iso + 'T00:00:00');
  const diff = Math.round((due.getTime() - today.getTime()) / 86400e3);
  if (done) return due.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (diff < 0)  return `${-diff}d late`;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7)  return `${diff}d`;
  return due.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const chipS = {
  marginLeft: 8, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
  background: 'var(--accent-soft)', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.06em',
};

// ---------- GOALS ----------
function GoalsPane({ goals, onCreate, onUpdate, onRemove }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="metric-label" style={{ flex: 1 }}>Goals</div>
        {!adding && (
          <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setAdding(true)} title="Add goal">
            <Icons.Plus size={14} sw={2}/>
          </button>
        )}
      </div>

      {adding && (
        <NewGoalForm
          onCreate={async (input) => { await onCreate(input); setAdding(false); }}
          onCancel={() => setAdding(false)}
        />
      )}

      {goals.length === 0 && !adding ? (
        <EmptyNote icon="Trending"
          title="No goals yet"
          hint="Set a target - revenue, clients, sessions - and watch your data march toward it."
          action={(
            <button className="btn btn-primary" style={{ padding: '7px 14px', fontSize: 13 }}
              onClick={() => setAdding(true)}>
              <Icons.Plus size={13} sw={2}/> Create your first goal
            </button>
          )}/>
      ) : goals.length === 0 ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} onUpdate={onUpdate} onRemove={onRemove}/>
          ))}
        </div>
      )}
    </div>
  );
}

function NewGoalForm({ onCreate, onCancel }) {
  const [title, setTitle] = useState('');
  const [type, setType]   = useState('revenue');
  const [target, setTarget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState(null);

  const submit = async (e) => {
    e?.preventDefault?.();
    // Inline validation instead of a silent no-op. The old code did
    // `if (!title.trim() || !target) return;` which made the "Add goal"
    // button feel dead when a field was blank.
    if (!title.trim()) { setErr('Give your goal a title.'); return; }
    if (!target || Number(target) <= 0) { setErr('Set a target greater than zero.'); return; }
    setBusy(true); setErr(null);
    try {
      await onCreate({
        title: title.trim(), type, target: Number(target),
        deadline: deadline || null,
      });
    } catch (ex) { setErr(ex.message || 'Could not create'); setBusy(false); }
  };

  const meta = GOAL_TYPES.find((t) => t.id === type);

  return (
    <form onSubmit={submit} style={{
      padding: 12, borderRadius: 10,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
        placeholder="What are you aiming for?" style={inputS}/>
      <div className="form-2col" style={{ gap: 8 }}>
        <select value={type} onChange={(e) => setType(e.target.value)} style={inputS}>
          {GOAL_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <input type="number" min={0} step={meta.id === 'revenue' ? 100 : 1} value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={meta.id === 'revenue' ? 'Target ($)' : 'Target'}
          style={inputS}/>
      </div>
      <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)}
        placeholder="Deadline (optional)" style={inputS}/>
      {meta.hint && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{meta.hint}</div>}
      {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}/>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !target}>
          {busy ? '…' : 'Add goal'}
        </button>
      </div>
    </form>
  );
}

function GoalCard({ goal, onUpdate, onRemove }) {
  const pct = Math.min(100, Math.round((goal.current / goal.target) * 100)) || 0;
  const isCustom = goal.type === 'custom';
  const [editingProgress, setEditingProgress] = useState(false);
  const [draftCurrent, setDraftCurrent] = useState(String(goal.current || 0));

  useEffect(() => { setDraftCurrent(String(goal.current || 0)); }, [goal.id, goal.current]);

  const meta = GOAL_TYPES.find((t) => t.id === goal.type) || GOAL_TYPES[3];
  const fmt = (n) => goal.type === 'revenue'
    ? '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : Number(n || 0).toLocaleString();

  const saveProgress = async () => {
    setEditingProgress(false);
    const n = Number(draftCurrent);
    if (Number.isFinite(n) && n >= 0 && n !== goal.current) {
      await onUpdate(goal.id, { current: n });
    }
  };

  const reached = pct >= 100;

  // Confetti moment the moment a goal crosses the line (the payoff the Goals
  // tutorial promises). Fire only on the false→true transition, never on a
  // reload of an already-hit goal.
  const wasReached = useRef(reached);
  const [wonToast, setWonToast] = useState(null);
  useEffect(() => {
    if (reached && !wasReached.current) {
      fireConfetti();
      setWonToast('Goal reached 🎉');
    }
    wasReached.current = reached;
  }, [reached]);

  return (
    <div className={reached ? 'glow-ready' : ''} style={{
      padding: 14, borderRadius: 12,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3 }}>{goal.title}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
            {meta.label}{goal.deadline ? ' · by ' + new Date(goal.deadline).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}
          </div>
        </div>
        <button className="btn btn-ghost" onClick={() => onRemove(goal.id)} style={{ padding: 4, color: 'var(--muted)' }}>
          <Icons.X size={12}/>
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 12 }}>
        {isCustom && editingProgress ? (
          <input type="number" min={0} value={draftCurrent} autoFocus
            onChange={(e) => setDraftCurrent(e.target.value)}
            onBlur={saveProgress}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setDraftCurrent(String(goal.current || 0)); setEditingProgress(false); } }}
            style={{ ...inputS, width: 100, fontSize: 18, fontWeight: 600 }}/>
        ) : (
          <span className="metric-value"
            onClick={() => isCustom && setEditingProgress(true)}
            onKeyDown={(e) => {
              if (!isCustom) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingProgress(true); }
            }}
            role={isCustom ? 'button' : undefined}
            tabIndex={isCustom ? 0 : undefined}
            aria-label={isCustom ? 'Update progress' : undefined}
            style={{ fontSize: 22, cursor: isCustom ? 'pointer' : 'default' }}
            title={isCustom ? 'Click to update' : ''}>
            {fmt(goal.current)}
          </span>
        )}
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>of {fmt(goal.target)}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600,
          color: pct >= 100 ? 'var(--ok)' : pct >= 60 ? 'var(--accent)' : 'var(--muted)' }}>
          {pct}%
        </span>
      </div>

      {/* Progress bar */}
      <div style={{
        marginTop: 8, height: 6, borderRadius: 99,
        background: 'var(--surface)', overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: pct >= 100 ? 'var(--ok)' : 'var(--accent)',
          transition: 'width .3s ease',
        }}/>
      </div>

      {goal.notes && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
          {goal.notes}
        </div>
      )}
      <SuccessToast text={wonToast} onDone={() => setWonToast(null)}/>
    </div>
  );
}

function Stat({ label, value, sub, tone = 'neutral' }) {
  const colors = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--danger)', neutral: 'var(--muted)' };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ fontSize: 28, color: tone !== 'neutral' && Number(value) > 0 ? colors[tone] : undefined }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}

const inputS = {
  width: '100%', padding: '8px 12px', borderRadius: 8,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 13, outline: 'none', fontFamily: 'inherit',
};
