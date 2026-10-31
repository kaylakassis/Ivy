// Check-ins: owner-built forms members fill in daily, weekly or once.
// Members see what is due, fill it in (and can edit until the period ends)
// and read the coach's private replies. The coach builds forms, reads every
// response in one inbox (filter by member or form), replies privately and
// sees a small trend for number and 1-10 answers. Answers are private to
// the member and the coach; the API enforces it.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { Sheet, Field, Toggle, ago, uploadProgramImage, IMAGE_TYPES } from './communityUi.jsx';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TYPES = [
  ['short', 'Short answer'], ['long', 'Long answer'], ['number', 'Number'], ['scale', 'Scale 1 to 10'],
  ['yesno', 'Yes / no'], ['choice', 'Multiple choice'], ['photo', 'Photo'],
];
const MAX_Q = 10;
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
export const frequencyLabel = (f) => (f.frequency === 'daily' ? 'Every day' : f.frequency === 'weekly' ? `Every ${WEEKDAYS[f.weekday ?? 1]}` : 'One time');

// ── answers ───────────────────────────────────────────────────────────
function AnswerInput({ q, value, onChange }) {
  const [uploading, setUploading] = useState(false); const [err, setErr] = useState(null);
  if (q.type === 'short') return <input className="input" value={value ?? ''} maxLength={300} onChange={(e) => onChange(e.target.value)}/>;
  if (q.type === 'long') return <textarea className="input" rows={4} value={value ?? ''} maxLength={5000} onChange={(e) => onChange(e.target.value)} style={{ resize: 'vertical' }}/>;
  if (q.type === 'number') return <input className="input" type="number" inputMode="decimal" step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} style={{ maxWidth: 180 }}/>;
  if (q.type === 'scale') {
    return (
      <div role="radiogroup" aria-label={q.label} style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 4, maxWidth: 420 }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} onClick={() => onChange(n)}
            style={{ padding: '8px 0', borderRadius: 8, fontSize: 13.5, fontWeight: 600, border: '1px solid var(--border)', background: value === n ? 'var(--accent)' : 'var(--surface)', color: value === n ? '#fff' : 'var(--fg)' }}>{n}</button>
        ))}
      </div>
    );
  }
  if (q.type === 'yesno') {
    return (
      <div style={{ display: 'flex', gap: 8 }}>
        {[[true, 'Yes'], [false, 'No']].map(([v, l]) => (
          <button key={l} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className="btn" style={{ minWidth: 80, background: value === v ? 'var(--accent)' : 'var(--surface)', color: value === v ? '#fff' : 'var(--fg)', border: '1px solid var(--border)' }}>{l}</button>
        ))}
      </div>
    );
  }
  if (q.type === 'choice') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(q.options || []).map((o) => (
          <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <input type="radio" name={q.id} checked={value === o} onChange={() => onChange(o)}/> {o}
          </label>
        ))}
      </div>
    );
  }
  if (q.type === 'photo') {
    const pick = async (file) => {
      if (!file) return; setUploading(true); setErr(null);
      try { onChange(await uploadProgramImage(file)); } catch (e) { setErr(e.message || 'Upload failed'); } finally { setUploading(false); }
    };
    const src = httpsOnly(value);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {src && <img src={src} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 10 }}/>}
        <label className="btn btn-outline" style={{ cursor: 'pointer' }}><Icons.Camera size={13}/> {uploading ? 'Uploading…' : src ? 'Change photo' : 'Add a photo'}
          <input type="file" accept={IMAGE_TYPES} hidden onChange={(e) => pick(e.target.files?.[0])}/>
        </label>
        {src && <button type="button" className="btn btn-ghost" onClick={() => onChange('')} style={{ fontSize: 12.5 }}>Remove</button>}
        {err && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>}
      </div>
    );
  }
  return null;
}

function AnswerView({ q, value }) {
  if (value == null || value === '') return <span style={{ color: 'var(--muted)' }}>No answer</span>;
  if (q.type === 'yesno') return <span>{value ? 'Yes' : 'No'}</span>;
  if (q.type === 'scale') return <span><b>{value}</b> / 10</span>;
  if (q.type === 'photo') { const src = httpsOnly(value); return src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 10 }}/></a> : null; }
  return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(value)}</span>;
}

function Answers({ form, answers }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {(form?.questions || []).map((q) => (
        <div key={q.id} style={{ fontSize: 13.5 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>{q.label}</div>
          <AnswerView q={q} value={answers?.[q.id]}/>
        </div>
      ))}
    </div>
  );
}

function Replies({ replies }) {
  if (!replies?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderLeft: '3px solid var(--accent)', paddingLeft: 10 }}>
      {replies.map((r, i) => (
        <div key={i} style={{ fontSize: 13.5 }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Coach · {ago(r.at)}</div>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.body}</div>
        </div>
      ))}
    </div>
  );
}

// ── member ────────────────────────────────────────────────────────────
export function MemberCheckins({ programId, onChange }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api.get(`/programs/${programId}/checkins`).then(setData).catch((e) => setErr(e.message)), [programId]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{err || 'Loading…'}</div>;
  const forms = data.forms || [];
  const byId = new Map(forms.map((f) => [f.id, f]));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Only you and your coach can see your check-ins.</div>
      {forms.length === 0 ? <EmptyNote icon="Check" title="No check-ins" hint="Your coach has not set up any check-ins for this program."/> : (
        <div className="card">
          {forms.map((f, i) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600 }}>{f.title}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{frequencyLabel(f)} · {f.status === 'done' ? `done${f.period?.endsAt ? `, you can edit until ${new Date(f.period.endsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}` : 'due now'}</div>
              </div>
              <button type="button" className={f.status === 'done' ? 'btn btn-outline' : 'btn btn-primary'} onClick={() => setOpen(f)} style={{ fontSize: 13 }}>{f.status === 'done' ? 'Edit' : 'Check in'}</button>
            </div>
          ))}
        </div>
      )}
      {(data.history || []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--fg-2)' }}>Your check-ins</div>
          {data.history.map((r) => (
            <div key={r.id} className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{r.formTitle}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{new Date(r.submittedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              </div>
              {byId.get(r.formId) ? <Answers form={byId.get(r.formId)} answers={r.answers}/> : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{Object.keys(r.answers || {}).length} answers</div>}
              <Replies replies={r.replies}/>
            </div>
          ))}
        </div>
      )}
      {open && <FillSheet programId={programId} form={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); load(); onChange?.(); }}/>}
    </div>
  );
}

function FillSheet({ programId, form, onClose, onSaved }) {
  const [answers, setAnswers] = useState(() => ({ ...(form.current?.answers || {}) }));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.post(`/programs/${programId}/checkins`, { formId: form.id, answers, periodKey: form.period?.key }); onSaved(); }
    catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <Sheet title={form.title} onClose={onClose} width={560}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {form.questions.map((q) => (
          <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{q.label}{q.required ? <span style={{ color: 'var(--danger)' }}> *</span> : null}</span>
            <AnswerInput q={q} value={answers[q.id]} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}/>
          </div>
        ))}
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : form.current ? 'Save changes' : 'Submit'}</button>
        </div>
      </form>
    </Sheet>
  );
}

// ── coach ─────────────────────────────────────────────────────────────
export function OwnerCheckins({ programId }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(null);
  const [filter, setFilter] = useState({ formId: '', clientId: '' });
  const [editing, setEditing] = useState(null);
  const [trend, setTrend] = useState(null);
  const load = useCallback(() => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    return api.get(`/programs/${programId}/checkins${qs ? `?${qs}` : ''}`).then(setData).catch((e) => setErr(e.message));
  }, [programId, filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setTrend(null);
    if (!filter.clientId) return;
    api.get(`/programs/${programId}/checkins?view=trend&clientId=${filter.clientId}`).then((r) => setTrend(r.series || [])).catch(() => setTrend([]));
  }, [programId, filter.clientId]);
  const archive = async (f) => {
    if (!window.confirm(`Stop the "${f.title}" check-in? Answers already given are kept.`)) return;
    try { await api.del(`/programs/${programId}/checkins?formId=${f.id}`); load(); } catch (e) { setErr(e.message); }
  };
  if (!data) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{err || 'Loading…'}</div>;
  const forms = data.forms || [];
  const formById = new Map(forms.map((f) => [f.id, f]));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, fontSize: 13, color: 'var(--muted)' }}>Members fill these in from their program page. Only you and that member see the answers.</div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing({})} disabled={forms.length >= 20}><Icons.Plus size={13} sw={2}/> New check-in</button>
      </div>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      {forms.length === 0 ? (
        <EmptyNote icon="Check" title="No check-ins yet" hint="Ask members a few questions every day, every week or once: how it went, a number to track, a photo of their work." action={<button className="btn btn-primary" onClick={() => setEditing({})}>Create a check-in</button>}/>
      ) : (
        <div className="card">
          {forms.map((f, i) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600 }}>{f.title}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{frequencyLabel(f)} · {f.questions.length} question{f.questions.length === 1 ? '' : 's'}{f.remind && f.frequency !== 'once' ? ' · reminder on the due day' : ''}</div>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(f)} style={{ fontSize: 12.5 }}>Edit</button>
              <button type="button" className="btn btn-ghost" onClick={() => archive(f)} style={{ fontSize: 12.5, color: 'var(--muted)' }}>Stop</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--fg-2)', marginRight: 'auto' }}>Responses</div>
        <select className="input" value={filter.clientId} onChange={(e) => setFilter({ ...filter, clientId: e.target.value })} aria-label="Filter by member" style={{ width: 'auto', maxWidth: '100%', padding: '6px 10px', fontSize: 13 }}>
          <option value="">All members</option>
          {(data.members || []).map((m) => <option key={m.clientId} value={m.clientId}>{m.name}</option>)}
        </select>
        <select className="input" value={filter.formId} onChange={(e) => setFilter({ ...filter, formId: e.target.value })} aria-label="Filter by check-in" style={{ width: 'auto', maxWidth: '100%', padding: '6px 10px', fontSize: 13 }}>
          <option value="">All check-ins</option>
          {forms.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
        </select>
      </div>
      {filter.clientId && trend && trend.length > 0 && (
        <div className="card" style={{ padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {trend.map((s) => <TrendCard key={`${s.formId}-${s.questionId}`} s={s}/>)}
        </div>
      )}
      {(data.responses || []).length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No responses yet.</div> : (
        data.responses.map((r) => <ResponseCard key={r.id} programId={programId} r={r} form={formById.get(r.formId)} onReplied={load}/>)
      )}
      {editing && <FormBuilder programId={programId} form={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }}/>}
    </div>
  );
}

function ResponseCard({ programId, r, form, onReplied }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const send = async (e) => {
    e.preventDefault(); if (!text.trim()) return; setBusy(true); setErr(null);
    try { await api.post(`/programs/${programId}/checkins`, { action: 'reply', responseId: r.id, body: text }); setText(''); onReplied(); }
    catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{r.memberName}</span>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{r.formTitle}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{ago(r.submittedAt)}</span>
      </div>
      {form ? <Answers form={form} answers={r.answers}/> : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>This check-in was stopped.</div>}
      <Replies replies={r.replies}/>
      <form onSubmit={send} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea className="input" rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply privately…" aria-label="Private reply" style={{ flex: 1, resize: 'vertical', minHeight: 40 }}/>
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()} style={{ fontSize: 13 }}>{busy ? 'Sending…' : 'Reply'}</button>
      </form>
      {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

// Minimal sparkline for one question's answers over time.
export function Sparkline({ values, width = 200, height = 44, max = null, min = null }) {
  if (!values.length) return null;
  const hi = max ?? Math.max(...values); const lo = min ?? Math.min(...values);
  const span = hi - lo || 1;
  const step = values.length > 1 ? (width - 8) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [4 + i * step, height - 4 - ((v - lo) / span) * (height - 8)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Trend: ${values.join(', ')}`} style={{ display: 'block', height }}>
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
      <circle cx={lx} cy={ly} r="3" fill="var(--accent)"/>
    </svg>
  );
}

function TrendCard({ s }) {
  const values = s.points.map((p) => Number(p.value));
  const last = values[values.length - 1];
  const first = values[0];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 18, fontWeight: 650 }}>{last}</span>
        {s.type === 'scale' && <span style={{ fontSize: 12, color: 'var(--muted)' }}>/ 10</span>}
        {values.length > 1 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>from {first} · {values.length} answers</span>}
      </div>
      <Sparkline values={values} max={s.type === 'scale' ? 10 : null} min={s.type === 'scale' ? 1 : null}/>
    </div>
  );
}

function newQuestion(type = 'short') { return { id: Math.random().toString(36).slice(2, 10), type, label: '', required: false, options: type === 'choice' ? ['', ''] : undefined }; }

function FormBuilder({ programId, form, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    title: form?.title || '', frequency: form?.frequency || 'weekly', weekday: form?.weekday ?? 1, remind: form ? !!form.remind : true,
    questions: form?.questions?.length ? form.questions.map((q) => ({ ...q, options: q.options ? [...q.options] : undefined })) : [newQuestion('short')],
  }));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const setQ = (i, patch) => setF((x) => ({ ...x, questions: x.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));
  const move = (i, d) => setF((x) => { const qs = [...x.questions]; const j = i + d; if (j < 0 || j >= qs.length) return x; [qs[i], qs[j]] = [qs[j], qs[i]]; return { ...x, questions: qs }; });
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const payload = { ...f, questions: f.questions.map((q) => ({ ...q, options: q.type === 'choice' ? (q.options || []).filter((o) => o.trim()) : undefined })) };
    try {
      if (form) await api.patch(`/programs/${programId}/checkins`, { formId: form.id, ...payload });
      else await api.post(`/programs/${programId}/checkins`, { action: 'create-form', ...payload });
      onSaved();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <Sheet title={form ? 'Edit check-in' : 'New check-in'} onClose={onClose} width={600}>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Weekly reflection" maxLength={140} autoFocus required/></Field>
        <div style={{ display: 'grid', gridTemplateColumns: f.frequency === 'weekly' ? '1fr 1fr' : '1fr', gap: 12 }}>
          <Field label="How often">
            <select className="input" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
              <option value="daily">Every day</option><option value="weekly">Once a week</option><option value="once">One time</option>
            </select>
          </Field>
          {f.frequency === 'weekly' && (
            <Field label="Due on">
              <select className="input" value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </Field>
          )}
        </div>
        {f.frequency !== 'once' && <Toggle checked={f.remind} onChange={(v) => setF({ ...f, remind: v })} label="Remind members on the due day" hint="One email and notification from 9am, only to members who have not checked in yet."/>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-2)' }}>Questions ({f.questions.length}/{MAX_Q})</div>
          {f.questions.map((q, i) => (
            <div key={q.id} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input className="input" value={q.label} onChange={(e) => setQ(i, { label: e.target.value })} placeholder={`Question ${i + 1}`} aria-label={`Question ${i + 1}`} maxLength={300} style={{ flex: '1 1 220px' }}/>
                <select className="input" value={q.type} onChange={(e) => setQ(i, { type: e.target.value, options: e.target.value === 'choice' ? (q.options?.length ? q.options : ['', '']) : undefined })} aria-label="Answer type" style={{ flex: '0 1 170px' }}>
                  {TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
                </select>
              </div>
              {q.type === 'choice' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(q.options || []).map((o, k) => (
                    <div key={k} style={{ display: 'flex', gap: 6 }}>
                      <input className="input" value={o} onChange={(e) => setQ(i, { options: q.options.map((x, j) => (j === k ? e.target.value : x)) })} placeholder={`Choice ${k + 1}`} aria-label={`Choice ${k + 1}`} maxLength={100} style={{ flex: 1 }}/>
                      {q.options.length > 2 && <button type="button" className="btn btn-ghost" aria-label="Remove choice" onClick={() => setQ(i, { options: q.options.filter((_, j) => j !== k) })}><Icons.X size={13}/></button>}
                    </div>
                  ))}
                  {q.options.length < 10 && <button type="button" className="btn btn-ghost" onClick={() => setQ(i, { options: [...q.options, ''] })} style={{ alignSelf: 'flex-start', fontSize: 12.5 }}><Icons.Plus size={12}/> Add a choice</button>}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginRight: 'auto' }}><input type="checkbox" checked={!!q.required} onChange={(e) => setQ(i, { required: e.target.checked })}/> Required</label>
                <button type="button" className="btn btn-ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} style={{ padding: 6 }}><Icons.ArrowUp size={13}/></button>
                <button type="button" className="btn btn-ghost" aria-label="Move down" disabled={i === f.questions.length - 1} onClick={() => move(i, 1)} style={{ padding: 6 }}><Icons.ArrowDown size={13}/></button>
                <button type="button" className="btn btn-ghost" aria-label="Remove question" disabled={f.questions.length === 1} onClick={() => setF({ ...f, questions: f.questions.filter((_, j) => j !== i) })} style={{ padding: 6 }}><Icons.Trash size={13}/></button>
              </div>
            </div>
          ))}
          {f.questions.length < MAX_Q && <button type="button" className="btn btn-outline" onClick={() => setF({ ...f, questions: [...f.questions, newQuestion('short')] })} style={{ alignSelf: 'flex-start' }}><Icons.Plus size={13}/> Add a question</button>}
        </div>
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !f.title.trim()}>{busy ? 'Saving…' : form ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </Sheet>
  );
}

