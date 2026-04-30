// Services management — list of cards, add/edit modal, preview-as-client toggle.
//
// Each service supports:
//   name, duration, price (the basics)
//   photo URL (Vercel Blob upload coming later)
//   description (shown to clients on the booking page)
//   prep_instructions (shown after booking — placeholder for the full
//     "items needed" doc-flow once Documents ships)
//   reminder_minutes (array of "minutes before appointment" — defaults to
//     7d/2d/1d/2h, fully customizable)

import React, { useState, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { inputSty } from './Drawer.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';

const DEFAULT_REMINDERS = [10080, 2880, 1440, 120];

// Built-in reminder options (in minutes before appointment).
const REMINDER_PRESETS = [
  { value: 30,    label: '30 minutes before' },
  { value: 60,    label: '1 hour before' },
  { value: 120,   label: '2 hours before' },
  { value: 240,   label: '4 hours before' },
  { value: 1440,  label: '1 day before' },
  { value: 2880,  label: '2 days before' },
  { value: 4320,  label: '3 days before' },
  { value: 10080, label: '1 week before' },
  { value: 20160, label: '2 weeks before' },
];

function reminderLabel(min) {
  const preset = REMINDER_PRESETS.find((p) => p.value === min);
  if (preset) return preset.label;
  if (min < 60) return `${min} min before`;
  if (min < 1440) return `${Math.round(min / 60)}h before`;
  return `${Math.round(min / 1440)}d before`;
}

export default function ServicesDrawer({ initial, onSave, onClose }) {
  const [items, setItems] = useState(() => initial.length > 0
    ? initial.map((s) => ({ ...s, _key: s.id || Math.random().toString(36).slice(2) }))
    : []);
  const [editId, setEditId] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const editing = useMemo(() => items.find((s) => s._key === editId), [items, editId]);

  const addNew = () => {
    const id = Math.random().toString(36).slice(2);
    const draft = {
      _key: id, id: null,
      name: 'New service',
      durationMinutes: 60, price: 0,
      description: '', photoUrl: '', prepInstructions: '',
      reminderMinutes: [...DEFAULT_REMINDERS],
    };
    setItems((xs) => [...xs, draft]);
    setEditId(id);
  };

  const update = (key, patch) => setItems((xs) => xs.map((x) => x._key === key ? { ...x, ...patch } : x));
  const remove = (key) => {
    setItems((xs) => xs.filter((x) => x._key !== key));
    if (editId === key) setEditId(null);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(items.map((s, i) => ({
        id: s.id,
        name: s.name.trim() || 'Untitled',
        durationMinutes: Number(s.durationMinutes) || 60,
        price: Number(s.price) || 0,
        displayOrder: i,
        description: (s.description || '').trim(),
        photoUrl: (s.photoUrl || '').trim(),
        prepInstructions: (s.prepInstructions || '').trim(),
        reminderMinutes: (s.reminderMinutes || []).slice(),
      })));
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={previewing ? 'Client preview' : 'Services'}
      subtitle={previewing ? "What clients see when they're picking a service to book." : 'What clients can book on your calendar.'}
      onClose={onClose}
      width={520}
    >
      {/* Top toolbar — preview toggle + add */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <button className="btn btn-outline"
          onClick={() => setPreviewing((v) => !v)}
          style={previewing ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'var(--accent)' } : {}}>
          <Icons.Eye size={13}/> {previewing ? 'Editing' : 'Preview as client'}
        </button>
        <div style={{ flex: 1 }}/>
        {!previewing && (
          <button className="btn btn-primary" onClick={addNew}>
            <Icons.Plus size={13}/> Add service
          </button>
        )}
      </div>

      {/* Empty state */}
      {items.length === 0 && (
        <div style={{ padding: 24, border: '1px dashed var(--border-strong)', borderRadius: 12, background: 'var(--surface-2)' }}>
          <EmptyNote
            icon="Dollar"
            title="No services yet"
            hint="Add your first bookable service. Clients will see them on your booking page."
          />
        </div>
      )}

      {/* List of cards */}
      {!previewing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((s) => (
            <ServiceCard
              key={s._key}
              service={s}
              onEdit={() => setEditId(s._key)}
              onRemove={() => remove(s._key)}
            />
          ))}
        </div>
      ) : (
        <ClientPreview services={items}/>
      )}

      {err && (
        <div style={{
          marginTop: 14, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      {/* Save bar */}
      {!previewing && (
        <div style={{ display: 'flex', gap: 10, marginTop: 22, position: 'sticky', bottom: 0 }}>
          <button className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}
            style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Saving…' : 'Save services'}
          </button>
        </div>
      )}

      {/* Edit modal */}
      {editing && (
        <ServiceEditModal
          service={editing}
          onChange={(patch) => update(editing._key, patch)}
          onClose={() => setEditId(null)}
          onRemove={() => remove(editing._key)}
        />
      )}
    </Drawer>
  );
}

function ServiceCard({ service, onEdit, onRemove }) {
  return (
    <div style={{
      display: 'flex', gap: 14, padding: 12,
      borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
      cursor: 'pointer', transition: 'border-color .12s, transform .05s',
    }}
      onClick={onEdit}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-strong)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <div style={{
        width: 64, height: 64, borderRadius: 10, flexShrink: 0,
        background: service.photoUrl
          ? `url(${service.photoUrl}) center/cover`
          : 'linear-gradient(135deg, var(--accent-soft), var(--surface-2))',
        border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--accent)',
      }}>
        {!service.photoUrl && <Icons.Dollar size={20} sw={1.6}/>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{service.name || 'Untitled'}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
          {service.durationMinutes || 60} min · ${Number(service.price || 0).toLocaleString()}
        </div>
        {service.description && (
          <div style={{
            fontSize: 12, color: 'var(--fg-2)', marginTop: 6, lineHeight: 1.4,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{service.description}</div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {service.prepInstructions && (
            <span style={chipS} title={service.prepInstructions}>
              <Icons.FileIcon size={10}/> Prep info
            </span>
          )}
          {(service.reminderMinutes || []).length > 0 && (
            <span style={chipS}>
              <Icons.Bell size={10}/> {service.reminderMinutes.length} reminder{service.reminderMinutes.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      <button className="btn btn-ghost" style={{ padding: 6, color: 'var(--danger)', alignSelf: 'flex-start' }}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}>
        <Icons.Trash size={14}/>
      </button>
    </div>
  );
}

const chipS = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '2px 7px', borderRadius: 99, fontSize: 10.5, fontWeight: 600,
  background: 'var(--surface-2)', color: 'var(--muted)',
  border: '1px solid var(--border)',
};

function ServiceEditModal({ service, onChange, onClose, onRemove }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card scroll" style={{
        padding: 24, width: '100%', maxWidth: 580,
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>Edit service</h3>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={15}/></button>
        </div>

        <Field label="Name">
          <input value={service.name} onChange={(e) => onChange({ name: e.target.value })} style={inputSty} autoFocus/>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Duration (min)">
            <input type="number" min={5} max={1440} step={5} value={service.durationMinutes}
              onChange={(e) => onChange({ durationMinutes: Math.max(5, Math.min(1440, Number(e.target.value) || 0)) })}
              style={inputSty}/>
          </Field>
          <Field label="Price ($)">
            <input type="number" min={0} step={1} value={service.price}
              onChange={(e) => onChange({ price: Math.max(0, Number(e.target.value) || 0) })}
              style={inputSty}/>
          </Field>
        </div>

        <Field label="Photo URL" hint="Paste a public image URL. (Drag-and-drop uploads coming next.)">
          <input value={service.photoUrl} onChange={(e) => onChange({ photoUrl: e.target.value })}
            placeholder="https://…" style={inputSty}/>
        </Field>

        <Field label="Description" hint="Shown to clients on your booking page.">
          <textarea value={service.description} onChange={(e) => onChange({ description: e.target.value })}
            placeholder="What's included? Who's it for? What should they expect?"
            rows={4}
            style={{ ...inputSty, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}/>
        </Field>

        <Field label="Prep instructions"
          hint="What to do or bring before the appointment. Sent with the booking confirmation. (Document attachments coming when Documents ships.)">
          <textarea value={service.prepInstructions} onChange={(e) => onChange({ prepInstructions: e.target.value })}
            placeholder={`Wear comfortable clothes\nBring water\nFill out the intake form below`}
            rows={4}
            style={{ ...inputSty, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}/>
        </Field>

        <Field label="Reminders"
          hint="When to remind both parties before the appointment. Picks here override the default schedule.">
          <ReminderEditor
            values={service.reminderMinutes || []}
            onChange={(reminderMinutes) => onChange({ reminderMinutes })}
          />
        </Field>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={onRemove}>
            <Icons.Trash size={13}/> Remove
          </button>
          <div style={{ flex: 1 }}/>
          <button className="btn btn-primary" onClick={onClose} style={{ minWidth: 120, justifyContent: 'center' }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function ReminderEditor({ values, onChange }) {
  const sorted = [...values].sort((a, b) => b - a);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState(60);

  const toggle = (v) => {
    if (sorted.includes(v)) onChange(sorted.filter((x) => x !== v));
    else onChange([...sorted, v].sort((a, b) => b - a));
  };
  const add = () => {
    const n = Number(pick);
    if (!Number.isInteger(n) || n < 5) return;
    onChange([...new Set([...sorted, n])].sort((a, b) => b - a));
    setAdding(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Selected reminders */}
      {sorted.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {sorted.map((m) => (
            <span key={m} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 99, fontSize: 12, fontWeight: 500,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              border: '1px solid var(--accent-tint)',
            }}>
              {reminderLabel(m)}
              <button onClick={() => toggle(m)} className="btn btn-ghost" style={{ padding: 0, color: 'var(--accent)' }}>
                <Icons.X size={11}/>
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Preset chips you can toggle on */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {REMINDER_PRESETS.filter((p) => !sorted.includes(p.value)).map((p) => (
          <button key={p.value} type="button" onClick={() => toggle(p.value)}
            className="btn btn-outline"
            style={{ padding: '4px 10px', fontSize: 12, fontWeight: 500 }}>
            <Icons.Plus size={11}/> {p.label}
          </button>
        ))}
        {!adding ? (
          <button type="button" onClick={() => setAdding(true)} className="btn btn-ghost"
            style={{ padding: '4px 10px', fontSize: 12 }}>
            Custom…
          </button>
        ) : (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: 3, borderRadius: 8, border: '1px solid var(--border-strong)' }}>
            <input type="number" min={5} value={pick} onChange={(e) => setPick(Number(e.target.value) || 0)}
              style={{ width: 70, padding: '4px 8px', fontSize: 12, border: 0, outline: 'none', background: 'transparent', color: 'var(--fg)' }}/>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>min before</span>
            <button onClick={add} className="btn btn-primary" style={{ padding: '3px 8px', fontSize: 11 }}>Add</button>
            <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: '3px 6px', fontSize: 11 }}>×</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ClientPreview({ services }) {
  if (services.length === 0) {
    return <EmptyNote icon="Dollar" title="No services to preview" hint="Add some services first."/>;
  }
  return (
    <div>
      <div style={{
        padding: 16, borderRadius: 12,
        background: 'var(--surface-2)', border: '1px dashed var(--border)',
        marginBottom: 14, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5,
      }}>
        <Icons.Eye size={13}/> This is what clients see on your booking page when they pick a service.
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {services.map((s, i) => (
          <div key={s._key || i} style={{
            padding: 16, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
            display: 'flex', gap: 14,
          }}>
            <div style={{
              width: 80, height: 80, borderRadius: 10, flexShrink: 0,
              background: s.photoUrl
                ? `url(${s.photoUrl}) center/cover`
                : 'linear-gradient(135deg, var(--accent-soft), var(--surface-2))',
              border: '1px solid var(--border)',
            }}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{s.name || 'Untitled'}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                {s.durationMinutes || 60} min · ${Number(s.price || 0).toLocaleString()}
              </div>
              {s.description && (
                <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                  {s.description}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}
