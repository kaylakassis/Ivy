// Edit a draft document: name, body (HTML/textarea), and the ordered list of
// fields the recipient must complete (signature / date / text / initial).
import React, { useState, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';

const FIELD_TYPES = [
  { id: 'signature', label: 'Signature' },
  { id: 'initial',   label: 'Initial' },
  { id: 'date',      label: 'Date' },
  { id: 'text',      label: 'Text' },
];

export default function DocumentEditor({ doc, onClose, onSave, onDelete, onSend }) {
  const [name, setName]     = useState(doc.name);
  const [body, setBody]     = useState(doc.contentHtml || '');
  const [fields, setFields] = useState(() => doc.fields?.length ? doc.fields : defaultFields());
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);

  const isEditable = doc.status === 'draft' || doc.status === 'voided';

  useEffect(() => {
    setName(doc.name);
    setBody(doc.contentHtml || '');
    setFields(doc.fields?.length ? doc.fields : defaultFields());
  }, [doc.id]);

  const save = async () => {
    setBusy(true); setErr(null);
    try { await onSave({ name: name.trim() || 'Untitled', contentHtml: body, fields }); }
    catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  const addField = () => setFields((xs) => [...xs, {
    id: `f_${Math.random().toString(36).slice(2, 8)}`,
    type: 'signature', label: '', required: true, value: '',
  }]);
  const updateField = (i, patch) => setFields((xs) => xs.map((f, j) => j === i ? { ...f, ...patch } : f));
  const removeField = (i) => setFields((xs) => xs.filter((_, j) => j !== i));

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 110,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="scroll" style={{
        width: '100%', maxWidth: 720, background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="metric-label">{doc.status}</div>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isEditable}
              style={{
                background: 'transparent', border: 0, outline: 'none',
                fontSize: 20, fontWeight: 600, color: 'var(--fg)', width: '100%',
                fontFamily: 'inherit',
              }}/>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {!isEditable && (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icons.Lock size={13}/>
              {doc.status === 'sent'      && 'Sent — content is locked while awaiting signature. Void to edit again.'}
              {doc.status === 'completed' && 'Completed — this document is locked.'}
            </div>
          )}

          {/* Body */}
          <div>
            <div className="metric-label" style={{ marginBottom: 6 }}>Document text</div>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={!isEditable}
              rows={12}
              placeholder="Plain text body. Use blank lines to separate paragraphs. HTML is allowed for headings + emphasis."
              style={{
                width: '100%', padding: '14px 16px',
                border: '1px solid var(--border-strong)', borderRadius: 10,
                background: 'var(--surface-2)', color: 'var(--fg)',
                fontSize: 14, lineHeight: 1.55, fontFamily: 'inherit',
                resize: 'vertical', outline: 'none', minHeight: 240,
              }}/>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
              The recipient sees this as the document body. Keep it focused — fields go below.
            </div>
          </div>

          {/* Fields */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <div className="metric-label" style={{ flex: 1 }}>Fields the recipient fills in</div>
              {isEditable && (
                <button className="btn btn-ghost" onClick={addField} style={{ fontSize: 12, padding: '4px 8px' }}>
                  <Icons.Plus size={12}/> Add field
                </button>
              )}
            </div>

            {fields.length === 0 ? (
              <div style={{
                padding: 16, borderRadius: 10, background: 'var(--surface-2)',
                border: '1px dashed var(--border-strong)',
                color: 'var(--muted)', fontSize: 12.5, textAlign: 'center',
              }}>
                No fields yet. Add at least one signature so the recipient has something to complete.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {fields.map((f, i) => (
                  <div key={f.id} style={{
                    display: 'grid', gridTemplateColumns: '120px 1fr 90px 30px', gap: 8, alignItems: 'center',
                    padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)',
                  }}>
                    <select value={f.type} onChange={(e) => updateField(i, { type: e.target.value })}
                      disabled={!isEditable}
                      style={selectS}>
                      {FIELD_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                    <input value={f.label || ''} onChange={(e) => updateField(i, { label: e.target.value })}
                      disabled={!isEditable}
                      placeholder="Label (e.g., Client signature)"
                      style={inputS}/>
                    <label style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={f.required !== false}
                        onChange={(e) => updateField(i, { required: e.target.checked })}
                        disabled={!isEditable}/>
                      Required
                    </label>
                    {isEditable ? (
                      <button className="btn btn-ghost" onClick={() => removeField(i)} style={{ padding: 4, color: 'var(--danger)' }}>
                        <Icons.X size={13}/>
                      </button>
                    ) : <div/>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Activity */}
          {(doc.activity || []).length > 0 && (
            <div>
              <div className="metric-label" style={{ marginBottom: 8 }}>Activity</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[...doc.activity].reverse().map((a, i) => (
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
          )}
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center',
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
                  <button className="btn btn-primary" onClick={async () => { await save(); onSend(); }} disabled={busy || !name.trim()}>
                    <Icons.Mail size={13}/> Send for signing
                  </button>
                </>
              )}
              {doc.status === 'sent' && (
                <button className="btn btn-outline" onClick={onSend}>
                  <Icons.Mail size={13}/> Resend / change recipient
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function defaultFields() {
  return [
    { id: 'sig',  type: 'signature', label: 'Signature', required: true,  value: '' },
    { id: 'date', type: 'date',      label: 'Date',      required: true,  value: '' },
  ];
}

const inputS = {
  padding: '7px 10px', borderRadius: 8,
  border: '1px solid var(--border-strong)', background: 'var(--surface)',
  color: 'var(--fg)', fontSize: 13, outline: 'none',
};
const selectS = { ...inputS };
