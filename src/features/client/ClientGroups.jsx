// Client-portal cohort group chat UI. Lists groups this client is in
// across all the businesses they're a client of, with per-thread
// view/send/leave.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useViewport } from '../../lib/viewport.js';
import { upload } from '@vercel/blob/client';

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function ClientGroups() {
  const { isMobile } = useViewport();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const refresh = useCallback(async () => {
    try { const r = await api.get('/me/groups'); setGroups(r.groups || []); }
    catch (e) { setError(e); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!isMobile && !selectedId && groups.length > 0) setSelectedId(groups[0].id);
  }, [groups, selectedId, isMobile]);

  const selected = useMemo(() => groups.find((g) => g.id === selectedId) || null, [groups, selectedId]);
  const showList = !isMobile || !selectedId;
  const showThread = !isMobile || !!selectedId;

  if (loading) return <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (error) return (
    <div style={{ padding: 20 }}>
      <EmptyNote icon="Chat" title="Couldn't load groups" hint={error.message || 'Try refreshing.'}/>
    </div>
  );

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '300px 1fr',
      flex: 1, minHeight: 0,
    }}>
      {showList && (
        <div style={{
          borderRight: isMobile ? 'none' : '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--surface)',
        }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)',
            fontSize: 13, fontWeight: 600 }}>Groups</div>
          <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
            {groups.length === 0 ? (
              <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
                You're not in any groups yet.
              </div>
            ) : groups.map((g) => (
              <button key={g.id} onClick={() => setSelectedId(g.id)} style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '12px 16px',
                background: g.id === selectedId ? 'var(--surface-2)' : 'transparent',
                border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 13.5, fontWeight: 600, minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {g.name}
                  </div>
                  {g.unreadClient > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--surface)',
                      background: 'var(--accent)', borderRadius: 999, padding: '2px 7px' }}>
                      {g.unreadClient}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {g.businessName}
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
          <GroupView
            key={selected.id}
            groupId={selected.id}
            onBack={() => isMobile && setSelectedId(null)}
            onLeave={async () => {
              if (!window.confirm('Leave this group?')) return;
              await api.post('/me/groups/' + encodeURIComponent(selected.id) + '/leave', {});
              setSelectedId(null);
              refresh();
            }}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--muted)', fontSize: 13 }}>Select a group.</div>
        )
      )}
    </div>
  );
}

const QUICK_EMOJIS = ['👍', '❤️', '🎉', '🔥', '😂', '👀'];

function GroupView({ groupId, onBack, onLeave }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const scrollRef = useRef(null);
  const { isMobile } = useViewport();

  const refresh = useCallback(async () => {
    const r = await api.get('/me/groups/' + encodeURIComponent(groupId));
    setData(r);
  }, [groupId]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => { refresh().catch(() => {}); }, 15000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data?.messages?.length]);

  const [pendingFiles, setPendingFiles] = useState([]);
  const fileInputRef = useRef(null);

  const onPickFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      try {
        const path = `messages/cg-${Date.now()}-${f.name}`;
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
    const t = text.trim();
    if ((!t && pendingFiles.length === 0) || sending) return;
    setSending(true);
    try {
      const r = await api.post('/me/groups/' + encodeURIComponent(groupId) + '/messages',
        { text: t, attachments: pendingFiles, parentMessageId: replyingTo?.id || null });
      setData((d) => d ? ({ ...d, messages: [...d.messages, r.message] }) : d);
      setText('');
      setPendingFiles([]);
      setReplyingTo(null);
    } catch (err) {
      window.alert(err.message || 'Send failed.');
    } finally { setSending(false); }
  };

  const toggleReaction = async (msg, emoji) => {
    const existing = (msg.reactions || []).find((r) => r.emoji === emoji);
    const mine = !!existing?.mine;
    try {
      if (mine) {
        await api.del('/me/groups/' + encodeURIComponent(groupId)
          + '/messages/' + encodeURIComponent(msg.id)
          + '/reactions?emoji=' + encodeURIComponent(emoji));
      } else {
        await api.post('/me/groups/' + encodeURIComponent(groupId)
          + '/messages/' + encodeURIComponent(msg.id) + '/reactions', { emoji });
      }
      setData((d) => d ? ({
        ...d,
        messages: d.messages.map((m) => {
          if (m.id !== msg.id) return m;
          const next = (m.reactions || []).filter((r) => r.emoji !== emoji);
          const newCount = (existing?.count || 0) + (mine ? -1 : 1);
          if (newCount > 0) next.push({ emoji, count: newCount, mine: !mine });
          return { ...m, reactions: next };
        }),
      }) : d);
    } catch (err) {
      window.alert(err.message || 'Failed.');
    }
  };

  if (!data) return <div style={{ flex: 1, padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const { group, messages, members, canReply, myClientId } = data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
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
          <div style={{ fontSize: 14, fontWeight: 600 }}>{group.name}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            {group.mode === 'broadcast'
              ? 'Announcements only'
              : (members.length > 0 ? `${members.length} member${members.length === 1 ? '' : 's'}` : 'Group')}
          </div>
        </div>
        <button className="btn btn-ghost" onClick={onLeave}
          style={{ padding: '6px 10px', fontSize: 12, color: 'var(--danger)' }}>
          Leave
        </button>
      </div>

      <div ref={scrollRef} className="scroll"
        style={{ flex: 1, overflowY: 'auto', padding: '16px 20px',
          display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 ? (
          <EmptyNote icon="Chat" title="No messages yet" hint=""/>
        ) : messages.map((m) => (
          <MessageBubble key={m.id} msg={m} mine={m.senderClientId === myClientId}
            parent={m.parentMessageId ? messages.find((x) => x.id === m.parentMessageId) : null}
            onReact={canReply ? (e) => toggleReaction(m, e) : null}
            onReply={canReply ? () => setReplyingTo(m) : null}/>
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

      {canReply ? (
        <>
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
              placeholder="Message the group…"
              style={{ flex: 1, padding: '10px 12px', border: '1px solid var(--border)',
                borderRadius: 8, fontSize: 14, background: 'var(--surface)' }}/>
            <button type="submit" className="btn btn-primary"
              disabled={(!text.trim() && pendingFiles.length === 0) || sending}>
              {sending ? '…' : 'Send'}
            </button>
          </form>
        </>
      ) : (
        <div style={{ padding: 14, borderTop: '1px solid var(--border)',
          background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 12.5, textAlign: 'center' }}>
          This group is announcements-only. You'll receive messages but can't reply here.
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg, mine, parent, onReact, onReply }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  if (msg.sender === 'system') {
    return (
      <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', margin: '6px 0' }}>
        {msg.text || (msg.kind || '').replace(/_/g, ' ')}
      </div>
    );
  }
  const fromBiz = msg.sender === 'biz';
  return (
    <div style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '78%' }}
      onMouseEnter={() => setPickerOpen(true)} onMouseLeave={() => setPickerOpen(false)}>
      {!mine && (
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 2, marginLeft: 4 }}>
          {fromBiz ? 'Owner' : (msg.senderName || 'Member')}
        </div>
      )}
      {parent && (
        <div style={{ fontSize: 11, color: 'var(--muted)',
          borderLeft: '2px solid var(--border)', paddingLeft: 8, marginBottom: 4,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          ↳ {(parent.text || parent.kind || '').slice(0, 80)}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <div style={{
          padding: '10px 14px', borderRadius: 14,
          background: mine ? 'var(--accent)' : 'var(--surface-2)',
          color: mine ? 'var(--surface)' : 'var(--fg)',
          fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap',
        }}>
          {renderMentions(msg.text, msg.mentions)}
          {(msg.attachments || []).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {msg.attachments.map((a, i) => {
                if ((a.type || '').startsWith('image/')) {
                  return (
                    <a key={i} href={a.url} target="_blank" rel="noopener noreferrer">
                      <img src={a.url} alt={a.name || 'image'}
                        style={{ maxWidth: 260, maxHeight: 260, borderRadius: 8, display: 'block' }}/>
                    </a>
                  );
                }
                return (
                  <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" download={a.name || true}
                    style={{ fontSize: 12, padding: '6px 10px', borderRadius: 8,
                      background: mine ? 'rgba(255,255,255,0.18)' : 'var(--surface)',
                      border: '1px solid ' + (mine ? 'rgba(255,255,255,0.18)' : 'var(--border)'),
                      color: 'inherit', textDecoration: 'none',
                      display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 260 }}>
                    📎 <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.name || 'Attachment'}
                    </span>
                  </a>
                );
              })}
            </div>
          )}
        </div>
        {(onReact || onReply) && pickerOpen && (
          <div style={{
            position: 'absolute', top: -16,
            [mine ? 'left' : 'right']: 0,
            display: 'flex', gap: 2, padding: 2, borderRadius: 999,
            background: 'var(--surface)', border: '1px solid var(--border)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)', fontSize: 14,
          }}>
            {onReact && QUICK_EMOJIS.map((e) => (
              <button key={e} onClick={() => onReact?.(e)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '2px 4px', borderRadius: 8 }}>{e}</button>
            ))}
            {onReply && (
              <button onClick={onReply} title="Reply"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '2px 6px', borderRadius: 8, fontSize: 11, color: 'var(--muted)' }}>
                ↩
              </button>
            )}
          </div>
        )}
      </div>
      {(msg.reactions || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4,
          justifyContent: mine ? 'flex-end' : 'flex-start' }}>
          {msg.reactions.map((r) => (
            <button key={r.emoji} onClick={() => onReact?.(r.emoji)}
              disabled={!onReact}
              style={{
                fontSize: 12, padding: '2px 8px', borderRadius: 999,
                border: r.mine ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: r.mine ? 'var(--accent-soft, rgba(0,0,0,0.05))' : 'var(--surface-2)',
                cursor: onReact ? 'pointer' : 'default',
              }}>
              {r.emoji} {r.count}
            </button>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3,
        textAlign: mine ? 'right' : 'left' }}>
        {fmtTime(msg.createdAt)}
      </div>
    </div>
  );
}

function renderMentions(text, mentions) {
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
