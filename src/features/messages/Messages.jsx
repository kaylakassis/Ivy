// Owner-side Messages: thread list (left) + conversation (right).
// Text-only for now. Attachments + doc-cards land in later phases.
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useThreads, useThread } from './state.js';
import { fmtTime, fmtTimestampHeader, computeTimestampPoints } from './utils.js';
import NewThreadModal from './NewThreadModal.jsx';

export default function Messages() {
  const { threads, loading, error, startThread, updateThread, setMode } = useThreads();
  const [selectedId, setSelectedId] = useState(null);
  const [newOpen, setNewOpen] = useState(false);

  // Auto-select the first thread when threads land.
  useEffect(() => {
    if (!selectedId && threads.length > 0) setSelectedId(threads[0].id);
  }, [threads, selectedId]);

  const existingClientIds = useMemo(
    () => new Set(threads.map((t) => t.clientId)),
    [threads],
  );

  const handlePickClient = async (clientId) => {
    const t = await startThread(clientId);
    setSelectedId(t.id);
    setNewOpen(false);
  };

  if (loading) {
    return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading messages…</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Chat" title="Couldn't load messages" hint={error.message || 'Try refreshing.'}/>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '320px 1fr',
      flex: 1, minHeight: 0,
      borderTop: '1px solid var(--border)',
    }}>
      {/* Thread list */}
      <div style={{
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        background: 'var(--surface)', minHeight: 0,
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Conversations</div>
          <button className="btn btn-ghost" style={{ padding: 6 }}
            onClick={() => setNewOpen(true)} title="New message">
            <Icons.Plus size={15} sw={2}/>
          </button>
        </div>
        <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
          {threads.length === 0 ? (
            <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
              No conversations yet.<br/>
              <button className="btn btn-outline" style={{ marginTop: 12 }} onClick={() => setNewOpen(true)}>
                <Icons.Plus size={13} sw={2}/> Start one
              </button>
            </div>
          ) : threads.map((t) => {
            const active = selectedId === t.id;
            return (
              <ThreadRow key={t.id} thread={t} active={active}
                onClick={() => setSelectedId(t.id)}/>
            );
          })}
        </div>
      </div>

      {/* Conversation */}
      <ConversationPane
        threadId={selectedId}
        onMarkRead={(id) => updateThread(id, { unreadBiz: 0 })}
        onSetMode={setMode}
      />

      {newOpen && (
        <NewThreadModal
          existingClientIds={existingClientIds}
          onPick={handlePickClient}
          onClose={() => setNewOpen(false)}
        />
      )}
    </div>
  );
}

function ThreadRow({ thread, active, onClick }) {
  const initials = (thread.clientName || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div onClick={onClick} style={{
      padding: '12px 16px', display: 'flex', gap: 12, cursor: 'pointer',
      background: active ? 'var(--surface-2)' : 'transparent',
      borderLeft: `3px solid ${active ? 'var(--accent)' : 'transparent'}`,
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, fontWeight: 600,
      }}>{initials}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontWeight: 600, fontSize: 13.5, flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {thread.clientName}
          </span>
          {thread.mode === 'one-way' && (
            <Icons.Mail size={11} stroke="var(--muted)" sw={1.8}/>
          )}
          <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
            {thread.lastMessageAt ? fmtTime(thread.lastMessageAt) : ''}
          </span>
        </div>
        <div style={{
          fontSize: 12.5,
          color: thread.unreadBiz > 0 ? 'var(--fg)' : 'var(--muted)',
          fontWeight: thread.unreadBiz > 0 ? 550 : 400,
          marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {thread.lastPreview || 'No messages yet'}
        </div>
      </div>
      {thread.unreadBiz > 0 && (
        <div style={{
          width: 18, height: 18, borderRadius: 99,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          fontSize: 10, fontWeight: 700, alignSelf: 'center',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{thread.unreadBiz}</div>
      )}
    </div>
  );
}

function ConversationPane({ threadId, onMarkRead, onSetMode }) {
  const { thread, messages, loading, error, send } = useThread(threadId);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  // Mark read in the parent's threads list once GET returns (server already did it).
  useEffect(() => {
    if (thread && thread.unreadBiz === 0) onMarkRead(thread.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  // Scroll to bottom whenever messages change.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  if (!threadId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
        <EmptyNote icon="Chat" title="No conversation selected" hint="Pick one from the left, or start a new one."/>
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading conversation…</div>;
  }
  if (error || !thread) {
    return (
      <div style={{ padding: 48 }}>
        <EmptyNote icon="Chat" title="Couldn't load this conversation" hint={error?.message || 'Pick a different thread.'}/>
      </div>
    );
  }

  const submit = async (e) => {
    e?.preventDefault?.();
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await send(text);
      setInput('');
    } finally {
      setSending(false);
    }
  };

  const tsPoints = computeTimestampPoints(messages);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 12, flexShrink: 0,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 600,
        }}>{(thread.clientName || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{thread.clientName}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{thread.clientEmail}</div>
        </div>
        {/* Per-thread mode */}
        <div style={{
          display: 'flex', gap: 2, padding: 3,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 8,
        }}>
          {[
            { id: 'two-way', label: 'Two-way' },
            { id: 'one-way', label: 'Broadcast' },
          ].map((m) => {
            const on = thread.mode === m.id;
            return (
              <button key={m.id} onClick={() => onSetMode(thread.id, m.id)}
                style={{
                  padding: '4px 10px', borderRadius: 6, border: 0,
                  fontSize: 11.5, fontWeight: 550, cursor: 'pointer',
                  background: on ? 'var(--surface)' : 'transparent',
                  color: on ? 'var(--fg)' : 'var(--muted)',
                  boxShadow: on ? 'var(--shadow-sm)' : 'none',
                  border: on ? '1px solid var(--border)' : '1px solid transparent',
                }}>
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="scroll" style={{
        flex: 1, overflowY: 'auto', padding: '20px 32px',
        background: 'var(--page)',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 40 }}>
            No messages yet. Say hello.
          </div>
        ) : messages.map((m, i) => (
          <React.Fragment key={m.id}>
            {tsPoints.has(i) && (
              <div style={{
                alignSelf: 'center', textAlign: 'center', fontSize: 10.5,
                color: 'var(--muted)', fontWeight: 500,
                margin: '14px 0 4px', lineHeight: 1.3,
              }}>
                {fmtTimestampHeader(m.createdAt)}
              </div>
            )}
            <Bubble message={m}/>
          </React.Fragment>
        ))}
      </div>

      {/* Composer */}
      <form onSubmit={submit} style={{
        padding: '14px 20px', borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
      }}>
        {thread.mode === 'one-way' && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icons.Mail size={11}/>
            Broadcast mode — clients can&apos;t reply to this thread.
          </div>
        )}
        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 8,
          padding: 6, borderRadius: 14,
          background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
        }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            placeholder="Write a message…"
            rows={1}
            style={{
              flex: 1, resize: 'none', minHeight: 32, maxHeight: 200,
              padding: '8px 10px', border: 0, outline: 'none',
              background: 'transparent', color: 'var(--fg)',
              fontSize: 14, fontFamily: 'inherit', lineHeight: 1.45,
            }}
          />
          <button className="btn btn-primary"
            type="submit" disabled={sending || !input.trim()}
            style={{ padding: '8px 14px', opacity: (sending || !input.trim()) ? 0.5 : 1 }}>
            {sending ? '…' : <Icons.Arrow size={14} sw={2.2}/>}
          </button>
        </div>
      </form>
    </div>
  );
}

function Bubble({ message }) {
  const mine = message.sender === 'biz';
  const isSystem = message.sender === 'system';

  if (isSystem) {
    return (
      <div style={{ alignSelf: 'center', fontSize: 11.5, color: 'var(--muted)', padding: '4px 12px' }}>
        {message.text}
      </div>
    );
  }

  return (
    <div style={{
      alignSelf: mine ? 'flex-end' : 'flex-start',
      maxWidth: '72%',
      padding: '9px 13px', borderRadius: 18,
      background: mine ? 'var(--accent)' : 'var(--surface)',
      color: mine ? 'var(--accent-ink)' : 'var(--fg)',
      border: mine ? 'none' : '1px solid var(--border)',
      fontSize: 14, lineHeight: 1.45,
      wordBreak: 'break-word', whiteSpace: 'pre-wrap',
    }}>
      {message.text}
    </div>
  );
}
