// Modal editor - pick trigger, configure its options, build a sequence
// of actions, name + save. Kept linear (no branching) for v1.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const TRIGGERS = [
  {
    id: 'lead_created',
    label: 'When a lead fills out the contact form',
    hint:  'Fires for new leads from your public booking page or embedded contact form.',
  },
  {
    id: 'client_created',
    label: 'When a new client is added',
    hint:  'Fires every time a client row is created - from a booking, manual add, or import.',
  },
  {
    id: 'client_inactive',
    label: "When a client hasn't booked in a while",
    hint:  'Daily check. Fires once per matching active client per day.',
    config: 'daysInactive',
  },
  {
    id: 'booking_completed',
    label: 'After a booking is completed',
    hint:  'Fires N days after the booking date passes.',
    config: 'daysAfter',
  },
];

const ACTIONS = [
  { id: 'send_email',    label: 'Send email' },
  { id: 'send_sms',      label: 'Send SMS' },
  { id: 'create_task',   label: 'Create a task' },
  { id: 'send_document', label: 'Send a document for signing' },
  { id: 'create_invoice', label: 'Draft an invoice' },
  { id: 'wait',          label: 'Wait (N days / hours)' },
  { id: 'if_has_tag',    label: 'Only continue if client HAS tag' },
  { id: 'if_lacks_tag',  label: 'Only continue if client LACKS tag' },
];

export default function WorkflowEditor({ workflow, isNew: isNewProp, onClose, onSave, busy }) {
  // Template-driven create: caller passes a template object (no `id`
  // from the DB) and isNew=true. We still pre-fill every field from it,
  // but the header says "New workflow" and save() goes through create.
  const isNew = isNewProp != null ? isNewProp : !workflow;
  const [name, setName]                 = useState(workflow?.name || '');
  const [description, setDescription]   = useState(workflow?.description || '');
  const [triggerType, setTriggerType]   = useState(workflow?.triggerType || 'lead_created');
  const [triggerConfig, setTriggerConfig] = useState(workflow?.triggerConfig || {});
  const [actions, setActions]           = useState(workflow?.actions || [defaultAction('send_email')]);
  const [enabled, setEnabled]           = useState(workflow?.enabled ?? true);
  const [err, setErr]                   = useState(null);

  const [templates, setTemplates] = useState(null);
  useEffect(() => {
    // Used by send_document actions. Fetch lazily - most workflows
    // don't include send_document.
    api.get('/documents?templates=1')
      .then((r) => setTemplates(r.documents || []))
      .catch(() => setTemplates([]));
  }, []);

  const triggerSpec = TRIGGERS.find((t) => t.id === triggerType);

  const addAction = (type) => setActions((p) => [...p, defaultAction(type)]);
  const removeAction = (idx) => setActions((p) => p.filter((_, i) => i !== idx));
  const updateAction = (idx, patch) => setActions((p) => p.map((a, i) => (
    i === idx ? { ...a, config: { ...a.config, ...patch } } : a
  )));
  const moveAction = (idx, dir) => setActions((p) => {
    const next = [...p];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return next;
    [next[idx], next[target]] = [next[target], next[idx]];
    return next;
  });

  const submit = async (e) => {
    e?.preventDefault();
    setErr(null);
    if (!name.trim()) { setErr('Give the workflow a name'); return; }
    if (actions.length === 0) { setErr('Add at least one action'); return; }
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || null,
        triggerType,
        triggerConfig,
        actions,
        enabled,
      });
    } catch (e2) {
      setErr(e2.message || 'Save failed');
    }
  };

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 220,
        background: 'rgba(10,12,8,0.55)', display: 'flex', justifyContent: 'center',
        alignItems: 'flex-start', padding: '4vh 16px',
      }}>
      <div className="card" style={{
        width: '100%', maxWidth: 640, padding: 0,
        display: 'flex', flexDirection: 'column',
        maxHeight: '92vh',
      }}>
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1, fontSize: 17, fontWeight: 600 }}>
            {isNew ? 'New workflow' : 'Edit workflow'}
          </div>
          <button onClick={onClose} className="btn btn-ghost" style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <form onSubmit={submit} style={{
          overflowY: 'auto', padding: 20, display: 'flex',
          flexDirection: 'column', gap: 18,
        }}>
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "New lead - send brochure"' autoFocus
              style={inputStyle}/>
          </Field>

          <Field label="Description (optional)">
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="One-liner so you remember what this does"
              style={inputStyle}/>
          </Field>

          <Field label="Trigger" hint="What kicks this off?">
            <select className="input" value={triggerType}
              onChange={(e) => {
                const next = e.target.value;
                setTriggerType(next);
                // Preserve sensible defaults rather than clearing - if
                // we set `{}` the displayed default (?? 60 / ?? 1)
                // never lands in state and Save 400s with "Trigger
                // needs a daysInactive in [1, 3650]".
                const spec = TRIGGERS.find((t) => t.id === next);
                if (spec?.config === 'daysInactive') {
                  setTriggerConfig({ daysInactive: 60 });
                } else if (spec?.config === 'daysAfter') {
                  setTriggerConfig({ daysAfter: 1 });
                } else {
                  setTriggerConfig({});
                }
              }}
              style={inputStyle}>
              {TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <div style={hintStyle}>{triggerSpec?.hint}</div>
            {triggerSpec?.config === 'daysInactive' && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13 }}>Inactive for</span>
                <input className="input" type="number" min={1} max={3650}
                  value={triggerConfig.daysInactive ?? 60}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    // Blank/non-numeric keeps the last good value
                    // instead of writing NaN that fails validation.
                    setTriggerConfig({ daysInactive: Number.isFinite(n) && n >= 1 ? n : (triggerConfig.daysInactive ?? 60) });
                  }}
                  style={{ ...inputStyle, width: 90 }}/>
                <span style={{ fontSize: 13 }}>days</span>
              </div>
            )}
            {triggerSpec?.config === 'daysAfter' && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13 }}>Fire</span>
                <input className="input" type="number" min={1} max={365}
                  value={triggerConfig.daysAfter ?? 1}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setTriggerConfig({ daysAfter: Number.isFinite(n) && n >= 1 ? n : (triggerConfig.daysAfter ?? 1) });
                  }}
                  style={{ ...inputStyle, width: 80 }}/>
                <span style={{ fontSize: 13 }}>days after the booking</span>
              </div>
            )}
          </Field>

          <Field label="Actions">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {actions.map((a, i) => (
                <ActionEditor key={i}
                  index={i}
                  action={a}
                  templates={templates}
                  canMoveUp={i > 0}
                  canMoveDown={i < actions.length - 1}
                  onMove={(dir) => moveAction(i, dir)}
                  onRemove={() => removeAction(i)}
                  onUpdate={(patch) => updateAction(i, patch)}/>
              ))}
            </div>

            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ACTIONS.map((a) => (
                <button key={a.id} type="button"
                  onClick={() => addAction(a.id)}
                  className="btn btn-outline"
                  style={{ padding: '5px 11px', fontSize: 12 }}>
                  + {a.label}
                </button>
              ))}
            </div>
          </Field>

          <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: 10,
            background: 'var(--surface-2)', borderRadius: 8,
          }}>
            Token tip: drop <code>{'{{firstName}}'}</code>, <code>{'{{clientName}}'}</code>,
            <code> {'{{businessName}}'}</code>, or <code>{'{{ownerName}}'}</code> into any
            email/SMS body or task title - they're filled in at send time.
          </div>

          {err && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>}
        </form>

        <div style={{
          padding: '14px 20px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}/>
            <span>Enabled (fires when the trigger matches)</span>
          </label>
          <div style={{ flex: 1 }}/>
          <button type="button" onClick={onClose} className="btn btn-outline" disabled={busy}>Cancel</button>
          <button type="button" onClick={submit} className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : (isNew ? 'Create workflow' : 'Save changes')}
          </button>
        </div>
      </div>
    </div>
  );
}

function defaultAction(type) {
  if (type === 'send_email') return {
    type, config: { subject: '', body: '', heading: '' },
  };
  if (type === 'send_sms') return {
    type, config: { body: '' },
  };
  if (type === 'create_task') return {
    type, config: { title: '', notes: '', dueInDays: 3 },
  };
  if (type === 'send_document') return {
    type, config: { templateId: '' },
  };
  if (type === 'create_invoice') return {
    type, config: { items: [{ description: '', quantity: 1, rate: 0 }], dueInDays: 14 },
  };
  if (type === 'wait') return {
    type, config: { days: 3, hours: 0 },
  };
  if (type === 'if_has_tag' || type === 'if_lacks_tag') return {
    type, config: { tag: '' },
  };
  return { type, config: {} };
}

function ActionEditor({ index, action, templates, canMoveUp, canMoveDown, onMove, onRemove, onUpdate }) {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 10,
      padding: 12, background: 'var(--surface-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: 'var(--muted)',
          padding: '2px 8px', borderRadius: 99,
          background: 'var(--surface)', border: '1px solid var(--border)',
        }}>{index + 1}</span>
        <strong style={{ fontSize: 13 }}>
          {ACTIONS_BY_ID[action.type]?.label || action.type}
        </strong>
        <div style={{ flex: 1 }}/>
        <button type="button" onClick={() => onMove(-1)} disabled={!canMoveUp}
          style={iconBtn}><Icons.ArrowUp size={12}/></button>
        <button type="button" onClick={() => onMove(1)} disabled={!canMoveDown}
          style={iconBtn}><Icons.ArrowDown size={12}/></button>
        <button type="button" onClick={onRemove}
          style={{ ...iconBtn, color: 'var(--danger)' }}><Icons.X size={12}/></button>
      </div>

      {action.type === 'send_email' && (
        <>
          <Sub label="Subject">
            <input className="input" style={inputStyle}
              value={action.config.subject || ''}
              onChange={(e) => onUpdate({ subject: e.target.value })}
              placeholder="Quick check-in, {{firstName}}"/>
          </Sub>
          <Sub label="Body">
            <textarea className="input"
              style={{ ...inputStyle, minHeight: 110, resize: 'vertical' }}
              value={action.config.body || ''}
              onChange={(e) => onUpdate({ body: e.target.value })}
              placeholder={`Hi {{firstName}},\n\nIt's been a while - wanted to see how things are. Reply if you'd like to book something in.\n\n{{ownerName}}`}/>
          </Sub>
          <Sub label="CTA URL (optional)" hint="Adds a button at the bottom of the email.">
            <input className="input" style={inputStyle}
              value={action.config.ctaUrl || ''}
              onChange={(e) => onUpdate({ ctaUrl: e.target.value })}
              placeholder="https://getivyos.com/book/your-handle"/>
          </Sub>
        </>
      )}

      {action.type === 'send_sms' && (
        <>
          <Sub label="Body" hint="Plain text only. Keep it under 160 chars to fit one SMS.">
            <textarea className="input"
              style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
              value={action.config.body || ''}
              onChange={(e) => onUpdate({ body: e.target.value })}
              placeholder="Hi {{firstName}}! It's been a while - text me back if you'd like to book."/>
          </Sub>
        </>
      )}

      {action.type === 'create_task' && (
        <>
          <Sub label="Task title">
            <input className="input" style={inputStyle}
              value={action.config.title || ''}
              onChange={(e) => onUpdate({ title: e.target.value })}
              placeholder="Follow up with {{clientName}}"/>
          </Sub>
          <Sub label="Notes (optional)">
            <textarea className="input"
              style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }}
              value={action.config.notes || ''}
              onChange={(e) => onUpdate({ notes: e.target.value })}/>
          </Sub>
          <Sub label="Due in N days (optional)">
            <input className="input" type="number" min={0} max={365}
              style={{ ...inputStyle, width: 90 }}
              value={action.config.dueInDays ?? ''}
              onChange={(e) => onUpdate({ dueInDays: Number(e.target.value) || null })}/>
          </Sub>
        </>
      )}

      {action.type === 'send_document' && (
        <>
          <Sub label="Document template">
            <select className="input" style={inputStyle}
              value={action.config.templateId || ''}
              onChange={(e) => onUpdate({ templateId: e.target.value })}>
              <option value="">- pick a template -</option>
              {(templates || []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <div style={hintStyle}>
              Manage templates in <a href="/documents" style={{ color: 'var(--accent)' }}>/documents</a> → Templates.
              We'll clone the template into a draft for this client; you review + send from Documents.
            </div>
          </Sub>
        </>
      )}

      {action.type === 'create_invoice' && (
        <>
          <Sub label="Line items"
               hint="Ivy drafts this invoice for the client — you review + send it from Finance. It never sends on its own. Descriptions support {{clientName}} etc.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(action.config.items || []).map((it, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input className="input" style={{ ...inputStyle, flex: 1 }}
                    value={it.description || ''}
                    placeholder="Onboarding fee for {{clientName}}"
                    onChange={(e) => {
                      const items = (action.config.items || []).map((x, j) => j === i ? { ...x, description: e.target.value } : x);
                      onUpdate({ items });
                    }}/>
                  <input className="input" type="number" min={0} step="0.5" style={{ ...inputStyle, width: 64 }}
                    value={it.quantity ?? 1} title="Quantity"
                    onChange={(e) => {
                      const items = (action.config.items || []).map((x, j) => j === i ? { ...x, quantity: Number(e.target.value) } : x);
                      onUpdate({ items });
                    }}/>
                  <input className="input" type="number" min={0} step="0.01" style={{ ...inputStyle, width: 90 }}
                    value={it.rate ?? 0} title="Rate ($)"
                    onChange={(e) => {
                      const items = (action.config.items || []).map((x, j) => j === i ? { ...x, rate: Number(e.target.value) } : x);
                      onUpdate({ items });
                    }}/>
                  <button type="button" style={{ ...iconBtn, color: 'var(--danger)' }}
                    disabled={(action.config.items || []).length <= 1}
                    onClick={() => onUpdate({ items: (action.config.items || []).filter((_, j) => j !== i) })}>
                    <Icons.X size={12}/>
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 12.5, padding: '4px 10px' }}
                onClick={() => onUpdate({ items: [...(action.config.items || []), { description: '', quantity: 1, rate: 0 }] })}>
                + Add line item
              </button>
            </div>
          </Sub>
          <Sub label="Due in N days">
            <input className="input" type="number" min={0} max={365}
              style={{ ...inputStyle, width: 90 }}
              value={action.config.dueInDays ?? 14}
              onChange={(e) => onUpdate({ dueInDays: Number(e.target.value) })}/>
          </Sub>
        </>
      )}

      {action.type === 'wait' && (
        <>
          <Sub label="Pause for"
               hint="Workflow continues to the next action after this delay. Resumes hourly via cron - actual fire time may be ±1h.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input className="input" type="number" min={0} max={365}
                style={{ ...inputStyle, width: 80 }}
                value={action.config.days ?? 0}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onUpdate({ days: Number.isFinite(n) && n >= 0 ? n : 0 });
                }}/>
              <span style={{ fontSize: 13 }}>days</span>
              <input className="input" type="number" min={0} max={23}
                style={{ ...inputStyle, width: 80 }}
                value={action.config.hours ?? 0}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onUpdate({ hours: Number.isFinite(n) && n >= 0 ? n : 0 });
                }}/>
              <span style={{ fontSize: 13 }}>hours</span>
            </div>
          </Sub>
        </>
      )}

      {(action.type === 'if_has_tag' || action.type === 'if_lacks_tag') && (
        <>
          <Sub label="Tag"
               hint={action.type === 'if_has_tag'
                 ? 'Subsequent actions only run if the client has this tag (case-insensitive).'
                 : 'Subsequent actions only run if the client does NOT have this tag.'}>
            <input className="input" style={inputStyle}
              value={action.config.tag || ''}
              onChange={(e) => onUpdate({ tag: e.target.value })}
              placeholder='e.g. "vip" or "new-client"'/>
          </Sub>
        </>
      )}
    </div>
  );
}

const ACTIONS_BY_ID = ACTIONS.reduce((acc, a) => { acc[a.id] = a; return acc; }, {});

function Field({ label, hint, children }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
      {hint && <div style={hintStyle}>{hint}</div>}
    </div>
  );
}
function Sub({ label, hint, children }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ ...hintStyle, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

const inputStyle = { padding: '9px 11px', fontSize: 13.5, width: '100%' };
const labelStyle = {
  display: 'block', fontSize: 11.5, fontWeight: 600,
  color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase',
  marginBottom: 6,
};
const hintStyle = { fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 };
const iconBtn = {
  padding: 4, borderRadius: 6, background: 'var(--surface)',
  border: '1px solid var(--border)', color: 'var(--muted)', cursor: 'pointer',
};
