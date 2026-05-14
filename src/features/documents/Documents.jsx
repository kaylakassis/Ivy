// Documents list view: header, status tabs, table, editor drawer + send modal.
import React, { useState, useMemo, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';
import { useDocuments } from './state.js';
import DocumentEditor from './DocumentEditor.jsx';
import SendDocumentModal from './SendDocumentModal.jsx';

const STATUS_META = {
  draft:     { label: 'Draft',     color: 'var(--muted)' },
  sent:      { label: 'Awaiting',  color: 'var(--warn)' },
  completed: { label: 'Completed', color: 'var(--ok)' },
  voided:    { label: 'Voided',    color: 'var(--danger)' },
  declined:  { label: 'Declined',  color: 'var(--danger)' },
};

export default function Documents() {
  const { documents, loading, error, create, createFromTemplate, update, remove, send, resend, uploadPdf } = useDocuments();
  const [tab, setTab]               = useState('all');
  const [openId, setOpenId]         = useState(null);
  const [creatingOpen, setCreating] = useState(false);
  const [sendingId, setSending]     = useState(null);

  // Cmd+K palette deep-link: /documents?doc=<id> opens that document's
  // editor. Param is stripped after consumption so a refresh doesn't
  // re-open the drawer on a doc the user already closed.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const docId = params.get('doc');
    if (!docId) return;
    setOpenId(docId);
    params.delete('doc');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const counts = useMemo(() => ({
    all:       documents.length,
    draft:     documents.filter((d) => d.status === 'draft').length,
    sent:      documents.filter((d) => d.status === 'sent').length,
    completed: documents.filter((d) => d.status === 'completed').length,
    voided:    documents.filter((d) => d.status === 'voided').length,
    declined:  documents.filter((d) => d.status === 'declined').length,
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
  const handleCreateFromTemplate = async (templateId) => {
    const d = await createFromTemplate(templateId);
    setCreating(false);
    setOpenId(d.id);
  };

  if (loading) return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SkelRowList rows={5}/>
    </div>
  );
  if (error) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Doc"
            title="Couldn't load documents"
            hint={error.message || 'Try refreshing.'}
            action={<button className="btn btn-outline" onClick={() => window.location.reload()}>Retry</button>}/>
        </div>
      </div>
    );
  }

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 240 }}>
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
      <div className="tab-row">
        {[
          { id: 'all', label: 'All' },
          { id: 'draft', label: 'Drafts' },
          { id: 'sent', label: 'Awaiting' },
          { id: 'completed', label: 'Completed' },
          { id: 'declined', label: 'Declined' },
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
            <div>Document</div><div>Status</div><div>Signers</div><div>Updated</div><div/>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center' }}>
              <EmptyNote
                icon="Doc"
                title={tab === 'all' ? 'No documents yet' : `No ${tab}`}
                hint={tab === 'all'
                  ? 'Pick a template or start blank — waivers, agreements, intake forms, NDAs.'
                  : 'Try a different tab.'}
              />
              {tab === 'all' && (
                <button className="btn btn-primary" onClick={() => setCreating(true)}
                  style={{ marginTop: 18 }}>
                  <Icons.Plus size={13} sw={2}/> Browse templates
                </button>
              )}
            </div>
          ) : rows.map((d, i) => (
            <DocRow key={d.id} doc={d} first={i === 0} onOpen={() => setOpenId(d.id)}/>
          ))}
        </div>
      </div>

      {creatingOpen && (
        <CreateDocumentModal
          onCreate={handleCreate}
          onCreateFromTemplate={handleCreateFromTemplate}
          onClose={() => setCreating(false)}
        />
      )}
      {openDoc && (
        <DocumentEditor
          doc={openDoc}
          onClose={() => setOpenId(null)}
          onSave={(patch) => update(openDoc.id, patch)}
          onDelete={async () => { await remove(openDoc.id); setOpenId(null); }}
          onSend={() => setSending(openDoc.id)}
          onResend={async () => { await resend(openDoc.id); }}
          onUploadPdf={(file) => uploadPdf(openDoc.id, file)}
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
      <SignerCell doc={doc}/>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {new Date(doc.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Icons.Arrow size={13} stroke="var(--muted)"/>
      </div>
    </div>
  );
}

// Compact "X of Y signed" cell with avatar dots per signer (green =
// signed, yellow = awaiting, red = declined). Fallback to legacy
// recipientName when the doc has no signer rows yet (e.g., predates
// multi-signer or single-signer flow).
function SignerCell({ doc }) {
  const signers = doc.signers || [];
  if (signers.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {doc.recipientName || <span style={{ color: 'var(--muted-2)' }}>—</span>}
      </div>
    );
  }
  const signed = signers.filter((s) => s.status === 'completed').length;
  const declined = signers.filter((s) => s.status === 'declined').length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 2 }}>
        {signers.map((s, i) => (
          <span key={s.id || i} title={`${s.name} — ${s.status}`}
            style={{
              width: 9, height: 9, borderRadius: 99,
              background:
                s.status === 'completed' ? 'var(--ok)'
              : s.status === 'declined'  ? 'var(--danger)'
              : s.status === 'awaiting' || s.status === 'viewed' ? 'var(--warn)'
              : 'var(--border-strong)',
            }}/>
        ))}
      </div>
      <div style={{
        fontSize: 12, color: 'var(--fg-2)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {declined > 0
          ? <span style={{ color: 'var(--danger)' }}>Declined</span>
          : `${signed} of ${signers.length} signed`}
      </div>
    </div>
  );
}

// Gallery for picking a starter template OR launching a blank doc.
// Templates are static, served by /api/documents/templates so the
// list can grow without redeploying the frontend. Categories are
// chip filters across the top.
function CreateDocumentModal({ onCreate, onCreateFromTemplate, onClose }) {
  const [templates, setTemplates] = useState([]);
  const [loadingTpl, setLoadingTpl] = useState(true);
  const [tplErr, setTplErr] = useState(null);
  const [activeCat, setActiveCat] = useState('All');
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState(null);

  // Blank-document inline form state.
  const [blankOpen, setBlankOpen] = useState(false);
  const [blankName, setBlankName] = useState('');

  useEffect(() => {
    let live = true;
    api.get('/documents/templates')
      .then((r) => live && setTemplates(r.templates || []))
      .catch((e) => live && setTplErr(e))
      .finally(() => live && setLoadingTpl(false));
    return () => { live = false; };
  }, []);

  const cats = useMemo(() => {
    const seen = new Set();
    for (const t of templates) seen.add(t.category);
    return ['All', ...Array.from(seen).sort()];
  }, [templates]);

  const visible = useMemo(() => {
    if (activeCat === 'All') return templates;
    return templates.filter((t) => t.category === activeCat);
  }, [templates, activeCat]);

  const pickTemplate = async (t) => {
    setBusyId(t.id); setErr(null);
    try { await onCreateFromTemplate(t.id); }
    catch (ex) { setErr(ex.message || 'Could not create'); setBusyId(null); }
  };

  const submitBlank = async (e) => {
    e.preventDefault();
    if (!blankName.trim()) { setErr('Name is required'); return; }
    setBusyId('__blank'); setErr(null);
    try {
      // Empty body — the user writes it in the rich editor that opens
      // immediately after creation. Default seeded fields are added by
      // the editor when fields[] is empty (see DocumentEditor.defaultFields).
      await onCreate({
        name: blankName.trim(),
        kind: 'written',
        contentHtml: '',
        fields: [],
      });
    } catch (ex) { setErr(ex.message || 'Could not create'); setBusyId(null); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()}
        className="card scroll" style={{
          padding: 0, width: '100%', maxWidth: 880,
          maxHeight: 'calc(100vh - 40px)',
          display: 'flex', flexDirection: 'column',
        }}>

        {/* Header */}
        <div style={{
          padding: '20px 24px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Doc size={18} sw={1.8}/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>New document</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              Start from a vetted template or build your own.
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {/* Disclaimer */}
        <div style={{
          padding: '10px 24px',
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border)',
          fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5,
        }}>
          Templates are starting points, not legal advice. Review and adapt the
          language to your jurisdiction and situation. For binding agreements,
          consult an attorney.
        </div>

        {/* Body */}
        <div style={{ padding: '18px 24px', flex: 1, overflowY: 'auto' }}>
          {/* Blank doc tile */}
          <div style={{
            padding: 14, borderRadius: 10,
            border: '1px dashed var(--border-strong)',
            background: 'var(--surface)',
            marginBottom: 18,
          }}>
            {!blankOpen ? (
              <button type="button" onClick={() => setBlankOpen(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  width: '100%', padding: 4, background: 'transparent',
                  border: 0, cursor: 'pointer', textAlign: 'left',
                }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 10,
                  background: 'var(--surface-2)', color: 'var(--fg-2)',
                  border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}><Icons.Plus size={16} sw={2}/></div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>Start from scratch</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    Empty document, no fields. You can always upload a PDF after.
                  </div>
                </div>
                <Icons.Arrow size={13} stroke="var(--muted)"/>
              </button>
            ) : (
              <form onSubmit={submitBlank} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Name your document" hint="You'll write the body and place fields in the next step.">
                  <input value={blankName} onChange={(e) => setBlankName(e.target.value)}
                    required autoFocus
                    placeholder="e.g., Intro waiver, service agreement, intake form"
                    style={inputSty}/>
                </Field>
                <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setBlankOpen(false)}
                    style={{ flex: 1, justifyContent: 'center' }}>
                    Back
                  </button>
                  <button type="submit" className="btn btn-primary"
                    disabled={busyId === '__blank' || !blankName.trim()}
                    style={{ flex: 2, justifyContent: 'center' }}>
                    {busyId === '__blank' ? 'Opening editor…' : 'Continue'}
                    <Icons.Arrow size={12} sw={2}/>
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Category chips */}
          {cats.length > 1 && (
            <div style={{
              display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14,
            }}>
              {cats.map((c) => (
                <button key={c} type="button" onClick={() => setActiveCat(c)}
                  style={{
                    padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 600,
                    border: '1px solid var(--border-strong)',
                    background: activeCat === c ? 'var(--accent)' : 'var(--surface)',
                    color: activeCat === c ? 'var(--accent-ink)' : 'var(--fg-2)',
                    cursor: 'pointer',
                  }}>{c}</button>
              ))}
            </div>
          )}

          {loadingTpl && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              Loading templates…
            </div>
          )}
          {tplErr && (
            <div style={{
              padding: 12, borderRadius: 10,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5,
            }}>Couldn't load templates: {tplErr.message}</div>
          )}

          {/* Template grid */}
          {!loadingTpl && !tplErr && (
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10,
            }}>
              {visible.map((t) => (
                <button key={t.id} type="button" onClick={() => pickTemplate(t)}
                  disabled={!!busyId}
                  style={{
                    padding: 14, borderRadius: 10,
                    border: '1px solid var(--border)', background: 'var(--surface)',
                    textAlign: 'left', cursor: busyId ? 'wait' : 'pointer',
                    display: 'flex', flexDirection: 'column', gap: 6,
                    transition: 'border-color .1s, background .1s',
                    opacity: busyId && busyId !== t.id ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (busyId) return;
                    e.currentTarget.style.borderColor = 'var(--accent)';
                    e.currentTarget.style.background = 'var(--surface-2)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border)';
                    e.currentTarget.style.background = 'var(--surface)';
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                      background: 'var(--surface-2)', color: 'var(--muted)',
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                    }}>{t.category}</span>
                    {t.suggestedSigners > 1 && (
                      <span style={{
                        fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                        background: 'var(--accent-soft)', color: 'var(--accent)',
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                      }}>{t.suggestedSigners} signers</span>
                    )}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--fg)' }}>
                    {busyId === t.id ? 'Creating…' : t.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                    {t.description}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 4 }}>
                    {t.fieldCount} {t.fieldCount === 1 ? 'field' : 'fields'}
                  </div>
                </button>
              ))}
            </div>
          )}

          {!loadingTpl && !tplErr && visible.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              No templates in this category yet.
            </div>
          )}

          {err && (
            <div style={{
              marginTop: 14, padding: '8px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5,
            }}>{err}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
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
