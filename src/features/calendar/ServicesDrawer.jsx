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

import React, { useState, useMemo, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { inputSty } from './Drawer.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

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
      capacity: 1,
      intakeFormTemplateIds: [],
      depositType: 'none',
      depositAmount: 0,
      locationType: 'in_person',
      locationLabel: '',
      travelBufferMinutes: 0,
      cancellationFeeAmount: 0,
      cancellationWindowHours: 24,
      noShowFeeAmount: 0,
      addOns: [],
      customFields: [],
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
        capacity: Number(s.capacity) || 1,
        intakeFormTemplateIds: (s.intakeFormTemplateIds || []).slice(),
        depositType: s.depositType || 'none',
        depositAmount: Number(s.depositAmount) || 0,
        locationType: s.locationType || 'in_person',
        locationLabel: (s.locationLabel || '').trim() || null,
        travelBufferMinutes: Math.max(0, Math.min(240, Number(s.travelBufferMinutes) || 0)),
        cancellationFeeAmount: Math.max(0, Number(s.cancellationFeeAmount) || 0),
        cancellationWindowHours: Math.max(0, Math.min(720, Number(s.cancellationWindowHours) || 24)),
        noShowFeeAmount: Math.max(0, Number(s.noShowFeeAmount) || 0),
        addOns: (s.addOns || []).map((a) => ({
          id: a.id || undefined,
          name: (a.name || '').trim(),
          price: Math.max(0, Number(a.price) || 0),
          durationMinutes: Math.max(0, Math.min(480, Number(a.durationMinutes) || 0)),
        })).filter((a) => a.name),
        customFields: (s.customFields || []).map((f) => ({
          id: f.id || undefined,
          label: (f.label || '').trim(),
          type: f.type || 'text',
          required: !!f.required,
          options: Array.isArray(f.options) ? f.options.map((o) => String(o).trim()).filter(Boolean) : [],
        })).filter((f) => f.label),
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

        <Field label="Duration">
          <DurationPicker
            value={service.durationMinutes}
            onChange={(m) => onChange({ durationMinutes: Math.max(5, Math.min(1440, m)) })}
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Price ($)">
            <NumericInput
              value={service.price}
              onChange={(n) => onChange({ price: Math.max(0, n) })}
              min={0}
              defaultOnBlank={0}
              style={inputSty}
            />
          </Field>
          <Field label="Capacity"
            hint={
              service.capacity > 1
                ? `Group / class — up to ${service.capacity} clients can book the same time slot.`
                : '1-on-1 — only one client can book each slot.'
            }>
            <NumericInput
              value={service.capacity}
              onChange={(n) => onChange({ capacity: Math.max(1, Math.min(1000, n)) })}
              min={1}
              max={1000}
              defaultOnBlank={1}
              style={inputSty}
            />
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

        <Field label="Intake forms"
          hint="Sent to the client automatically when this service is booked.">
          <IntakeFormPicker
            selected={service.intakeFormTemplateIds || []}
            onChange={(intakeFormTemplateIds) => onChange({ intakeFormTemplateIds })}
          />
        </Field>

        <Field label="Deposit"
          hint={service.depositType === 'percent'
            ? `Charged at booking. ${Math.round((Number(service.price || 0) * Number(service.depositAmount || 0)) / 100 * 100) / 100} of $${Number(service.price || 0).toFixed(0)}.`
            : service.depositType === 'fixed'
            ? `Flat amount charged at booking. Balance owed at session.`
            : 'Pay the full price after the session (default).'}>
          <div className="form-2col" style={{ gap: 8 }}>
            <select value={service.depositType || 'none'}
              onChange={(e) => onChange({ depositType: e.target.value })}
              style={inputSty}>
              <option value="none">No deposit</option>
              <option value="percent">% of price</option>
              <option value="fixed">Fixed $ amount</option>
            </select>
            <input type="number" min={0} step={service.depositType === 'percent' ? 1 : 0.01}
              max={service.depositType === 'percent' ? 100 : 1e7}
              value={service.depositAmount || 0}
              onChange={(e) => onChange({ depositAmount: Math.max(0, Number(e.target.value) || 0) })}
              disabled={(service.depositType || 'none') === 'none'}
              placeholder={service.depositType === 'percent' ? '50' : '25.00'}
              style={{
                ...inputSty,
                opacity: (service.depositType || 'none') === 'none' ? 0.5 : 1,
              }}/>
          </div>
        </Field>

        {/* Where does this service happen? — three rows by location type:
            in_person → text input for the venue/address
            mobile    → number input for travel buffer (the address comes
                        from the client at booking time)
            virtual   → text input for an optional default meeting URL
                        (overrides the auto-generated Jitsi room) */}
        <Field label="Where does it happen?"
          hint={service.locationType === 'mobile'
            ? 'You travel to the client. They enter their address when they book.'
            : service.locationType === 'virtual'
            ? 'Online — clients join over video. We generate a meeting link automatically; set your own below to override.'
            : 'At your place. Add the address or room name below so clients know exactly where to come.'}>
          <select value={service.locationType || 'in_person'}
            onChange={(e) => onChange({ locationType: e.target.value })}
            style={{ ...inputSty, marginBottom: 8 }}>
            <option value="in_person">At your place</option>
            <option value="mobile">You travel to the client</option>
            <option value="virtual">Online / video</option>
          </select>

          {/* In-person → free-form address. */}
          {(service.locationType || 'in_person') === 'in_person' && (
            <input
              value={service.locationLabel || ''}
              onChange={(e) => onChange({ locationLabel: e.target.value })}
              placeholder="123 Main St, Suite 4 · or 'My home studio'"
              maxLength={500}
              style={inputSty}
            />
          )}

          {/* Mobile → travel buffer minutes around each booking. */}
          {service.locationType === 'mobile' && (
            <>
              <NumericInput
                value={service.travelBufferMinutes || 0}
                onChange={(n) => onChange({ travelBufferMinutes: Math.max(0, Math.min(240, n)) })}
                min={0}
                max={240}
                defaultOnBlank={0}
                placeholder="Travel buffer (min)"
                style={inputSty}
              />
              {Number(service.travelBufferMinutes) > 0 && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  {service.travelBufferMinutes} minutes blocked off before + after each booking so you can drive between locations.
                </div>
              )}
            </>
          )}

          {/* Virtual → optional override URL. */}
          {service.locationType === 'virtual' && (
            <input
              value={service.locationLabel || ''}
              onChange={(e) => onChange({ locationLabel: e.target.value })}
              placeholder="https://zoom.us/j/your-personal-room"
              maxLength={500}
              style={inputSty}
            />
          )}
        </Field>

        {/* Cancellation + no-show policy. Both fees auto-charge against
            the client's saved card if one's on file; otherwise the owner
            sees the late-cancel/no-show in the booking and can chase it
            manually. */}
        <Field label="Cancellation policy"
          hint={`Cancellations within ${service.cancellationWindowHours ?? 24}h ${Number(service.cancellationFeeAmount) > 0 ? `auto-charge $${Number(service.cancellationFeeAmount).toFixed(2)} to the saved card on file` : 'are flagged as late but no fee charges'}.`}>
          <div className="form-2col" style={{ gap: 8 }}>
            <input type="number" min={0} step={1} max={720}
              value={service.cancellationWindowHours ?? 24}
              onChange={(e) => onChange({ cancellationWindowHours: Math.max(0, Math.min(720, Number(e.target.value) || 0)) })}
              placeholder="Window (hours)"
              style={inputSty}/>
            <input type="number" min={0} step={0.01}
              value={service.cancellationFeeAmount || 0}
              onChange={(e) => onChange({ cancellationFeeAmount: Math.max(0, Number(e.target.value) || 0) })}
              placeholder="Late-cancel fee ($)"
              style={inputSty}/>
          </div>
        </Field>

        <Field label="No-show fee ($)"
          hint="Charged automatically when you mark a booking as a no-show, if the client has a card on file.">
          <input type="number" min={0} step={0.01}
            value={service.noShowFeeAmount || 0}
            onChange={(e) => onChange({ noShowFeeAmount: Math.max(0, Number(e.target.value) || 0) })}
            placeholder="0.00"
            style={inputSty}/>
        </Field>

        {/* Add-ons: optional extras the client picks at booking. Each
            extends the slot duration + total. Example: "Hot stones +$20",
            "Deep tissue +$30 +15min". */}
        <Field label="Add-ons (optional extras)"
          hint="Clients pick these at booking. Each extends the slot duration + total.">
          <AddOnEditor
            value={service.addOns || []}
            onChange={(addOns) => onChange({ addOns })}/>
        </Field>

        {/* Per-service intake fields. Best for service-specific context:
            pet breed/size, vehicle make/model, tutoring subject/grade,
            preferred pressure, allergies. */}
        <Field label="Custom intake fields"
          hint="Asked at booking. Shown back to you on the booking detail.">
          <CustomFieldEditor
            value={service.customFields || []}
            onChange={(customFields) => onChange({ customFields })}/>
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

// Numeric input that doesn't fight the user. The naïve
//   <input type="number" value={n} onChange={(e) => set(Number(e.target.value) || 1)} />
// pattern collapses to its fallback (1, 0, …) the moment the user
// backspaces the field empty — so changing "1" to "5" requires
// highlight-and-replace, and capacity / price feel stuck.
//
// This wrapper holds a raw string locally and only commits to the
// parent on blur or when the typed value is a clean integer. Empty /
// in-progress states stay editable. The `defaultOnBlank` value is what
// gets committed if the user blurs while the field is empty.
function NumericInput({ value, onChange, min, max, defaultOnBlank = 0, style, ...rest }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  // Sync from outside when the parent value changes for non-typing
  // reasons (preset chip click, modal reopen with another service).
  useEffect(() => {
    if (Number(draft) === Number(value)) return;
    setDraft(String(value ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') return onChange(defaultOnBlank);
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return onChange(defaultOnBlank);
    onChange(n);
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      value={draft}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        // Live-commit only when the value parses cleanly to a number
        // — the "draft empty" and "draft = '-'" intermediate states
        // stay local until blur.
        if (v.trim() === '') return; // wait for blur
        const n = Number(v);
        if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => commit(draft)}
      min={min}
      max={max}
      style={style}
      {...rest}
    />
  );
}

// Duration picker — preset chips for the four common appointment lengths
// plus a Custom chip that reveals a free-form number input. The current
// value drives which chip is highlighted; if it matches one of the
// presets the input stays hidden, otherwise it shows so the owner can
// fine-tune (e.g. a 75-min service or a 90-min deep tissue).
const DURATION_PRESETS = [15, 30, 45, 60];

function DurationPicker({ value, onChange }) {
  const numeric = Number(value) || 0;
  const matchesPreset = DURATION_PRESETS.includes(numeric);
  // Once the user opens Custom, keep it open even if they happen to type
  // a preset value — they expressed intent to fine-tune. Reset is via
  // tapping a preset chip.
  const [customOpen, setCustomOpen] = useState(!matchesPreset && numeric > 0);

  const pickPreset = (m) => {
    setCustomOpen(false);
    onChange(m);
  };
  const pickCustom = () => {
    setCustomOpen(true);
    // Don't reset the value — the owner may have typed a number already
    // and just want to fine-tune from there. If the current value is a
    // preset, leave it; the input will display it editable.
  };

  const showInput = customOpen || (!matchesPreset && numeric > 0);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {DURATION_PRESETS.map((m) => {
          const active = !showInput && numeric === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => pickPreset(m)}
              style={{
                padding: '8px 14px', borderRadius: 8,
                border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border-strong)'),
                background: active ? 'var(--accent-soft)' : 'var(--surface)',
                color: active ? 'var(--accent)' : 'var(--fg)',
                fontSize: 13, fontWeight: 600,
                cursor: 'pointer',
                minWidth: 64,
                transition: 'background .12s ease, border-color .12s ease',
              }}
            >
              {m} min
            </button>
          );
        })}
        <button
          type="button"
          onClick={pickCustom}
          style={{
            padding: '8px 14px', borderRadius: 8,
            border: '1px solid ' + (showInput ? 'var(--accent)' : 'var(--border-strong)'),
            background: showInput ? 'var(--accent-soft)' : 'var(--surface)',
            color: showInput ? 'var(--accent)' : 'var(--fg)',
            fontSize: 13, fontWeight: 600,
            cursor: 'pointer',
            minWidth: 80,
          }}
        >
          Custom
        </button>
      </div>
      {showInput && (
        <div style={{
          marginTop: 8, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <input
            type="number"
            min={5}
            max={1440}
            step={1}
            autoFocus={customOpen}
            value={numeric || ''}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange(Number.isFinite(n) ? n : 0);
            }}
            placeholder="e.g. 75"
            style={{
              ...inputSty,
              maxWidth: 120,
              textAlign: 'right',
            }}
          />
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>minutes</span>
        </div>
      )}
    </div>
  );
}

// Inline editor for service add-ons. Each row: name + price + duration.
// "Add" appends a row; clicking the X removes it. Empty rows are
// dropped at submit time.
function AddOnEditor({ value, onChange }) {
  const items = Array.isArray(value) ? value : [];
  const setItem = (i, patch) => onChange(items.map((x, j) => j === i ? { ...x, ...patch } : x));
  const remove  = (i) => onChange(items.filter((_, j) => j !== i));
  const add     = () => onChange([...items, { name: '', price: 0, durationMinutes: 0 }]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.length === 0 && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)',
          border: '1px dashed var(--border-strong)', fontSize: 12, color: 'var(--muted)',
        }}>
          No add-ons. Add one to let clients pick extras at checkout.
        </div>
      )}
      {items.map((a, i) => (
        <div key={a.id || i} style={{
          display: 'grid', gridTemplateColumns: '2fr 80px 90px 30px', gap: 6,
          alignItems: 'center',
        }}>
          <input value={a.name || ''}
            onChange={(e) => setItem(i, { name: e.target.value })}
            placeholder="Hot stones"
            style={{ ...inputSty, padding: '7px 10px' }}/>
          <input type="number" min={0} step={0.01}
            value={a.price || 0}
            onChange={(e) => setItem(i, { price: Number(e.target.value) || 0 })}
            placeholder="$"
            style={{ ...inputSty, padding: '7px 10px', textAlign: 'right' }}/>
          <input type="number" min={0} max={480} step={5}
            value={a.durationMinutes || 0}
            onChange={(e) => setItem(i, { durationMinutes: Number(e.target.value) || 0 })}
            placeholder="+min"
            style={{ ...inputSty, padding: '7px 10px', textAlign: 'right' }}/>
          <button type="button" onClick={() => remove(i)}
            className="btn btn-ghost" style={{ padding: 4, color: 'var(--danger)' }}>
            <Icons.X size={13}/>
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="btn btn-ghost"
        style={{ alignSelf: 'flex-start', fontSize: 12, padding: '4px 8px' }}>
        <Icons.Plus size={11}/> Add an extra
      </button>
    </div>
  );
}

// Inline editor for custom intake fields. Each row: label + type
// + required flag + options (only for select). Same UX pattern as
// the add-on editor.
function CustomFieldEditor({ value, onChange }) {
  const items = Array.isArray(value) ? value : [];
  const setItem = (i, patch) => onChange(items.map((x, j) => j === i ? { ...x, ...patch } : x));
  const remove  = (i) => onChange(items.filter((_, j) => j !== i));
  const add     = () => onChange([...items, { label: '', type: 'text', required: false, options: [] }]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.length === 0 && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)',
          border: '1px dashed var(--border-strong)', fontSize: 12, color: 'var(--muted)',
        }}>
          No custom fields. Add one to ask service-specific questions at booking.
        </div>
      )}
      {items.map((f, i) => (
        <div key={f.id || i} style={{
          padding: 10, borderRadius: 8, background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 90px 30px', gap: 6, alignItems: 'center' }}>
            <input value={f.label || ''}
              onChange={(e) => setItem(i, { label: e.target.value })}
              placeholder="What's the make and model?"
              style={{ ...inputSty, padding: '7px 10px' }}/>
            <select value={f.type || 'text'}
              onChange={(e) => setItem(i, { type: e.target.value })}
              style={{ ...inputSty, padding: '7px 10px' }}>
              <option value="text">Short text</option>
              <option value="textarea">Long text</option>
              <option value="number">Number</option>
              <option value="select">Pick from list</option>
              <option value="checkbox">Yes / no</option>
            </select>
            <label style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!!f.required}
                onChange={(e) => setItem(i, { required: e.target.checked })}/>
              Required
            </label>
            <button type="button" onClick={() => remove(i)}
              className="btn btn-ghost" style={{ padding: 4, color: 'var(--danger)' }}>
              <Icons.X size={13}/>
            </button>
          </div>
          {f.type === 'select' && (
            <input value={(f.options || []).join(', ')}
              onChange={(e) => setItem(i, {
                options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean),
              })}
              placeholder="Comma-separated options: small, medium, large"
              style={{ ...inputSty, padding: '7px 10px', fontSize: 12.5 }}/>
          )}
        </div>
      ))}
      <button type="button" onClick={add} className="btn btn-ghost"
        style={{ alignSelf: 'flex-start', fontSize: 12, padding: '4px 8px' }}>
        <Icons.Plus size={11}/> Add a field
      </button>
    </div>
  );
}

// Multi-select picker for document templates that should be sent to
// clients when this service is booked. Loads workspace templates from
// /api/documents?templates=1 once on mount.
function IntakeFormPicker({ selected, onChange }) {
  const [templates, setTemplates] = useState(null);

  useEffect(() => {
    api.get('/documents?templates=1')
      .then((r) => setTemplates(r.documents || []))
      .catch(() => setTemplates([]));
  }, []);

  if (templates === null) {
    return <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading templates…</div>;
  }
  if (templates.length === 0) {
    return (
      <div style={{
        padding: '10px 12px', borderRadius: 8,
        background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
        fontSize: 12, color: 'var(--muted)', lineHeight: 1.5,
      }}>
        No form templates yet. In the Documents page, create a document and
        toggle <em>Save as template</em> — then come back here to attach it.
      </div>
    );
  }
  const toggle = (id) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {templates.map((t) => {
        const on = selected.includes(t.id);
        return (
          <label key={t.id} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
            borderRadius: 8, background: on ? 'var(--surface-2)' : 'transparent',
            cursor: 'pointer', fontSize: 12.5,
          }}>
            <input type="checkbox" checked={on} onChange={() => toggle(t.id)}/>
            <span style={{ flex: 1 }}>{t.name}</span>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              {t.fields?.length || 0} field{t.fields?.length === 1 ? '' : 's'}
            </span>
          </label>
        );
      })}
    </div>
  );
}
