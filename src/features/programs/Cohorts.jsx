// Cohorts (owner): groups that start together. In a cohort program the
// drip counts from the cohort's start date. Sits on the Members tab.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import { Sheet, Field } from './communityUi.jsx';

const fmt = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

export function useCohorts(programId, enabled) {
  const [data, setData] = useState(null);
  const load = useCallback(() => { if (enabled) api.get(`/programs/${programId}/cohorts`).then(setData).catch(() => setData({ cohorts: [] })); }, [programId, enabled]);
  useEffect(() => { load(); }, [load]);
  return { data, reload: load };
}

export function CohortsPanel({ programId, data, reload, onChanged }) {
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState(null);
  if (!data) return null;
  const remove = async (c) => {
    if (!window.confirm(`Remove the ${c.name} cohort?`)) return;
    setErr(null);
    try { await api.del(`/programs/${programId}/cohorts?cohortId=${c.id}`); reload(); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Cohorts</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Buyers join the next open cohort (or pick one). Lessons open counting from the cohort&apos;s start date.</div>
        </div>
        <button type="button" className="btn btn-outline" onClick={() => setEditing({})} style={{ fontSize: 12.5 }}><Icons.Plus size={12} sw={2}/> Add a cohort</button>
      </div>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      {data.cohorts.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--danger)' }}>No cohorts yet. Add one so people can join.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {data.cohorts.map((c, i) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.name} <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: c.open ? 'var(--ok)' : 'var(--muted)', marginLeft: 6 }}>{c.open ? 'open' : c.full ? 'full' : 'closed'}</span></div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>Starts {fmt(c.startDate)} · enrollment until {fmt(c.closesOn)} · {c.members}{c.capacity ? ` of ${c.capacity}` : ''} member{c.members === 1 && !c.capacity ? '' : 's'}</div>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(c)} style={{ fontSize: 12.5 }}>Edit</button>
              {c.members === 0 && <button type="button" className="btn btn-ghost" onClick={() => remove(c)} aria-label={`Remove ${c.name}`} style={{ padding: 6 }}><Icons.Trash size={13}/></button>}
            </div>
          ))}
        </div>
      )}
      {data.unassigned > 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{data.unassigned} member{data.unassigned === 1 ? ' is' : 's are'} not in a cohort yet; their lessons count from the day they joined.</div>}
      {editing && <CohortSheet programId={programId} cohort={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); onChanged?.(); }}/>}
    </div>
  );
}

function CohortSheet({ programId, cohort, onClose, onSaved }) {
  const [f, setF] = useState({ name: cohort?.name || '', startDate: cohort?.startDate || '', enrollmentClosesOn: cohort?.enrollmentClosesOn || '', capacity: cohort?.capacity ? String(cohort.capacity) : '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const body = { name: f.name, startDate: f.startDate, enrollmentClosesOn: f.enrollmentClosesOn || null, capacity: f.capacity === '' ? null : Number(f.capacity) };
    try {
      if (cohort) await api.patch(`/programs/${programId}/cohorts`, { cohortId: cohort.id, ...body });
      else await api.post(`/programs/${programId}/cohorts`, body);
      onSaved();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <Sheet title={cohort ? 'Edit cohort' : 'New cohort'} onClose={onClose} width={460}>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Spring group" maxLength={120} autoFocus required/></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Start date"><input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required/></Field>
          <Field label="Spots" hint="Blank = no limit"><input className="input" type="number" min="1" inputMode="numeric" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} placeholder="No limit"/></Field>
        </div>
        <Field label="Enrollment closes" hint="Blank = closes on the start date."><input className="input" type="date" value={f.enrollmentClosesOn} onChange={(e) => setF({ ...f, enrollmentClosesOn: e.target.value })}/></Field>
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !f.name.trim() || !f.startDate}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Sheet>
  );
}

// Per-member "move to cohort" select on the owner's members list.
export function CohortSelect({ programId, member, cohorts, onMoved, onError }) {
  const move = async (cohortId) => {
    try { await api.patch(`/programs/${programId}/cohorts`, { action: 'move', enrollmentId: member.id, cohortId: cohortId || null }); onMoved(); }
    catch (e) { onError?.(e.message); }
  };
  return (
    <select className="input" value={member.cohortId || ''} onChange={(e) => move(e.target.value)} aria-label={`Cohort for ${member.clientName || 'member'}`} style={{ width: 'auto', maxWidth: 160, padding: '4px 8px', fontSize: 12 }}>
      <option value="">No cohort</option>
      {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}
