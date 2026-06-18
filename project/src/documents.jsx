// DOCUMENTS - DocuSign-style flow for Ivy OS.
// Features: upload-PDF / write-in-app / from-template, drag-drop fields,
// send to registered clients, in-app signing, reminders, vault, Drive mock.

/* ============ STORE ============ */
const DOC_KEY = 'Ivy OS:docs';

function loadDocs() {
  try { return JSON.parse(localStorage.getItem(DOC_KEY)) || defaultDocs(); }
  catch { return defaultDocs(); }
}
function saveDocs(s) {
  localStorage.setItem(DOC_KEY, JSON.stringify(s));
  try { window.dispatchEvent(new StorageEvent('storage', { key: DOC_KEY })); } catch {}
}
function defaultDocs() {
  return {
    driveConnected: false,
    documents: [
      {
        id: 'd1', name: 'Intro Waiver & Liability',
        kind: 'pdf', fileName: 'intro-waiver.pdf', pageCount: 2,
        pages: [{ kind:'pdf' }, { kind:'pdf' }],
        fields: [
          { id:'f1', page:0, x: 8,  y: 82, w: 40, h: 6, type: 'signature', label: "Client signature", value: '' },
          { id:'f2', page:0, x: 58, y: 82, w: 24, h: 6, type: 'date', label: "Date", value: '' },
          { id:'f3', page:1, x: 8,  y: 60, w: 6,  h: 6, type: 'initial', label: "Initial", value: '' },
          { id:'f4', page:1, x: 8,  y: 84, w: 40, h: 6, type: 'signature', label: "Signature", value: '' },
        ],
        recipient: { clientId: 'c2', name: 'Jordan Cole', email: 'jordan@example.com' },
        status: 'sent',
        sentAt: Date.now() - 86400e3 * 2,
        reminders: 0,
        activity: [
          { ts: Date.now() - 86400e3 * 2, kind:'sent',     text: "Sent to Jordan Cole" },
          { ts: Date.now() - 86400e3 * 2 + 3600e3 * 3, kind:'viewed', text: "Jordan opened the document" },
        ],
      },
      {
        id: 'd2', name: 'Studio Membership Agreement',
        kind: 'written', pageCount: 1,
        pages: [{ kind:'written', html: "<h1>Studio Membership Agreement</h1><p>This agreement outlines the terms of your monthly membership at the studio, including cancellation policy, booking limits, and payment schedule.</p><p>By signing below, you acknowledge you have read and agree to these terms.</p>" }],
        fields: [
          { id:'f1', page:0, x: 8,  y: 78, w: 40, h: 6, type: 'signature', label: "Client signature", value: '' },
          { id:'f2', page:0, x: 58, y: 78, w: 24, h: 6, type: 'date', label: "Date", value: '' },
          { id:'f3', page:0, x: 8,  y: 88, w: 58, h: 6, type: 'text', label: "Full legal name", value: '' },
        ],
        recipient: { clientId: 'c1', name: 'Ana Beltrán', email: 'ana@example.com' },
        status: 'completed',
        sentAt: Date.now() - 86400e3 * 9,
        completedAt: Date.now() - 86400e3 * 8,
        reminders: 0,
        activity: [
          { ts: Date.now() - 86400e3 * 9, kind:'sent',      text: "Sent to Ana Beltrán" },
          { ts: Date.now() - 86400e3 * 8, kind:'completed', text: "Ana signed and completed the document" },
        ],
      },
    ],
    templates: [
      { id:'t1', name:"Intake Form",    kind:'written', pages:[{ kind:'written', html:"<h1>Client Intake Form</h1><p>Please complete the following to help us prepare for your first session.</p><h3>Goals</h3><p>What do you hope to get from working together?</p><h3>Medical history</h3><p>List any conditions, injuries, or medications we should know about.</p>" }], fields:[
        { id:'tf1', page:0, x: 8, y: 90, w: 40, h: 6, type:'signature', label:'Signature', value:'' },
        { id:'tf2', page:0, x: 58,y: 90, w: 24, h: 6, type:'date', label:'Date', value:'' },
      ]},
      { id:'t2', name:"Cancellation Policy", kind:'written', pages:[{ kind:'written', html:"<h1>Cancellation Policy</h1><p>24 hours' notice is required to cancel or reschedule without charge. Same-day cancellations forfeit the session fee.</p>" }], fields:[
        { id:'tf1', page:0, x: 8, y: 70, w: 6, h: 6, type:'initial', label:'Initial', value:'' },
        { id:'tf2', page:0, x: 8, y: 84, w: 40, h: 6, type:'signature', label:'Signature', value:'' },
      ]},
    ],
  };
}

function useDocsStore() {
  const [s, setS] = React.useState(loadDocs);
  React.useEffect(() => {
    const h = (e) => { if (e.key === DOC_KEY || e.key == null) setS(loadDocs()); };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, []);
  const update = (next) => { setS(next); saveDocs(next); };
  return [s, update];
}

/* ============ Toast system (fake email notifications) ============ */
const ToastCtx = React.createContext(null);
function ToastProvider({ children }) {
  const [items, setItems] = React.useState([]);
  const push = React.useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setItems(xs => [...xs, { id, ...t }]);
    setTimeout(() => setItems(xs => xs.filter(x => x.id !== id)), 4800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 200, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 380 }}>
        {items.map(t => (
          <div key={t.id} className="card" style={{
            padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start',
            boxShadow: '0 10px 30px -8px rgba(0,0,0,0.3)', animation: 'slideIn .25s ease-out',
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, background: 'var(--accent-soft)',
              color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>{t.icon || <Icons.Mail size={16} sw={1.8}/>}</div>
            <div style={{ flex: 1, fontSize: 13 }}>
              <div style={{ fontWeight: 600 }}>{t.title}</div>
              {t.body && <div style={{ color: 'var(--muted)', marginTop: 2, fontSize: 12 }}>{t.body}</div>}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
const useToast = () => React.useContext(ToastCtx) || (() => {});

/* ============ Helpers to push system messages to the messages store ============ */
function pushDocMessage(clientId, payload) {
  // payload = { kind: 'doc-sent'|'doc-completed'|'doc-reminder', docId, docName, from: 'biz'|'system' }
  let store;
  try { store = JSON.parse(localStorage.getItem('Ivy OS:messages')) || null; } catch { store = null; }
  if (!store) return;
  const existing = store.threads[clientId] || { mode: store.defaultMode || 'two-way', messages: [], unreadBiz: 0, unreadClient: 0 };
  const msg = { ts: Date.now(), ...payload };
  // system message regardless of mode
  const updated = { ...existing, messages: [...existing.messages, msg] };
  if (payload.from === 'biz' || payload.from === 'system') updated.unreadClient = (existing.unreadClient || 0) + 1;
  if (payload.from === 'client') updated.unreadBiz = (existing.unreadBiz || 0) + 1;
  store.threads = { ...store.threads, [clientId]: updated };
  localStorage.setItem('Ivy OS:messages', JSON.stringify(store));
  try { window.dispatchEvent(new StorageEvent('storage', { key: 'Ivy OS:messages' })); } catch {}
}

/* ============ BUSINESS DOCUMENTS VIEW ============ */
const STATUS_META = {
  draft:     { label:'Draft',      bg:'var(--surface-2)', fg:'var(--muted)' },
  sent:      { label:'Awaiting',   bg:'color-mix(in srgb, var(--warn) 18%, var(--surface-2))', fg:'color-mix(in srgb, var(--warn) 80%, var(--fg))' },
  completed: { label:'Completed',  bg:'color-mix(in srgb, var(--ok) 16%, var(--surface-2))',   fg:'color-mix(in srgb, var(--ok) 75%, var(--fg))' },
  voided:    { label:'Voided',     bg:'var(--surface-2)', fg:'var(--danger)' },
};

function DocumentsView({ direction }) {
  return (
    <ToastProvider>
      <DocumentsInner direction={direction}/>
    </ToastProvider>
  );
}

function DocumentsInner({ direction }) {
  const [store, update] = useDocsStore();
  const [tab, setTab] = React.useState('inbox'); // inbox | templates | vault
  const [editing, setEditing] = React.useState(null);   // doc id being edited
  const [sending, setSending] = React.useState(null);   // doc id to send
  const [viewing, setViewing] = React.useState(null);   // doc id to view read-only
  const [newMenuOpen, setNewMenuOpen] = React.useState(false);
  const toast = useToast();

  const docs = store.documents;
  const inbox     = docs.filter(d => d.status === 'draft' || d.status === 'sent');
  const completed = docs.filter(d => d.status === 'completed');

  const createFromBlank = () => {
    const id = 'd' + Date.now();
    const doc = {
      id, name:'Untitled document', kind:'written', pageCount:1,
      pages:[{ kind:'written', html:'<h1>New document</h1><p>Start writing…</p>' }],
      fields:[], status:'draft', activity:[], reminders:0,
    };
    update({ ...store, documents: [doc, ...store.documents] });
    setEditing(id); setNewMenuOpen(false);
  };
  const createFromPdf = () => {
    const id = 'd' + Date.now();
    // Simulate file pick
    const name = prompt("PDF file name", "contract.pdf");
    if (!name) return;
    const pageCount = 3;
    const doc = {
      id, name: name.replace(/\.pdf$/i,''), kind:'pdf', fileName: name, pageCount,
      pages: Array.from({length:pageCount}, () => ({ kind:'pdf' })),
      fields:[], status:'draft', activity:[], reminders:0,
    };
    update({ ...store, documents: [doc, ...store.documents] });
    setEditing(id); setNewMenuOpen(false);
    toast({ title:'PDF imported', body:`${name} · ${pageCount} pages ready for fields.` , icon: <Icons.Doc size={16} sw={1.8}/> });
  };
  const createFromTemplate = (tid) => {
    const tpl = store.templates.find(t => t.id === tid);
    if (!tpl) return;
    const id = 'd' + Date.now();
    const doc = {
      id, name: tpl.name + ' (copy)', kind: tpl.kind, pageCount: tpl.pages.length,
      pages: JSON.parse(JSON.stringify(tpl.pages)),
      fields: JSON.parse(JSON.stringify(tpl.fields)),
      status:'draft', activity:[], reminders:0,
    };
    update({ ...store, documents: [doc, ...store.documents] });
    setEditing(id); setNewMenuOpen(false);
  };

  const deleteDoc = (id) => {
    if (!confirm("Delete this document?")) return;
    update({ ...store, documents: store.documents.filter(d => d.id !== id) });
  };
  const voidDoc = (id) => {
    update({ ...store, documents: store.documents.map(d => d.id === id ? { ...d, status:'voided', activity:[...(d.activity||[]), { ts:Date.now(), kind:'voided', text:'Document voided' }] } : d) });
  };
  const sendReminder = (doc) => {
    update({ ...store, documents: store.documents.map(d => d.id === doc.id ? {
      ...d, reminders:(d.reminders||0)+1,
      activity:[...(d.activity||[]), { ts: Date.now(), kind:'reminder', text:'Reminder sent' }],
    } : d) });
    if (doc.recipient?.clientId) {
      pushDocMessage(doc.recipient.clientId, {
        kind: 'doc-reminder', from: 'biz', docId: doc.id, docName: doc.name,
      });
    }
    toast({ title: 'Reminder sent', body: `Email sent to ${doc.recipient?.email}` });
  };

  const connectDrive = () => {
    update({ ...store, driveConnected: !store.driveConnected });
    toast({
      title: store.driveConnected ? 'Disconnected from Google Drive' : 'Connected to Google Drive',
      body: store.driveConnected ? 'Auto-sync paused.' : 'New completed documents will auto-save to Drive.',
      icon: <Icons.Globe size={16} sw={1.8}/>,
    });
  };

  return (
    <div style={{ padding: '24px 32px 120px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
        <div className="seg" style={{ padding: 4 }}>
          <button className={tab==='inbox'?'on':''}    onClick={()=>setTab('inbox')}>Inbox <span style={{ opacity:0.6 }}>· {inbox.length}</span></button>
          <button className={tab==='vault'?'on':''}    onClick={()=>setTab('vault')}>Vault <span style={{ opacity:0.6 }}>· {completed.length}</span></button>
          <button className={tab==='templates'?'on':''} onClick={()=>setTab('templates')}>Templates <span style={{ opacity:0.6 }}>· {store.templates.length}</span></button>
        </div>
        <div style={{ flex: 1 }}/>
        <button className={`btn ${store.driveConnected ? 'btn-outline' : 'btn-ghost'}`}
          onClick={connectDrive}
          title={store.driveConnected ? 'Google Drive connected' : 'Connect Google Drive'}>
          <DriveIcon connected={store.driveConnected}/>
          {store.driveConnected ? 'Drive · Synced' : 'Connect Drive'}
        </button>
        <div style={{ position:'relative' }}>
          <button className="btn btn-primary" onClick={()=>setNewMenuOpen(v=>!v)}>
            <Icons.Plus size={14} sw={2}/> New document
          </button>
          {newMenuOpen && (
            <>
              <div onClick={()=>setNewMenuOpen(false)} style={{ position:'fixed', inset:0, zIndex: 50 }}/>
              <div className="card" style={{
                position:'absolute', top:'100%', right:0, marginTop:6, width: 260, zIndex: 60,
                padding: 6, display: 'flex', flexDirection: 'column', gap: 2,
                boxShadow:'0 12px 30px -8px rgba(0,0,0,0.25)',
              }}>
                <MenuItem icon={<Icons.Doc size={15} sw={1.7}/>} title="Upload PDF" subtitle="Drop in an existing contract" onClick={createFromPdf}/>
                <MenuItem icon={<Icons.Edit size={15} sw={1.7}/>} title="Write new document" subtitle="Blank, formatted text" onClick={createFromBlank}/>
                <div style={{ height:1, background:'var(--border)', margin:'4px 8px' }}/>
                <div style={{ fontSize:10.5, padding:'6px 10px 2px', color:'var(--muted)', textTransform:'uppercase', letterSpacing:'0.08em', fontWeight:600 }}>From template</div>
                {store.templates.map(t => (
                  <MenuItem key={t.id} icon={<Icons.Copy size={15} sw={1.7}/>} title={t.name} subtitle={`${t.pages.length} page · ${t.fields.length} fields`} onClick={()=>createFromTemplate(t.id)}/>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {tab === 'inbox' && (
        <DocList
          docs={inbox}
          empty="No active documents. Click New document to get started."
          actions={(d) => (
            <>
              {d.status === 'draft' && <button className="btn btn-primary" onClick={(e)=>{ e.stopPropagation(); setSending(d.id); }}><Icons.Arrow size={13} sw={2}/> Prepare & send</button>}
              {d.status === 'sent' && <button className="btn btn-outline" onClick={(e)=>{ e.stopPropagation(); sendReminder(d); }}><Icons.Bell size={13} sw={1.8}/> Send reminder{d.reminders ? ` (${d.reminders})` : ''}</button>}
              {d.status === 'sent' && <button className="btn btn-ghost" onClick={(e)=>{ e.stopPropagation(); voidDoc(d.id); }} style={{ color:'var(--danger)' }}>Void</button>}
              <button className="btn btn-ghost" onClick={(e)=>{ e.stopPropagation(); setEditing(d.id); }}><Icons.Edit size={13} sw={1.7}/></button>
              <button className="btn btn-ghost" onClick={(e)=>{ e.stopPropagation(); deleteDoc(d.id); }} style={{ color:'var(--danger)' }}><Icons.Trash size={13} sw={1.7}/></button>
            </>
          )}
          onOpen={(d) => { if (d.status === 'draft') setEditing(d.id); else setViewing(d.id); }}
        />
      )}

      {tab === 'vault' && <VaultView store={store} onOpen={(id)=>setViewing(id)} />}

      {tab === 'templates' && <TemplatesView store={store} update={update} toast={toast} setEditing={setEditing} />}

      {/* Modals */}
      {editing && <DocumentEditor docId={editing} store={store} update={update} onClose={()=>setEditing(null)} onRequestSend={(id)=>{ setEditing(null); setSending(id); }}/>}
      {sending && <SendDialog docId={sending} store={store} update={update} toast={toast} onClose={()=>setSending(null)}/>}
      {viewing && <DocViewer docId={viewing} store={store} onClose={()=>setViewing(null)}/>}
    </div>
  );
}

function MenuItem({ icon, title, subtitle, onClick }) {
  return (
    <div onClick={onClick} style={{
      padding: '8px 10px', display:'flex', gap:10, alignItems:'center', cursor:'pointer', borderRadius: 8,
    }} onMouseEnter={e=>e.currentTarget.style.background='var(--surface-2)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
      <div style={{ color:'var(--muted)', width: 20, display:'flex', justifyContent:'center' }}>{icon}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize: 13, fontWeight: 550 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{subtitle}</div>}
      </div>
    </div>
  );
}

function DriveIcon({ connected }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight:2 }}>
      <path d="M9 3h6l6 10-3 5H6l-3-5L9 3z" stroke={connected ? '#1FA463' : 'currentColor'} strokeWidth="1.6" strokeLinejoin="round"/>
      <path d="M9 3l-6 10M15 3l6 10M6 18L15 3" stroke={connected ? '#1FA463' : 'currentColor'} strokeWidth="1.6"/>
    </svg>
  );
}

/* ============ Document list (shared) ============ */
function DocList({ docs, empty, actions, onOpen }) {
  if (docs.length === 0) return <div className="card" style={{ padding: 48, textAlign:'center', color:'var(--muted)', fontSize: 13 }}>{empty}</div>;
  return (
    <div className="card" style={{ overflow:'hidden' }}>
      <div style={{
        display:'grid', gridTemplateColumns:'1fr 220px 140px 120px auto',
        padding:'10px 18px', fontSize:10.5, color:'var(--muted)', fontWeight:600,
        letterSpacing:'0.08em', textTransform:'uppercase', borderBottom:'1px solid var(--border)',
      }}>
        <div>Document</div><div>Recipient</div><div>Status</div><div>Updated</div><div/>
      </div>
      {docs.map((d, i) => {
        const meta = STATUS_META[d.status] || STATUS_META.draft;
        const ts = d.completedAt || d.sentAt || (d.activity?.[d.activity.length-1]?.ts) || 0;
        return (
          <div key={d.id} onClick={()=>onOpen(d)} style={{
            display:'grid', gridTemplateColumns:'1fr 220px 140px 120px auto', alignItems:'center', gap: 8,
            padding:'14px 18px', borderTop: i>0 ? '1px solid var(--border)' : 'none', cursor:'pointer',
          }}>
            <div style={{ display:'flex', alignItems:'center', gap: 12, minWidth:0 }}>
              <div style={{
                width:36, height:42, background:'var(--surface-2)', borderRadius:4, border:'1px solid var(--border)',
                display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, color:'var(--muted)',
                fontSize: 9, fontWeight:700, letterSpacing:'0.05em',
              }}>{d.kind === 'pdf' ? 'PDF' : 'DOC'}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight:600, fontSize:14, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{d.name}</div>
                <div style={{ fontSize:11, color:'var(--muted)', marginTop:2 }}>{d.pageCount || d.pages.length} page{(d.pageCount||d.pages.length)>1?'s':''} · {d.fields.length} field{d.fields.length!==1?'s':''}</div>
              </div>
            </div>
            <div style={{ fontSize:13, color: d.recipient ? 'var(--fg)' : 'var(--muted)' }}>
              {d.recipient ? d.recipient.name : 'No recipient'}
              {d.recipient && <div style={{ fontSize:11, color:'var(--muted)' }}>{d.recipient.email}</div>}
            </div>
            <div>
              <span style={{
                display:'inline-block', padding:'3px 9px', borderRadius:99, fontSize:11, fontWeight:600,
                background: meta.bg, color: meta.fg,
              }}>{meta.label}</span>
            </div>
            <div style={{ fontSize:12, color:'var(--muted)' }}>{ts ? relTime(ts) : '-'}</div>
            <div style={{ display:'flex', gap:4, justifyContent:'flex-end', flexWrap:'nowrap' }}>
              {actions(d)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function relTime(ts) {
  const diff = Date.now() - ts;
  const d = Math.floor(diff / 86400e3);
  if (d > 14) return new Date(ts).toLocaleDateString();
  if (d >= 1) return `${d}d ago`;
  const h = Math.floor(diff / 3600e3);
  if (h >= 1) return `${h}h ago`;
  const m = Math.floor(diff / 60e3);
  if (m >= 1) return `${m}m ago`;
  return 'just now';
}

/* ============ VAULT ============ */
function VaultView({ store, onOpen }) {
  const [q, setQ] = React.useState('');
  const completed = store.documents.filter(d => d.status === 'completed');
  const filtered = completed.filter(d => !q || d.name.toLowerCase().includes(q.toLowerCase()) || d.recipient?.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div style={{
        display:'flex', alignItems:'center', gap: 8, padding:'8px 14px',
        border:'1px solid var(--border-strong)', borderRadius:10, marginBottom: 14, background: 'var(--surface-2)', maxWidth: 420,
      }}>
        <Icons.Search size={14} stroke="var(--muted)"/>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search completed documents"
          style={{ flex:1, background:'none', border:0, outline:'none', fontSize:13, color:'var(--fg)' }}/>
      </div>
      {store.driveConnected && (
        <div style={{
          padding:'10px 14px', borderRadius: 10, marginBottom: 14, display:'flex', alignItems:'center', gap: 10,
          background: 'color-mix(in srgb, #1FA463 10%, var(--surface))', border:'1px solid color-mix(in srgb, #1FA463 28%, var(--border))',
          fontSize: 12.5,
        }}>
          <DriveIcon connected/>
          <div style={{ flex:1 }}>Google Drive is connected. Completed documents auto-save to <b>Ivy OS / Signed documents</b>.</div>
          <span style={{ fontSize:11, color:'var(--muted)' }}>{completed.length} synced</span>
        </div>
      )}
      <DocList
        docs={filtered}
        empty="Completed documents will live here."
        onOpen={(d)=>onOpen(d.id)}
        actions={(d) => (
          <>
            <button className="btn btn-outline" onClick={(e)=>{ e.stopPropagation(); onOpen(d.id); }}>View</button>
          </>
        )}
      />
    </>
  );
}

/* ============ TEMPLATES ============ */
function TemplatesView({ store, update, toast, setEditing }) {
  const createTemplate = () => {
    const name = prompt("Template name", "New template");
    if (!name) return;
    const id = 't' + Date.now();
    update({ ...store, templates: [...store.templates, {
      id, name, kind:'written',
      pages:[{ kind:'written', html:`<h1>${name}</h1><p>Write your template here…</p>` }],
      fields: [],
    }]});
    toast({ title: 'Template created', body: name });
  };
  const rename = (t) => {
    const name = prompt("Rename template", t.name);
    if (!name) return;
    update({ ...store, templates: store.templates.map(x => x.id === t.id ? { ...x, name } : x) });
  };
  const del = (t) => {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    update({ ...store, templates: store.templates.filter(x => x.id !== t.id) });
  };
  const saveAsDocAndEdit = (t) => {
    // Templates editor: clone to a temp doc, edit, then save back to template
    const tempDocId = 'temp-' + t.id;
    const tempDoc = {
      id: tempDocId, name: t.name, kind: t.kind, pageCount: t.pages.length,
      pages: JSON.parse(JSON.stringify(t.pages)),
      fields: JSON.parse(JSON.stringify(t.fields)),
      __template: t.id, status:'draft', activity:[], reminders:0,
    };
    update({ ...store, documents: [tempDoc, ...store.documents] });
    setEditing(tempDocId);
  };

  return (
    <>
      <div style={{ display:'flex', marginBottom: 14 }}>
        <div style={{ flex:1 }}/>
        <button className="btn btn-primary" onClick={createTemplate}><Icons.Plus size={14} sw={2}/> New template</button>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
        {store.templates.map(t => (
          <div key={t.id} className="card" style={{ padding: 16, display:'flex', flexDirection:'column', gap: 10 }}>
            <div style={{
              height:120, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius: 8,
              padding: 12, fontSize: 10, color:'var(--muted)', overflow:'hidden', position: 'relative',
            }}>
              <div style={{ fontWeight:700, color:'var(--fg-2)', marginBottom: 4, fontSize:11 }}>{t.name}</div>
              <div dangerouslySetInnerHTML={{ __html: (t.pages[0]?.html || '').replace(/<h1>/g,'<b style="font-size:11px">').replace(/<\/h1>/g,'</b><br/>') }}/>
              <div style={{ position: 'absolute', right: 8, bottom: 8, fontSize: 9, color: 'var(--muted)', background:'var(--surface)', padding:'2px 6px', borderRadius: 4, border:'1px solid var(--border)' }}>
                {t.fields.length} fields
              </div>
            </div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{t.name}</div>
            <div style={{ display:'flex', gap: 6 }}>
              <button className="btn btn-outline" style={{ flex:1, justifyContent:'center' }} onClick={()=>saveAsDocAndEdit(t)}>
                <Icons.Edit size={13} sw={1.7}/> Edit
              </button>
              <button className="btn btn-ghost" onClick={()=>rename(t)} title="Rename"><Icons.Edit size={13} sw={1.7}/></button>
              <button className="btn btn-ghost" onClick={()=>del(t)} style={{ color:'var(--danger)' }} title="Delete"><Icons.Trash size={13} sw={1.7}/></button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ============ DOCUMENT EDITOR ============ */
const FIELD_TYPES = [
  { id:'signature', label:'Signature', icon:<Icons.Edit size={13} sw={1.8}/>,  defaultSize:{w:40, h:6} },
  { id:'initial',   label:'Initial',   icon:<Icons.Edit size={13} sw={1.8}/>,  defaultSize:{w:8,  h:6} },
  { id:'date',      label:'Date',      icon:<Icons.Clock size={13} sw={1.8}/>, defaultSize:{w:24, h:6} },
  { id:'text',      label:'Text',      icon:<Icons.Doc size={13} sw={1.8}/>,   defaultSize:{w:30, h:6} },
  { id:'checkbox',  label:'Checkbox',  icon:<Icons.Check size={13} sw={2.2}/>, defaultSize:{w:4,  h:4} },
];

function DocumentEditor({ docId, store, update, onClose, onRequestSend }) {
  const doc = store.documents.find(d => d.id === docId);
  const [selFieldId, setSelFieldId] = React.useState(null);
  const [activePage, setActivePage] = React.useState(0);
  const pagesRefs = React.useRef({});
  const isTemplate = !!doc?.__template;

  if (!doc) return null;

  const patch = (changes) => {
    update({ ...store, documents: store.documents.map(d => d.id === docId ? { ...d, ...changes } : d) });
  };
  const patchField = (fid, changes) => {
    patch({ fields: doc.fields.map(f => f.id === fid ? { ...f, ...changes } : f) });
  };
  const removeField = (fid) => {
    patch({ fields: doc.fields.filter(f => f.id !== fid) });
    setSelFieldId(null);
  };

  // Drag from toolbar: use HTML5 DnD
  const onPageDrop = (pageIdx, e) => {
    e.preventDefault();
    const typeId = e.dataTransfer.getData('application/x-ivy-field');
    if (!typeId) return;
    const type = FIELD_TYPES.find(t => t.id === typeId);
    const rect = e.currentTarget.getBoundingClientRect();
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top)  / rect.height) * 100;
    const w = type.defaultSize.w, h = type.defaultSize.h;
    const id = 'f' + Date.now();
    patch({ fields: [...doc.fields, { id, page: pageIdx, x: Math.max(0, xPct - w/2), y: Math.max(0, yPct - h/2), w, h, type: typeId, label: type.label, value:'' }] });
    setSelFieldId(id);
  };

  const saveTemplate = () => {
    if (!isTemplate) return;
    // commit this doc back to its template and delete the temp doc
    const tid = doc.__template;
    update({
      ...store,
      templates: store.templates.map(t => t.id === tid ? {
        ...t, name: doc.name, kind: doc.kind, pages: doc.pages, fields: doc.fields,
      } : t),
      documents: store.documents.filter(d => d.id !== doc.id),
    });
    onClose();
  };

  return (
    <div style={{
      position:'fixed', inset:0, background:'var(--page)', zIndex: 120,
      display:'flex', flexDirection:'column',
    }}>
      {/* Top bar */}
      <div style={{
        padding:'12px 22px', borderBottom:'1px solid var(--border)', background:'var(--surface)',
        display:'flex', alignItems:'center', gap: 14,
      }}>
        <button className="btn btn-ghost" onClick={onClose}><Icons.Arrow size={14} style={{ transform:'rotate(180deg)' }}/> Close</button>
        <div style={{ height: 24, width:1, background:'var(--border)' }}/>
        <input value={doc.name} onChange={e=>patch({ name: e.target.value })} style={{
          background:'none', border:0, outline:'none', fontFamily:'var(--font-display)', fontSize: 18, fontWeight: 500,
          letterSpacing:'-0.02em', color:'var(--fg)', minWidth: 300, padding: '4px 8px', borderRadius: 6,
        }}/>
        <span style={{ fontSize:11, color:'var(--muted)' }}>{isTemplate ? 'Template' : doc.kind === 'pdf' ? 'PDF · ' + doc.fileName : 'Written document'}</span>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize:11, color:'var(--muted)' }}>Auto-saving</span>
        {isTemplate ? (
          <button className="btn btn-primary" onClick={saveTemplate}><Icons.Check size={13} sw={2.2}/> Save template</button>
        ) : (
          <button className="btn btn-primary" onClick={()=>onRequestSend(doc.id)} disabled={doc.fields.length === 0}>
            <Icons.Arrow size={13} sw={2}/> Prepare & send
          </button>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, display:'flex', minHeight: 0 }}>
        {/* Left: field toolbar */}
        <div style={{ width: 220, borderRight:'1px solid var(--border)', background:'var(--surface)', padding: 16, overflowY:'auto' }}>
          <div style={{ fontSize:10.5, color:'var(--muted)', fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', marginBottom: 10 }}>
            Drag onto page
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap: 6 }}>
            {FIELD_TYPES.map(ft => (
              <div key={ft.id}
                draggable
                onDragStart={e => e.dataTransfer.setData('application/x-ivy-field', ft.id)}
                onTouchStart={() => { /* simple add-on-tap fallback */
                  const id = 'f' + Date.now();
                  patch({ fields: [...doc.fields, { id, page: activePage, x: 10, y: 30, w: ft.defaultSize.w, h: ft.defaultSize.h, type: ft.id, label: ft.label, value:'' }] });
                  setSelFieldId(id);
                }}
                style={{
                  padding: '10px 12px', display:'flex', alignItems:'center', gap: 10,
                  background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius: 8,
                  fontSize: 13, fontWeight: 500, cursor: 'grab', userSelect: 'none',
                }}>
                <span style={{ color:'var(--accent)' }}>{ft.icon}</span>
                {ft.label}
              </div>
            ))}
          </div>

          <div style={{ fontSize:10.5, color:'var(--muted)', fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', margin:'22px 0 10px' }}>
            Pages
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap: 4 }}>
            {doc.pages.map((p, i) => (
              <button key={i} onClick={()=>{ setActivePage(i); pagesRefs.current[i]?.scrollIntoView({ block:'start' }); }}
                style={{
                  padding:'8px 10px', borderRadius: 6, fontSize: 12, textAlign:'left',
                  background: activePage === i ? 'var(--accent-soft)' : 'transparent',
                  color: activePage === i ? 'var(--accent)' : 'var(--fg-2)',
                  fontWeight: activePage === i ? 600 : 500,
                }}>
                Page {i + 1}
                <span style={{ color:'var(--muted)', marginLeft: 6, fontWeight: 400 }}>
                  · {doc.fields.filter(f=>f.page===i).length} field{doc.fields.filter(f=>f.page===i).length!==1?'s':''}
                </span>
              </button>
            ))}
            {doc.kind === 'written' && (
              <button className="btn btn-ghost" style={{ fontSize:11, marginTop: 4 }} onClick={()=>{
                patch({ pages: [...doc.pages, { kind:'written', html:'<p>…</p>' }], pageCount: (doc.pageCount||doc.pages.length)+1 });
              }}><Icons.Plus size={12} sw={2}/> Add page</button>
            )}
          </div>
        </div>

        {/* Center: pages canvas */}
        <div className="scroll" style={{ flex: 1, overflowY:'auto', padding: 24, background:'var(--page)' }}>
          <div style={{ maxWidth: 780, margin: '0 auto', display:'flex', flexDirection:'column', gap: 18 }}>
            {doc.pages.map((page, pi) => (
              <div key={pi} ref={el => { if (el) pagesRefs.current[pi] = el; }}>
                <div style={{ fontSize: 11, color:'var(--muted)', marginBottom: 6 }}>Page {pi + 1} of {doc.pages.length}</div>
                <div
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => onPageDrop(pi, e)}
                  onClick={() => setSelFieldId(null)}
                  style={{
                    position:'relative', background:'#fff', color:'#222', borderRadius: 4,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)', aspectRatio: '8.5 / 11',
                    overflow:'hidden', border: `1px solid ${activePage === pi ? 'var(--accent)' : 'var(--border)'}`,
                  }}>
                  {page.kind === 'pdf' ? (
                    <PdfPagePlaceholder pageNum={pi + 1} fileName={doc.fileName}/>
                  ) : (
                    <WrittenPageEditor
                      html={page.html}
                      onChange={(html) => patch({ pages: doc.pages.map((p,i)=>i===pi?{...p,html}:p) })}
                    />
                  )}
                  {/* Fields overlay */}
                  {doc.fields.filter(f => f.page === pi).map(f => (
                    <FieldBox
                      key={f.id} field={f} selected={selFieldId===f.id}
                      onSelect={()=>setSelFieldId(f.id)}
                      onMove={(x,y)=>patchField(f.id, { x, y })}
                      onResize={(w,h)=>patchField(f.id, { w, h })}
                      onDelete={()=>removeField(f.id)}
                      onLabel={(label)=>patchField(f.id, { label })}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PdfPagePlaceholder({ pageNum, fileName }) {
  return (
    <div style={{
      position:'absolute', inset: 0, display:'flex', flexDirection:'column', padding: '10% 10%',
      fontFamily: 'Georgia, serif', color: '#666', pointerEvents:'none', background:
        'repeating-linear-gradient(transparent 0 32px, rgba(0,0,0,0.04) 32px 33px)',
    }}>
      <div style={{ fontSize:11, color:'#999', marginBottom: 14 }}>{fileName || 'document.pdf'} · page {pageNum}</div>
      <div style={{
        height: 10, background:'rgba(0,0,0,0.08)', borderRadius: 2, marginBottom: 16, width: '70%',
      }}/>
      {[...Array(14)].map((_,i) => (
        <div key={i} style={{
          height: 6, background:'rgba(0,0,0,0.06)', borderRadius: 2, marginBottom: 12,
          width: `${60 + (i*7)%35}%`,
        }}/>
      ))}
    </div>
  );
}

function WrittenPageEditor({ html, onChange }) {
  const ref = React.useRef(null);
  const onInput = () => onChange(ref.current.innerHTML);
  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onInput={onInput}
      onBlur={onInput}
      style={{
        position:'absolute', inset:0, padding: '10% 10% 12%', outline:'none',
        fontFamily: 'Georgia, "Times New Roman", serif', fontSize: 13, lineHeight: 1.6, color: '#222',
        overflow: 'auto',
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function FieldBox({ field, selected, onSelect, onMove, onResize, onDelete, onLabel }) {
  const COLORS = {
    signature: { bg:'rgba(255,215,130,0.55)', br:'#E4A84A' },
    initial:   { bg:'rgba(255,215,130,0.55)', br:'#E4A84A' },
    date:      { bg:'rgba(174,214,255,0.6)',  br:'#4B88C0' },
    text:      { bg:'rgba(198,229,200,0.6)',  br:'#4C9960' },
    checkbox:  { bg:'rgba(221,204,248,0.65)', br:'#7A63C0' },
  };
  const c = COLORS[field.type] || COLORS.text;

  const dragRef = React.useRef({});
  const startDrag = (e, mode) => {
    e.stopPropagation();
    const parent = e.currentTarget.closest('[data-page]') || e.currentTarget.parentElement;
    const rect = parent.getBoundingClientRect();
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, rect, orig: { ...field } };
    window.addEventListener('pointermove', onMoveE);
    window.addEventListener('pointerup', endDrag);
  };
  const onMoveE = (e) => {
    const { mode, startX, startY, rect, orig } = dragRef.current;
    if (!rect) return;
    const dxPct = ((e.clientX - startX) / rect.width) * 100;
    const dyPct = ((e.clientY - startY) / rect.height) * 100;
    if (mode === 'move') {
      onMove(Math.max(0, Math.min(100 - orig.w, orig.x + dxPct)), Math.max(0, Math.min(100 - orig.h, orig.y + dyPct)));
    } else if (mode === 'resize') {
      onResize(Math.max(4, Math.min(100 - orig.x, orig.w + dxPct)), Math.max(3, Math.min(100 - orig.y, orig.h + dyPct)));
    }
  };
  const endDrag = () => {
    dragRef.current = {};
    window.removeEventListener('pointermove', onMoveE);
    window.removeEventListener('pointerup', endDrag);
  };

  return (
    <div
      data-page
      onClick={(e)=>{ e.stopPropagation(); onSelect(); }}
      onPointerDown={(e)=>{ onSelect(); startDrag(e, 'move'); }}
      style={{
        position:'absolute', left: `${field.x}%`, top: `${field.y}%`,
        width: `${field.w}%`, height: `${field.h}%`,
        background: c.bg, border: `1.5px ${selected ? 'solid' : 'dashed'} ${c.br}`,
        borderRadius: 3, cursor: 'move', display:'flex', alignItems:'center', justifyContent:'center',
        fontSize: 10, color:'#333', fontWeight: 600, padding: '2px 6px', userSelect:'none',
        boxShadow: selected ? '0 0 0 3px rgba(224,160,60,0.25)' : 'none', zIndex: selected ? 3 : 2,
      }}
    >
      <span style={{ pointerEvents:'none', textTransform:'capitalize' }}>{field.type}</span>
      {selected && (
        <>
          <div onPointerDown={(e)=>{ e.stopPropagation(); startDrag(e, 'resize'); }}
            style={{ position:'absolute', right:-5, bottom:-5, width:10, height:10, background: c.br, borderRadius: 2, cursor:'nwse-resize' }}/>
          <button onClick={(e)=>{ e.stopPropagation(); onDelete(); }}
            style={{
              position:'absolute', top:-10, right:-10, width:20, height:20, borderRadius:99,
              background: '#fff', border: `1px solid ${c.br}`, display:'flex', alignItems:'center', justifyContent:'center',
              cursor:'pointer', color:'#333', zIndex: 4,
            }}>
            <Icons.X size={11} sw={2}/>
          </button>
        </>
      )}
    </div>
  );
}

/* ============ SEND DIALOG ============ */
function SendDialog({ docId, store, update, toast, onClose }) {
  const doc = store.documents.find(d => d.id === docId);
  const [name, setName]   = React.useState(doc?.recipient?.name || '');
  const [email, setEmail] = React.useState(doc?.recipient?.email || '');
  const [clientId, setClientId] = React.useState(doc?.recipient?.clientId || '');
  const [message, setMessage] = React.useState(`Hi${doc?.recipient?.name ? ' ' + doc.recipient.name.split(' ')[0] : ''}, please review and sign.`);

  // pull clients from messages store
  const msgsStore = (() => {
    try { return JSON.parse(localStorage.getItem('Ivy OS:messages')) || { clients: [] }; }
    catch { return { clients: [] }; }
  })();
  const registered = (msgsStore.clients || []).filter(c => c.registered);

  const pick = (c) => { setClientId(c.id); setName(c.name); setEmail(c.email); };

  const send = () => {
    if (!clientId) { alert('Only registered clients can receive documents.'); return; }
    const recipient = { clientId, name, email };
    const updated = {
      ...doc, recipient, status: 'sent', sentAt: Date.now(),
      activity: [...(doc.activity||[]), { ts: Date.now(), kind:'sent', text: `Sent to ${name}` }],
    };
    update({ ...store, documents: store.documents.map(d => d.id === docId ? updated : d) });
    pushDocMessage(clientId, { kind:'doc-sent', from:'biz', docId: doc.id, docName: doc.name, noteText: message });
    toast({ title: 'Document sent', body: `Email + in-app notification delivered to ${email}` });
    onClose();
  };

  if (!doc) return null;

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(10,12,8,0.55)', zIndex: 130, display:'flex', alignItems:'center', justifyContent:'center', padding: 20 }} onClick={onClose}>
      <div className="card" style={{ width:'100%', maxWidth: 540, padding: 24, maxHeight:'90vh', overflow:'auto' }} onClick={e=>e.stopPropagation()}>
        <div style={{ fontSize:11, color:'var(--muted)', letterSpacing:'0.1em', textTransform:'uppercase', fontWeight:600 }}>Prepare & send</div>
        <h3 style={{ margin:'4px 0 18px', fontSize:20, fontWeight:600, letterSpacing:'-0.02em' }}>{doc.name}</h3>

        <div style={{ fontSize: 12, color:'var(--muted)', marginBottom: 8, fontWeight: 500 }}>Recipient - registered clients only</div>
        <div style={{
          border:'1px solid var(--border)', borderRadius: 10, maxHeight: 180, overflow:'auto', marginBottom: 14,
        }}>
          {registered.map(c => (
            <div key={c.id} onClick={()=>pick(c)} style={{
              padding:'10px 12px', display:'flex', gap: 10, alignItems:'center', cursor:'pointer',
              background: clientId === c.id ? 'var(--accent-soft)' : 'transparent',
              borderLeft: `3px solid ${clientId === c.id ? 'var(--accent)' : 'transparent'}`,
            }}>
              <div style={{ width:30, height:30, borderRadius: 8, background: c.accent, color:'#333',
                display:'flex', alignItems:'center', justifyContent:'center', fontWeight:600, fontFamily:'var(--font-display)' }}>
                {c.name[0]}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:550, fontSize: 13 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.email}</div>
              </div>
              {clientId === c.id && <Icons.Check size={14} sw={2.2} stroke="var(--accent)"/>}
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12, color:'var(--muted)', marginBottom: 6, fontWeight: 500 }}>Message to recipient</div>
        <textarea value={message} onChange={e=>setMessage(e.target.value)} rows={3}
          style={{ width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--border-strong)',
            background:'var(--surface)', color:'var(--fg)', fontSize:13, resize:'vertical', fontFamily:'inherit', outline:'none' }}/>

        <div style={{ display:'flex', gap: 10, marginTop: 22 }}>
          <button className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent:'center' }}>Cancel</button>
          <button className="btn btn-primary" onClick={send} disabled={!clientId}
            style={{ flex: 2, justifyContent:'center' }}>
            <Icons.Arrow size={13} sw={2}/> Send document
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============ VIEWER (read-only, for completed or in-progress) ============ */
function DocViewer({ docId, store, onClose }) {
  const doc = store.documents.find(d => d.id === docId);
  if (!doc) return null;
  return (
    <div style={{
      position:'fixed', inset:0, background:'var(--page)', zIndex: 120, display:'flex', flexDirection:'column',
    }}>
      <div style={{ padding:'12px 22px', borderBottom:'1px solid var(--border)', background:'var(--surface)', display:'flex', alignItems:'center', gap: 14 }}>
        <button className="btn btn-ghost" onClick={onClose}><Icons.Arrow size={14} style={{ transform:'rotate(180deg)' }}/> Close</button>
        <div style={{ height:24, width:1, background:'var(--border)' }}/>
        <div style={{ fontFamily:'var(--font-display)', fontSize: 18, fontWeight: 500, letterSpacing:'-0.02em' }}>{doc.name}</div>
        <span style={{ padding:'3px 9px', borderRadius:99, fontSize:11, fontWeight:600, background: STATUS_META[doc.status]?.bg, color: STATUS_META[doc.status]?.fg }}>
          {STATUS_META[doc.status]?.label}
        </span>
        <div style={{ flex:1 }}/>
        {doc.recipient && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{doc.recipient.name} · {doc.recipient.email}</span>}
      </div>
      <div style={{ flex:1, display:'flex', minHeight: 0 }}>
        <div className="scroll" style={{ flex:1, overflowY:'auto', padding: 24 }}>
          <div style={{ maxWidth: 780, margin:'0 auto', display:'flex', flexDirection:'column', gap: 18 }}>
            {doc.pages.map((page, pi) => (
              <div key={pi} style={{
                position:'relative', background:'#fff', color:'#222', borderRadius: 4,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)', aspectRatio:'8.5 / 11', overflow:'hidden',
              }}>
                {page.kind === 'pdf'
                  ? <PdfPagePlaceholder pageNum={pi+1} fileName={doc.fileName}/>
                  : <div style={{ position:'absolute', inset:0, padding: '10%', fontFamily:'Georgia, serif', fontSize: 13, color:'#222', overflow:'auto' }}
                      dangerouslySetInnerHTML={{ __html: page.html }}/>}
                {doc.fields.filter(f=>f.page===pi).map(f => (
                  <div key={f.id} style={{
                    position:'absolute', left:`${f.x}%`, top:`${f.y}%`, width:`${f.w}%`, height:`${f.h}%`,
                    background: f.value ? 'rgba(198,229,200,0.3)' : 'rgba(255,215,130,0.3)',
                    border: `1px solid ${f.value ? '#4C9960' : '#E4A84A'}`, borderRadius: 3,
                    display:'flex', alignItems:'center', justifyContent:'center', fontSize: 11,
                    fontFamily: f.type === 'signature' ? '"Dancing Script", cursive' : 'inherit',
                    color:'#333', fontWeight: f.type === 'signature' ? 600 : 500,
                    padding:'2px 6px', overflow:'hidden',
                  }}>{f.value || `(${f.type})`}</div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div style={{ width: 320, borderLeft:'1px solid var(--border)', background:'var(--surface)', padding: 20, overflowY:'auto' }}>
          <div style={{ fontSize:10.5, color:'var(--muted)', fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', marginBottom: 10 }}>
            Activity
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap: 12 }}>
            {(doc.activity || []).slice().reverse().map((a, i) => (
              <div key={i} style={{ display:'flex', gap: 10, fontSize: 12 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: 99, marginTop: 5,
                  background: a.kind === 'completed' ? 'var(--ok)' : a.kind === 'sent' ? 'var(--accent)' : 'var(--muted-2)',
                  flexShrink: 0,
                }}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight: 550 }}>{a.text}</div>
                  <div style={{ color:'var(--muted)', fontSize:11, marginTop: 2 }}>{new Date(a.ts).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ SIGNING FLOW (client) ============ */
function SigningModal({ docId, onClose }) {
  const [store, update] = useDocsStore();
  const doc = store.documents.find(d => d.id === docId);
  const toast = useToast();
  const [active, setActive] = React.useState(null);
  const [sigText, setSigText] = React.useState('');

  if (!doc) return (
    <div style={{ position:'fixed', inset:0, background:'var(--page)', zIndex: 140, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div>Document not found. <button className="btn btn-outline" onClick={onClose}>Close</button></div>
    </div>
  );

  const allFilled = doc.fields.every(f => f.value && f.value.trim());
  const remaining = doc.fields.filter(f => !f.value || !f.value.trim()).length;

  const fillField = (fid, value) => {
    update({ ...store, documents: store.documents.map(d => d.id === docId
      ? { ...d, fields: d.fields.map(f => f.id === fid ? { ...f, value } : f) }
      : d) });
    setActive(null); setSigText('');
  };

  const complete = () => {
    const updatedDoc = {
      ...doc, status:'completed', completedAt: Date.now(),
      activity: [...(doc.activity||[]), { ts: Date.now(), kind:'completed', text:`${doc.recipient?.name || 'Client'} signed and completed the document` }],
    };
    update({ ...store, documents: store.documents.map(d => d.id === docId ? updatedDoc : d) });
    if (doc.recipient?.clientId) {
      pushDocMessage(doc.recipient.clientId, { kind:'doc-completed', from:'system', docId: doc.id, docName: doc.name });
    }
    toast({ title: 'Document completed', body: `Email sent to both you and ${doc.recipient?.email || 'your business'}.` });
    onClose();
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'var(--page)', zIndex: 140, display:'flex', flexDirection:'column' }}>
      <div style={{ padding:'12px 22px', borderBottom:'1px solid var(--border)', background:'var(--surface)', display:'flex', alignItems:'center', gap: 14 }}>
        <button className="btn btn-ghost" onClick={onClose}><Icons.X size={14}/> Exit</button>
        <div style={{ height:24, width:1, background:'var(--border)' }}/>
        <div>
          <div style={{ fontFamily:'var(--font-display)', fontSize: 17, fontWeight: 500 }}>{doc.name}</div>
          <div style={{ fontSize:11, color:'var(--muted)' }}>Please review and sign · {remaining} field{remaining!==1?'s':''} remaining</div>
        </div>
        <div style={{ flex:1 }}/>
        <button className="btn btn-primary" onClick={complete} disabled={!allFilled}>
          <Icons.Check size={13} sw={2.2}/> Finish & submit
        </button>
      </div>
      <div className="scroll" style={{ flex:1, overflowY:'auto', padding: 24, background: 'var(--page)' }}>
        <div style={{ maxWidth: 780, margin:'0 auto', display:'flex', flexDirection:'column', gap: 18 }}>
          {doc.pages.map((page, pi) => (
            <div key={pi} style={{
              position:'relative', background:'#fff', color:'#222', borderRadius: 4,
              boxShadow:'0 4px 16px rgba(0,0,0,0.14)', aspectRatio:'8.5 / 11', overflow:'hidden',
            }}>
              {page.kind === 'pdf'
                ? <PdfPagePlaceholder pageNum={pi+1} fileName={doc.fileName}/>
                : <div style={{ position:'absolute', inset:0, padding:'10%', fontFamily:'Georgia, serif', fontSize: 13, color:'#222', overflow:'auto' }}
                    dangerouslySetInnerHTML={{ __html: page.html }}/>}
              {doc.fields.filter(f=>f.page===pi).map(f => {
                const filled = f.value && f.value.trim();
                return (
                  <div key={f.id}
                    onClick={()=>{
                      if (f.type === 'checkbox') { fillField(f.id, f.value ? '' : '✓'); return; }
                      if (f.type === 'date')     { fillField(f.id, new Date().toLocaleDateString()); return; }
                      setActive(f);
                    }}
                    style={{
                      position:'absolute', left:`${f.x}%`, top:`${f.y}%`, width:`${f.w}%`, height:`${f.h}%`,
                      background: filled ? 'rgba(198,229,200,0.45)' : 'rgba(255,215,130,0.6)',
                      border: `1.5px solid ${filled ? '#4C9960' : '#E4A84A'}`,
                      borderRadius: 3, display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize: 12, fontWeight: 600, cursor:'pointer', color:'#333',
                      fontFamily: f.type === 'signature' && filled ? '"Dancing Script", cursive' : 'inherit',
                      padding:'2px 6px', overflow:'hidden',
                    }}>
                    {filled ? f.value : `Tap to ${f.type === 'signature' ? 'sign' : f.type === 'initial' ? 'initial' : f.type === 'checkbox' ? 'check' : 'fill'}`}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {active && (
        <div onClick={()=>setActive(null)} style={{
          position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex: 150,
          display:'flex', alignItems:'center', justifyContent:'center', padding: 20,
        }}>
          <div className="card" style={{ width:'100%', maxWidth: 480, padding: 24 }} onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize: 11, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--muted)', fontWeight: 600 }}>
              {active.type === 'signature' ? 'Adopt your signature' : active.type === 'initial' ? 'Initial' : 'Fill in'}
            </div>
            <h3 style={{ margin:'4px 0 16px', fontSize:18, fontWeight: 600 }}>{active.label}</h3>
            {(active.type === 'signature' || active.type === 'initial') ? (
              <>
                <input value={sigText} onChange={e=>setSigText(e.target.value)} placeholder="Type your full name"
                  style={{ width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--border-strong)', background:'var(--surface-2)', color:'var(--fg)', fontSize: 14, marginBottom: 12, outline:'none' }}/>
                {sigText && (
                  <div style={{
                    padding:'18px', borderRadius: 10, background:'#fff', border:'1px solid var(--border)',
                    marginBottom: 16, display:'flex', alignItems:'center', justifyContent:'center',
                    fontFamily:'"Dancing Script", cursive', fontSize: active.type === 'initial' ? 28 : 40,
                    color:'#1a1a1a', fontWeight: 600,
                  }}>
                    {active.type === 'initial' ? sigText.split(' ').map(w=>w[0]).filter(Boolean).join('').toUpperCase() : sigText}
                  </div>
                )}
              </>
            ) : (
              <input value={sigText} onChange={e=>setSigText(e.target.value)} placeholder={active.label}
                style={{ width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--border-strong)', background:'var(--surface-2)', color:'var(--fg)', fontSize: 14, marginBottom: 16, outline:'none' }}/>
            )}
            <div style={{ display:'flex', gap: 10 }}>
              <button className="btn btn-outline" onClick={()=>setActive(null)} style={{ flex:1, justifyContent:'center' }}>Cancel</button>
              <button className="btn btn-primary" onClick={()=>{
                if (!sigText.trim()) return;
                const value = (active.type === 'initial')
                  ? sigText.split(' ').map(w=>w[0]).filter(Boolean).join('').toUpperCase()
                  : sigText;
                fillField(active.id, value);
              }} style={{ flex:2, justifyContent:'center' }}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Global opener - called from Messages when client taps "Open document" */
function SigningPortal() {
  const [openId, setOpenId] = React.useState(null);
  React.useEffect(() => {
    window.openSigningFlow = (id) => setOpenId(id);
    return () => { delete window.openSigningFlow; };
  }, []);
  if (!openId) return null;
  return (
    <ToastProvider>
      <SigningModal docId={openId} onClose={()=>setOpenId(null)}/>
    </ToastProvider>
  );
}

window.DocumentsView = DocumentsView;
window.SigningPortal = SigningPortal;
