// Owner-side cohort group chat UI. Sibling of Messages.jsx — they
// share a tab toggle in MessagesPage but each owns its own layout.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useViewport } from '../../lib/viewport.js';
import { fmtTime } from './utils.js';
import { upload } from '@vercel/blob/client';

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

const QUICK_EMOJIS = ['👍', '❤️', '🎉', '🔥', '😂', '👀'];

function GroupConversation({ groupId, onBack, onAddMembers, onArchive, onModeChange, onRename, onUnreadCleared }) {
  const [group, setGroup]     = useState(null);
  const [members, setMembers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [text, setText]       = useState('');
  const [sending, setSending] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [replyingTo, setReplyingTo] = useState(null); // message being replied to
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

  // Smart polling: 2s when this tab is focused + visible, 30s when not.
  // Cheap "real-time" without any new infra — feels instant for the
  // active reader, near-free for background tabs. SSE with Neon would
  // still need server-side DB polling so the cost trade is identical,
  // and Pusher/Ably are paid. Revisit if active simultaneous members
  // per group regularly exceed a few dozen.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      try { await refresh(); } catch { /* ignore */ }
      if (cancelled) return;
      const visible = document.visibilityState === 'visible' && document.hasFocus();
      timer = setTimeout(tick, visible ? 2000 : 30000);
    };
    timer = setTimeout(tick, 2000);
    const onVisChange = () => {
      if (timer) clearTimeout(timer);
      tick();
    };
    document.addEventListener('visibilitychange', onVisChange);
    window.addEventListener('focus', onVisChange);
    window.addEventListener('blur', onVisChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisChange);
      window.removeEventListener('focus', onVisChange);
      window.removeEventListener('blur', onVisChange);
    };
  }, [refresh]);

  // Scroll to bottom on new message.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  const [pendingFiles, setPendingFiles] = useState([]); // [{ name, type, url }]
  const fileInputRef = useRef(null);

  const onPickFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    for (const f of files) {
      try {
        const path = `messages/group-${Date.now()}-${f.name}`;
        const uploaded = await upload(path, f, {
          access: 'public', handleUploadUrl: '/api/messages/upload-token',
          contentType: f.type || 'application/octet-stream',
        });
        setPendingFiles((p) => [...p, { url: uploaded.url, type: f.type, name: f.name }]);
      } catch (err) {
        window.alert(`Couldn't upload ${f.name}: ${err.message}`);
      }
    }
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    const trimmed = text.trim();
    if (!trimmed && pendingFiles.length === 0) return;
    if (sending) return;
    setSending(true);
    try {
      const r = await api.post('/messages/groups/' + encodeURIComponent(groupId) + '/messages',
        { text: trimmed, attachments: pendingFiles, parentMessageId: replyingTo?.id || null });
      setMessages((m) => [...m, r.message]);
      setText('');
      setPendingFiles([]);
      setReplyingTo(null);
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(err.message || 'Send failed.');
    } finally { setSending(false); }
  };

  const toggleReaction = async (msg, emoji) => {
    const existing = (msg.reactions || []).find((r) => r.emoji === emoji);
    const mine = !!existing?.mine;
    try {
      if (mine) {
        await api.del('/messages/groups/' + encodeURIComponent(groupId)
          + '/messages/' + encodeURIComponent(msg.id)
          + '/reactions?emoji=' + encodeURIComponent(emoji));
      } else {
        await api.post('/messages/groups/' + encodeURIComponent(groupId)
          + '/messages/' + encodeURIComponent(msg.id) + '/reactions', { emoji });
      }
      // Optimistic update.
      setMessages((arr) => arr.map((m) => {
        if (m.id !== msg.id) return m;
        const next = (m.reactions || []).filter((r) => r.emoji !== emoji);
        const newCount = (existing?.count || 0) + (mine ? -1 : 1);
        if (newCount > 0) next.push({ emoji, count: newCount, mine: !mine });
        return { ...m, reactions: next };
      }));
    } catch (err) {
      window.alert(err.message || 'Failed.');
    }
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
        ) : messages.map((m) => (
          <MessageBubble key={m.id} msg={m}
            parent={m.parentMessageId ? messages.find((x) => x.id === m.parentMessageId) : null}
            onReact={(emoji) => toggleReaction(m, emoji)}
            onReply={() => setReplyingTo(m)}
          />
        ))}
      </div>

      {replyingTo && (
        <div style={{
          padding: '8px 16px', background: 'var(--surface-2)',
          borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
        }}>
          <span style={{ color: 'var(--muted)' }}>Replying to</span>
          <span style={{ flex: 1, fontWeight: 500, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--fg)' }}>
            {(replyingTo.text || replyingTo.kind || '').slice(0, 80)}
          </span>
          <button onClick={() => setReplyingTo(null)}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', padding: 0 }}>
            <Icons.X size={14}/>
          </button>
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 12px',
          borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          {pendingFiles.map((f, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
              padding: '4px 8px', borderRadius: 6, background: 'var(--surface)',
              border: '1px solid var(--border)',
            }}>
              <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap' }}>{f.name}</span>
              <button onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: 0, color: 'var(--muted)' }}>
                <Icons.X size={12}/>
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submit} style={{
        padding: 12, borderTop: '1px solid var(--border)', background: 'var(--surface)',
        display: 'flex', gap: 8,
      }}>
        <input ref={fileInputRef} type="file" multiple hidden onChange={onPickFiles}
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"/>
        <button type="button" onClick={() => fileInputRef.current?.click()}
          title="Attach file"
          style={{ padding: '8px 10px', background: 'transparent',
            border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer' }}>
          <Icons.Plus size={14} sw={2}/>
        </button>
        <input value={text} onChange={(e) => setText(e.target.value)}
          placeholder={group.mode === 'broadcast' ? 'Announce to the group…' : 'Message the group…'}
          style={{ flex: 1, padding: '10px 12px', border: '1px solid var(--border)',
            borderRadius: 8, fontSize: 14, background: 'var(--surface)' }}/>
        <button type="submit" className="btn btn-primary"
          disabled={(!text.trim() && pendingFiles.length === 0) || sending}>
          {sending ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ msg, parent, onReact, onReply }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  if (msg.sender === 'system') {
    return (
      <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', margin: '8px 0' }}>
        {msg.text || msg.kind?.replace(/_/g, ' ')}
      </div>
    );
  }
  const fromBiz = msg.sender === 'biz';
  return (
    <div style={{ alignSelf: fromBiz ? 'flex-end' : 'flex-start', maxWidth: '78%' }}
      onMouseEnter={() => setPickerOpen(true)} onMouseLeave={() => setPickerOpen(false)}>
      {!fromBiz && msg.senderName && (
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 2, marginLeft: 4 }}>
          {msg.senderName}
        </div>
      )}
      {parent && (
        <div style={{ fontSize: 11, color: 'var(--muted)',
          borderLeft: '2px solid var(--border)', paddingLeft: 8, marginBottom: 4,
          maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          ↳ {(parent.text || parent.kind || '').slice(0, 80)}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <div style={{
          padding: '10px 14px', borderRadius: 14,
          background: fromBiz ? 'var(--accent)' : 'var(--surface-2)',
          color: fromBiz ? 'var(--surface)' : 'var(--fg)',
          fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap',
        }}>
          {renderTextWithMentions(msg.text, msg.mentions)}
          <AttachmentList attachments={msg.attachments} fromBiz={fromBiz}/>
        </div>
        {(onReact || onReply) && pickerOpen && (
          <div style={{
            position: 'absolute', top: -16,
            [fromBiz ? 'left' : 'right']: 0,
            display: 'flex', gap: 2, padding: 2, borderRadius: 999,
            background: 'var(--surface)', border: '1px solid var(--border)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)', fontSize: 14,
          }}>
            {QUICK_EMOJIS.map((e) => (
              <button key={e} onClick={() => onReact?.(e)} title={`React ${e}`}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '2px 4px', borderRadius: 8 }}>
                {e}
              </button>
            ))}
            {onReply && (
              <button onClick={onReply} title="Reply in thread"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '2px 6px', borderRadius: 8, fontSize: 11, color: 'var(--muted)' }}>
                ↩ Reply
              </button>
            )}
          </div>
        )}
      </div>
      {(msg.reactions || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4,
          justifyContent: fromBiz ? 'flex-end' : 'flex-start' }}>
          {msg.reactions.map((r) => (
            <button key={r.emoji} onClick={() => onReact?.(r.emoji)}
              style={{
                fontSize: 12, padding: '2px 8px', borderRadius: 999,
                border: r.mine ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: r.mine ? 'var(--accent-soft, rgba(0,0,0,0.05))' : 'var(--surface-2)',
                cursor: 'pointer',
              }}>
              {r.emoji} {r.count}
            </button>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3,
        textAlign: fromBiz ? 'right' : 'left' }}>
        {fmtTime(msg.createdAt)}
      </div>
    </div>
  );
}

// Render text with @mention chips highlighted. Mentions are pre-resolved
// by the backend — we just style any @Name token that matches a mention.
function AttachmentList({ attachments, fromBiz }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6,
      marginTop: attachments.length > 0 ? 8 : 0 }}>
      {attachments.map((a, i) => {
        if ((a.type || '').startsWith('image/')) {
          return (
            <a key={i} href={a.url} target="_blank" rel="noopener noreferrer"
              style={{ display: 'block' }}>
              <img src={a.url} alt={a.name || 'image'}
                style={{ maxWidth: 280, maxHeight: 280, borderRadius: 8, display: 'block' }}/>
            </a>
          );
        }
        return (
          <a key={i} href={a.url} target="_blank" rel="noopener noreferrer"
            download={a.name || true}
            style={{
              fontSize: 12, padding: '6px 10px', borderRadius: 8,
              background: fromBiz ? 'rgba(255,255,255,0.18)' : 'var(--surface)',
              color: 'inherit', textDecoration: 'none',
              border: '1px solid ' + (fromBiz ? 'rgba(255,255,255,0.18)' : 'var(--border)'),
              display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 280,
            }}>
            📎 <span style={{ overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap' }}>{a.name || 'Attachment'}</span>
          </a>
        );
      })}
    </div>
  );
}

function renderTextWithMentions(text, mentions) {
  if (!text) return text;
  const names = (mentions || []).map((m) => m.name).filter(Boolean);
  if (names.length === 0) return text;
  const parts = text.split(/(@[\w\-.]+)/g);
  return parts.map((p, i) => {
    if (!p.startsWith('@')) return p;
    const lower = p.slice(1).toLowerCase();
    const match = names.some((n) => {
      const first = String(n).toLowerCase().split(/\s+/)[0];
      return first === lower || String(n).toLowerCase().startsWith(lower);
    });
    return match
      ? <span key={i} style={{ fontWeight: 600, color: 'var(--accent)' }}>{p}</span>
      : p;
  });
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
  const [inviteUrl, setInviteUrl] = useState(null);
  const [mintingInvite, setMintingInvite] = useState(false);

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

  const mintInvite = async () => {
    setMintingInvite(true);
    try {
      const r = await api.post('/messages/groups/' + encodeURIComponent(groupId) + '/invites',
        { maxUses: 50, expiresInHours: 24 * 30 });
      setInviteUrl(r.invite.url);
    } catch (e) {
      setErr(e);
    } finally { setMintingInvite(false); }
  };
  const copyInvite = () => {
    if (!inviteUrl) return;
    navigator.clipboard?.writeText(inviteUrl);
  };

  return (
    <ModalShell title="Add members" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients…" style={inputStyle}/>
        <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)',
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

      <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em',
          textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
          Or share an invite link
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.4 }}>
          Anyone with this link who signs in (or signs up) becomes a member.
          Defaults: up to 50 uses, expires in 30 days.
        </div>
        {!inviteUrl ? (
          <button type="button" className="btn btn-outline" onClick={mintInvite} disabled={mintingInvite}>
            {mintingInvite ? 'Generating…' : 'Generate invite link'}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={inviteUrl} readOnly
              onFocus={(e) => e.target.select()}
              style={{ ...inputStyle, fontSize: 12 }}/>
            <button type="button" className="btn btn-primary" onClick={copyInvite}>Copy</button>
          </div>
        )}
      </div>
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
