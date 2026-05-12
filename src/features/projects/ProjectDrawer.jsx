// Drawer for a single project. Editable header (name + status + dates),
// linked-artifact tabs (Bookings / Invoices / Quotes / Documents) each
// of which deep-links into the right tab + drawer combo we already
// support via the Cmd+K palette work.
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const STATUSES = [
  { id: 'planning',  label: 'Planning' },
  { id: 'active',    label: 'Active' },
  { id: 'on_hold',   label: 'On hold' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
];

export default function ProjectDrawer({ project, onClose, onUpdate, onDelete }) {
  const [linked, setLinked]   = useState(null);
  const [tab, setTab]         = useState('bookings');
  const [name, setName]       = useState(project.name);
  const [descr, setDescr]     = useState(project.description || '');
  const [amount, setAmount]   = useState(project.amountQuoted == null ? '' : String(project.amountQuoted));
  const [startsAt, setStarts] = useState(project.startsAt ? project.startsAt.toString().slice(0, 10) : '');
  const [endsAt, setEnds]     = useState(project.endsAt   ? project.endsAt.toString().slice(0, 10)   : '');
  const [saveStatus, setSaveStatus] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    api.get(`/projects/${encodeURIComponent(project.id)}`)
      .then((r) => { if (live) setLinked(r.linked || null); })
      .catch(() => { if (live) setLinked({ bookings: [], invoices: [], quotes: [], documents: [] }); });
    return () => { live = false; };
  }, [project.id]);

  // Sync header fields when the project prop updates (e.g. on save).
  useEffect(() => { setName(project.name); }, [project.name]);
  useEffect(() => { setDescr(project.description || ''); }, [project.description]);
  useEffect(() => { setAmount(project.amountQuoted == null ? '' : String(project.amountQuoted)); }, [project.amountQuoted]);

  const safeUpdate = async (patch) => {
    setSaveStatus({ kind: 'pending', text: 'Saving…' });
    try {
      await onUpdate(patch);
      setSaveStatus({ kind: 'ok', text: 'Saved' });
      setTimeout(() => setSaveStatus(null), 1500);
    } catch (e) {
      setSaveStatus({ kind: 'error', text: e.message || 'Save failed' });
    }
  };

  const saveHeader = () => {
    const patch = {};
    if (name.trim() !== project.name) patch.name = name.trim();
    if ((descr || '') !== (project.description || '')) patch.description = descr || null;
    const amtParsed = amount === '' ? null : Number(amount);
    if ((amtParsed ?? null) !== (project.amountQuoted ?? null)) {
      if (amount === '' || (Number.isFinite(amtParsed) && amtParsed >= 0)) {
        patch.amountQuoted = amtParsed;
      }
    }
    if ((startsAt || null) !== (project.startsAt || null)) patch.startsAt = startsAt || null;
    if ((endsAt   || null) !== (project.endsAt   || null)) patch.endsAt   = endsAt   || null;
    if (Object.keys(patch).length === 0) return;
    safeUpdate(patch);
  };

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(10,12,8,0.45)',
        display: 'flex', justifyContent: 'flex-end',
      }}>
      <div style={{
        width: 'min(720px, 100vw)', height: '100vh', background: 'var(--surface)',
        display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border-strong)',
      }}>
        {/* Header */}
        <div style={{ padding: 20, borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input value={name} onChange={(e) => setName(e.target.value)} onBlur={saveHeader}
                placeholder="Project name"
                style={{
                  fontSize: 22, fontWeight: 600, padding: '4px 0',
                  border: 0, background: 'transparent', outline: 'none',
                  width: '100%', color: 'var(--fg)',
                  fontFamily: 'inherit',
                }}/>
              {project.clientName && (
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
                  Client: <strong style={{ color: 'var(--fg-2)' }}>{project.clientName}</strong>
                </div>
              )}
            </div>
            <button onClick={onClose} className="btn btn-ghost" style={{ padding: 8 }}>
              <Icons.X size={15}/>
            </button>
          </div>
        </div>

        {saveStatus && (
          <div style={{
            padding: '6px 20px', fontSize: 12.5,
            background: saveStatus.kind === 'error' ? 'rgba(155,44,44,0.10)' : 'var(--surface-2)',
            color: saveStatus.kind === 'error' ? 'var(--danger)' : 'var(--muted)',
            borderBottom: '1px solid var(--border)',
          }}>{saveStatus.text}</div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Status pills */}
          <div>
            <Label>Status</Label>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {STATUSES.map((s) => (
                <button key={s.id}
                  onClick={() => safeUpdate({ status: s.id })}
                  className={`btn ${project.status === s.id ? 'btn-primary' : 'btn-outline'}`}
                  style={{ padding: '5px 11px', fontSize: 12 }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Description</Label>
            <textarea value={descr} onChange={(e) => setDescr(e.target.value)} onBlur={saveHeader}
              rows={3} placeholder="Optional one-liner"
              style={{
                padding: '9px 11px', borderRadius: 8, fontSize: 13.5,
                width: '100%', border: '1px solid var(--border)',
                background: 'var(--surface-2)', color: 'inherit',
                resize: 'vertical', outline: 'none', fontFamily: 'inherit',
              }}/>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <Label>Quoted</Label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={saveHeader}
                placeholder="$0.00" type="number" min={0} step="0.01"
                style={smallFieldStyle}/>
            </div>
            <div>
              <Label>Starts</Label>
              <input type="date" value={startsAt} onChange={(e) => setStarts(e.target.value)} onBlur={saveHeader}
                style={smallFieldStyle}/>
            </div>
            <div>
              <Label>Ends</Label>
              <input type="date" value={endsAt} onChange={(e) => setEnds(e.target.value)} onBlur={saveHeader}
                style={smallFieldStyle}/>
            </div>
          </div>

          {/* Linked-artifact tabs */}
          <div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {[
                ['bookings',  'Bookings',  linked?.bookings?.length],
                ['invoices',  'Invoices',  linked?.invoices?.length],
                ['quotes',    'Quotes',    linked?.quotes?.length],
                ['documents', 'Documents', linked?.documents?.length],
              ].map(([id, label, n]) => (
                <button key={id}
                  onClick={() => setTab(id)}
                  className={`btn ${tab === id ? 'btn-primary' : 'btn-outline'}`}
                  style={{ padding: '5px 11px', fontSize: 12 }}>
                  {label} {n != null && <span style={{ opacity: 0.7 }}>· {n}</span>}
                </button>
              ))}
            </div>
            <LinkedList tab={tab} linked={linked} navigate={navigate} onClose={onClose}/>
          </div>

          {/* Danger zone */}
          <div style={{ marginTop: 'auto', paddingTop: 24, borderTop: '1px solid var(--border)' }}>
            <button onClick={() => {
                if (window.confirm('Delete this project? Linked invoices/bookings/docs stay; they\'ll just no longer be grouped under this project.')) {
                  onDelete();
                }
              }}
              style={{
                fontSize: 12, color: 'var(--danger)',
                background: 'transparent', padding: '6px 0',
              }}>
              Delete project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LinkedList({ tab, linked, navigate, onClose }) {
  if (!linked) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>;
  const rows = linked[tab] || [];
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: 12 }}>
        Nothing linked yet. Link an existing {tab.slice(0, -1)} from its editor's "Project" field.
      </div>
    );
  }
  const go = (path) => { onClose(); navigate(path); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map((r) => {
        if (tab === 'bookings') {
          return (
            <Row key={r.id} onClick={() => go(`/calendar?booking=${r.id}`)}
              title={`${r.date} · ${fmtTime(r.startMin)}–${fmtTime(r.endMin)}`}
              subtitle={r.clientName + (r.notes ? ' · ' + r.notes : '')}/>
          );
        }
        if (tab === 'invoices' || tab === 'quotes') {
          const route = tab === 'invoices' ? `/finance?invoice=${r.id}` : `/finance?quote=${r.id}`;
          return (
            <Row key={r.id} onClick={() => go(route)}
              title={r.number}
              subtitle={`${r.clientName || ''} · ${r.status} · $${r.total.toFixed(2)}`}/>
          );
        }
        return (
          <Row key={r.id} onClick={() => go(`/documents?doc=${r.id}`)}
            title={r.name} subtitle={r.status}/>
        );
      })}
    </div>
  );
}

function Row({ title, subtitle, onClick }) {
  return (
    <button onClick={onClick}
      style={{
        display: 'block', textAlign: 'left', width: '100%',
        padding: '10px 12px', borderRadius: 8,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        cursor: 'pointer',
      }}>
      <div style={{ fontSize: 13.5, fontWeight: 550 }}>{title}</div>
      {subtitle && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>
      )}
    </button>
  );
}

function Label({ children }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6,
    }}>{children}</div>
  );
}

function fmtTime(min) {
  if (typeof min !== 'number') return '';
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

const smallFieldStyle = {
  padding: '7px 10px', fontSize: 13, width: '100%',
  border: '1px solid var(--border)', borderRadius: 8,
  background: 'var(--surface-2)', color: 'inherit', outline: 'none',
};
