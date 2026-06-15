// Client portal direct messages. List of 1:1 conversations with other
// clients in groups you share. Each conversation has block / mute / leave /
// report actions.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useViewport } from '../../lib/viewport.js';
import { upload } from '@vercel/blob/client';
import { useVoiceMemo } from '../../lib/speech.js';
import {
  AudioPlayer, RecordingBar, MicButton, isAudioAttachment, uploadVoiceMemo,
} from '../../components/AudioMessage.jsx';

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function ClientDms() {
  const { isMobile } = useViewport();
  const [dms, setDms]         = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [err, setErr]         = useState(null);

  const refresh = useCallback(async () => {
    try { const r = await api.get('/me/dms'); setDms(r.dms || []); }
    catch (e) { setErr(e); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!isMobile && !selectedId && dms.length > 0) setSelectedId(dms[0].id);
  }, [dms, selectedId, isMobile]);

  const selected = dms.find((d) => d.id === selectedId) || null;
  const showList = !isMobile || !selectedId;
  const showThread = !isMobile || !!selectedId;

  if (loading) return <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (err) return (
    <div style={{ padding: 20 }}>
      <EmptyNote icon="Chat" title="Couldn't load DMs" hint={err.message || 'Try refreshing.'}/>
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
          display: 'flex', flexDirection: 'column', background: 'var(--surface)', minHeight: 0,
        }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)',
            fontSize: 13, fontWeight: 600 }}>
            Direct messages
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontWeight: 400 }}>
              With people you share a group with.
            </div>
          </div>
          <div className="scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {dms.length === 0 ? (
              <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
                No DMs yet. Start one from a group's member list.
              </div>
            ) : dms.map((d) => (
              <button key={d.id} onClick={() => setSelectedId(d.id)} style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '12px 16px',
                background: d.id === selectedId ? 'var(--surface-2)' : 'transparent',
                border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 13.5, fontWeight: 600, minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {d.otherClientName || d.otherClientEmail || 'Unnamed'}
                  </div>
                  {d.unread > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--surface)',
                      background: 'var(--accent)', borderRadius: 999, padding: '2px 7px' }}>
                      {d.unread}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {d.mutedByMe && '🔕 '}
                  {d.blockedByMe && '🚫 '}
                  {d.lastPreview || '—'}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      {showThread && (
        selected ? (
          <DmView
            key={selected.id}
            dmId={selected.id}
            onBack={() => isMobile && setSelectedId(null)}
            onChanged={refresh}
            onLeave={async () => {
              if (!window.confirm('Hide this conversation? You can come back if they message you again.')) return;
              await api.del('/me/dms/' + encodeURIComponent(selected.id));
              setSelectedId(null);
              refresh();
            }}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--muted)', fontSize: 13 }}>Select a conversation.</div>
        )
      )}
    </div>
  );
}

function DmView({ dmId, onBack, onChanged, onLeave }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [replyingTo, setReplyingTo] = useState(null);
  const [voiceErr, setVoiceErr] = useState(null);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  const { isMobile } = useViewport();
  const memo = useVoiceMemo();

  const refresh = useCallback(async () => {
    const r = await api.get('/me/dms/' + encodeURIComponent(dmId));
    setData(r);
  }, [dmId]);
  useEffect(() => { refresh(); }, [refresh]);

  // Smart polling.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      try { await refresh(); } catch { /* ignore */ }
      if (cancelled) return;
      const v = document.visibilityState === 'visible' && document.hasFocus();
      timer = setTimeout(tick, v ? 2000 : 30000);
    };
    timer = setTimeout(tick, 2000);
    const onVis = () => { if (timer) clearTimeout(timer); tick(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    window.addEventListener('blur', onVis);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      window.removeEventListener('blur', onVis);
    };
  }, [refresh]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data?.messages?.length]);

  const onPickFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      try {
        const path = `messages/dm-${Date.now()}-${f.name}`;
        const uploaded = await upload(path, f, {
          access: 'public', handleUploadUrl: '/api/messages/upload-token',
          contentType: f.type || 'application/octet-stream',
        });
        setPendingFiles((p) => [...p, { url: uploaded.url, type: f.type, name: f.name }]);
      } catch (err) { window.alert(`Couldn't upload ${f.name}: ${err.message}`); }
    }
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    const t = text.trim();
    if ((!t && pendingFiles.length === 0) || sending) return;
    setSending(true);
    try {
      const r = await api.post('/me/dms/' + encodeURIComponent(dmId) + '/messages',
        { text: t, attachments: pendingFiles, parentMessageId: replyingTo?.id || null });
      setData((d) => d ? ({ ...d, messages: [...d.messages, r.message] }) : d);
      setText(''); setPendingFiles([]); setReplyingTo(null);
    } catch (err) {
      window.alert(err.message || 'Send failed.');
    } finally { setSending(false); }
  };

  const startVoiceMemo = async () => {
    setVoiceErr(null);
    if (!memo.supported) { setVoiceErr('Recording not supported in this browser'); return; }
    await memo.start();
  };
  const cancelVoiceMemo = () => { memo.cancel(); setVoiceErr(null); };
  const sendVoiceMemo = async () => {
    if (!memo.recording) return;
    setSending(true);
    try {
      const result = await memo.stop();
      if (!result || !result.blob || result.blob.size === 0) return;
      const attachment = await uploadVoiceMemo(upload, result, 'dm-voice');
      const r = await api.post('/me/dms/' + encodeURIComponent(dmId) + '/messages', {
        text: result.transcript || '',
        attachments: [attachment],
        parentMessageId: replyingTo?.id || null,
      });
      setData((d) => d ? ({ ...d, messages: [...d.messages, r.message] }) : d);
      setReplyingTo(null);
    } catch (err) {
      setVoiceErr(err.message || 'Could not send voice message');
    } finally { setSending(false); }
  };

  const toggleBlock = async () => {
    try {
      if (data.dm.blockedByMe) await api.del('/me/dms/' + encodeURIComponent(dmId) + '/block');
      else await api.post('/me/dms/' + encodeURIComponent(dmId) + '/block', {});
      await refresh(); onChanged?.();
    } catch (e) { window.alert(e.message || 'Failed.'); }
  };
  const toggleMute = async () => {
    try {
      if (data.dm.mutedByMe) await api.del('/me/dms/' + encodeURIComponent(dmId) + '/mute');
      else await api.post('/me/dms/' + encodeURIComponent(dmId) + '/mute', {});
      await refresh(); onChanged?.();
    } catch (e) { window.alert(e.message || 'Failed.'); }
  };

  const reportMessage = async (msg) => {
    const reason = window.prompt('What\'s the issue? (optional)') ?? '';
    try {
      await api.post('/me/dms/' + encodeURIComponent(dmId)
        + '/messages/' + encodeURIComponent(msg.id) + '/report', { reason });
      window.alert('Reported. Our team will review.');
      await refresh();
    } catch (e) { window.alert(e.message || 'Could not report.'); }
  };

  if (!data) return <div style={{ flex: 1, padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const { dm, messages } = data;
  const blocked = dm.blockedByMe;

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
          <div style={{ fontSize: 14, fontWeight: 600 }}>{dm.otherClientName || dm.otherClientEmail}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            {dm.mutedByMe && '🔕 Muted · '}{dm.blockedByMe && '🚫 Blocked · '}Direct message
          </div>
        </div>
        <button className="btn btn-ghost" onClick={toggleMute} style={{ padding: '6px 10px', fontSize: 12 }}>
          {dm.mutedByMe ? 'Unmute' : 'Mute'}
        </button>
        <button className="btn btn-ghost" onClick={toggleBlock} style={{ padding: '6px 10px', fontSize: 12 }}>
          {dm.blockedByMe ? 'Unblock' : 'Block'}
        </button>
        <button className="btn btn-ghost" onClick={onLeave}
          style={{ padding: '6px 10px', fontSize: 12, color: 'var(--danger)' }}>
          Hide
        </button>
      </div>

      <div ref={scrollRef} className="scroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px',
          display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 ? (
          <EmptyNote icon="Chat" title="No messages yet" hint=""/>
        ) : messages.map((m) => (
          <DmBubble key={m.id} msg={m}
            parent={m.parentMessageId ? messages.find((x) => x.id === m.parentMessageId) : null}
            onReply={() => setReplyingTo(m)}
            onReport={() => reportMessage(m)}
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
            {(replyingTo.text || '').slice(0, 80)}
          </span>
          <button onClick={() => setReplyingTo(null)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--muted)', padding: 0 }}>
            <Icons.X size={14}/>
          </button>
        </div>
      )}

      {blocked ? (
        <div style={{ padding: 14, borderTop: '1px solid var(--border)',
          background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 12.5, textAlign: 'center' }}>
          You've blocked this person. Their new messages won't reach you, and you can't send theirs. Unblock to resume.
        </div>
      ) : (
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
          {voiceErr && (
            <div style={{
              fontSize: 11, color: 'var(--danger)', padding: '6px 14px',
              borderTop: '1px solid var(--border)',
              background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
            }}>{voiceErr}</div>
          )}
          {memo.recording ? (
            <div style={{ padding: 12, borderTop: '1px solid var(--border)',
              background: 'var(--surface)' }}>
              <RecordingBar
                elapsedMs={memo.elapsedMs}
                transcript={memo.transcript}
                onSend={sendVoiceMemo}
                onCancel={cancelVoiceMemo}
                sending={sending}/>
            </div>
          ) : (
            <form onSubmit={submit} style={{
              padding: 12, borderTop: '1px solid var(--border)', background: 'var(--surface)',
              display: 'flex', gap: 8, alignItems: 'center',
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
                placeholder="Type a message…"
                style={{ flex: 1, padding: '10px 12px', border: '1px solid var(--border)',
                  borderRadius: 8, fontSize: 14, background: 'var(--surface)' }}/>
              {memo.supported && (
                <MicButton onClick={startVoiceMemo} disabled={sending}/>
              )}
              <button type="submit" className="btn btn-primary"
                disabled={(!text.trim() && pendingFiles.length === 0) || sending}>
                {sending ? '…' : 'Send'}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function DmBubble({ msg, parent, onReply, onReport }) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ alignSelf: msg.mine ? 'flex-end' : 'flex-start', maxWidth: '78%' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {parent && (
        <div style={{ fontSize: 11, color: 'var(--muted)',
          borderLeft: '2px solid var(--border)', paddingLeft: 8, marginBottom: 4,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          ↳ {(parent.text || '').slice(0, 80)}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <div style={{
          padding: '10px 14px', borderRadius: 14,
          background: msg.mine ? 'var(--accent)' : 'var(--surface-2)',
          color: msg.mine ? 'var(--surface)' : 'var(--fg)',
          fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap',
        }}>
          {msg.text}
          {(msg.attachments || []).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {msg.attachments.map((a, i) => {
                if (isAudioAttachment(a)) {
                  return <AudioPlayer key={i} url={a.url} mine={msg.mine} durationMs={a.durationMs}/>;
                }
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
                      background: msg.mine ? 'rgba(255,255,255,0.18)' : 'var(--surface)',
                      border: '1px solid ' + (msg.mine ? 'rgba(255,255,255,0.18)' : 'var(--border)'),
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
        {(onReply || onReport) && hover && (
          <div style={{
            position: 'absolute', top: -16, [msg.mine ? 'left' : 'right']: 0,
            display: 'flex', gap: 2, padding: 2, borderRadius: 999,
            background: 'var(--surface)', border: '1px solid var(--border)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)', fontSize: 11,
          }}>
            {onReply && (
              <button onClick={onReply} title="Reply"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '2px 8px', borderRadius: 8, color: 'var(--muted)' }}>↩ Reply</button>
            )}
            {onReport && !msg.mine && (
              <button onClick={onReport} title="Report message"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '2px 8px', borderRadius: 8, color: 'var(--danger)' }}>⚐ Report</button>
            )}
          </div>
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3,
        textAlign: msg.mine ? 'right' : 'left' }}>
        {msg.reportedAt && '⚐ Reported · '}{fmtTime(msg.createdAt)}
      </div>
    </div>
  );
}
