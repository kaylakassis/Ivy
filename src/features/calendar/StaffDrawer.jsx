// Drawer for managing staff / chair-rental practitioners. Mirrors the
// services drawer pattern: list with inline edit, "+ New staff", soft
// delete (active=FALSE) preserves historical bookings.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { inputSty } from './Drawer.jsx';
import { api } from '../../lib/api.js';

const COLORS = [
  '#8E826A', '#A78BFA', '#60A5FA', '#F472B6', '#FB923C',
  '#34D399', '#FBBF24', '#F87171', '#94A3B8',
];

export default function StaffDrawer({ onClose, onChanged }) {
  const [staff, setStaff] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({});
  const [adding, setAdding] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.get(`/staff${showInactive ? '?includeInactive=1' : ''}`);
      setStaff(r.staff || []);
    } catch (e) {
      setErr(e.message || 'Could not load staff');
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [showInactive]);

  const startAdd = () => {
    setAdding(true);
    setDraft({ name: '', email: '', role: '', color: COLORS[0] });
    setEditingId(null);
  };
  const cancel = () => { setAdding(false); setEditingId(null); setDraft({}); };

  const saveNew = async () => {
    if (!draft.name?.trim()) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try {
      await api.post('/staff', draft);
      cancel();
      load();
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally { setBusy(false); }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    if (!draft.name?.trim()) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try {
      await api.patch('/staff/' + encodeURIComponent(editingId), draft);
      cancel();
      load();
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally { setBusy(false); }
  };

  const startEdit = (s) => {
    setEditingId(s.id); setAdding(false);
    setDraft({
      name: s.name, email: s.email || '', phone: s.phone || '',
      role: s.role || '', color: s.color || COLORS[0],
      hourlyRate: s.hourlyRate ?? '', commissionRate: s.commissionRate ?? '',
      active: s.active,
    });
  };

  const toggleActive = async (s) => {
    try {
      await api.patch('/staff/' + encodeURIComponent(s.id), { active: !s.active });
      load();
      onChanged?.();
    } catch { /* surfaced inline if it fails */ }
  };

  return (
    <Drawer title="Staff & chair rentals"
      subtitle="Add the practitioners working out of your space. Each can be assigned to bookings + filtered on the calendar."
      onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <button onClick={startAdd} className="btn btn-primary"
          style={{ padding: '6px 12px', fontSize: 13 }}>
          <Icons.Plus size={12} sw={2}/> New staff
        </button>
        <div style={{ flex: 1 }}/>
        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)}/>
          Show inactive
        </label>
      </div>

      {adding && (
        <StaffForm draft={draft} setDraft={setDraft} onSave={saveNew} onCancel={cancel} busy={busy} err={err}/>
      )}

      {staff === null ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
      ) : staff.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
          No staff yet. Add one to start filtering the calendar by practitioner.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {staff.map((s) => editingId === s.id ? (
            <StaffForm key={s.id} draft={draft} setDraft={setDraft}
              onSave={saveEdit} onCancel={cancel} busy={busy} err={err}/>
          ) : (
            <div key={s.id} className="card" style={{
              padding: 12, display: 'flex', alignItems: 'center', gap: 12,
              opacity: s.active ? 1 : 0.55,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 14,
                background: s.color || COLORS[0],
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'white', fontWeight: 600, fontSize: 12,
              }}>{(s.name || '?')[0].toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 550 }}>{s.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                  {[s.role, s.email, s.hourlyRate != null ? `$${s.hourlyRate}/hr` : null]
                    .filter(Boolean).join(' · ')}
                </div>
              </div>
              <button onClick={() => toggleActive(s)} className="btn btn-ghost"
                style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {s.active ? 'Deactivate' : 'Reactivate'}
              </button>
              <button onClick={() => startEdit(s)} className="btn btn-outline"
                style={{ padding: '4px 10px', fontSize: 12 }}>
                Edit
              </button>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

function StaffForm({ draft, setDraft, onSave, onCancel, busy, err }) {
  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Row>
        <Field label="Name" required>
          <input value={draft.name || ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={inputSty} autoFocus placeholder="Sam Johnson"/>
        </Field>
        <Field label="Role">
          <input value={draft.role || ''} onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            style={inputSty} placeholder="Stylist, Trainer, Therapist…"/>
        </Field>
      </Row>
      <Row>
        <Field label="Email">
          <input type="email" value={draft.email || ''} onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            style={inputSty} placeholder="sam@yourshop.com"/>
        </Field>
        <Field label="Phone">
          <input type="tel" value={draft.phone || ''} onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            style={inputSty} placeholder="+1 555-555-5555"/>
        </Field>
      </Row>
      <Row>
        <Field label="Hourly rate ($)">
          <input type="number" min={0} step="0.01"
            value={draft.hourlyRate ?? ''}
            onChange={(e) => setDraft({ ...draft, hourlyRate: e.target.value === '' ? null : Number(e.target.value) })}
            style={inputSty}/>
        </Field>
        <Field label="Commission (%)" hint="If staff keeps a % of services they perform">
          <input type="number" min={0} max={100} step="0.1"
            value={draft.commissionRate ?? ''}
            onChange={(e) => setDraft({ ...draft, commissionRate: e.target.value === '' ? null : Number(e.target.value) })}
            style={inputSty}/>
        </Field>
      </Row>
      <Field label="Color (calendar marker)">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {COLORS.map((c) => (
            <button key={c} type="button"
              onClick={() => setDraft({ ...draft, color: c })}
              style={{
                width: 26, height: 26, borderRadius: 13, background: c,
                border: draft.color === c ? '3px solid var(--fg)' : '1px solid var(--border)',
                cursor: 'pointer',
              }}/>
          ))}
        </div>
      </Field>
      {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} className="btn btn-outline" disabled={busy}>Cancel</button>
        <button onClick={onSave} className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Row({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{children}</div>;
}
function Field({ label, hint, required, children }) {
  return (
    <div>
      <label style={{
        display: 'block', fontSize: 11, fontWeight: 600,
        color: 'var(--muted)', letterSpacing: '0.04em',
        textTransform: 'uppercase', marginBottom: 4,
      }}>{label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
