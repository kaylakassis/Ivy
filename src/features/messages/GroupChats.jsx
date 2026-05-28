// Owner-side cohort group chat UI. Sibling of Messages.jsx — they
// share a tab toggle in MessagesPage but each owns its own layout.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useViewport } from '../../lib/viewport.js';
import { fmtTime } from './utils.js';

export default function GroupChats() {
  const [groups, setGroups]         = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError]           = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [newOpen, setNewOpen]       = useState(false);
  const [addOpen, setAddOpen]       = useState(false);
  const { isMobile } = useViewport();

  const refresh = useCallback(async () => {
    try {
      const r = await api.get('/messages/groups');
      setGroups(r.groups || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-select first on desktop.
  useEffect(() => {
    if (!isMobile && !selectedId && groups.length > 0) setSelectedId(groups[0].id);
  }, [groups, selectedId, isMobile]);

  const selected = useMemo(() => groups.find((g) => g.id === selectedId) || null, [groups, selectedId]);
  const showList = !isMobile || !selectedId;
  const showThread = !isMobile || !!selectedId;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? '1fr' : '320px 1fr',
      flex: 1, minHeight: 0,
      borderTop: '1px solid var(--border)',
    }}>
      {showList && (
        <div style={{
          borderRight: isMobile ? 'none' : '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', minHeight: 0,
        }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Groups</div>
            <button className="btn btn-ghost" style={{ padding: 6 }}
              onClick={() => setNewOpen(true)} title="New group">
              <Icons.Plus size={15} sw={2}/>
            </button>
          </div>
          <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
            {loadingList ? (
              <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>Loading…</div>
            ) : groups.length === 0 ? (
              <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
                No groups yet.<br/>
                <button className="btn btn-outline" style={{ marginTop: 12 }} onClick={() => setNewOpen(true)}>
                  <Icons.Plus size={13} sw={2}/> Create one
                </button>
              </div>
            ) : groups.map((g) => (
              <button key={g.id} onClick={() => setSelectedId(g.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '12px 16px',
                  background: g.id === selectedId ? 'var(--surface-2)' : 'transparent',
                  border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 13.5, fontWeight: 600, minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {g.name}
                  </div>
                  {g.unreadBiz > 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: 'var(--surface)',
                      background: 'var(--accent)', borderRadius: 999, padding: '2px 7px',
                    }}>{g.unreadBiz}</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {g.memberCount ?? '—'} member{g.memberCount === 1 ? '' : 's'}
                  {g.mode === 'broadcast' && ' · Announcements'}
                  {g.lastPreview && ` · ${g.lastPreview}`}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {showThread && (
        selected ? (
          <GroupConversation
            key={selected.id}
            groupId={selected.id}
            onBack={() => isMobile && setSelectedId(null)}
            onAddMembers={() => setAddOpen(true)}
            onArchive={async () => {
              if (!window.confirm('Archive this group? Members keep their history.')) return;
              await api.del('/messages/groups/' + encodeURIComponent(selected.id));
              setSelectedId(null);
              refresh();
            }}
            onModeChange={async (mode) => {
              await api.patch('/messages/groups/' + encodeURIComponent(selected.id), { mode });
              refresh();
            }}
            onRename={async (name) => {
              await api.patch('/messages/groups/' + encodeURIComponent(selected.id), { name });
              refresh();
            }}
            onUnreadCleared={() => {
              setGroups((gs) => gs.map((g) => g.id === selected.id ? { ...g, unreadBiz: 0 } : g));
            }}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--muted)', fontSize: 13 }}>
            Select a group to view messages.
          </div>
        )
      )}

      {newOpen && (
        <NewGroupModal
          onClose={() => setNewOpen(false)}
          onCreated={(g) => {
            setNewOpen(false);
            setGroups((gs) => [g, ...gs]);
            setSelectedId(g.id);
          }}
        />
      )}

      {addOpen && selected && (
        <AddMembersModal
          groupId={selected.id}
          onClose={() => setAddOpen(false)}
          onAdded={() => { setAddOpen(false); refresh(); }}
        />
      )}

      {error && (
        <div style={{ position: 'fixed', bottom: 16, right: 16, padding: '10px 14px',
          background: 'var(--surface)', border: '1px solid var(--danger)', color: 'var(--danger)',
          borderRadius: 8, fontSize: 13 }}>{error.message || 'Something went wrong.'}</div>
      )}
    </div>
  );
}

function GroupConversation({ groupId, onBack, onAddMembers, onArchive, onModeChange, onRename, onUnreadCleared }) {
  const [group, setGroup]     = useState(null);
  const [members, setMembers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [text, setText]       = useState('');
  const [sending, setSending] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const scrollRef = useRef(null);
  const { isMobile } = useViewport();

  const refresh = useCallback(async () => {
    const r = await api.get('/messages/groups/' + encodeURIComponent(groupId));
    setGroup(r.group);
    setMembers(r.members || []);
    setMessages(r.messages || []);
    if (r.group?.unreadBiz === 0) onUnreadCleared?.();
  }, [groupId, onUnreadCleared]);

  useEffect(() => { refresh(); }, [refresh]);

  // Light polling for new messages (15s). Existing Messages.jsx uses
  // the same idle-polling pattern; real-time is Phase 2.
  useEffect(() => {
    const t = setInterval(() => { refresh().catch(() => {}); }, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  // Scroll to bottom on new message.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  const submit = async (e) => {
    e?.preventDefault?.();
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const r = await api.post('/messages/groups/' + encodeURIComponent(groupId) + '/messages',
        { text: trimmed });
      setMessages((m) => [...m, r.message]);
      setText('');
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(err.message || 'Send failed.');
    } finally { setSending(false); }
  };

  if (!group) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface)',
      }}>
        {isMobile && (
          <button className="btn btn-ghost" onClick={onBack} style={{ padding: 4 }}>
            <Icons.Arrow size={16} stroke="var(--fg)" style={{ transform: 'rotate(180deg)' }}/>
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {renaming ? (
            <form onSubmit={async (e) => {
              e.preventDefault();
              const v = renameValue.trim();
              if (v && v !== group.name) await onRename(v);
              setRenaming(false);
            }}>
              <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => setRenaming(false)}
                style={{ fontSize: 14, fontWeight: 600, padding: '4px 6px', width: '100%',
                  border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}/>
            </form>
          ) : (
            <button onClick={() => { setRenameValue(group.name); setRenaming(true); }}
              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                fontSize: 14, fontWeight: 600, textAlign: 'left' }}>
              {group.name}
            </button>
          )}
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            {members.length} member{members.length === 1 ? '' : 's'}
            {group.mode === 'broadcast' && ' · Announcements only'}
          </div>
        </div>
        <select value={group.mode}
          onChange={(e) => onModeChange(e.target.value)}
          style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--surface)' }}>
          <option value="open">Open</option>
          <option value="broadcast">Broadcast</option>
        </select>
        <button className="btn btn-ghost" onClick={onAddMembers} style={{ padding: '6px 10px', fontSize: 12 }}>
          <Icons.Plus size={12} sw={2}/> Add
        </button>
        <button className="btn btn-ghost" onClick={onArchive}
          style={{ padding: '6px 10px', fontSize: 12, color: 'var(--danger)' }}>
          Archive
        </button>
      </div>

      <div ref={scrollRef} className="scroll"
        style={{ flex: 1, overflowY: 'auto', padding: '16px 20px',
          display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 ? (
          <EmptyNote icon="Chat" title="No messages yet" hint="Send the first one."/>
        ) : messages.map((m) => <MessageBubble key={m.id} msg={m}/>)}
      </div>

      <form onSubmit={submit} style={{
        padding: 12, borderTop: '1px solid var(--border)', background: 'var(--surface)',
        display: 'flex', gap: 8,
      }}>
        <input value={text} onChange={(e) => setText(e.target.value)}
          placeholder={group.mode === 'broadcast' ? 'Announce to the group…' : 'Message the group…'}
          style={{ flex: 1, padding: '10px 12px', border: '1px solid var(--border)',
            borderRadius: 8, fontSize: 14, background: 'var(--surface)' }}/>
        <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending}>
          {sending ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ msg }) {
  if (msg.sender === 'system') {
    return (
      <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', margin: '8px 0' }}>
        {msg.text || msg.kind?.replace(/_/g, ' ')}
      </div>
    );
  }
  const fromBiz = msg.sender === 'biz';
  return (
    <div style={{
      alignSelf: fromBiz ? 'flex-end' : 'flex-start',
      maxWidth: '78%',
    }}>
      {!fromBiz && msg.senderName && (
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 2, marginLeft: 4 }}>
          {msg.senderName}
        </div>
      )}
      <div style={{
        padding: '10px 14px', borderRadius: 14,
        background: fromBiz ? 'var(--accent)' : 'var(--surface-2)',
        color: fromBiz ? 'var(--surface)' : 'var(--fg)',
        fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap',
      }}>
        {msg.text}
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3,
        textAlign: fromBiz ? 'right' : 'left' }}>
        {fmtTime(msg.createdAt)}
      </div>
    </div>
  );
}

function NewGroupModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState('open');
  const [clients, setClients] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get('/clients').then((r) => setClients(r.clients || [])).catch((e) => setErr(e));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return (clients || []).slice(0, 200);
    return (clients || []).filter((c) =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q)
    ).slice(0, 200);
  }, [clients, search]);

  const toggle = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr({ message: 'Name is required' }); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/messages/groups', {
        name: name.trim(), description: description.trim() || null,
        mode, clientIds: Array.from(selectedIds),
      });
      onCreated(r.group);
    } catch (e2) {
      setErr(e2);
    } finally { setBusy(false); }
  };

  return (
    <ModalShell title="New group" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required
            placeholder="Tuesday 7am Yoga"
            style={inputStyle}/>
        </Field>
        <Field label="Description (optional)">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)}
            rows={2} style={{ ...inputStyle, resize: 'vertical' }}/>
        </Field>
        <Field label="Mode">
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={inputStyle}>
            <option value="open">Open — clients see each other + can reply</option>
            <option value="broadcast">Broadcast — owner posts only</option>
          </select>
        </Field>
        <Field label={`Members (${selectedIds.size} selected)`}>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients…"
            style={{ ...inputStyle, marginBottom: 8 }}/>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)',
            borderRadius: 8, background: 'var(--surface-2)' }}>
            {clients === null ? (
              <div style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}>Loading clients…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}>No matches.</div>
            ) : filtered.map((c) => (
              <label key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                cursor: 'pointer', borderBottom: '1px solid var(--border)',
              }}>
                <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggle(c.id)}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name || c.email}</div>
                  {c.email && c.name && (
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.email}</div>
                  )}
                </div>
              </label>
            ))}
          </div>
        </Field>
        {err && (
          <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err.message || 'Something went wrong.'}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function AddMembersModal({ groupId, onClose, onAdded }) {
  const [clients, setClients] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get('/clients').then((r) => setClients(r.clients || [])).catch((e) => setErr(e));
  }, []);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return (clients || []).slice(0, 200);
    return (clients || []).filter((c) =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q)
    ).slice(0, 200);
  }, [clients, search]);

  const submit = async (e) => {
    e.preventDefault();
    if (selectedIds.size === 0) { setErr({ message: 'Pick at least one client' }); return; }
    setBusy(true); setErr(null);
    try {
      await api.post('/messages/groups/' + encodeURIComponent(groupId) + '/members',
        { clientIds: Array.from(selectedIds) });
      onAdded();
    } catch (e2) {
      setErr(e2);
    } finally { setBusy(false); }
  };

  return (
    <ModalShell title="Add members" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients…" style={inputStyle}/>
        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)',
          borderRadius: 8, background: 'var(--surface-2)' }}>
          {clients === null ? (
            <div style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}>No matches.</div>
          ) : filtered.map((c) => (
            <label key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              cursor: 'pointer', borderBottom: '1px solid var(--border)',
            }}>
              <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => {
                const next = new Set(selectedIds);
                if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                setSelectedIds(next);
              }}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name || c.email}</div>
                {c.email && c.name && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.email}</div>}
              </div>
            </label>
          ))}
        </div>
        {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err.message || 'Failed.'}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || selectedIds.size === 0}>
            {busy ? 'Adding…' : `Add ${selectedIds.size || ''}`}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em',
        textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      {children}
    </label>
  );
}

function ModalShell({ title, onClose, children }) {
  return (
    <div onClick={onClose} role="dialog" aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 60, padding: 20,
      }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--surface)', borderRadius: 14, padding: 24,
        width: '100%', maxWidth: 520, maxHeight: '90vh', overflow: 'auto',
        border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 700 }}>{title}</div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 4 }}>
            <Icons.X size={16} sw={2}/>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '10px 12px', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: 14, background: 'var(--surface)',
};
