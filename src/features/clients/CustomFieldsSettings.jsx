// Custom client fields: the owner defines them once for the business (text,
// number, date, yes/no, dropdown) and fills them in on each client's
// profile. Opened from the client profile, the Clients page and the import
// preview. Owner only (the API refuses helpers). Up to 25 fields.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { Sheet, Note } from './import/parts.jsx';
import { useClientFields, setClientFields, FIELD_TYPE_LABELS } from './clientFields.js';

const TYPES = ['text', 'number', 'date', 'boolean', 'select'];

export default function CustomFieldsSettings({ onClose }) {
  const { fields, max } = useClientFields();
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [editingId, setEditingId] = useState(null);

  const run = async (id, fn) => {
    setBusyId(id); setErr(null);
    try { await fn(); } catch (e) { setErr(e.message || 'That did not save. Try again.'); } finally { setBusyId(null); }
  };

  const move = (i, dir) => run('order', async () => {
    const next = fields.slice();
    const [f] = next.splice(i, 1);
    next.splice(i + dir, 0, f);
    setClientFields(next);
    const r = await api.patch('/clients/fields', { order: next.map((x) => x.id) });
    setClientFields(r.fields || next);
  });

  const remove = (f) => run(f.id, async () => {
    await api.del(`/clients/fields?id=${encodeURIComponent(f.id)}`);
    setClientFields(fields.filter((x) => x.id !== f.id));
    setConfirmDel(null);
  });

  return (
    <Sheet title="Custom fields" icon="Settings" onClose={onClose} maxWidth={560} z={140}>
      <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Add the things you track for every client, like goals, injuries or a membership number. They show on each
        client's profile, and only you see them.
      </p>

      {fields.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
          {fields.map((f, i) => (
            <div key={f.id} style={{ borderTop: i ? '1px solid var(--border)' : 'none', padding: '10px 12px' }}>
              {editingId === f.id ? (
                <FieldEditor initial={f} busy={busyId === f.id}
                  onCancel={() => setEditingId(null)}
                  onSave={(body) => run(f.id, async () => {
                    const r = await api.patch('/clients/fields', { id: f.id, ...body });
                    setClientFields(fields.map((x) => (x.id === f.id ? r.field : x)));
                    setEditingId(null);
                  })}/>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {FIELD_TYPE_LABELS[f.type]}{f.type === 'select' && f.options?.length ? `: ${f.options.join(', ')}` : ''}
                    </div>
                  </div>
                  {confirmDel === f.id ? (
                    <>
                      <span style={{ fontSize: 12, color: 'var(--danger)' }}>Delete it from every client?</span>
                      <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(null)} style={{ padding: '4px 8px', fontSize: 12 }}>No</button>
                      <button type="button" className="btn btn-primary" onClick={() => remove(f)} disabled={busyId === f.id}
                        style={{ padding: '4px 10px', fontSize: 12, background: 'var(--danger)', color: '#fff' }}>Delete</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn btn-ghost" aria-label={`Move ${f.label} up`} disabled={i === 0 || !!busyId}
                        onClick={() => move(i, -1)} style={{ padding: 5, opacity: i === 0 ? 0.35 : 1 }}><Icons.ArrowUp size={13}/></button>
                      <button type="button" className="btn btn-ghost" aria-label={`Move ${f.label} down`} disabled={i === fields.length - 1 || !!busyId}
                        onClick={() => move(i, 1)} style={{ padding: 5, opacity: i === fields.length - 1 ? 0.35 : 1 }}><Icons.ArrowDown size={13}/></button>
                      <button type="button" className="btn btn-ghost" aria-label={`Edit ${f.label}`} onClick={() => setEditingId(f.id)} style={{ padding: 5 }}>
                        <Icons.Edit size={13}/></button>
                      <button type="button" className="btn btn-ghost" aria-label={`Delete ${f.label}`} onClick={() => setConfirmDel(f.id)} style={{ padding: 5, color: 'var(--danger)' }}>
                        <Icons.Trash size={13}/></button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {err && <Note tone="err" style={{ marginBottom: 10 }}>{err}</Note>}

      {adding ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
          <FieldEditor busy={busyId === 'new'} onCancel={() => setAdding(false)}
            onSave={(body) => run('new', async () => {
              const r = await api.post('/clients/fields', body);
              setClientFields([...fields, r.field]);
              setAdding(false);
            })}/>
        </div>
      ) : fields.length < max ? (
        <button type="button" className="btn btn-outline" onClick={() => setAdding(true)} style={{ width: '100%', justifyContent: 'center' }}>
          <Icons.Plus size={13} sw={2}/> Add a field
        </button>
      ) : (
        <Note>You have {max} fields, the most a business can have. Delete one to add another.</Note>
      )}
    </Sheet>
  );
}

function FieldEditor({ initial, busy, onSave, onCancel }) {
  const [label, setLabel] = useState(initial?.label || '');
  const [type, setType] = useState(initial?.type || 'text');
  const [options, setOptions] = useState((initial?.options || []).join('\n'));
  const opts = options.split(/\n|,/).map((o) => o.trim()).filter(Boolean);
  const can = label.trim() && (type !== 'select' || opts.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label style={{ display: 'block' }}>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 5 }}>Name</span>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} autoFocus
          placeholder="Goals, Injuries, Membership number…" style={{ width: '100%' }}/>
      </label>
      {!initial && (
        <div>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 5 }}>Kind of answer</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TYPES.map((t) => (
              <button key={t} type="button" onClick={() => setType(t)} aria-pressed={type === t} style={{
                padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 550, cursor: 'pointer',
                border: '1px solid ' + (type === t ? 'var(--accent)' : 'var(--border)'),
                background: type === t ? 'var(--accent-soft)' : 'var(--surface)',
                color: type === t ? 'var(--accent)' : 'var(--fg-2)',
              }}>{FIELD_TYPE_LABELS[t]}</button>
            ))}
          </div>
        </div>
      )}
      {type === 'select' && (
        <label style={{ display: 'block' }}>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 5 }}>Choices, one per line</span>
          <textarea className="input" rows={4} value={options} onChange={(e) => setOptions(e.target.value)}
            placeholder={'Beginner\nIntermediate\nAdvanced'} style={{ width: '100%', resize: 'vertical' }}/>
        </label>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!can || busy}
          onClick={() => onSave(initial
            ? { label: label.trim(), ...(type === 'select' ? { options: opts } : {}) }
            : { label: label.trim(), type, ...(type === 'select' ? { options: opts } : {}) })}
          style={{ flex: 2, justifyContent: 'center', opacity: !can || busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : initial ? 'Save' : 'Add field'}
        </button>
      </div>
    </div>
  );
}
