// /helper/messages - only with the "messages" permission. The business
// inbox, narrowed: threads for the clients this helper is booked with
// (every client when they also have the schedule permission), and a
// plain composer. Sends go through the owner's /api/messages endpoints in
// helper mode, so they land as the business with the same push and
// notifications, and the server stamps who wrote them.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';
import { useViewport } from '../../lib/viewport.js';
import { useHelper } from './helperContext.jsx';

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function HelperMessages() {
  const { permissions, me } = useHelper();
  const { isMobile } = useViewport();
  const [searchParams, setSearchParams] = useSearchParams();
  const [threads, setThreads] = useState(null);
  const [err, setErr] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const activeId = searchParams.get('threadId');

  const load = useCallback(async () => {
    try {
      const r = await api.get('/messages');
      setThreads(r.threads || []);
      setErr(null);
    } catch (e) { setErr(e.message || 'Could not load messages'); }
  }, []);
  useEffect(() => { if (permissions.messages) load(); }, [load, permissions.messages]);

  const open = (id) => setSearchParams(id ? { threadId: id } : {});

  if (!permissions.messages) {
    return (
      <div className="page-pad">
        <div className="card"><EmptyNote icon="Lock" title="Messages are not part of your access" hint="Ask the owner to turn on the Messages permission for you."/></div>
      </div>
    );
  }

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)' }}>
          {permissions.schedule ? 'Every client of the business.' : 'Clients you are booked with.'}
        </div>
        <button className="btn btn-outline" onClick={() => setNewOpen(true)} style={{ fontSize: 12.5 }}>
          <Icons.Plus size={12} sw={2}/> New
        </button>
      </div>
      {err && <div className="card" style={{ padding: 14, color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      {threads === null && !err && <SkelRowList rows={4} withAvatar/>}
      {threads !== null && threads.length === 0 && (
        <div className="card"><EmptyNote icon="Chat" title="No conversations yet" hint="Start one with New, or wait for a client to write in."/></div>
      )}
      {(threads || []).map((t) => (
        <button key={t.id} type="button" className="card" onClick={() => open(t.id)} style={{
          padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', width: '100%', cursor: 'pointer',
          borderColor: t.id === activeId ? 'var(--accent)' : undefined,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <div style={{ flex: 1, fontSize: 14, fontWeight: t.unreadBiz > 0 ? 650 : 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.clientName}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{fmtWhen(t.lastMessageAt)}</div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.lastMessagePreview || 'No messages yet'}
            </div>
          </div>
          {t.unreadBiz > 0 && <span className="nav-badge">{t.unreadBiz}</span>}
        </button>
      ))}
    </div>
  );

  const thread = activeId ? (
    <Thread key={activeId} id={activeId} helperName={me?.staff?.name} onBack={isMobile ? () => open(null) : null}
      onSent={load}/>
  ) : (
    !isMobile && <div className="card"><EmptyNote icon="Chat" title="Pick a conversation" hint="Messages you send go out as the business, with your name on them for the owner."/></div>
  );

  return (
    <div className="page-pad">
      {isMobile ? (activeId ? thread : list) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 16, alignItems: 'start' }}>
          {list}
          {thread}
        </div>
      )}
      {newOpen && <NewThread onClose={() => setNewOpen(false)} onStarted={(id) => { setNewOpen(false); load(); open(id); }}/>}
    </div>
  );
}

function Thread({ id, helperName, onBack, onSent }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/messages/${encodeURIComponent(id)}`);
      setData(r);
      setErr(null);
    } catch (e) { setErr(e.message || 'Could not load this conversation'); }
  }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [data?.messages?.length]);

  const send = async (e) => {
    e?.preventDefault?.();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null);
    try {
      await api.post(`/messages/${encodeURIComponent(id)}`, { text: t, channel: 'app' },
        { headers: { 'Idempotency-Key': `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } });
      setText('');
      await load();
      onSent?.();
    } catch (ex) { setErr(ex.message || 'Could not send'); }
    finally { setBusy(false); }
  };

  const blocked = !!data?.thread?.blocked;
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 420, maxHeight: 'calc(100vh - 220px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        {onBack && (
          <button className="btn btn-ghost" onClick={onBack} aria-label="Back" style={{ padding: 6 }}><Icons.ArrowLeft size={16}/></button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data?.thread?.clientName || 'Conversation'}</div>
          {data?.thread?.clientEmail && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{data.thread.clientEmail}</div>}
        </div>
      </div>
      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!data && !err && <SkelRowList rows={3}/>}
        {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
        {(data?.messages || []).map((m) => {
          const mine = m.sender === 'biz';
          const by = m.meta?.sentBy === 'helper' ? (m.meta.helperName || 'a helper') : null;
          return (
            <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
              <div style={{
                padding: '8px 12px', borderRadius: 14, fontSize: 13.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: mine ? 'var(--fg)' : 'var(--surface-2)', color: mine ? 'var(--page)' : 'var(--fg)',
              }}>{m.text || (m.attachments?.length ? 'Attachment' : '')}</div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, textAlign: mine ? 'right' : 'left' }}>
                {fmtWhen(m.createdAt)}{mine ? ` · ${by ? `written by ${by}` : 'the owner'}` : ''}
              </div>
            </div>
          );
        })}
        <div ref={endRef}/>
      </div>
      <form onSubmit={send} style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} disabled={blocked || busy}
          placeholder={blocked ? 'Messaging is switched off for this client' : `Message as the business (signed ${helperName || 'you'})`}
          style={{ flex: 1, fontSize: 14 }}/>
        <button type="submit" className="btn btn-primary" disabled={blocked || busy || !text.trim()}>Send</button>
      </form>
    </div>
  );
}

// Start a thread with a client. The /api/clients list answers in helper
// mode with the clients permission or the schedule permission; without
// either we fall back to the clients this helper is booked with.
function NewThread({ onClose, onStarted }) {
  const [clients, setClients] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/clients?limit=1000')
      .then((r) => live && setClients(r.clients || []))
      .catch(() => api.get('/helper/clients-for-my-bookings').then((r) => live && setClients(r.clients || [])).catch((e) => live && setErr(e.message)));
    return () => { live = false; };
  }, []);
  const start = async (c) => {
    try {
      const r = await api.post('/messages', { clientId: c.id });
      onStarted(r.thread?.id || r.id);
    } catch (e) { setErr(e.message || 'Could not start a conversation'); }
  };
  const shown = (clients || []).filter((c) => !q.trim() || (c.name || '').toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div onClick={onClose} className="motion-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 95 }}/>
      <div role="dialog" aria-modal="true" aria-label="New conversation" className="motion-modal" style={{
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 100,
        width: 'min(92vw, 420px)', background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 16, padding: 16, boxShadow: 'var(--shadow)', maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, fontWeight: 600 }}>Message a client</div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients" style={{ fontSize: 14 }}/>
        {err && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>}
        <div className="scroll" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {clients === null && !err && <SkelRowList rows={3}/>}
          {shown.map((c) => (
            <button key={c.id} type="button" className="nav-item" onClick={() => start(c)} style={{ justifyContent: 'flex-start' }}>
              <span style={{ fontWeight: 550 }}>{c.name}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>{c.email || c.phone || ''}</span>
            </button>
          ))}
          {clients !== null && shown.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)', padding: 8 }}>No clients to message.</div>}
        </div>
      </div>
    </>
  );
}
