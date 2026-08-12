// Owner-side Messages: thread list (left) + conversation (right).
// Composer supports text, dictation (voice → text), and voice memos
// (recorded audio + automatic transcription, both saved on the message).
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useThreads, useThread } from './state.js';
import { fmtTime, fmtTimestampHeader, computeTimestampPoints } from './utils.js';
import NewThreadModal from './NewThreadModal.jsx';
import { useViewport } from '../../lib/viewport.js';
import { useDictation, useVoiceMemo } from '../../lib/speech.js';
import { upload } from '@vercel/blob/client';
import { AudioPlayer, RecordingBar, uploadVoiceMemo } from '../../components/AudioMessage.jsx';
import GroupChats from './GroupChats.jsx';

export default function Messages() {
  const [tab, setTab] = useState('direct'); // 'direct' | 'groups'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{
        display: 'flex', gap: 4, padding: '8px 16px',
        borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      }}>
        <TabButton active={tab === 'direct'} onClick={() => setTab('direct')}>Direct</TabButton>
        <TabButton active={tab === 'groups'} onClick={() => setTab('groups')}>Groups</TabButton>
      </div>
      {tab === 'direct' ? <DirectMessages/> : <GroupChats/>}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: 'transparent', border: 'none', cursor: 'pointer',
      padding: '8px 14px', fontSize: 13, fontWeight: 600,
      color: active ? 'var(--fg)' : 'var(--muted)',
      borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
      marginBottom: -9,
    }}>{children}</button>
  );
}

function DirectMessages() {
  const { threads, loading, error, startThread, updateThread, setMode } = useThreads();
  const [selectedId, setSelectedId] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const { isMobile } = useViewport();
  const location = useLocation();
  const navigate = useNavigate();

  // ?threadId=X selects a specific conversation (deep-link from
  // ClientDrawer's Message quick-action, push notifications, etc.)
  // Strips the param after consuming so a refresh doesn't fight the
  // user picking a different thread.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tid = params.get('threadId');
    if (!tid) return;
    setSelectedId(tid);
    params.delete('threadId');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // On desktop/tablet auto-select the first thread; on mobile show the list
  // first and let the user tap into a conversation.
  useEffect(() => {
    if (!isMobile && !selectedId && threads.length > 0) setSelectedId(threads[0].id);
  }, [threads, selectedId, isMobile]);

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

  // On mobile we show ONE pane at a time - list when nothing's selected,
  // conversation otherwise (with a back button rendered in ConversationPane).
  const showList = !isMobile || !selectedId;
  const showConversation = !isMobile || !!selectedId;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? '1fr' : '320px 1fr',
      flex: 1, minHeight: 0,
      borderTop: '1px solid var(--border)',
      // Clear the fixed bottom nav (~64px + safe area) - without this
      // the composer rendered UNDERNEATH it and Send was untappable on
      // phones (the app's most-used surface).
      paddingBottom: isMobile ? 'calc(env(safe-area-inset-bottom, 0px) + 72px)' : 0,
    }}>
      {/* Thread list */}
      {showList && <div style={{
        borderRight: isMobile ? 'none' : '1px solid var(--border)',
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
        <div className="scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
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
      </div>}

      {/* Conversation */}
      {showConversation && (
        <ConversationPane
          threadId={selectedId}
          onMarkRead={(id) => updateThread(id, { unreadBiz: 0 })}
          onSetMode={setMode}
          onBack={isMobile ? () => setSelectedId(null) : null}
        />
      )}

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

function ConversationPane({ threadId, onMarkRead, onSetMode, onBack }) {
  const { thread, messages, loading, error, send } = useThread(threadId);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceErr, setVoiceErr] = useState(null);
  const [smsMode, setSmsMode] = useState(false);
  const [smsNote, setSmsNote] = useState(null);
  const smsAvailable = !!(thread?.smsConsent && thread?.clientPhone);
  const scrollRef = useRef(null);
  const dictation = useDictation();
  const memo = useVoiceMemo();

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
    // Stop a running dictation first so its final transcript flushes
    // into the input. Without this, the user's last spoken phrase
    // sometimes gets cut.
    if (dictation.listening) dictation.stop();
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await send(text, undefined, smsMode ? 'sms' : undefined);
      setInput('');
      if (smsMode && r && r.smsSent === false) {
        setSmsNote(`Saved to chat, but the text wasn't sent (${r.smsReason || 'no phone/consent'}).`);
      } else { setSmsNote(null); }
    } catch (err) {
      // Surface send failures (offline / 5xx) instead of silently dropping
      // them. The input text is preserved so the user can retry.
      setSmsNote(err?.message || "Couldn't send — check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  const toggleDictation = () => {
    setVoiceErr(null);
    if (dictation.listening) {
      dictation.stop();
      return;
    }
    if (!dictation.supported) {
      setVoiceErr('Voice input not supported in this browser');
      return;
    }
    // Snapshot the existing input so the dictated transcript appends
    // rather than replaces - useful when the owner has already typed
    // a few words and just wants to dictate the rest.
    const prefix = input.trim() ? input.trim() + ' ' : '';
    dictation.start((transcript) => setInput(prefix + transcript));
  };

  // Voice memo recording: hold down or tap-to-toggle. We use tap-to-
  // toggle because press-and-hold is fiddly on touch devices and a
  // disorienting gesture for first-time users. Tap once to start, tap
  // Send to finish + send (or X to cancel).
  const startVoiceMemo = async () => {
    setVoiceErr(null);
    if (!memo.supported) {
      setVoiceErr('Recording not supported in this browser');
      return;
    }
    await memo.start();
  };

  const sendVoiceMemo = async () => {
    if (!memo.recording) return;
    setSending(true);
    try {
      const result = await memo.stop();
      if (!result || !result.blob || result.blob.size === 0) return;
      // Upload the audio blob directly to Vercel Blob storage; bypasses
      // the 4.5MB serverless body limit. The transcript travels as the
      // visible text so a recipient can read the message without
      // playback.
      const attachment = await uploadVoiceMemo(upload, result, 'voice');
      await send(result.transcript || '', [attachment]);
    } catch (err) {
      setVoiceErr(err.message || 'Could not send voice message');
    } finally {
      setSending(false);
    }
  };

  const cancelVoiceMemo = () => { memo.cancel(); setVoiceErr(null); };

  const tsPoints = computeTimestampPoints(messages);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        {onBack && (
          <button onClick={onBack} aria-label="Back to conversations"
            style={{
              padding: 6, borderRadius: 8, color: 'var(--muted)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <Icons.Arrow size={18} sw={2} style={{ transform: 'rotate(180deg)' }}/>
          </button>
        )}
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
                  padding: '4px 10px', borderRadius: 6,
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
        flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 32px',
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
            Broadcast mode - clients can&apos;t reply to this thread.
          </div>
        )}
        {voiceErr && (
          <div style={{
            fontSize: 11, color: 'var(--danger)', marginBottom: 8,
            padding: '6px 10px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          }}>{voiceErr}</div>
        )}
        {smsMode && smsAvailable && (
          <div style={{ fontSize: 11.5, color: 'var(--accent)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icons.Phone size={12}/> Replying by text to {thread.clientPhone}
          </div>
        )}
        {smsNote && (
          <div style={{ fontSize: 11, color: 'var(--warn)', marginBottom: 8 }}>{smsNote}</div>
        )}

        {memo.recording ? (
          <RecordingBar
            elapsedMs={memo.elapsedMs}
            transcript={memo.transcript}
            onSend={sendVoiceMemo}
            onCancel={cancelVoiceMemo}
            sending={sending}
          />
        ) : (
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
              placeholder={dictation.listening ? 'Listening…' : 'Write a message…'}
              rows={1}
              style={{
                flex: 1, resize: 'none', minHeight: 32, maxHeight: 200,
                padding: '8px 10px', border: 0, outline: 'none',
                background: 'transparent', color: 'var(--fg)',
                fontSize: 14, fontFamily: 'inherit', lineHeight: 1.45,
              }}
            />
            {/* Dictation: voice → text into the composer. Hidden when
                the browser doesn't expose Web Speech API. */}
            {dictation.supported && (
              <ComposerIconButton
                title={dictation.listening ? 'Stop dictating' : 'Dictate'}
                onClick={toggleDictation}
                pulse={dictation.listening}
                tone={dictation.listening ? 'accent' : 'muted'}
              >
                <DictationIcon active={dictation.listening}/>
              </ComposerIconButton>
            )}
            {/* Voice memo: records audio + transcribes simultaneously. */}
            {memo.supported && (
              <ComposerIconButton
                title="Record voice message"
                onClick={startVoiceMemo}
              >
                <MicIcon/>
              </ComposerIconButton>
            )}
            {/* Channel toggle: when the client has a phone + SMS consent,
                the owner can send this reply as a text (it still lands in
                the thread). */}
            {smsAvailable && (
              <ComposerIconButton
                title={smsMode ? 'Sending as text - tap for in-app' : 'Send as text message'}
                onClick={() => setSmsMode((v) => !v)}
                tone={smsMode ? 'accent' : 'muted'}
              >
                <Icons.Phone size={16}/>
              </ComposerIconButton>
            )}
            <button className="btn btn-primary"
              type="submit" disabled={sending || !input.trim()}
              title={smsMode ? 'Send as SMS' : 'Send'}
              style={{ padding: '8px 14px', opacity: (sending || !input.trim()) ? 0.5 : 1 }}>
              {sending ? '…' : <Icons.Arrow size={14} sw={2.2}/>}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function Bubble({ message }) {
  const mine = message.sender === 'biz';
  const isSystem = message.sender === 'system';
  const audioAtt = (message.attachments || []).find((a) => (a.type || '').startsWith('audio/'));

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
      maxWidth: '78%',
      padding: '9px 13px', borderRadius: 18,
      background: mine ? 'var(--accent)' : 'var(--surface)',
      color: mine ? 'var(--accent-ink)' : 'var(--fg)',
      border: mine ? 'none' : '1px solid var(--border)',
      fontSize: 14, lineHeight: 1.45,
      wordBreak: 'break-word', whiteSpace: 'pre-wrap',
    }}>
      {audioAtt && <AudioPlayer url={audioAtt.url} mine={mine} durationMs={audioAtt.durationMs}/>}
      {message.text && (
        <div style={{
          marginTop: audioAtt ? 6 : 0,
          fontSize: audioAtt ? 13 : 14,
          opacity: audioAtt ? 0.92 : 1,
        }}>
          {message.text}
        </div>
      )}
      {message.meta?.channel === 'sms' && (
        <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 3 }}>
          <Icons.Phone size={9}/> SMS
        </div>
      )}
    </div>
  );
}


// ── Composer helpers ──────────────────────────────────────────────

function ComposerIconButton({ children, title, onClick, pulse, tone }) {
  const accent = tone === "accent";
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        flex: "0 0 auto",
        width: 38, height: 38, borderRadius: 999,
        border: "1px solid " + (accent ? "var(--accent)" : "var(--border)"),
        background: accent ? "var(--accent-soft)" : "var(--surface)",
        color: accent ? "var(--accent)" : "var(--fg-2)",
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer",
        transition: "background .12s, border-color .12s",
        animation: pulse ? "msg-mic-pulse 1.4s ease-in-out infinite" : undefined,
      }}
    >
      {children}
    </button>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3"/>
      <path d="M5 11a7 7 0 0 0 14 0"/>
      <path d="M12 18v3"/>
    </svg>
  );
}

function DictationIcon({ active }) {
  return (
    <svg width="18" height="16" viewBox="0 0 24 18" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round">
      <path d="M3 9h2"/>
      <path d="M7 5v8" opacity={active ? "1" : "0.85"}/>
      <path d="M11 2v14"/>
      <path d="M15 5v8" opacity={active ? "1" : "0.85"}/>
      <path d="M19 9h2"/>
    </svg>
  );
}

// RecordingBar + AudioPlayer come from ../../components/AudioMessage.jsx;
// MicButton lives there too but this file wraps its own ComposerIconButton
// (with dictation pulse styling) so we keep the inline MicIcon for that.
