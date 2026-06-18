// Edit a draft document with a DocuSign-style two-pane layout:
//   - LEFT: name, rich-text body editor, fields the signer fills in
//   - RIGHT: live "paper page" preview that mirrors what the recipient
//            sees at /sign/<token>, including each field rendered as
//            the actual control (signature line, date stamp, text box).
// Mobile collapses to a single column with the preview tucked under
// the fields strip via a "Preview" tab toggle.
//
// PDF documents skip the rich-text path entirely and use PdfFieldEditor
// (drag-and-drop placement on the PDF page itself).
import React, { useState, useEffect, useRef } from 'react';
import { Icons } from '../../components/Icons.jsx';
import PdfFieldEditor from './PdfFieldEditor.jsx';
import RichTextEditor from './RichTextEditor.jsx';
import DocumentPreview from './DocumentPreview.jsx';
import { useUserContext } from '../../lib/userContext.jsx';

const FIELD_TYPES = [
  { id: 'signature', label: 'Signature',     icon: 'Edit'     },
  { id: 'initial',   label: 'Initial',       icon: 'Edit'     },
  { id: 'date',      label: 'Date',          icon: 'Calendar' },
  { id: 'text',      label: 'Text response', icon: 'Doc'      },
];

export default function DocumentEditor({ doc, onClose, onSave, onDelete, onSend, onResend, onUploadPdf, onVoid }) {
  const { ctx } = useUserContext();
  const businessName = ctx?.bizName || null;

  const [name, setName]       = useState(doc.name);
  const [body, setBody]       = useState(doc.contentHtml || '');
  const [fields, setFields]   = useState(() => doc.fields?.length ? doc.fields : defaultFields(doc.kind));
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [uploading, setUploading]   = useState(false);
  // Mobile-only: 'edit' (default) shows the editor controls; 'preview'
  // shows the live paper page. On desktop both panes render side-by-side
  // and this state is irrelevant.
  const [mobileTab, setMobileTab] = useState('edit');
  const fileInputRef = useRef(null);

  const isEditable = doc.status === 'draft' || doc.status === 'voided';
  const isPdf = doc.kind === 'pdf' && !!doc.fileUrl;

  useEffect(() => {
    setName(doc.name);
    setBody(doc.contentHtml || '');
    setFields(doc.fields?.length ? doc.fields : defaultFields(doc.kind));
  }, [doc.id, doc.kind, doc.fileUrl]);

  const onPickPdf = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true); setErr(null);
    try { await onUploadPdf(file); }
    catch (ex) { setErr(ex.message || 'Could not upload PDF'); }
    finally { setUploading(false); }
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try { await onSave({ name: name.trim() || 'Untitled', contentHtml: body, fields }); }
    catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  const addField = (type = 'signature') => setFields((xs) => [...xs, {
    id: `f_${Math.random().toString(36).slice(2, 8)}`,
    type, label: '', required: true, value: '',
  }]);
  const updateField = (i, patch) => setFields((xs) => xs.map((f, j) => j === i ? { ...f, ...patch } : f));
  const removeField = (i) => setFields((xs) => xs.filter((_, j) => j !== i));
  const moveField = (i, dir) => setFields((xs) => {
    const j = i + dir;
    if (j < 0 || j >= xs.length) return xs;
    const next = xs.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 110,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="scroll" style={{
        width: '100%',
        // 1280 gives the preview pane real breathing room on widescreens
        // while still leaving the listing visible behind the dim. On
        // narrower laptops the drawer fills most of the screen, which
        // is the right call for an editor of this density.
        maxWidth: isPdf ? 920 : 1280,
        background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header: status pill, editable name, close */}
        <div style={{
          padding: '18px 22px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <StatusPill status={doc.status}/>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isEditable}
            placeholder="Untitled document"
            style={{
              flex: 1, minWidth: 0,
              background: 'transparent', border: 0, outline: 'none',
              fontSize: 19, fontWeight: 600, color: 'var(--fg)',
              fontFamily: 'var(--font-display)', letterSpacing: '-0.01em',
            }}/>
          {!isPdf && (
            <div className="doc-mobile-tabs" style={{
              display: 'none', // shown on mobile via global.css
              gap: 4, padding: 4,
              background: 'var(--surface-2)', borderRadius: 99,
            }}>
              <MobileTabBtn active={mobileTab === 'edit'} onClick={() => setMobileTab('edit')}>
                Edit
              </MobileTabBtn>
              <MobileTabBtn active={mobileTab === 'preview'} onClick={() => setMobileTab('preview')}>
                Preview
              </MobileTabBtn>
            </div>
          )}
          <button className="btn btn-ghost" onClick={onClose}
            aria-label="Close" style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {/* Lock banner if not editable */}
        {!isEditable && (
          <div style={{
            padding: '10px 22px',
            background: 'var(--surface-2)', borderBottom: '1px solid var(--border)',
            fontSize: 12.5, color: 'var(--muted)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Icons.Lock size={13}/>
            {doc.status === 'sent'      && 'Sent - content is locked while awaiting signature. Void to edit again.'}
            {doc.status === 'completed' && 'Completed - this document is locked.'}
            {doc.status === 'declined'  && 'Declined - content is locked. Void and resend a new draft if needed.'}
          </div>
        )}

        {/* Two-pane workspace */}
        <div className="doc-editor-panes" style={{
          flex: 1, minHeight: 0,
          display: 'flex',
          // Desktop: side-by-side. Mobile flips to column via global.css.
          flexDirection: 'row',
        }}>
          {/* LEFT - editor controls (rich text + fields). Hidden on
              mobile when the user is on the "preview" tab.
              minHeight: 0 is load-bearing: flex's implicit
              min-height: auto would otherwise keep the pane at the
              full intrinsic height of its content, defeating
              overflow-y: auto. On mobile that meant the pane
              refused to scroll and the footer action bar got pushed
              below (or behind, on iOS) the visible viewport. */}
          <div className="doc-editor-pane-left" data-mobile-tab={mobileTab} style={{
            flex: '1 1 480px', minWidth: 0, minHeight: 0, maxWidth: isPdf ? '100%' : 580,
            padding: 22, overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 22,
            borderRight: '1px solid var(--border)',
          }}>
            {isPdf ? (
              <PdfPane
                doc={doc}
                fields={fields}
                onChange={setFields}
                isEditable={isEditable}
                fileInputRef={fileInputRef}
                onPickPdf={onPickPdf}
                uploading={uploading}
              />
            ) : (
              <>
                <Section
                  title="Document text"
                  trailing={isEditable && (
                    <>
                      <button className="btn btn-ghost"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        style={{ fontSize: 12, padding: '4px 10px' }}>
                        <Icons.Paperclip size={12}/>
                        {uploading ? 'Uploading…' : 'Use a PDF instead'}
                      </button>
                      <input ref={fileInputRef} type="file" accept="application/pdf"
                        onChange={onPickPdf} style={{ display: 'none' }}/>
                    </>
                  )}>
                  <RichTextEditor
                    value={body}
                    onChange={setBody}
                    disabled={!isEditable}
                    placeholder="Write the body of your document - headings, paragraphs, lists. The recipient sees this on the right."/>
                </Section>

                <Section
                  title="Fields the signer fills in"
                  trailing={isEditable && (
                    <FieldQuickAdd onAdd={addField}/>
                  )}>
                  {fields.length === 0 ? (
                    <button onClick={() => addField('signature')}
                      type="button"
                      disabled={!isEditable}
                      style={{
                        width: '100%', padding: 18, borderRadius: 12,
                        background: 'var(--surface-2)',
                        border: '1px dashed var(--border-strong)',
                        color: 'var(--muted)', fontSize: 13, lineHeight: 1.5,
                        cursor: isEditable ? 'pointer' : 'default',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                      }}>
                      <Icons.Plus size={16} sw={1.6}/>
                      Add a signature so the recipient has something to complete.
                    </button>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {fields.map((f, i) => (
                        <FieldRow key={f.id} field={f} index={i} count={fields.length}
                          isEditable={isEditable}
                          onUpdate={(patch) => updateField(i, patch)}
                          onMove={(dir) => moveField(i, dir)}
                          onRemove={() => removeField(i)}/>
                      ))}
                    </div>
                  )}
                </Section>
              </>
            )}

            {/* Final signed PDF, when ready */}
            {doc.finalPdfUrl && (
              <a href={doc.finalPdfUrl} target="_blank" rel="noopener noreferrer"
                className="card"
                style={{
                  padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
                  textDecoration: 'none', color: 'inherit',
                  background: 'color-mix(in srgb, var(--ok) 6%, var(--surface))',
                  border: '1px solid var(--ok)',
                }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 10,
                  background: 'var(--ok)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}><Icons.Doc size={16} sw={2}/></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>Signed PDF ready</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                    Flattened with every signature, date, and the audit page.
                  </div>
                </div>
                <Icons.Arrow size={14} stroke="var(--muted)"/>
              </a>
            )}

            {(doc.signers || []).length > 0 && <SignersPanel doc={doc}/>}

            {(doc.activity || []).length > 0 && <ActivityPanel activity={doc.activity}/>}
          </div>

          {/* RIGHT - live preview. Hidden on mobile when the user is on
              the "edit" tab. PDF docs don't have a separate preview
              pane - the PdfFieldEditor itself is the preview. */}
          {!isPdf && (
            <div className="doc-editor-pane-right" data-mobile-tab={mobileTab} style={{
              // Same minHeight: 0 reasoning as the left pane -
              // without it the inner .doc-preview-shell's
              // overflow-y: auto never engages and the preview
              // page silently extends past the drawer.
              flex: '1 1 540px', minWidth: 0, minHeight: 0,
              padding: 0,
              background: 'var(--surface-2)',
              display: 'flex', flexDirection: 'column',
            }}>
              <DocumentPreview
                name={name}
                body={body}
                fields={fields}
                businessName={businessName}/>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div style={{
          padding: '14px 22px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        }}>
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>Delete this document?</span>
              <button className="btn btn-ghost" onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}
                style={{ background: 'var(--danger)', color: '#fff' }}
                onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }}>
                Delete
              </button>
            </>
          ) : (
            <>
              {isEditable && (
                <button className="btn btn-ghost" onClick={() => setConfirmDel(true)}
                  style={{ color: 'var(--danger)' }}>
                  <Icons.Trash size={13}/> Delete
                </button>
              )}
              <div style={{ flex: 1 }}/>
              {err && <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</span>}
              {isEditable && (
                <>
                  <button className="btn btn-outline" onClick={save} disabled={busy}>
                    {busy ? 'Saving…' : 'Save draft'}
                  </button>
                  <button className="btn btn-primary"
                    onClick={async () => { await save(); onSend(); }}
                    disabled={busy || !name.trim()}>
                    <Icons.Mail size={13}/> Send for signing
                  </button>
                </>
              )}
              {doc.status === 'sent' && (
                <>
                  {/* One-click resend to the current pending signer.
                      No recipient picker - uses the already-stored
                      target. The Resend endpoint mints a fresh sign
                      link so older emails stop working. */}
                  {onResend && (
                    <button className="btn btn-primary" onClick={onResend}
                      title="Re-email the current signer with a fresh link">
                      <Icons.Mail size={13}/> Resend reminder
                    </button>
                  )}
                  <button className="btn btn-outline" onClick={onSend}>
                    <Icons.Mail size={13}/> Change recipient
                  </button>
                </>
              )}
              {/* Void recovers a sent/declined doc: it reverts to an
                  editable draft so the owner can fix + resend. Without
                  this, declined/stuck documents were a dead-end. */}
              {(doc.status === 'sent' || doc.status === 'declined') && onVoid && (
                <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} disabled={busy}
                  title="Void this document so you can edit it and send a fresh draft"
                  onClick={async () => { setBusy(true); try { await onVoid(); } finally { setBusy(false); } }}>
                  Void {doc.status === 'declined' ? '& edit' : ''}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, trailing, children }) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 10,
      }}>
        <div className="metric-label" style={{ flex: 1 }}>{title}</div>
        {trailing}
      </div>
      {children}
    </div>
  );
}

function FieldQuickAdd({ onAdd }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {FIELD_TYPES.map((t) => {
        const Icon = Icons[t.icon] || Icons.Plus;
        return (
          <button key={t.id} type="button" onClick={() => onAdd(t.id)}
            title={`Add ${t.label.toLowerCase()} field`}
            className="btn btn-ghost"
            style={{
              padding: '4px 10px', fontSize: 11.5, fontWeight: 600,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              gap: 5,
            }}>
            <Icon size={11} sw={1.7}/> {t.label.split(' ')[0]}
          </button>
        );
      })}
    </div>
  );
}

function FieldRow({ field, index, count, isEditable, onUpdate, onMove, onRemove }) {
  const meta = FIELD_TYPES.find((t) => t.id === field.type) || FIELD_TYPES[3];
  const Icon = Icons[meta.icon] || Icons.Doc;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: 10, borderRadius: 10,
      border: '1px solid var(--border)',
      background: 'var(--surface)',
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={13} sw={1.7}/>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select value={field.type} onChange={(e) => onUpdate({ type: e.target.value })}
            disabled={!isEditable}
            style={{
              padding: '3px 6px', borderRadius: 6,
              border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
              fontSize: 11.5, fontWeight: 600, color: 'var(--fg-2)',
              outline: 'none',
            }}>
            {FIELD_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <label style={{
            fontSize: 11, color: 'var(--muted)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <input type="checkbox" checked={field.required !== false}
              onChange={(e) => onUpdate({ required: e.target.checked })}
              disabled={!isEditable}/>
            Required
          </label>
        </div>
        <input value={field.label || ''}
          onChange={(e) => onUpdate({ label: e.target.value })}
          disabled={!isEditable}
          placeholder={`Label (e.g., "Client ${meta.label.toLowerCase()}")`}
          style={{
            width: '100%', padding: '4px 0', border: 0, outline: 'none',
            background: 'transparent', color: 'var(--fg)',
            fontSize: 13, fontWeight: 500,
          }}/>
      </div>
      {isEditable && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button onClick={() => onMove(-1)} disabled={index === 0}
            aria-label="Move up"
            style={miniBtn(index === 0)}>
            <Icons.ArrowUp size={10} sw={1.7}/>
          </button>
          <button onClick={() => onMove(1)} disabled={index === count - 1}
            aria-label="Move down"
            style={miniBtn(index === count - 1)}>
            <Icons.ArrowDown size={10} sw={1.7}/>
          </button>
        </div>
      )}
      {isEditable && (
        <button className="btn btn-ghost" onClick={onRemove}
          aria-label="Remove field"
          style={{ padding: 6, color: 'var(--danger)' }}>
          <Icons.X size={12} sw={1.7}/>
        </button>
      )}
    </div>
  );
}

function miniBtn(disabled) {
  return {
    width: 22, height: 16, borderRadius: 4,
    background: 'transparent',
    border: '1px solid var(--border)',
    color: disabled ? 'var(--muted-2)' : 'var(--muted)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  };
}

function MobileTabBtn({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{
      padding: '5px 12px', borderRadius: 99,
      background: active ? 'var(--surface)' : 'transparent',
      color: active ? 'var(--fg)' : 'var(--muted)',
      border: 0, fontSize: 12, fontWeight: 600,
      boxShadow: active ? 'var(--shadow-sm)' : 'none',
      cursor: 'pointer',
    }}>{children}</button>
  );
}

function StatusPill({ status }) {
  const META = {
    draft:     { label: 'Draft',     fg: 'var(--muted)',  bg: 'var(--surface-2)' },
    sent:      { label: 'Awaiting',  fg: 'var(--warn)',   bg: 'color-mix(in srgb, var(--warn) 12%, transparent)' },
    completed: { label: 'Completed', fg: 'var(--ok)',     bg: 'color-mix(in srgb, var(--ok) 12%, transparent)' },
    voided:    { label: 'Voided',    fg: 'var(--danger)', bg: 'rgba(155,44,44,0.12)' },
    declined:  { label: 'Declined',  fg: 'var(--danger)', bg: 'rgba(155,44,44,0.12)' },
  };
  const m = META[status] || META.draft;
  return (
    <span style={{
      padding: '4px 10px', borderRadius: 99,
      fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
      fontWeight: 700, background: m.bg, color: m.fg,
      flexShrink: 0,
    }}>
      {m.label}
    </span>
  );
}

function PdfPane({ doc, fields, onChange, isEditable, fileInputRef, onPickPdf, uploading }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div className="metric-label" style={{ flex: 1 }}>PDF document</div>
        {isEditable && (
          <>
            <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{ fontSize: 12, padding: '4px 10px' }}>
              <Icons.Paperclip size={12}/> Replace PDF
            </button>
            <input ref={fileInputRef} type="file" accept="application/pdf"
              onChange={onPickPdf} style={{ display: 'none' }}/>
          </>
        )}
      </div>
      <PdfFieldEditor
        pdfUrl={doc.fileUrl}
        fields={fields}
        onChange={onChange}
        signers={doc.signers || []}
        disabled={!isEditable}
      />
    </div>
  );
}

function defaultFields(kind) {
  if (kind === 'pdf') return [];
  return [
    { id: 'sig',  type: 'signature', label: 'Signature', required: true,  value: '' },
    { id: 'date', type: 'date',      label: 'Date',      required: true,  value: '' },
  ];
}

// Multi-signer status panel. Order, name, status pill, signed time,
// IP. Surfaces the tamper-evident completion hash when the doc is
// fully signed so the owner can copy it for legal storage.
function SignersPanel({ doc }) {
  const signers = doc.signers || [];
  const completed = signers.every((s) => s.status === 'completed');
  return (
    <div>
      <div className="metric-label" style={{ marginBottom: 8 }}>Signers</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {signers.map((s, i) => (
          <div key={s.id || i} style={{
            display: 'grid',
            gridTemplateColumns: '24px minmax(0, 1.4fr) 90px minmax(0, 1fr)',
            gap: 12, alignItems: 'center',
            padding: '10px 12px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            fontSize: 12.5,
          }}>
            <span style={{
              width: 22, height: 22, borderRadius: 99,
              background: 'var(--surface)', color: 'var(--fg)',
              border: '1px solid var(--border-strong)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
            }}>{i + 1}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.email}
              </div>
            </div>
            <SignerStatusPill status={s.status}/>
            <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
              {s.signedAt && (
                <div>Signed {new Date(s.signedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
              )}
              {s.declinedAt && (
                <div style={{ color: 'var(--danger)' }}>
                  Declined {new Date(s.declinedAt).toLocaleString([], { month: 'short', day: 'numeric' })}
                </div>
              )}
              {s.declineReason && (
                <div style={{ fontStyle: 'italic', maxWidth: 200, marginLeft: 'auto' }}>
                  "{s.declineReason}"
                </div>
              )}
              {s.ip && <div>IP {s.ip}</div>}
            </div>
          </div>
        ))}
      </div>
      {completed && doc.completionHash && (
        <div style={{
          marginTop: 10, padding: '10px 12px', borderRadius: 10,
          background: 'color-mix(in srgb, var(--ok) 6%, var(--surface-2))',
          border: '1px solid var(--ok)', fontSize: 11.5,
        }}>
          <div style={{ color: 'var(--ok)', fontWeight: 600, marginBottom: 4 }}>
            Tamper-evident completion hash
          </div>
          <code style={{
            display: 'block', wordBreak: 'break-all', fontSize: 11,
            color: 'var(--fg-2)', fontFamily: 'ui-monospace, monospace',
          }}>{doc.completionHash}</code>
          <div style={{ marginTop: 6, color: 'var(--muted)', lineHeight: 1.5 }}>
            SHA-256 over the document body and every signer's name, email,
            field values, and timestamps. If anything changes after this
            point, recomputing won't match - store this hash for any
            future dispute.
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityPanel({ activity }) {
  return (
    <div>
      <div className="metric-label" style={{ marginBottom: 8 }}>Activity</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[...activity].reverse().map((a, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            fontSize: 12.5,
          }}>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
              background: 'var(--surface)', border: '1px solid var(--border)',
              color: a.kind === 'completed' ? 'var(--ok)'
                    : a.kind === 'voided' ? 'var(--danger)'
                    : 'var(--muted)',
            }}>{a.kind}</span>
            <span style={{ flex: 1 }}>{a.text}</span>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              {new Date(a.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SignerStatusPill({ status }) {
  const META = {
    pending:    { label: 'Pending',    fg: 'var(--muted)', bg: 'var(--surface)' },
    awaiting:   { label: 'Awaiting',   fg: 'var(--warn)',  bg: 'color-mix(in srgb, var(--warn) 12%, transparent)' },
    viewed:     { label: 'Viewed',     fg: 'var(--accent)', bg: 'var(--accent-soft)' },
    completed:  { label: 'Signed',     fg: 'var(--ok)',    bg: 'color-mix(in srgb, var(--ok) 12%, transparent)' },
    declined:   { label: 'Declined',   fg: 'var(--danger)', bg: 'rgba(155,44,44,0.1)' },
  };
  const m = META[status] || META.pending;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 99, justifySelf: 'flex-start',
      fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
      background: m.bg, color: m.fg,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: m.fg }}/>{m.label}
    </span>
  );
}
