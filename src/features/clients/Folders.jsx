// Folders view inside the Clients tab. A folder is one client's or one
// job's bookings, invoices, quotes and documents in one place. Cards
// grid + New folder modal; the drawer lives in FolderDrawer.jsx.
import React, { useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { useEscapeKey } from '../../lib/useEscapeKey.js';
import { FOLDER_STATUS } from './folders.js';

export const FOLDERS_NOTE = "All of your clients' files in one place.";

const FILTERS = [
  ['all',       'All'],
  ['active',    'Active'],
  ['planning',  'Planning'],
  ['on_hold',   'On hold'],
  ['completed', 'Completed'],
];

export default function FoldersView({ folders, loading, error, clients, query, onOpen, onNew }) {
  const [filter, setFilter] = useState('all');

  const rows = useMemo(() => {
    let r = folders;
    if (filter !== 'all') r = r.filter((f) => f.status === filter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      r = r.filter((f) => f.name.toLowerCase().includes(q) || (f.clientName || '').toLowerCase().includes(q));
    }
    return r;
  }, [folders, filter, query]);

  const counts = useMemo(() => {
    const c = { all: folders.length };
    for (const f of folders) c[f.status] = (c[f.status] || 0) + 1;
    return c;
  }, [folders]);

  if (error) {
    return (
      <div className="card" style={{ padding: 40 }}>
        <EmptyNote icon="Folder" title="Couldn't load folders" hint={error.message || 'Try refreshing.'}/>
      </div>
    );
  }

  return (
    <>
      {/* Filter row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="tab-row">
          {FILTERS.map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)} style={{
              padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
              background: filter === id ? 'var(--surface)' : 'transparent',
              color: filter === id ? 'var(--fg)' : 'var(--muted)',
              boxShadow: filter === id ? 'var(--shadow-sm)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              {label}
              <span style={{
                fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
                background: filter === id ? 'var(--surface-2)' : 'var(--surface)',
                color: 'var(--muted)', fontWeight: 600,
              }}>{counts[id] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 16 }}><SkelRowList rows={4}/></div>
      ) : folders.length === 0 ? (
        <FoldersEmpty onNew={onNew} hasClients={clients.length > 0}/>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Folder" title="No folders match" hint="Try a different filter or clear your search."/>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {rows.map((f) => <FolderCard key={f.id} folder={f} onOpen={() => onOpen(f.id)}/>)}
        </div>
      )}
    </>
  );
}

function FolderCard({ folder, onOpen }) {
  const meta = FOLDER_STATUS[folder.status] || FOLDER_STATUS.active;
  const c = folder.counts || {};
  const parts = [
    [c.bookings,  'booking',  'bookings'],
    [c.invoices,  'invoice',  'invoices'],
    [c.quotes,    'quote',    'quotes'],
    [c.documents, 'document', 'documents'],
  ].filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  const total = (c.bookings || 0) + (c.invoices || 0) + (c.quotes || 0) + (c.documents || 0);
  return (
    <button onClick={onOpen} className="card" style={{
      display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'left', width: '100%',
      padding: 16, cursor: 'pointer', border: '1px solid var(--border)', color: 'inherit',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 11, flexShrink: 0,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Folder size={20} sw={1.8}/></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {folder.clientName || 'No client yet'}
          </div>
        </div>
        <span style={{
          fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
          padding: '2px 8px', borderRadius: 99, flexShrink: 0, color: meta.color,
          background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
        }}>{meta.label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {total > 0 ? parts.join(' · ') : 'Empty - open to add files'}
        </span>
        {folder.amountQuoted != null && (
          <span className="mono-num" style={{ color: 'var(--fg-2)', fontWeight: 600, flexShrink: 0 }}>
            ${Number(folder.amountQuoted).toLocaleString()}
          </span>
        )}
      </div>
    </button>
  );
}

function FoldersEmpty({ onNew, hasClients }) {
  return (
    <div className="card" style={{ padding: '40px 24px', textAlign: 'center' }}>
      <div style={{
        width: 56, height: 56, borderRadius: 16, margin: '0 auto 14px',
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Folder size={28} sw={1.7}/></div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{FOLDERS_NOTE}</div>
      <div style={{ fontSize: 13.5, color: 'var(--muted)', maxWidth: 440, margin: '8px auto 18px', lineHeight: 1.5 }}>
        Make a folder for a client or a job, then drop their bookings, invoices, quotes and signed documents into it.
        Open the folder later and the whole story is right there.
      </div>
      <button className="btn btn-primary" onClick={onNew}>
        <Icons.Plus size={13} sw={2}/> New folder
      </button>
      {!hasClients && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
          Tip: add a client first so the folder can be theirs.
        </div>
      )}
    </div>
  );
}

export function NewFolderModal({ clients, defaultClientId = '', onClose, onCreate }) {
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState(defaultClientId || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEscapeKey(onClose);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Give the folder a name'); return; }
    setBusy(true); setErr(null);
    try {
      await onCreate({ name: name.trim(), clientId: clientId || null, status: 'active' });
    } catch (e2) {
      setErr(e2.message || 'Could not create the folder');
      setBusy(false);
    }
  };

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 220, background: 'rgba(10,12,8,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form onSubmit={submit} className="card" style={{ width: '100%', maxWidth: 460, padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Folder size={18} sw={1.8}/></div>
          <div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600 }}>New folder</h2>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{FOLDERS_NOTE}</div>
          </div>
        </div>
        <div>
          <label style={fieldLabelStyle}>Folder name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Smith wedding, Q4 retainer, Brand refresh" style={fieldStyle}/>
        </div>
        <div>
          <label style={fieldLabelStyle}>Client</label>
          <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} style={fieldStyle}>
            <option value="">No client (a general folder)</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
            Choosing a client means the folder offers their bookings, invoices, quotes and documents to file.
          </div>
        </div>
        {err && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create folder'}
          </button>
        </div>
      </form>
    </div>
  );
}

const fieldStyle = { padding: '9px 11px', fontSize: 14, width: '100%' };
const fieldLabelStyle = {
  display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)',
  letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 4,
};
