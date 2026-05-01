// Documents list view: header, status tabs, table, editor drawer + send modal.
import React, { useState, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useDocuments } from './state.js';
import DocumentEditor from './DocumentEditor.jsx';
import SendDocumentModal from './SendDocumentModal.jsx';

const STATUS_META = {
  draft:     { label: 'Draft',     color: 'var(--muted)' },
  sent:      { label: 'Awaiting',  color: 'var(--warn)' },
  completed: { label: 'Completed', color: 'var(--ok)' },
  voided:    { label: 'Voided',    color: 'var(--danger)' },
};

export default function Documents() {
  const { documents, loading, error, create, update, remove, send } = useDocuments();
  const [tab, setTab]               = useState('all');
  const [openId, setOpenId]         = useState(null);
  const [creatingOpen, setCreating] = useState(false);
  const [sendingId, setSending]     = useState(null);

  const counts = useMemo(() => ({
    all:       documents.length,
    draft:     documents.filter((d) => d.status === 'draft').length,
    sent:      documents.filter((d) => d.status === 'sent').length,
    completed: documents.filter((d) => d.status === 'completed').length,
    voided:    documents.filter((d) => d.status === 'voided').length,
  }), [documents]);

  const rows = useMemo(() => {
    if (tab === 'all') return documents;
    return documents.filter((d) => d.status === tab);
  }, [documents, tab]);

  const openDoc = documents.find((d) => d.id === openId) || null;
  const sendingDoc = documents.find((d) => d.id === sendingId) || null;

  const handleCreate = async (input) => {
    const d = await create(input);
    setCreating(false);
    setOpenId(d.id);
  };

  if (loading) return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading documents…</div>;
  if (error) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Doc" title="Couldn't load documents" hint={error.message || 'Try refreshing.'}/>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px 96px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Documents</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Send waivers, agreements, or intake forms — clients sign with one click from their email.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icons.Plus size={13} sw={2}/> New document
        </button>
      </div>

      {/* Status tabs */}
      <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 4, borderRadius: 10, alignSelf: 'flex-start' }}>
        {[
          { id: 'all', label: 'All' },
          { id: 'draft', label: 'Drafts' },
          { id: 'sent', label: 'Awaiting' },
          { id: 'completed', label: 'Completed' },
          { id: 'voided', label: 'Voided' },
        ].map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
            background: tab === id ? 'var(--surface)' : 'transparent',
            color: tab === id ? 'var(--fg)' : 'var(--muted)',
            boxShadow: tab === id ? 'var(--shadow-sm)' : 'none',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {label}
            <span style={{
              fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
              background: tab === id ? 'var(--surface-2)' : 'var(--surface)',
              color: 'var(--muted)', fontWeight: 600,
            }}>{counts[id]}</span>
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="card table-scroll" style={{ overflow: 'auto' }}>
        <div>
          <div style={{
            display: 'grid', gridTemplateColumns: '2fr 110px 140px 160px 140px',
            padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div>Document</div><div>Status</div><div>Recipient</div><div>Updated</div><div/>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 48 }}>
              <EmptyNote
                icon="Doc"
                title={tab === 'all' ? 'No documents yet' : `No ${tab}`}
                hint={tab === 'all'
                  ? 'Click "New document" to create your first waiver, agreement, or intake form.'
                  : 'Try a different tab.'}
              />
            </div>
          ) : rows.map((d, i) => (
            <DocRow key={d.id} doc={d} first={i === 0} onOpen={() => setOpenId(d.id)}/>
          ))}
        </div>
      </div>

      {creatingOpen && (
        <CreateDocumentModal onCreate={handleCreate} onClose={() => setCreating(false)}/>
      )}
      {openDoc && (
        <DocumentEditor
          doc={openDoc}
          onClose={() => setOpenId(null)}
          onSave={(patch) => update(openDoc.id, patch)}
          onDelete={async () => { await remove(openDoc.id); setOpenId(null); }}
          onSend={() => setSending(openDoc.id)}
        />
      )}
      {sendingDoc && (
        <SendDocumentModal
          documentName={sendingDoc.name}
          onSend={async (clientId) => { await send(sendingDoc.id, clientId); setSending(null); }}
          onClose={() => setSending(null)}
        />
      )}
    </div>
  );
}

function DocRow({ doc, first, onOpen }) {
  const meta = STATUS_META[doc.status] || STATUS_META.draft;
  return (
    <div onClick={onOpen} style={{
      display: 'grid', gridTemplateColumns: '2fr 110px 140px 160px 140px',
      padding: '14px 20px', alignItems: 'center', cursor: 'pointer',
      borderTop: first ? 'none' : '1px solid var(--border)',
      transition: 'background .1s',
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div style={{
          width: 36, height: 44, borderRadius: 4,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--muted)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
          flexShrink: 0,
        }}>{doc.kind === 'pdf' ? 'PDF' : 'DOC'}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {doc.name}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            {(doc.fields || []).length} field{(doc.fields || []).length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 99,
        fontSize: 11, fontWeight: 600,
        background: 'var(--surface-2)', border: '1px solid var(--border)', color: meta.color,
      }}>
        <span style={{ width: 5, height: 5, borderRadius: 99, background: meta.color }}/>{meta.label}
      </span>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {doc.recipientName || <span style={{ color: 'var(--muted-2)' }}>—</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {new Date(doc.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Icons.Arrow size={13} stroke="var(--muted)"/>
      </div>
    </div>
  );
}

function CreateDocumentModal({ onCreate, onClose }) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try {
      await onCreate({
        name: name.trim(),
        kind: 'written',
        contentHtml: body || `<p>Replace this with your document text.</p>`,
        fields: [],
      });
    } catch (ex) { setErr(ex.message || 'Could not create'); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="card" style={{ padding: 24, width: '100%', maxWidth: 540 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Doc size={16} sw={1.8}/></div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>New document</h3>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <Field label="Name" hint="e.g., Intro Waiver, Cancellation Policy, New Client Intake">
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus
            style={inputSty}/>
        </Field>
        <Field label="Body (optional — you can fill it in after)" hint="Plain text or simple HTML.">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6}
            placeholder="Write the body of your document here…"
            style={{ ...inputSty, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}/>
        </Field>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 14,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button type="button" className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}
            style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Creating…' : 'Create draft'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

const inputSty = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};
