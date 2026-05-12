// /projects — list view of engagements that group bookings + invoices
// + quotes + documents under a named project. Useful for project-based
// service providers (photographers, designers, consultants); session-
// based providers can ignore the surface.
//
// Status tabs across the top (planning / active / on hold / completed),
// list of project cards with linked-artifact counts, "+ New project"
// button. Clicking a card opens ProjectDrawer.
import React, { useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useProjects } from './state.js';
import ProjectDrawer from './ProjectDrawer.jsx';

const STATUS_META = {
  planning:  { label: 'Planning',  color: 'var(--muted)' },
  active:    { label: 'Active',    color: 'var(--ok)' },
  on_hold:   { label: 'On hold',   color: 'var(--warn)' },
  completed: { label: 'Completed', color: 'var(--muted-2)' },
  cancelled: { label: 'Cancelled', color: 'var(--danger)' },
};

const TABS = [
  { id: '',          label: 'All' },
  { id: 'planning',  label: 'Planning' },
  { id: 'active',    label: 'Active' },
  { id: 'on_hold',   label: 'On hold' },
  { id: 'completed', label: 'Completed' },
];

export default function Projects() {
  const {
    projects, loading, error,
    statusFilter, setStatusFilter,
    refresh, create, update, remove,
  } = useProjects();
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  const visible = useMemo(() => projects, [projects]);
  const openProject = projects.find((p) => p.id === openId) || null;

  if (loading) return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading projects…</div>;
  if (error) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Doc" title="Couldn't load projects" hint={error.message || 'Try refreshing.'}/>
        </div>
      </div>
    );
  }

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Projects</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Group bookings, invoices, quotes, and documents under a named engagement.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icons.Plus size={13} sw={2}/> New project
        </button>
      </div>

      {/* Status tabs */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.id || 'all'}
            onClick={() => setStatusFilter(t.id)}
            className={`btn ${statusFilter === t.id ? 'btn-primary' : 'btn-outline'}`}
            style={{ padding: '5px 13px', fontSize: 12.5 }}>
            {t.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="card" style={{ padding: 48 }}>
          <EmptyNote icon="Doc" title="No projects yet"
            hint="Create one to group everything tied to a client engagement (e.g. 'Smith wedding') in one place."/>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {visible.map((p) => (
            <ProjectCard key={p.id} project={p} onOpen={() => setOpenId(p.id)}/>
          ))}
        </div>
      )}

      {openProject && (
        <ProjectDrawer
          project={openProject}
          onClose={() => setOpenId(null)}
          onUpdate={(patch) => update(openProject.id, patch)}
          onDelete={async () => { await remove(openProject.id); setOpenId(null); }}
        />
      )}

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreate={async (payload) => {
            const created = await create(payload);
            setCreating(false);
            if (created) setOpenId(created.id);
          }}
        />
      )}
    </div>
  );
}

function ProjectCard({ project, onOpen }) {
  const meta = STATUS_META[project.status] || STATUS_META.active;
  const c = project.counts || {};
  const totalArtifacts = (c.bookings || 0) + (c.invoices || 0) + (c.quotes || 0) + (c.documents || 0);
  return (
    <button onClick={onOpen}
      className="card"
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: 16, cursor: 'pointer',
        border: '1px solid var(--border)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{
              fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '2px 8px', borderRadius: 99,
              background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
              color: meta.color,
            }}>{meta.label}</span>
            {project.clientName && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>· {project.clientName}</span>
            )}
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{project.name}</div>
          {project.description && (
            <div style={{
              fontSize: 12.5, color: 'var(--muted)', marginTop: 4,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{project.description}</div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          {totalArtifacts > 0 ? (
            <>
              {(c.bookings  || 0) > 0 && <Pill icon="Calendar" label={c.bookings  + (c.bookings  === 1 ? ' booking'  : ' bookings')}/>}
              {(c.invoices  || 0) > 0 && <Pill icon="Doc"      label={c.invoices  + (c.invoices  === 1 ? ' invoice'  : ' invoices')}/>}
              {(c.quotes    || 0) > 0 && <Pill icon="Doc"      label={c.quotes    + (c.quotes    === 1 ? ' quote'    : ' quotes')}/>}
              {(c.documents || 0) > 0 && <Pill icon="Doc"      label={c.documents + (c.documents === 1 ? ' doc'      : ' docs')}/>}
            </>
          ) : (
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Nothing linked yet</span>
          )}
          {project.amountQuoted != null && (
            <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginTop: 4 }}>
              ${Number(project.amountQuoted).toLocaleString()}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function Pill({ icon, label }) {
  const Icon = Icons[icon] || Icons.Check;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11.5, color: 'var(--muted)', marginLeft: 8,
    }}>
      <Icon size={11} sw={1.7}/> {label}
    </span>
  );
}

function NewProjectModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('active');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try {
      await onCreate({ name: name.trim(), description: description.trim() || null, status });
    } catch (e2) {
      setErr(e2.message || 'Could not create project');
      setBusy(false);
    }
  };

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 220,
        background: 'rgba(10,12,8,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
      <form onSubmit={submit} className="card" style={{
        width: '100%', maxWidth: 480, padding: 24,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>New project</h2>
        <div>
          <label style={fieldLabelStyle}>Name</label>
          <input className="input" autoFocus
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Smith wedding"
            style={fieldStyle}/>
        </div>
        <div>
          <label style={fieldLabelStyle}>Description (optional)</label>
          <textarea className="input"
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="One-liner so you remember at a glance"
            rows={3}
            style={{ ...fieldStyle, resize: 'vertical' }}/>
        </div>
        <div>
          <label style={fieldLabelStyle}>Status</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}
            style={fieldStyle}>
            {Object.entries(STATUS_META).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>
        {err && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </div>
  );
}

const fieldStyle = { padding: '9px 11px', fontSize: 14, width: '100%' };
const fieldLabelStyle = {
  display: 'block', fontSize: 11.5, fontWeight: 600,
  color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase',
  marginBottom: 4,
};
