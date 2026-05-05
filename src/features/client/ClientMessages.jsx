// /me/messages — client side of native chat. Mirrors the owner's Messages
// view but inverted: the client is the user, the business is the "other"
// participant. Two-pane on desktop/tablet, single-pane on mobile.
//
// Lives on its own state hooks (no shared store with the owner Messages
// because of different endpoints + different unread accounting).
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { useViewport } from '../../lib/viewport.js';
import { api } from '../../lib/api.js';
import { useClientPortal } from './clientContext.jsx';

function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const days = Math.floor((now - d) / 86400e3);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Hash-stable accent palette so each business gets the same coloured avatar
// chip every time, matching how Discover renders its banners. Keeps the
// portal feeling like one design language across pages.
const AVATAR_PALETTE = ['#C8D8FF', '#FFD1DC', '#D0E8D0', '#FFE3B0', '#E0D4F7', '#CDEBF0'];
function avatarBg(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

export default function ClientMessages() {
  const { isMobile } = useViewport();
  const { data: ctx } = useClientPortal();
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  // Deep link: ClientHome's "Message" buttons pass ?clientId=<id> so
  // we can auto-select the right thread (or create one) on landing.
  const [searchParams, setSearchParams] = useSearchParams();

  const refreshThreads = useCallback(async () => {
    const r = await api.get('/me/threads');
    setThreads(r.threads || []);
    return r.threads;
  }, []);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    api.get('/me/threads')
      .then((r) => {
        if (!live) return;
        setThreads(r.threads || []);
        if (!isMobile && r.threads?.length > 0) setSelectedId(r.threads[0].id);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [isMobile, reloadKey]);

  // Auto-create a thread for any business membership that doesn't have one
  // yet, so the client can send the first message.
  const startThreadFor = useCallback(async (clientId) => {
    const r = await api.post('/me/threads', { clientId });
    setThreads((xs) => {
      const existing = xs.find((t) => t.id === r.thread.id);
      return existing ? xs : [r.thread, ...xs];
    });
    setSelectedId(r.thread.id);
  }, []);

  // Deep-link consumer: when ClientHome sends us here with ?clientId=<id>,
  // open the matching thread (or create one) and strip the param so a
  // refresh doesn't re-trigger.
  const consumedRef = useRef(false);
  useEffect(() => {
    if (consumedRef.current) return;
    if (loading) return;
    const cid = searchParams.get('clientId');
    if (!cid) return;
    consumedRef.current = true;
    const existing = threads.find((t) => t.clientId === cid);
    if (existing) {
      setSelectedId(existing.id);
    } else if ((ctx?.memberships || []).some((m) => m.clientId === cid)) {
      startThreadFor(cid).catch(() => {});
    }
    const next = new URLSearchParams(searchParams);
    next.delete('clientId');
    setSearchParams(next, { replace: true });
  }, [loading, threads, searchParams, ctx, startThreadFor, setSearchParams]);

  if (loading) return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SkelRowList rows={5} withAvatar/>
    </div>
  );
  if (error) return (
    <div style={{ padding: 48 }}>
      <div className="card" style={{ padding: 40 }}>
        <EmptyNote icon="Chat" title="Couldn't load messages"
          hint={error.message || 'Try refreshing.'}
          action={<button className="btn btn-outline" onClick={() => setReloadKey((n) => n + 1)}>Retry</button>}/>
      </div>
    </div>
  );

  // Memberships without an existing thread → render at the bottom of the
  // list as "Start a chat with X" entries so users can initiate.
  const threadedClientIds = new Set(threads.map((t) => t.clientId));
  const newableMemberships = (ctx?.memberships || []).filter((m) => !threadedClientIds.has(m.clientId));

  const showList = !isMobile || !selectedId;
  const showConversation = !isMobile || !!selectedId;

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
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
            Conversations
          </div>
          <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
            {threads.length === 0 && newableMemberships.length === 0 ? (
              <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
                No conversations yet.
                <br/>Once a business adds you or you book with one, they'll show up here.
              </div>
            ) : (
              <>
                {threads.map((t) => (
                  <ThreadRow key={t.id} thread={t} active={selectedId === t.id}
                    onClick={() => setSelectedId(t.id)}/>
                ))}
                {newableMemberships.length > 0 && (
                  <>
                    {threads.length > 0 && (
                      <div style={{ padding: '14px 16px 6px', fontSize: 10.5,
                        color: 'var(--muted)', fontWeight: 600,
                        textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Start new
                      </div>
                    )}
                    {newableMemberships.map((m) => (
                      <button key={m.clientId} onClick={() => startThreadFor(m.clientId)}
                        style={{
                          display: 'flex', width: '100%', alignItems: 'center', gap: 10,
                          padding: '12px 16px', borderTop: '1px solid var(--border)',
                          background: 'transparent', textAlign: 'left',
                        }}>
                        <Icons.Plus size={14} sw={2} stroke="var(--muted)"/>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--fg)' }}>
                            Message {m.businessName}
                          </div>
                        </div>
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {showConversation && (
        <ConversationPane threadId={selectedId}
          onUpdated={refreshThreads}
          onBack={isMobile ? () => setSelectedId(null) : null}/>
      )}
    </div>
  );
}

function ThreadRow({ thread, active, onClick }) {
  const initial = (thread.businessName || '?').trim()[0]?.toUpperCase() || '?';
  return (
    <button onClick={onClick} style={{
      display: 'flex', width: '100%', alignItems: 'center', gap: 12,
      padding: '14px 16px', textAlign: 'left',
      background: active ? 'var(--surface-2)' : 'transparent',
      borderBottom: '1px solid var(--border)', cursor: 'pointer',
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
        background: avatarBg(thread.clientId || thread.businessName),
        color: '#333',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 17,
      }}>{initial}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {thread.businessName}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>
            {thread.lastMessageAt ? fmtTime(thread.lastMessageAt) : ''}
          </span>
        </div>
        <div style={{
          fontSize: 12, marginTop: 2, color: thread.unreadClient > 0 ? 'var(--fg)' : 'var(--muted)',
          fontWeight: thread.unreadClient > 0 ? 550 : 400,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {thread.lastPreview || 'No messages yet'}
        </div>
      </div>
      {thread.unreadClient > 0 && (
        <div style={{
          minWidth: 18, height: 18, padding: '0 5px', borderRadius: 99,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10.5, fontWeight: 700,
        }}>{thread.unreadClient}</div>
      )}
    </button>
  );
}

function ConversationPane({ threadId, onUpdated, onBack }) {
  const [thread, setThread]     = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [input, setInput]       = useState('');
  const [sending, setSending]   = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!threadId) return;
    let live = true;
    setLoading(true);
    setError(null);
    api.get('/me/threads/' + threadId)
      .then((r) => {
        if (!live) return;
        setThread(r.thread);
        setMessages(r.messages || []);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [threadId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  if (!threadId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
        <EmptyNote icon="Chat" title="No conversation selected" hint="Pick one from the left."/>
      </div>
    );
  }
  if (loading) {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SkelRowList rows={6} withAvatar height={48}/>
      </div>
    );
  }
  if (error || !thread) {
    return (
      <div style={{ padding: 48 }}>
        <EmptyNote icon="Chat" title="Couldn't load this conversation" hint={error?.message || ''}/>
      </div>
    );
  }

  const submit = async (e) => {
    e?.preventDefault?.();
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await api.post('/me/threads/' + threadId, { text });
      setMessages((m) => [...m, r.message]);
      setInput('');
      onUpdated?.();
    } finally { setSending(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12 }}>
        {onBack && (
          <button onClick={onBack} aria-label="Back"
            style={{ padding: 6, borderRadius: 8, color: 'var(--muted)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icons.Arrow size={18} sw={2} style={{ transform: 'rotate(180deg)' }}/>
          </button>
        )}
        <div style={{
          width: 38, height: 38, borderRadius: 12, flexShrink: 0,
          background: avatarBg(thread.clientId || thread.businessName),
          color: '#333',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 17,
        }}>{(thread.businessName || '?').trim()[0]?.toUpperCase() || '?'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{thread.businessName}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {thread.mode === 'one-way' ? 'Announcements only — replies disabled' : 'Direct chat'}
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '20px 32px',
        background: 'var(--page)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 40 }}>
            No messages yet. Say hello to {thread.businessName}.
          </div>
        ) : messages.map((m) => <Bubble key={m.id} msg={m}/>)}
      </div>

      <form onSubmit={submit} style={{ padding: '14px 20px', borderTop: '1px solid var(--border)',
        background: 'var(--surface)' }}>
        {thread.mode === 'one-way' ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: 6 }}>
            This business has set replies off. Reach out via their booking link instead.
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8,
            padding: 6, borderRadius: 14,
            background: 'var(--surface-2)', border: '1px solid var(--border-strong)' }}>
            <textarea value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder="Write a message…" rows={1}
              style={{ flex: 1, resize: 'none', minHeight: 32, maxHeight: 200,
                padding: '8px 10px', border: 0, outline: 'none',
                background: 'transparent', color: 'var(--fg)',
                fontSize: 14, fontFamily: 'inherit', lineHeight: 1.45 }}/>
            <button type="submit" className="btn btn-primary" disabled={sending || !input.trim()}
              style={{ padding: '8px 14px', opacity: (sending || !input.trim()) ? 0.5 : 1 }}>
              {sending ? '…' : <Icons.Arrow size={14} sw={2.2}/>}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function Bubble({ msg }) {
  // From the client's perspective: their own messages are 'mine' (right-side,
  // accent), the biz's messages are 'theirs' (left-side, neutral).
  const mine = msg.sender === 'client';
  if (msg.sender === 'system') {
    return (
      <div style={{ alignSelf: 'center', fontSize: 11.5, color: 'var(--muted)', padding: '4px 12px' }}>
        {msg.text}
      </div>
    );
  }
  return (
    <div style={{
      alignSelf: mine ? 'flex-end' : 'flex-start',
      maxWidth: '72%', padding: '9px 13px', borderRadius: 18,
      background: mine ? 'var(--accent)' : 'var(--surface)',
      color: mine ? 'var(--accent-ink)' : 'var(--fg)',
      border: mine ? 'none' : '1px solid var(--border)',
      fontSize: 14, lineHeight: 1.45,
      wordBreak: 'break-word', whiteSpace: 'pre-wrap',
    }}>{msg.text}</div>
  );
}
