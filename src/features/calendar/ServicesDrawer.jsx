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

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { inputSty } from './Drawer.jsx';
import { ColorPicker } from './EventDrawer.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import VisibilityPicker from '../../components/VisibilityPicker.jsx';
import { api } from '../../lib/api.js';
import { upload } from '@vercel/blob/client';

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

export default function ServicesDrawer({ initial, onSave, onClose, inline = false }) {
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
      visibility: 'public',
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
        visibility: ['public','private','only_me'].includes(s.visibility) ? s.visibility : 'public',
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
      inline={inline}
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

        <Field label="Visibility"
          hint={
            service.visibility === 'only_me'
              ? "Hidden from everyone except you. Use this to draft a service before launch."
              : service.visibility === 'private'
              ? "Hidden from your booking page and Discover. Bookable by anyone you give the direct link to."
              : "Listed on your booking page and on Discover. Anyone can find and book it."
          }>
          <VisibilityPicker
            value={service.visibility || 'public'}
            onChange={(visibility) => onChange({ visibility })}
          />
        </Field>

        {/* Calendar color — owner-only legibility helper. Doesn't
            affect the client-facing booking page; just paints booking
            tiles on the owner's calendar so a yoga class is visually
            distinct from a massage at a glance. */}
        <Field label="Calendar color" hint="Picks the booking tile color on your calendar. Clients never see this.">
          <ColorPicker
            value={service.color || ''}
            onChange={(c) => onChange({ color: c })}/>
        </Field>

        <Field label="Photo" hint="Shown to clients on your booking page. JPG/PNG/WebP/HEIC, up to 5 MB.">
          <PhotoUploader
            value={service.photoUrl}
            onChange={(photoUrl) => onChange({ photoUrl })}
          />
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

        <Field label="What's charged at booking?"
          hint={
            service.depositType === 'full'
              ? `Clients pay the full $${Number(service.price || 0).toFixed(0)} when they book — nothing owed at the session.`
              : service.depositType === 'percent'
              ? `${service.depositAmount || 0}% deposit at booking ($${(Number(service.price || 0) * Number(service.depositAmount || 0) / 100).toFixed(2)}) — balance owed at the session.`
              : service.depositType === 'fixed'
              ? `Flat $${Number(service.depositAmount || 0).toFixed(2)} deposit at booking — balance owed at the session.`
              : 'Free to book — pay the full price at the session.'
          }>
          <DepositPicker
            depositType={service.depositType || 'none'}
            depositAmount={service.depositAmount || 0}
            onChange={(patch) => onChange(patch)}
          />
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
            <LabeledNumberInput
              label="Hours before"
              value={service.cancellationWindowHours}
              defaultDisplay={24}
              min={0} max={720} step={1}
              placeholder="24"
              onChange={(v) => onChange({ cancellationWindowHours: clampInt(v, 0, 720, 24) })}/>
            <LabeledNumberInput
              label="Fee ($)"
              value={service.cancellationFeeAmount}
              min={0} step={0.01}
              placeholder="0.00"
              prefix="$"
              onChange={(v) => onChange({ cancellationFeeAmount: clampNum(v, 0) })}/>
          </div>
        </Field>

        <Field label="No-show fee ($)"
          hint="Charged automatically when you mark a booking as a no-show, if the client has a card on file.">
          <LabeledNumberInput
            value={service.noShowFeeAmount}
            min={0} step={0.01}
            placeholder="0.00"
            prefix="$"
            onChange={(v) => onChange({ noShowFeeAmount: clampNum(v, 0) })}/>
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

// Photo upload — replaces the old "paste a URL" input. Two ways to add
// a photo:
//   • Choose from library (a regular file picker — desktop and mobile)
//   • Take photo (mobile only — uses `capture="environment"` to launch
//     the camera straight into rear-facing capture, the same trick the
//     iOS App Store uses for product photos)
//
// Uploads go through @vercel/blob/client → /api/calendar/services/photo-token,
// the same client-token pattern the message attachments and branding
// logo upload use. While uploading we show a small progress state and
// disable both buttons. The committed URL only lands on `service.photoUrl`
// once the upload finishes; the parent's existing save flow ships it
// to the API on the next "Save services" click.
function PhotoUploader({ value, onChange }) {
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Detect mobile-ish devices so we only show "Take photo" where the
  // capture attribute can actually launch a camera. Desktop browsers
  // ignore `capture` and just open the file picker again, which would
  // be a confusing duplicate button.
  const isMobile = typeof navigator !== 'undefined'
    && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);

  const startUpload = async (file) => {
    if (!file) return;
    setErr(null);
    if (!file.type.startsWith('image/')) {
      setErr('Please pick an image file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErr('Photo must be under 5 MB.');
      return;
    }
    setBusy(true);
    try {
      // Path is rebuilt server-side; we just need a unique-ish name.
      // addRandomSuffix on the server adds a hash so name collisions
      // can't overwrite each other's files.
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
      const blob = await upload(`services/photo-${Date.now()}.${ext}`, file, {
        access: 'public',
        handleUploadUrl: '/api/calendar/services/photo-token',
        contentType: file.type || 'image/jpeg',
      });
      onChange(blob.url);
    } catch (e) {
      setErr(e.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        onChange={(e) => { startUpload(e.target.files?.[0]); e.target.value = ''; }}
        style={{ display: 'none' }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => { startUpload(e.target.files?.[0]); e.target.value = ''; }}
        style={{ display: 'none' }}
      />

      {value ? (
        <div style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16/9',
          borderRadius: 12,
          overflow: 'hidden',
          background: `url(${value}) center/cover, var(--surface-2)`,
          border: '1px solid var(--border)',
        }}>
          <button
            type="button"
            onClick={() => onChange('')}
            disabled={busy}
            title="Remove photo"
            style={{
              position: 'absolute', top: 8, right: 8,
              width: 28, height: 28, borderRadius: 999,
              border: 'none', cursor: 'pointer',
              background: 'rgba(0,0,0,0.55)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icons.X size={13}/>
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            style={{
              position: 'absolute', bottom: 8, right: 8,
              padding: '6px 10px', borderRadius: 8,
              border: 'none', cursor: 'pointer',
              background: 'rgba(0,0,0,0.55)', color: '#fff',
              fontSize: 11, fontWeight: 600,
            }}
          >
            Replace
          </button>
        </div>
      ) : (
        <div style={{
          border: '1px dashed var(--border-strong)',
          borderRadius: 12,
          padding: 18,
          background: 'var(--surface-2)',
          textAlign: 'center',
          color: 'var(--muted)',
        }}>
          <Icons.Image size={26} sw={1.4}/>
          <div style={{ fontSize: 12, marginTop: 6, color: 'var(--fg-2)' }}>
            {busy ? 'Uploading…' : 'No photo yet'}
          </div>
          <div style={{
            display: 'flex', gap: 8, marginTop: 12, justifyContent: 'center',
            flexWrap: 'wrap',
          }}>
            <button type="button" disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="btn btn-outline" style={{ fontSize: 12 }}>
              <Icons.Image size={13}/> Choose photo
            </button>
            {isMobile && (
              <button type="button" disabled={busy}
                onClick={() => cameraRef.current?.click()}
                className="btn btn-outline" style={{ fontSize: 12 }}>
                <Icons.Camera size={13}/> Take photo
              </button>
            )}
          </div>
        </div>
      )}

      {err && (
        <div style={{
          marginTop: 8, fontSize: 11.5, color: 'var(--danger)',
          padding: '6px 10px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
        }}>{err}</div>
      )}
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

// Deposit picker — four options as radio cards: none, percent, fixed, full.
// Picking percent/fixed reveals an inline amount input. Picking 'full' or
// 'none' hides the input since neither needs an amount.
const DEPOSIT_OPTIONS = [
  { id: 'none',    label: 'No deposit',       sub: 'Free to book' },
  { id: 'percent', label: '% deposit',        sub: 'e.g. 50% upfront' },
  { id: 'fixed',   label: '$ deposit',        sub: 'Flat amount' },
  { id: 'full',    label: 'Pay in full',      sub: 'Required to book' },
];
function DepositPicker({ depositType, depositAmount, onChange }) {
  const showAmount = depositType === 'percent' || depositType === 'fixed';
  return (
    <div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 8,
      }}>
        {DEPOSIT_OPTIONS.map((opt) => {
          const active = depositType === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChange({
                depositType: opt.id,
                // Reset amount when switching to none/full; otherwise keep the
                // current number so the user doesn't lose their typed value
                // when toggling between percent and fixed.
                depositAmount: (opt.id === 'none' || opt.id === 'full') ? 0 : depositAmount,
              })}
              style={{
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border-strong)'),
                background: active ? 'var(--accent-soft)' : 'var(--surface)',
                color: active ? 'var(--accent)' : 'var(--fg)',
                cursor: 'pointer',
                transition: 'border-color .12s ease, background .12s ease',
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{opt.label}</div>
              <div style={{ fontSize: 11, color: active ? 'var(--accent)' : 'var(--muted)', opacity: active ? 0.85 : 1 }}>
                {opt.sub}
              </div>
            </button>
          );
        })}
      </div>
      {showAmount && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <NumericInput
            value={depositAmount}
            onChange={(n) => onChange({
              depositAmount: depositType === 'percent'
                ? Math.max(0, Math.min(100, n))
                : Math.max(0, n),
            })}
            min={0}
            max={depositType === 'percent' ? 100 : 1e7}
            defaultOnBlank={0}
            placeholder={depositType === 'percent' ? '50' : '25.00'}
            style={{ ...inputSty, maxWidth: 140, textAlign: 'right' }}
          />
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            {depositType === 'percent' ? 'percent' : 'dollars'}
          </span>
        </div>
      )}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.length === 0 && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)',
          border: '1px dashed var(--border-strong)', fontSize: 12, color: 'var(--muted)',
        }}>
          No add-ons. Add one to let clients pick extras at checkout.
        </div>
      )}
      {items.map((a, i) => (
        // Each add-on is a small card with the name on its own row
        // (so long names like "Post workout massage" don't truncate)
        // and labeled price + duration inputs below. Mobile-friendly:
        // no horizontal squeeze, every field's purpose visible.
        <div key={a.id || i} style={{
          padding: 10, borderRadius: 8, background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input value={a.name || ''}
              onChange={(e) => setItem(i, { name: e.target.value })}
              placeholder="Add-on name (e.g. Hot stones)"
              style={{ ...inputSty, padding: '7px 10px', flex: 1 }}/>
            <button type="button" onClick={() => remove(i)}
              className="btn btn-ghost"
              title="Remove add-on"
              style={{ padding: 4, color: 'var(--danger)' }}>
              <Icons.X size={13}/>
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <LabeledNumberInput
              label="Extra charge ($)"
              value={a.price}
              min={0} step={0.01}
              placeholder="0.00"
              prefix="$"
              onChange={(v) => setItem(i, { price: clampNum(v, 0) })}/>
            <LabeledNumberInput
              label="Extra time (min)"
              value={a.durationMinutes}
              min={0} max={480} step={5}
              placeholder="0"
              suffix="min"
              onChange={(v) => setItem(i, { durationMinutes: clampInt(v, 0, 480, 0) })}/>
          </div>
        </div>
      ))}
      <button type="button" onClick={add} className="btn btn-ghost"
        style={{ alignSelf: 'flex-start', fontSize: 12, padding: '4px 8px' }}>
        <Icons.Plus size={11}/> Add an extra
      </button>
    </div>
  );
}

// LabeledNumberInput — replaces the stuck-"0" pattern from before.
//
// Bugs this fixes:
//   • value={x || 0}: when the field was empty the input rendered
//     literal '0' that some mobile keyboards (iOS Safari especially)
//     wouldn't let the user erase. They'd end up typing on top,
//     producing '048' instead of '48'.
//   • No visible label: in tight grids users couldn't tell which
//     box was hours vs fee, price vs duration. Placeholders disappear
//     on focus, leaving the user guessing once they start typing.
//
// Fixes:
//   • Empty when zero/missing → placeholder shows the hint, no
//     stuck '0' to erase. On blur if the user left it empty, we
//     report 0 to the parent so downstream math still works.
//   • Optional `label` renders as a small caption above the input;
//     reads cleanly in tight grids and stays visible during typing.
//   • Optional `prefix` ($) / `suffix` (min) render adjacent to
//     the input — explicit unit, no ambiguity.
//
// Stores the raw typed string locally during edit so the user can
// fully clear the field; emits a parsed Number to the parent on
// every change. Keeps the parent in number-land while the input
// stays in string-land where browser keyboards are happy.
function LabeledNumberInput({
  label, value, onChange, defaultDisplay = '',
  placeholder = '', prefix = '', suffix = '',
  min, max, step = 1,
}) {
  // Render the parent's number as a string. Empty string when the
  // value is null/undefined OR exactly zero (so the placeholder
  // shows and the user can type fresh digits). The `defaultDisplay`
  // override lets cancellation-window-hours show '24' when unset
  // rather than empty — clearer for that specific field.
  const display = React.useMemo(() => {
    if (value == null || value === '') {
      return defaultDisplay === '' ? '' : String(defaultDisplay);
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n === 0) return '';
    return String(n);
  }, [value, defaultDisplay]);

  const [draft, setDraft] = React.useState(display);
  // Re-sync from props when the parent's value changes externally
  // (e.g. another field's change re-renders this row). Only override
  // the draft when the input isn't currently focused — otherwise we'd
  // yank the user's in-progress typing out from under them.
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current && document.activeElement === ref.current) return;
    setDraft(display);
  }, [display]);

  const onBlur = () => {
    if (draft === '') onChange(0);
  };

  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && (
        <span style={{
          fontSize: 10.5, fontWeight: 600, color: 'var(--muted)',
          letterSpacing: '0.04em', textTransform: 'uppercase',
        }}>{label}</span>
      )}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        border: '1px solid var(--border)', borderRadius: 6,
        background: 'var(--surface)',
        overflow: 'hidden',
      }}>
        {prefix && (
          <span style={{
            padding: '7px 8px', fontSize: 13, color: 'var(--muted)',
            background: 'var(--surface-2)', borderRight: '1px solid var(--border)',
          }}>{prefix}</span>
        )}
        <input
          ref={ref}
          type="number"
          inputMode="decimal"
          min={min} max={max} step={step}
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            // Parent gets a number even if the user cleared the
            // field; we treat empty as 0 for the underlying state
            // but keep `draft` empty so the placeholder shows.
            onChange(v === '' ? 0 : Number(v));
          }}
          onBlur={onBlur}
          placeholder={placeholder}
          style={{
            flex: 1, padding: '7px 10px', fontSize: 14,
            background: 'transparent', border: 'none', outline: 'none',
            minWidth: 0, textAlign: prefix ? 'left' : 'left',
          }}/>
        {suffix && (
          <span style={{
            padding: '7px 8px', fontSize: 13, color: 'var(--muted)',
            background: 'var(--surface-2)', borderLeft: '1px solid var(--border)',
          }}>{suffix}</span>
        )}
      </div>
    </label>
  );
}

function clampNum(v, min, max) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = 0;
  if (min != null && n < min) n = min;
  if (max != null && n > max) n = max;
  return n;
}

function clampInt(v, min, max, fallback = 0) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = fallback;
  if (min != null && n < min) n = min;
  if (max != null && n > max) n = max;
  return n;
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
