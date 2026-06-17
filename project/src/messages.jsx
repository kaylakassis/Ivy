// Shared messaging: business owner ↔ registered clients.
// - localStorage-backed so both views share state on the same device
// - Per-thread setting: one-way (broadcast) or two-way
// - Only shows registered users (clients or business owners on Ivy OS)

const MSG_KEY = 'Ivy OS:messages';
const REG_KEY = 'Ivy OS:registered-clients';

function loadMsgs() {
  try { return JSON.parse(localStorage.getItem(MSG_KEY)) || defaultMsgs(); }
  catch { return defaultMsgs(); }
}
function saveMsgs(s) {
  localStorage.setItem(MSG_KEY, JSON.stringify(s));
  try { window.dispatchEvent(new StorageEvent('storage', { key: MSG_KEY })); } catch {}
}

function defaultMsgs() {
  return {
    // Business-wide default mode; per-thread can override
    defaultMode: 'two-way',
    // Registered clients (only registered users are visible / reachable)
    clients: [
      { id: 'c1', name: 'Ana Beltrán',  email: 'ana@example.com',   registered: true,  accent: '#C8D8FF' },
      { id: 'c2', name: 'Jordan Cole',  email: 'jordan@example.com',registered: true,  accent: '#FFD6B8' },
      { id: 'c3', name: 'Rina Okafor',  email: 'rina@example.com',  registered: true,  accent: '#E8D8FF' },
      { id: 'c4', name: 'Chris Mendes', email: 'chris@example.com', registered: false, accent: '#D0E8D0' },
      { id: 'c5', name: 'Leah Park',    email: 'leah@example.com',  registered: true,  accent: '#FFD1DC' },
    ],
    threads: {
      c1: {
        mode: 'two-way',
        unreadBiz: 1, unreadClient: 0,
        messages: [
          { from: 'biz',    text: "Looking forward to seeing you tomorrow. Please arrive 10 min early.", ts: Date.now() - 3600e3 * 5 },
          { from: 'client', text: "Thanks! Should I bring anything?", ts: Date.now() - 3600e3 * 2 },
        ],
      },
      c2: {
        mode: 'two-way',
        unreadBiz: 0, unreadClient: 1,
        messages: [
          { from: 'biz', text: "Here's your program for the week.", ts: Date.now() - 3600e3 * 28 },
        ],
      },
      c5: {
        mode: 'one-way',
        unreadBiz: 0, unreadClient: 0,
        messages: [
          { from: 'biz', text: "Studio hours change next week — closing at 6pm Fri.", ts: Date.now() - 86400e3 * 2 },
        ],
      },
    },
  };
}

function useMsgsStore() {
  const [s, setS] = React.useState(loadMsgs);
  React.useEffect(() => {
    const h = (e) => { if (e.key === MSG_KEY || e.key == null) setS(loadMsgs()); };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, []);
  const update = (next) => { setS(next); saveMsgs(next); };
  return [s, update];
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(y.getDate() - 1);
  const yest = d.toDateString() === y.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (yest)    return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* iMessage-style timestamp header shown between message groups separated by a gap */
function fmtTimestampHeader(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(y.getDate() - 1);
  const yest = d.toDateString() === y.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const daysAgo = Math.floor((now - d) / 86400e3);
  if (sameDay) return `Today ${time}`;
  if (yest)    return `Yesterday ${time}`;
  if (daysAgo < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const datePart = sameYear
    ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return `${datePart} ${time}`;
}

/* Decide where to insert iMessage-style timestamp dividers.
   Rules: always before the first message, and before any message that arrived
   15+ minutes after the previous one. */
function computeTimestampPoints(messages) {
  const points = new Set();
  const GAP = 15 * 60 * 1000;
  for (let i = 0; i < messages.length; i++) {
    if (i === 0) { points.add(0); continue; }
    if ((messages[i].ts || 0) - (messages[i-1].ts || 0) >= GAP) points.add(i);
  }
  return points;
}

function TimestampHeader({ ts }) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yest = d.toDateString() === y.toDateString();
  const now = new Date();
  const daysAgo = Math.floor((now - d) / 86400e3);
  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let prefix = '';
  if (sameDay) prefix = 'Today';
  else if (yest) prefix = 'Yesterday';
  else if (daysAgo < 7) prefix = d.toLocaleDateString([], { weekday: 'long' });
  else {
    const sameYear = d.getFullYear() === now.getFullYear();
    prefix = sameYear
      ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  return (
    <div style={{
      alignSelf: 'center', textAlign: 'center', fontSize: 10.5,
      color: 'var(--muted)', fontWeight: 500, letterSpacing: '0.02em',
      margin: '14px 0 2px', lineHeight: 1.3,
    }}>
      <span style={{ fontWeight: 600 }}>{prefix}</span>
      <span style={{ margin: '0 4px' }}>·</span>
      <span>{timeStr}</span>
    </div>
  );
}

/* Renders every message bubble — including special kind='doc-*' cards. */
function MessageBubble({ m, perspective }) {
  // perspective: 'biz' (owner view) or 'client'
  const mine = (perspective === 'biz' ? m.from === 'biz' : m.from === 'client');
  const isSystem = m.from === 'system';
  const kind = m.kind;

  // System doc-completed event — centered announcement
  if (kind === 'doc-completed') {
    return (
      <div style={{ alignSelf: 'stretch', display: 'flex', justifyContent: 'center', margin: '10px 0' }}>
        <div style={{
          padding: '8px 14px', borderRadius: 99, fontSize: 12,
          background: 'color-mix(in srgb, var(--ok) 16%, var(--surface-2))',
          color: 'color-mix(in srgb, var(--ok) 75%, var(--fg))',
          border: '1px solid color-mix(in srgb, var(--ok) 30%, var(--border))',
          display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 550,
        }}>
          <Icons.Check size={13} sw={2.4}/>
          <span>Document completed: <b>{m.docName}</b></span>
          <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {fmtTime(m.ts)}</span>
        </div>
      </div>
    );
  }

  // Doc sent / reminder — card bubble on the "from biz" side
  if (kind === 'doc-sent' || kind === 'doc-reminder') {
    const fromBiz = true;
    const bubbleMine = (perspective === 'biz');
    const canAct = perspective === 'client';
    return (
      <div style={{ alignSelf: bubbleMine ? 'flex-end' : 'flex-start', maxWidth: '78%', marginTop: 8 }}>
        <div style={{
          padding: 14, borderRadius: 14,
          background: bubbleMine ? 'var(--accent-soft)' : 'var(--surface)',
          border: `1px solid ${bubbleMine ? 'color-mix(in srgb, var(--accent) 30%, var(--border))' : 'var(--border)'}`,
          minWidth: 260,
        }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{
              width: 38, height: 46, background: 'var(--surface-2)', borderRadius: 4, border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--muted)',
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
            }}>DOC</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', fontWeight: 600, marginBottom: 2 }}>
                {kind === 'doc-reminder' ? 'Reminder' : 'Document to sign'}
              </div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--fg)' }}>{m.docName}</div>
              {m.noteText && (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>
                  "{m.noteText}"
                </div>
              )}
              {canAct && (
                <button className="btn btn-primary" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}
                  onClick={() => window.openSigningFlow && window.openSigningFlow(m.docId)}>
                  <Icons.Edit size={13} sw={1.8}/> {kind === 'doc-reminder' ? 'Complete now' : 'Open & sign'}
                </button>
              )}
              {!canAct && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icons.Mail size={11} sw={1.8}/> Email + in-app notification delivered
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, textAlign: bubbleMine ? 'right' : 'left' }}>
          {fmtTime(m.ts)}
        </div>
      </div>
    );
  }

  // Regular text message (+ optional attachments)
  const atts = m.attachments || [];
  const hasText = m.text && m.text.trim();
  const onlyImages = atts.length > 0 && atts.every(a => a.kind === 'image') && !hasText;

  return (
    <div style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '72%', display: 'flex', flexDirection: 'column', gap: 4, alignItems: mine ? 'flex-end' : 'flex-start' }}>
      {atts.filter(a => a.kind === 'image').map((a, i) => (
        <div key={'img'+i} style={{
          borderRadius: 16, overflow: 'hidden',
          maxWidth: 240, maxHeight: 300,
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
          lineHeight: 0,
        }}>
          <img src={a.url} alt={a.name || 'photo'} style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 300, objectFit: 'cover' }}/>
        </div>
      ))}
      {atts.filter(a => a.kind === 'file').map((a, i) => (
        <div key={'file'+i} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', borderRadius: 14,
          background: mine ? 'color-mix(in srgb, var(--accent) 85%, white)' : 'var(--surface)',
          color: mine ? 'var(--accent-ink)' : 'var(--fg)',
          border: mine ? 'none' : '1px solid var(--border)',
          minWidth: 180, maxWidth: 260,
        }}>
          <div style={{
            width: 34, height: 40, borderRadius: 4,
            background: mine ? 'rgba(255,255,255,0.22)' : 'var(--surface-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
            color: mine ? 'var(--accent-ink)' : 'var(--muted)',
            flexShrink: 0,
          }}>{(a.ext || 'FILE').toUpperCase().slice(0,4)}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 1 }}>{a.size || ''}</div>
          </div>
        </div>
      ))}
      {hasText && (
        <div style={{
          padding: '9px 13px', borderRadius: 18,
          background: mine ? 'var(--accent)' : 'var(--surface)',
          color: mine ? 'var(--accent-ink)' : 'var(--fg)',
          border: mine ? 'none' : '1px solid var(--border)',
          fontSize: 14, lineHeight: 1.4,
          wordBreak: 'break-word',
        }}>{m.text}</div>
      )}
    </div>
  );
}

function Avatar({ name, accent, size = 36 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: 12, background: accent || 'var(--surface-2)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      fontFamily: 'var(--font-display)', fontWeight: 600, color: '#333',
      fontSize: size * 0.44,
    }}>{(name || '?')[0]?.toUpperCase()}</div>
  );
}

/* ============ ATTACHMENT BUTTON ============ */
function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Renders the paperclip + dropdown menu and three hidden <input>s.
// onAttach(list) receives [{kind:'image'|'file', url, name, size, ext}]
function AttachButton({ onAttach, disabled, compact }) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  const photoRef = React.useRef(null);
  const cameraRef = React.useRef(null);
  const fileRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const h = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const handleFiles = async (files, forceImage) => {
    const list = [];
    for (const f of Array.from(files || [])) {
      const url = await readAsDataURL(f);
      const isImage = forceImage || (f.type && f.type.startsWith('image/'));
      const ext = (f.name.split('.').pop() || '').slice(0, 4);
      list.push({
        kind: isImage ? 'image' : 'file',
        url, name: f.name || (isImage ? 'photo.jpg' : 'file'),
        size: fmtBytes(f.size), ext,
      });
    }
    if (list.length) onAttach(list);
    setOpen(false);
  };

  const size = compact ? 32 : 36;
  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title="Attach"
        style={{
          width: size, height: size, borderRadius: 99,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: open ? 'var(--surface)' : 'transparent',
          border: 'none', cursor: disabled ? 'default' : 'pointer',
          color: 'var(--muted)', padding: 0, flexShrink: 0,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Icons.Paperclip size={compact ? 16 : 18} sw={1.7}/>
      </button>

      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 8px)', left: 0,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          padding: 6, minWidth: 220, zIndex: 60,
        }}>
          <AttachMenuItem
            icon={<Icons.Image size={16} sw={1.7}/>}
            title="Photo library"
            sub="Pick an existing photo"
            onClick={() => photoRef.current?.click()}
          />
          <AttachMenuItem
            icon={<Icons.Camera size={16} sw={1.7}/>}
            title="Take photo"
            sub="Use your camera"
            onClick={() => cameraRef.current?.click()}
          />
          <AttachMenuItem
            icon={<Icons.FileIcon size={16} sw={1.7}/>}
            title="File"
            sub="PDF, doc, any file"
            onClick={() => fileRef.current?.click()}
          />
        </div>
      )}

      {/* Photo library — images only, multi */}
      <input ref={photoRef} type="file" accept="image/*" multiple
        style={{ display: 'none' }}
        onChange={(e) => { handleFiles(e.target.files, true); e.target.value = ''; }}/>
      {/* Camera — forces capture on mobile, falls back to file dialog on desktop */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => { handleFiles(e.target.files, true); e.target.value = ''; }}/>
      {/* Any file */}
      <input ref={fileRef} type="file" multiple
        style={{ display: 'none' }}
        onChange={(e) => { handleFiles(e.target.files, false); e.target.value = ''; }}/>
    </div>
  );
}

function AttachMenuItem({ icon, title, sub, onClick }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
      borderRadius: 8, cursor: 'pointer',
    }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 8, background: 'var(--surface-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--fg-2)', flexShrink: 0,
      }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{sub}</div>
      </div>
    </div>
  );
}

/* Small pill showing a pending attachment above the composer */
function PendingAttachmentChip({ att, onRemove }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      padding: att.kind === 'image' ? 4 : '6px 10px 6px 6px',
      borderRadius: 10, background: 'var(--surface)',
      border: '1px solid var(--border)', maxWidth: 200,
    }}>
      {att.kind === 'image' ? (
        <div style={{ width: 40, height: 40, borderRadius: 6, overflow: 'hidden', background: 'var(--surface-2)' }}>
          <img src={att.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}/>
        </div>
      ) : (
        <div style={{
          width: 28, height: 34, borderRadius: 3, background: 'var(--surface-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 8, fontWeight: 700, color: 'var(--muted)',
        }}>{(att.ext || 'FILE').toUpperCase().slice(0,4)}</div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{att.name}</div>
        {att.size && <div style={{ fontSize: 10, color: 'var(--muted)' }}>{att.size}</div>}
      </div>
      <button type="button" onClick={onRemove} title="Remove" style={{
        width: 20, height: 20, borderRadius: 99, background: 'var(--fg)',
        color: 'var(--page)', border: 'none', cursor: 'pointer', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
      }}>
        <Icons.X size={10} sw={2.4}/>
      </button>
    </div>
  );
}

/* ============================================================
   BUSINESS VIEW — Messages
   ============================================================ */
function BusinessMessagesView({ direction }) {
  const [store, update] = useMsgsStore();
  const [selected, setSelected] = React.useState(() => Object.keys(store.threads)[0] || null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [pending, setPending] = React.useState([]);

  const threadList = Object.entries(store.threads)
    .map(([cid, t]) => ({ cid, client: store.clients.find(c => c.id === cid), ...t }))
    .filter(r => r.client && r.client.registered)
    .sort((a, b) => {
      const at = a.messages[a.messages.length - 1]?.ts || 0;
      const bt = b.messages[b.messages.length - 1]?.ts || 0;
      return bt - at;
    });

  const selectedT = selected && store.threads[selected];
  const selectedC = selected && store.clients.find(c => c.id === selected);
  const mode = selectedT?.mode || store.defaultMode;

  // Mark thread read when selected
  React.useEffect(() => {
    if (selected && store.threads[selected]?.unreadBiz > 0) {
      const next = { ...store };
      next.threads = { ...store.threads, [selected]: { ...store.threads[selected], unreadBiz: 0 } };
      update(next);
    }
  }, [selected]);

  const send = () => {
    if (!selected) return;
    if (!input.trim() && pending.length === 0) return;
    const t = store.threads[selected] || { mode: store.defaultMode, messages: [], unreadBiz: 0, unreadClient: 0 };
    const msg = { from: 'biz', text: input, ts: Date.now() };
    if (pending.length) msg.attachments = pending;
    const nextThread = { ...t, messages: [...t.messages, msg], unreadClient: (t.unreadClient || 0) + 1 };
    update({ ...store, threads: { ...store.threads, [selected]: nextThread } });
    setInput('');
    setPending([]);
  };

  const startThread = (cid) => {
    if (!store.threads[cid]) {
      update({ ...store, threads: { ...store.threads, [cid]: { mode: store.defaultMode, messages: [], unreadBiz: 0, unreadClient: 0 } } });
    }
    setSelected(cid);
    setNewOpen(false);
  };

  const setThreadMode = (m) => {
    if (!selected) return;
    update({ ...store, threads: { ...store.threads, [selected]: { ...store.threads[selected], mode: m } } });
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', height: 'calc(100vh - 200px)', minHeight: 560, borderTop: '1px solid var(--border)', marginBottom: 96 }}>
      {/* Thread list */}
      <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Conversations</div>
          <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setNewOpen(true)} title="New message">
            <Icons.Plus size={15} sw={2}/>
          </button>
          <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setSettingsOpen(true)} title="Message settings">
            <Icons.Settings size={15} sw={1.7}/>
          </button>
        </div>
        <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
          {threadList.length === 0 ? (
            <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
              No conversations yet.<br/>
              <button className="btn btn-outline" style={{ marginTop: 12 }} onClick={() => setNewOpen(true)}>
                <Icons.Plus size={13} sw={2}/> Start one
              </button>
            </div>
          ) : threadList.map(t => {
            const last = t.messages[t.messages.length - 1];
            const active = selected === t.cid;
            return (
              <div key={t.cid} onClick={() => setSelected(t.cid)} style={{
                padding: '12px 16px', display: 'flex', gap: 12, cursor: 'pointer',
                background: active ? 'var(--surface-2)' : 'transparent',
                borderLeft: `3px solid ${active ? 'var(--accent)' : 'transparent'}`,
                borderBottom: '1px solid var(--border)',
              }}>
                <Avatar name={t.client.name} accent={t.client.accent} size={40}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.client.name}
                    </span>
                    {t.mode === 'one-way' && (
                      <Icons.Mail size={11} stroke="var(--muted)" sw={1.8} title="Broadcast only"/>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{last ? fmtTime(last.ts) : ''}</span>
                  </div>
                  <div style={{
                    fontSize: 12.5, color: t.unreadBiz > 0 ? 'var(--fg)' : 'var(--muted)',
                    fontWeight: t.unreadBiz > 0 ? 550 : 400,
                    marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {last ? (last.from === 'biz' ? 'You: ' : '') + last.text : 'No messages yet'}
                  </div>
                </div>
                {t.unreadBiz > 0 && (
                  <div style={{
                    width: 18, height: 18, borderRadius: 99, background: 'var(--accent)',
                    color: 'var(--accent-ink)', fontSize: 10, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'center',
                  }}>{t.unreadBiz}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Conversation */}
      {selectedT && selectedC ? (
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <Avatar name={selectedC.name} accent={selectedC.accent} size={36}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{selectedC.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{selectedC.email} · Registered client</div>
            </div>
            {/* Per-thread mode */}
            <div className="seg" style={{ padding: 3 }}>
              <button className={mode === 'two-way' ? 'on' : ''} onClick={() => setThreadMode('two-way')}>Two-way</button>
              <button className={mode === 'one-way' ? 'on' : ''} onClick={() => setThreadMode('one-way')}>Broadcast</button>
            </div>
          </div>

          <div className="scroll" style={{
            flex: 1, overflowY: 'auto', padding: '24px 32px',
            background: 'var(--page)', display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {selectedT.messages.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 40 }}>
                No messages yet. Say hello.
              </div>
            )}
            {(() => {
              const points = computeTimestampPoints(selectedT.messages);
              return selectedT.messages.map((m, i) => (
                <React.Fragment key={i}>
                  {points.has(i) && <TimestampHeader ts={m.ts}/>}
                  <MessageBubble m={m} perspective="biz"/>
                </React.Fragment>
              ));
            })()}
          </div>

          {/* Composer */}
          <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
            {mode === 'one-way' && (
              <div style={{
                padding: '8px 12px', borderRadius: 8, marginBottom: 10,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <Icons.Mail size={12} sw={1.8}/>
                <span><b style={{ color: 'var(--fg-2)' }}>Broadcast only.</b> Your client can read messages but can't reply to this thread.</span>
              </div>
            )}
            {pending.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                {pending.map((a, i) => (
                  <PendingAttachmentChip key={i} att={a}
                    onRemove={() => setPending(p => p.filter((_, idx) => idx !== i))}/>
                ))}
              </div>
            )}
            <div style={{
              display: 'flex', alignItems: 'flex-end', gap: 6,
              padding: '6px 6px 6px 6px',
              border: '1px solid var(--border-strong)', borderRadius: 12,
              background: 'var(--surface-2)',
            }}>
              <AttachButton
                onAttach={(list) => setPending(p => [...p, ...list])}
              />
              <textarea value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={mode === 'one-way' ? 'Write a broadcast message…' : 'Write a message…'}
                rows={1}
                style={{
                  flex: 1, background: 'none', border: 0, outline: 'none',
                  fontSize: 14, color: 'var(--fg)', resize: 'none',
                  fontFamily: 'inherit', lineHeight: 1.4, maxHeight: 120, minHeight: 22,
                  padding: '6px 4px',
                }}
              />
              <button className="btn btn-primary" onClick={send} disabled={!input.trim() && pending.length === 0}
                style={{ padding: '8px 12px' }}>
                <Icons.Arrow size={14} sw={2.2}/>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
          Select a conversation, or start a new one.
        </div>
      )}

      {settingsOpen && (
        <MessagingSettings store={store} update={update} onClose={() => setSettingsOpen(false)} />
      )}
      {newOpen && (
        <NewMessageModal store={store} onPick={startThread} onClose={() => setNewOpen(false)} />
      )}
    </div>
  );
}

/* ============ Settings ============ */
function MessagingSettings({ store, update, onClose }) {
  const [draft, setDraft] = React.useState(store.defaultMode);
  const save = () => { update({ ...store, defaultMode: draft }); onClose(); };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,12,8,0.5)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div className="card" style={{ width: '100%', maxWidth: 520, padding: 28 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, background: 'var(--accent-soft)',
            color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}><Icons.Settings size={18} sw={1.7}/></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>
              Message settings
            </div>
            <h3 style={{ margin: '4px 0 0', fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>
              How clients can reach you
            </h3>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, fontWeight: 500 }}>Default for new conversations</div>
        <ModeCard
          id="two-way"  current={draft} onPick={setDraft}
          title="Two-way messaging"
          body="You and your client can both send messages. Best for coaching, check-ins, and back-and-forth."
          icon={<Icons.Chat size={18} sw={1.6}/>}
        />
        <ModeCard
          id="one-way"  current={draft} onPick={setDraft}
          title="Broadcast only"
          body="You can send messages, but clients can't reply. Best for announcements, studio updates, appointment reminders."
          icon={<Icons.Mail size={18} sw={1.6}/>}
        />

        <div style={{
          padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 8,
        }}>
          <b style={{ color: 'var(--fg-2)' }}>Registered users only.</b> Messaging works only between Ivy OS accounts —
          your registered clients and other business owners. Unregistered contacts won't appear here.
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button className="btn btn-primary" onClick={save} style={{ flex: 2, justifyContent: 'center' }}>Save settings</button>
        </div>
      </div>
    </div>
  );
}

function ModeCard({ id, current, onPick, title, body, icon }) {
  const sel = current === id;
  return (
    <div onClick={() => onPick(id)} style={{
      padding: 14, borderRadius: 12, cursor: 'pointer', marginBottom: 10,
      background: sel ? 'var(--accent-soft)' : 'var(--surface)',
      border: `1px solid ${sel ? 'var(--accent)' : 'var(--border)'}`,
      display: 'flex', gap: 12, alignItems: 'flex-start',
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: sel ? 'var(--accent)' : 'var(--surface-2)',
        color: sel ? 'var(--accent-ink)' : 'var(--muted)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{body}</div>
      </div>
      <div style={{
        width: 18, height: 18, borderRadius: 99, flexShrink: 0, marginTop: 2,
        border: `2px solid ${sel ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: sel ? 'var(--accent)' : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-ink)',
      }}>{sel && <Icons.Check size={10} sw={3}/>}</div>
    </div>
  );
}

/* ============ New Message picker ============ */
function NewMessageModal({ store, onPick, onClose }) {
  const [q, setQ] = React.useState('');
  const registered = store.clients.filter(c => c.registered);
  const filtered = registered.filter(c =>
    !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.email.toLowerCase().includes(q.toLowerCase())
  );
  const unregisteredCount = store.clients.length - registered.length;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,12,8,0.5)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div className="card" style={{ width: '100%', maxWidth: 480, padding: 22, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>
              New conversation
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>Pick a registered client</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          border: '1px solid var(--border-strong)', borderRadius: 10, marginBottom: 12,
          background: 'var(--surface-2)',
        }}>
          <Icons.Search size={14} stroke="var(--muted)"/>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search name or email"
            style={{ flex: 1, background: 'none', border: 0, outline: 'none', fontSize: 13, color: 'var(--fg)' }}/>
        </div>

        <div className="scroll" style={{ flex: 1, overflowY: 'auto', margin: '0 -8px' }}>
          {filtered.map(c => (
            <div key={c.id} onClick={()=>onPick(c.id)} style={{
              padding: '10px 12px', display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer',
              borderRadius: 10,
            }}
              onMouseEnter={e=>e.currentTarget.style.background='var(--surface-2)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <Avatar name={c.name} accent={c.accent} size={36}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 550, fontSize: 14 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{c.email}</div>
              </div>
              <span className="chip chip-ok"><span className="chip-dot"/>Registered</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
              No registered clients match.
            </div>
          )}
        </div>

        {unregisteredCount > 0 && (
          <div style={{
            marginTop: 10, padding: 10, borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5,
          }}>
            {unregisteredCount} other {unregisteredCount === 1 ? 'contact isn’t' : 'contacts aren’t'} on Ivy OS yet.
            Invite them from the Clients tab to message them.
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   CLIENT VIEW — Messages (replaces old mock)
   ============================================================ */
function ClientMessagesLive({ direction }) {
  const [store, update] = useMsgsStore();
  // Client is simulating one of the registered clients for demo purposes — use first registered
  const me = store.clients.find(c => c.registered) || store.clients[0];
  const [selected, setSelected] = React.useState(me?.id);
  const [input, setInput] = React.useState('');
  const [pending, setPending] = React.useState([]);

  const thread = selected && store.threads[selected];
  const mode = thread?.mode || store.defaultMode;
  const canReply = mode === 'two-way';

  // Mark read
  React.useEffect(() => {
    if (selected && store.threads[selected]?.unreadClient > 0) {
      const next = { ...store };
      next.threads = { ...store.threads, [selected]: { ...store.threads[selected], unreadClient: 0 } };
      update(next);
    }
  }, [selected]);

  const send = () => {
    if (!selected || !canReply) return;
    if (!input.trim() && pending.length === 0) return;
    const t = store.threads[selected];
    const msg = { from: 'client', text: input, ts: Date.now() };
    if (pending.length) msg.attachments = pending;
    const nextT = { ...t, messages: [...t.messages, msg], unreadBiz: (t.unreadBiz||0)+1 };
    update({ ...store, threads: { ...store.threads, [selected]: nextT } });
    setInput('');
    setPending([]);
  };

  const threadList = Object.entries(store.threads)
    .map(([cid, t]) => ({ cid, client: store.clients.find(c => c.id === cid), ...t }))
    .filter(r => r.client && r.client.registered)
    .sort((a, b) => (b.messages[b.messages.length - 1]?.ts || 0) - (a.messages[a.messages.length - 1]?.ts || 0));

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.03em', margin: '0 0 24px' }}>
        Messages
      </h2>

      <div className="card" style={{
        overflow: 'hidden', display: 'grid', gridTemplateColumns: '280px 1fr', height: 560,
      }}>
        <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Your businesses
          </div>
          <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
            {threadList.map(t => {
              const last = t.messages[t.messages.length - 1];
              const active = selected === t.cid;
              return (
                <div key={t.cid} onClick={() => setSelected(t.cid)} style={{
                  padding: '12px 14px', display: 'flex', gap: 10, cursor: 'pointer',
                  background: active ? 'var(--surface-2)' : 'transparent',
                  borderLeft: `3px solid ${active ? 'var(--accent)' : 'transparent'}`,
                  borderBottom: '1px solid var(--border)',
                }}>
                  <Avatar name={t.client.name} accent={t.client.accent} size={36}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        Your business
                      </span>
                      {t.mode === 'one-way' && <Icons.Mail size={11} stroke="var(--muted)" sw={1.8}/>}
                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>{last ? fmtTime(last.ts) : ''}</span>
                    </div>
                    <div style={{ fontSize: 12, color: t.unreadClient > 0 ? 'var(--fg)' : 'var(--muted)', fontWeight: t.unreadClient > 0 ? 550 : 400, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {last ? last.text : 'No messages'}
                    </div>
                  </div>
                  {t.unreadClient > 0 && (
                    <div style={{
                      width: 16, height: 16, borderRadius: 99, background: 'var(--accent)',
                      color: 'var(--accent-ink)', fontSize: 9, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'center',
                    }}>{t.unreadClient}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {thread ? (
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Your business</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {mode === 'one-way' ? 'Broadcast — replies disabled by business' : 'Two-way messaging'}
                </div>
              </div>
            </div>
            <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', background: 'var(--page)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(() => {
                const points = computeTimestampPoints(thread.messages);
                return thread.messages.map((m, i) => (
                  <React.Fragment key={i}>
                    {points.has(i) && <TimestampHeader ts={m.ts}/>}
                    <MessageBubble m={m} perspective="client"/>
                  </React.Fragment>
                ));
              })()}
            </div>
            <div style={{ padding: 14, borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
              {!canReply ? (
                <div style={{
                  padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)',
                  border: '1px solid var(--border)', fontSize: 12, color: 'var(--muted)',
                  display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
                }}>
                  <Icons.Mail size={12} sw={1.8}/>
                  Replies aren't enabled in this conversation.
                </div>
              ) : (
                <>
                  {pending.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                      {pending.map((a, i) => (
                        <PendingAttachmentChip key={i} att={a}
                          onRemove={() => setPending(p => p.filter((_, idx) => idx !== i))}/>
                      ))}
                    </div>
                  )}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '4px 4px 4px 4px',
                    border: '1px solid var(--border-strong)', borderRadius: 12,
                    background: 'var(--surface-2)',
                  }}>
                    <AttachButton compact onAttach={(list) => setPending(p => [...p, ...list])}/>
                    <input value={input} onChange={e=>setInput(e.target.value)}
                      onKeyDown={e=>e.key==='Enter'&&send()}
                      placeholder="Message your business…"
                      style={{ flex: 1, background: 'none', border: 0, outline: 'none', fontSize: 13, color: 'var(--fg)', padding: '6px 4px' }}/>
                    <button className="btn btn-primary" onClick={send} disabled={!input.trim() && pending.length === 0} style={{ padding: '7px 11px' }}>
                      <Icons.Arrow size={13} sw={2.2}/>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
            Pick a thread.
          </div>
        )}
      </div>
    </div>
  );
}

window.BusinessMessagesView = BusinessMessagesView;
window.ClientMessagesLive = ClientMessagesLive;