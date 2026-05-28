// Client-portal cohort group chat UI. Lists groups this client is in
// across all the businesses they're a client of, with per-thread
// view/send/leave.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useViewport } from '../../lib/viewport.js';

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

function GroupView({ groupId, onBack, onLeave }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
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

  const submit = async (e) => {
    e?.preventDefault?.();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const r = await api.post('/me/groups/' + encodeURIComponent(groupId) + '/messages', { text: t });
      setData((d) => d ? ({ ...d, messages: [...d.messages, r.message] }) : d);
      setText('');
    } catch (err) {
      window.alert(err.message || 'Send failed.');
    } finally { setSending(false); }
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
          <MessageBubble key={m.id} msg={m} mine={m.senderClientId === myClientId}/>
        ))}
      </div>

      {canReply ? (
        <form onSubmit={submit} style={{
          padding: 12, borderTop: '1px solid var(--border)', background: 'var(--surface)',
          display: 'flex', gap: 8,
        }}>
          <input value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Message the group…"
            style={{ flex: 1, padding: '10px 12px', border: '1px solid var(--border)',
              borderRadius: 8, fontSize: 14, background: 'var(--surface)' }}/>
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending}>
            {sending ? '…' : 'Send'}
          </button>
        </form>
      ) : (
        <div style={{ padding: 14, borderTop: '1px solid var(--border)',
          background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 12.5, textAlign: 'center' }}>
          This group is announcements-only. You'll receive messages but can't reply here.
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg, mine }) {
  if (msg.sender === 'system') {
    return (
      <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', margin: '6px 0' }}>
        {msg.text || (msg.kind || '').replace(/_/g, ' ')}
      </div>
    );
  }
  const fromBiz = msg.sender === 'biz';
  return (
    <div style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '78%' }}>
      {!mine && (
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 2, marginLeft: 4 }}>
          {fromBiz ? 'Owner' : (msg.senderName || 'Member')}
        </div>
      )}
      <div style={{
        padding: '10px 14px', borderRadius: 14,
        background: mine ? 'var(--accent)' : 'var(--surface-2)',
        color: mine ? 'var(--surface)' : 'var(--fg)',
        fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap',
      }}>
        {msg.text}
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3,
        textAlign: mine ? 'right' : 'left' }}>
        {fmtTime(msg.createdAt)}
      </div>
    </div>
  );
}
