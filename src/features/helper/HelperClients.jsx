// /helper/clients - only with the "clients" permission. A focused list:
// search, add, edit (name, email, phone, notes) and delete. Talks to the
// owner's /api/clients endpoints in helper mode (X-Helper-Workspace), so
// everything is scoped to this business server-side. No money, no
// packages, no documents: those stay with the owner.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';
import { useViewport } from '../../lib/viewport.js';
import { useAnimatedClose } from '../../components/motion/useExitAnimation.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';
import { useHelper } from './helperContext.jsx';

export default function HelperClients() {
  const { permissions } = useHelper();
  const [clients, setClients] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // client | 'new' | null

  const load = useCallback(async () => {
    try {
      const r = await api.get('/clients?limit=1000');
      setClients(r.clients || []);
      setErr(null);
    } catch (e) {
      setErr(e.message || 'Could not load clients');
    }
  }, []);
  useEffect(() => { if (permissions.clients) load(); }, [load, permissions.clients]);

  const shown = useMemo(() => {
    const list = clients || [];
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter((c) => [c.name, c.email, c.phone].filter(Boolean).some((v) => String(v).toLowerCase().includes(s)));
  }, [clients, q]);

  if (!permissions.clients) {
    return (
      <div className="page-pad">
        <div className="card"><EmptyNote icon="Lock" title="Clients are not part of your access" hint="Ask the owner to turn on the Clients permission for you."/></div>
      </div>
    );
  }

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or phone"
          style={{ flex: 1, fontSize: 14 }}/>
        <button className="btn btn-primary" onClick={() => setEditing('new')} style={{ whiteSpace: 'nowrap' }}>
          <Icons.Plus size={13} sw={2}/> Add client
        </button>
      </div>
      {err && <div className="card" style={{ padding: 14, color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      {clients === null && !err && <SkelRowList rows={4} withAvatar/>}
      {clients !== null && shown.length === 0 && (
        <div className="card"><EmptyNote icon="Users" title={q ? 'No one matches that search' : 'No clients yet'} hint={q ? null : 'Add the first client and they show up here and on the owner’s list.'}/></div>
      )}
      {shown.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((c) => (
            <button key={c.id} type="button" className="card" onClick={() => setEditing(c)} style={{
              padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', width: '100%', cursor: 'pointer',
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: 99, flex: 'none', background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 13,
              }}>{(c.name || '?')[0].toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details'}
                </div>
              </div>
              <Icons.Arrow size={14} stroke="var(--muted)"/>
            </button>
          ))}
        </div>
      )}
      {editing && (
        <ClientSheet client={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}/>
      )}
    </div>
  );
}

function ClientSheet({ client, onClose: onCloseNow, onSaved }) {
  const { isMobile } = useViewport();
  const { closing, close: onClose } = useAnimatedClose(onCloseNow);
  useEscapeKey(onClose);
  const [draft, setDraft] = useState({ name: client?.name || '', email: client?.email || '', phone: client?.phone || '', notes: client?.notes || '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    if (!draft.name.trim()) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try {
      const body = { name: draft.name.trim(), email: draft.email.trim() || null, phone: draft.phone.trim() || null, notes: draft.notes };
      if (client) await api.patch(`/clients/${encodeURIComponent(client.id)}`, body);
      else await api.post('/clients', body);
      onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setErr(null);
    try { await api.del(`/clients/${encodeURIComponent(client.id)}`); onSaved(); }
    catch (e) { setErr(e.message || 'Could not delete'); setBusy(false); }
  };

  const field = (label, key, type = 'text', rows) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
      {label}
      {rows ? (
        <textarea className="input" rows={rows} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          style={{ fontSize: 14, textTransform: 'none', letterSpacing: 0, fontWeight: 400, resize: 'vertical' }}/>
      ) : (
        <input className="input" type={type} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          style={{ fontSize: 14, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}/>
      )}
    </label>
  );

  return (
    <>
      <div onClick={onClose} className={`motion-backdrop${closing ? ' is-closing' : ''}`}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 95 }}/>
      <div role="dialog" aria-modal="true" aria-label={client ? 'Edit client' : 'Add client'}
        className={`${isMobile ? 'motion-sheet' : 'motion-modal'}${closing ? ' is-closing' : ''}`}
        style={isMobile ? {
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 100, background: 'var(--surface)',
          borderTop: '1px solid var(--border)', borderRadius: '16px 16px 0 0',
          padding: '14px 16px calc(16px + env(safe-area-inset-bottom))', maxHeight: '90vh', overflowY: 'auto',
        } : {
          position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 100,
          width: 'min(92vw, 460px)', background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 16, padding: 20, boxShadow: 'var(--shadow)', maxHeight: '90vh', overflowY: 'auto',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.015em' }}>
            {client ? client.name : 'Add client'}
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {field('Name', 'name')}
          {field('Email', 'email', 'email')}
          {field('Phone', 'phone', 'tel')}
          {field('Notes', 'notes', 'text', 4)}
        </div>
        {err && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={busy} onClick={save} style={{ flex: 1, justifyContent: 'center' }}>
            {busy ? 'Saving…' : client ? 'Save changes' : 'Add client'}
          </button>
          {client && !confirmDelete && (
            <button className="btn btn-outline" disabled={busy} onClick={() => setConfirmDelete(true)} style={{ color: 'var(--danger)' }}>
              <Icons.Trash size={13}/>
            </button>
          )}
        </div>
        {confirmDelete && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: 'var(--surface-2)', fontSize: 13 }}>
            Delete {client.name}? Their bookings and messages with the business go too.
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-outline" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</button>
              <button className="btn btn-primary" disabled={busy} onClick={remove} style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>Delete</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
