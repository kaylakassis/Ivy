// One folder: name, client, status, dates, quoted amount, and four
// tabs of what's inside (bookings, invoices, quotes, documents). Each
// tab has an "Add" picker that lists the client's items not yet in the
// folder; a row's × takes it back out. Items are never deleted here,
// only filed and unfiled.
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';
import { FOLDER_STATUS } from './folders.js';

const TABS = [
  ['bookings',  'Bookings'],
  ['invoices',  'Invoices'],
  ['quotes',    'Quotes'],
  ['documents', 'Documents'],
];

export default function FolderDrawer({ folder, clients, onClose, onUpdate, onDelete }) {
  const [linked, setLinked]   = useState(null);
  const [tab, setTab]         = useState('bookings');
  const [picking, setPicking] = useState(false);
  const [name, setName]       = useState(folder.name);
  const [descr, setDescr]     = useState(folder.description || '');
  const [amount, setAmount]   = useState(folder.amountQuoted == null ? '' : String(folder.amountQuoted));
  const [startsAt, setStarts] = useState(folder.startsAt || '');
  const [endsAt, setEnds]     = useState(folder.endsAt || '');
  const [saveStatus, setSaveStatus] = useState(null);
  const navigate = useNavigate();
  useEscapeKey(onClose);

  const load = () => api.get(`/projects/${encodeURIComponent(folder.id)}`)
    .then((r) => setLinked(r.linked || { bookings: [], invoices: [], quotes: [], documents: [] }))
    .catch(() => setLinked({ bookings: [], invoices: [], quotes: [], documents: [] }));
  useEffect(() => { setLinked(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [folder.id]);

  useEffect(() => { setName(folder.name); }, [folder.name]);
  useEffect(() => { setDescr(folder.description || ''); }, [folder.description]);
  useEffect(() => { setAmount(folder.amountQuoted == null ? '' : String(folder.amountQuoted)); }, [folder.amountQuoted]);
  useEffect(() => { setStarts(folder.startsAt || ''); }, [folder.startsAt]);
  useEffect(() => { setEnds(folder.endsAt || ''); }, [folder.endsAt]);

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
    if (name.trim() && name.trim() !== folder.name) patch.name = name.trim();
    if ((descr || '') !== (folder.description || '')) patch.description = descr || null;
    const amt = amount === '' ? null : Number(amount);
    if ((amt ?? null) !== (folder.amountQuoted ?? null) && (amount === '' || (Number.isFinite(amt) && amt >= 0))) patch.amountQuoted = amt;
    if ((startsAt || null) !== (folder.startsAt || null)) patch.startsAt = startsAt || null;
    if ((endsAt || null) !== (folder.endsAt || null)) patch.endsAt = endsAt || null;
    if (Object.keys(patch).length) safeUpdate(patch);
  };

  const unfile = async (type, id) => {
    setLinked((l) => l ? { ...l, [type]: (l[type] || []).filter((r) => r.id !== id) } : l);
    try { await api.del(`/projects/${encodeURIComponent(folder.id)}/link`, { type, id }); }
    catch { load(); }
  };

  const counts = linked ? Object.fromEntries(TABS.map(([id]) => [id, (linked[id] || []).length])) : null;
  const meta = FOLDER_STATUS[folder.status] || FOLDER_STATUS.active;

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(10,12,8,0.45)', display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{
        width: 'min(720px, 100vw)', height: '100vh', background: 'var(--surface)',
        display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border-strong)',
      }}>
        {/* Header */}
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 11, flexShrink: 0, marginTop: 2,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><Icons.Folder size={20} sw={1.8}/></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input value={name} onChange={(e) => setName(e.target.value)} onBlur={saveHeader}
                placeholder="Folder name" aria-label="Folder name"
                style={{
                  fontSize: 21, fontWeight: 600, padding: '2px 0', border: 0, background: 'transparent',
                  outline: 'none', width: '100%', color: 'var(--fg)', fontFamily: 'inherit',
                }}/>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                  padding: '2px 8px', borderRadius: 99, color: meta.color,
                  background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
                }}>{meta.label}</span>
                <label style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  Client
                  <select value={folder.clientId || ''} onChange={(e) => safeUpdate({ clientId: e.target.value || null })}
                    aria-label="Client" style={{ ...smallFieldStyle, width: 'auto', padding: '4px 8px', fontSize: 12.5 }}>
                    <option value="">No client</option>
                    {(clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              </div>
            </div>
            <button onClick={onClose} className="btn btn-ghost" style={{ padding: 8 }} aria-label="Close">
              <Icons.X size={15}/>
            </button>
          </div>
        </div>

        {saveStatus && (
          <div style={{
            padding: '6px 20px', fontSize: 12.5, borderBottom: '1px solid var(--border)',
            background: saveStatus.kind === 'error' ? 'rgba(155,44,44,0.10)' : 'var(--surface-2)',
            color: saveStatus.kind === 'error' ? 'var(--danger)' : 'var(--muted)',
          }}>{saveStatus.text}</div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* What's inside */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              <div className="tab-row" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {TABS.map(([id, label]) => (
                  <button key={id} onClick={() => { setTab(id); setPicking(false); }}
                    className={`btn ${tab === id ? 'btn-primary' : 'btn-outline'}`}
                    style={{ padding: '5px 11px', fontSize: 12 }}>
                    {label}{counts && <span style={{ opacity: 0.7 }}> · {counts[id]}</span>}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1 }}/>
              <button onClick={() => setPicking((p) => !p)} className="btn btn-outline" style={{ padding: '5px 11px', fontSize: 12 }}>
                <Icons.Plus size={12} sw={2}/> Add {TABS.find(([id]) => id === tab)[1].toLowerCase()}
              </button>
            </div>

            {picking && (
              <Picker folder={folder} type={tab}
                onClose={() => setPicking(false)}
                onAdded={() => { setPicking(false); load(); }}/>
            )}

            <LinkedList tab={tab} linked={linked}
              onOpen={(path) => { onClose(); navigate(path); }}
              onRemove={(id) => unfile(tab, id)}/>
          </div>

          {/* Details */}
          <div>
            <Label>Status</Label>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {Object.entries(FOLDER_STATUS).map(([id, s]) => (
                <button key={id} onClick={() => safeUpdate({ status: id })}
                  className={`btn ${folder.status === id ? 'btn-primary' : 'btn-outline'}`}
                  style={{ padding: '5px 11px', fontSize: 12 }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Notes</Label>
            <textarea value={descr} onChange={(e) => setDescr(e.target.value)} onBlur={saveHeader}
              rows={3} placeholder="What this folder is for, in a line or two"
              style={{
                padding: '9px 11px', borderRadius: 8, fontSize: 13.5, width: '100%',
                border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'inherit',
                resize: 'vertical', outline: 'none', fontFamily: 'inherit',
              }}/>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
            <div>
              <Label>Quoted</Label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={saveHeader}
                placeholder="$0.00" type="number" min={0} step="0.01" inputMode="decimal" style={smallFieldStyle}/>
            </div>
            <div>
              <Label>Starts</Label>
              <input type="date" value={startsAt} onChange={(e) => setStarts(e.target.value)} onBlur={saveHeader} style={smallFieldStyle}/>
            </div>
            <div>
              <Label>Ends</Label>
              <input type="date" value={endsAt} onChange={(e) => setEnds(e.target.value)} onBlur={saveHeader} style={smallFieldStyle}/>
            </div>
          </div>

          <div style={{ marginTop: 'auto', paddingTop: 24, borderTop: '1px solid var(--border)' }}>
            <button onClick={() => {
                if (window.confirm('Delete this folder? Everything inside stays where it is; it just won\'t be grouped any more.')) onDelete();
              }}
              style={{ fontSize: 12, color: 'var(--danger)', background: 'transparent', padding: '6px 0', border: 0, cursor: 'pointer' }}>
              Delete folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Lists the items not yet in this folder (the client's own when the
// folder has a client) with one tap to add each.
function Picker({ folder, type, onClose, onAdded }) {
  const [cands, setCands] = useState(null);
  const [scoped, setScoped] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    setCands(null);
    api.get(`/projects/${encodeURIComponent(folder.id)}/link`)
      .then((r) => { if (live) { setCands(r.candidates || {}); setScoped(!!r.scopedToClient); } })
      .catch((e) => { if (live) { setCands({}); setErr(e.message || 'Could not load'); } });
    return () => { live = false; };
  }, [folder.id, type]);

  const add = async (id) => {
    setBusyId(id); setErr(null);
    try {
      await api.post(`/projects/${encodeURIComponent(folder.id)}/link`, { type, id });
      onAdded();
    } catch (e) {
      setErr(e.message || 'Could not add');
    } finally {
      setBusyId(null);
    }
  };

  const rows = cands ? (cands[type] || []) : null;
  const noun = type === 'documents' ? 'documents' : type;
  return (
    <div style={{
      border: '1px solid var(--border-strong)', borderRadius: 12, padding: 12, marginBottom: 12,
      background: 'var(--surface-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
          Add {noun} to this folder
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          {scoped ? `Showing ${folder.clientName || 'this client'}'s ${noun}` : `Showing all ${noun}`}
        </div>
        <div style={{ flex: 1 }}/>
        <button onClick={onClose} className="btn btn-ghost" style={{ padding: 4 }} aria-label="Close picker"><Icons.X size={13}/></button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 6 }}>{err}</div>}
      {rows === null ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          Nothing left to add. {scoped ? `Every one of this client's ${noun} is already here, or none exist yet.` : `Create ${noun} first, then add them here.`}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
          {rows.map((r) => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8,
              background: 'var(--surface)', border: '1px solid var(--border)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rowTitle(type, r)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{rowSubtitle(type, r)}</div>
              </div>
              <button onClick={() => add(r.id)} disabled={busyId === r.id} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 12 }}>
                {busyId === r.id ? '…' : 'Add'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkedList({ tab, linked, onOpen, onRemove }) {
  if (!linked) return <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: 12 }}>Loading…</div>;
  const rows = linked[tab] || [];
  if (rows.length === 0) {
    return (
      <div style={{
        fontSize: 12.5, color: 'var(--muted)', padding: '18px 12px', textAlign: 'center',
        border: '1px dashed var(--border)', borderRadius: 10,
      }}>
        No {tab} in this folder yet. Tap Add {tab} above to file some.
      </div>
    );
  }
  const route = (r) => tab === 'bookings' ? `/calendar?booking=${r.id}`
    : tab === 'invoices' ? `/finance?invoice=${r.id}`
    : tab === 'quotes' ? `/finance?quote=${r.id}`
    : `/documents?doc=${r.id}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map((r) => (
        <div key={r.id} style={{
          display: 'flex', alignItems: 'center', gap: 6, borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
        }}>
          <button onClick={() => onOpen(route(r))}
            style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: '10px 12px', background: 'transparent', border: 0, cursor: 'pointer', color: 'inherit' }}>
            <div style={{ fontSize: 13.5, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rowTitle(tab, r)}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{rowSubtitle(tab, r)}</div>
          </button>
          <button onClick={() => onRemove(r.id)} className="btn btn-ghost" title="Take out of this folder" aria-label="Take out of this folder"
            style={{ padding: 8, marginRight: 4, color: 'var(--muted)' }}>
            <Icons.X size={13}/>
          </button>
        </div>
      ))}
    </div>
  );
}

function rowTitle(type, r) {
  if (type === 'bookings') return `${r.date} · ${fmtTime(r.startMin)}–${fmtTime(r.endMin)}`;
  if (type === 'documents') return r.name;
  return r.number;
}
function rowSubtitle(type, r) {
  if (type === 'bookings') return (r.clientName || '') + (r.notes ? ' · ' + r.notes : '');
  if (type === 'documents') return r.status;
  return `${r.clientName || ''} · ${r.status} · $${Number(r.total || 0).toFixed(2)}`;
}

function Label({ children }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
      {children}
    </div>
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
