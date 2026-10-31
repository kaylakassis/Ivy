// Drawer for managing staff / chair-rental practitioners. Mirrors the
// services drawer pattern: list with inline edit, "+ New staff", soft
// delete (active=FALSE) preserves historical bookings.
//
// Helpers: a staff member with an email can be invited to Ivy. They get
// their own sign-in and a small view (their schedule, the client details
// for those sessions, mark complete). Up to 2 helpers per business are
// included; the server (api/_lib/helpers.js HELPER_SEATS) is the source
// of truth and the GET returns the live count.
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
  const [seats, setSeats] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({});
  const [adding, setAdding] = useState(false);   // false | 'staff' | 'helper'
  const [showInactive, setShowInactive] = useState(false);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    try {
      const r = await api.get(`/staff${showInactive ? '?includeInactive=1' : ''}`);
      setStaff(r.staff || []);
      setSeats(r.helperSeats || null);
    } catch (e) {
      setErr(e.message || 'Could not load staff');
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [showInactive]);

  const seatsLeft = seats ? Math.max(0, seats.seats - seats.used) : null;

  const startAdd = (kind) => {
    setAdding(kind);
    setDraft({ name: '', email: '', role: '', color: COLORS[0] });
    setEditingId(null);
    setErr(null);
  };
  const cancel = () => { setAdding(false); setEditingId(null); setDraft({}); };

  const saveNew = async () => {
    if (!draft.name?.trim()) { setErr('Name is required'); return; }
    if (adding === 'helper' && !draft.email?.trim()) { setErr('An email is required to invite a helper'); return; }
    setBusy(true); setErr(null); setNotice(null);
    try {
      const r = await api.post('/staff', { ...draft, invite: adding === 'helper' });
      if (adding === 'helper') {
        setNotice(r.invite?.sent === false
          ? `Added ${draft.name.trim()}, but the invite email could not be sent. Use Resend.`
          : `Invite sent to ${draft.email.trim()}. It works once and expires in 7 days.`);
      }
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

  // Helper actions. Each is one request; the row re-renders from the
  // server's answer so the status pill never drifts from the truth.
  const helperAction = async (s, fn, okText) => {
    setBusyId(s.id); setErr(null); setNotice(null);
    try {
      await fn();
      if (okText) setNotice(okText);
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Something went wrong');
    } finally { setBusyId(null); }
  };
  const invite  = (s) => helperAction(s, () => api.post(`/staff/${encodeURIComponent(s.id)}/invite`), `Invite sent to ${s.email}. It works once and expires in 7 days.`);
  const resend  = (s) => helperAction(s, () => api.post(`/staff/${encodeURIComponent(s.id)}/invite`), `A fresh invite went to ${s.email}. The earlier link no longer works.`);
  const cancelInvite = (s) => helperAction(s, () => api.del(`/staff/${encodeURIComponent(s.id)}/invite`), 'Invite cancelled.');
  const revoke  = (s) => {
    if (!window.confirm(`Remove ${s.name}'s sign-in? They lose access right away. Their record and past bookings stay.`)) return;
    return helperAction(s, () => api.post(`/staff/${encodeURIComponent(s.id)}/revoke`), `${s.name} no longer has access.`);
  };

  return (
    <Drawer title="Staff & helpers"
      subtitle="Add the people working with you. Assign them to bookings and filter the calendar by person. Invite up to 2 helpers to sign in and see their own schedule."
      onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <button onClick={() => startAdd('staff')} className="btn btn-outline"
          style={{ padding: '6px 12px', fontSize: 13 }}>
          <Icons.Plus size={12} sw={2}/> New staff
        </button>
        <button onClick={() => startAdd('helper')} className="btn btn-primary"
          disabled={seatsLeft === 0}
          title={seatsLeft === 0 ? 'Both helper spots are in use' : 'Create the record and send the invite in one step'}
          style={{ padding: '6px 12px', fontSize: 13 }}>
          <Icons.Mail size={12} sw={2}/> Add helper
        </button>
        <div style={{ flex: 1 }}/>
        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)}/>
          Show inactive
        </label>
      </div>

      {seats && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: 'var(--fg-2)' }}>Helpers with a sign-in: {seats.used} of {seats.seats}</span>
          <span>·</span>
          <span>{seats.seats} helpers included with your subscription. Helpers see only their schedule.</span>
        </div>
      )}

      {notice && (
        <div style={{ fontSize: 12.5, color: 'var(--ok)', marginBottom: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icons.Check size={13} sw={2.2}/> {notice}
        </div>
      )}
      {err && !adding && !editingId && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}

      {adding && (
        <StaffForm draft={draft} setDraft={setDraft} onSave={saveNew} onCancel={cancel} busy={busy} err={err}
          helper={adding === 'helper'}/>
      )}

      {staff === null ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
      ) : staff.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
          No staff yet. Add someone to start assigning bookings, or invite a helper so they can see their own schedule.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {staff.map((s) => editingId === s.id ? (
            <StaffForm key={s.id} draft={draft} setDraft={setDraft}
              onSave={saveEdit} onCancel={cancel} busy={busy} err={err}/>
          ) : (
            <div key={s.id} className="card" style={{
              padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
              opacity: s.active ? 1 : 0.55,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 14, flex: 'none',
                  background: s.color || COLORS[0],
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'white', fontWeight: 600, fontSize: 12,
                }}>{(s.name || '?')[0].toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 550, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span>{s.name}</span>
                    <HelperPill status={s.helper?.status}/>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[s.role, s.email].filter(Boolean).join(' · ')}
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
              <HelperRow s={s} busy={busyId === s.id} seatsLeft={seatsLeft}
                onInvite={() => invite(s)} onResend={() => resend(s)}
                onCancel={() => cancelInvite(s)} onRevoke={() => revoke(s)}/>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

function HelperPill({ status }) {
  if (!status) return null;
  const map = {
    active:  { label: 'Active',  tone: 'var(--ok)' },
    invited: { label: 'Invited', tone: 'var(--warn)' },
    revoked: { label: 'Revoked', tone: 'var(--muted)' },
  };
  const m = map[status];
  if (!m) return null;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      padding: '2px 7px', borderRadius: 99, color: m.tone,
      background: `color-mix(in srgb, ${m.tone} 14%, transparent)`,
    }}>{m.label}</span>
  );
}

// The sign-in line under each staff row: what state their helper access
// is in and the one or two actions that make sense from there.
function HelperRow({ s, busy, seatsLeft, onInvite, onResend, onCancel, onRevoke }) {
  const st = s.helper?.status || null;
  const line = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)', paddingTop: 8, borderTop: '1px solid var(--border)', flexWrap: 'wrap' };
  const small = { padding: '4px 10px', fontSize: 12 };
  if (!s.active) return null;
  if (st === 'active') {
    return (
      <div style={line}>
        <Icons.Check size={13} sw={2}/>
        <span style={{ flex: 1 }}>Signs in to see their schedule{s.helper?.acceptedAt ? ` since ${fmtDate(s.helper.acceptedAt)}` : ''}.</span>
        <button className="btn btn-ghost" disabled={busy} onClick={onRevoke} style={{ ...small, color: 'var(--danger)' }}>Revoke access</button>
      </div>
    );
  }
  if (st === 'invited') {
    return (
      <div style={line}>
        <Icons.Mail size={13}/>
        <span style={{ flex: 1 }}>Invite sent{s.helper?.inviteExpiresAt ? `, expires ${fmtDate(s.helper.inviteExpiresAt)}` : ''}.</span>
        <button className="btn btn-outline" disabled={busy} onClick={onResend} style={small}>Resend</button>
        <button className="btn btn-ghost" disabled={busy} onClick={onCancel} style={small}>Cancel invite</button>
      </div>
    );
  }
  // Not a helper yet (or revoked).
  const canInvite = !!s.email && seatsLeft !== 0;
  return (
    <div style={line}>
      <Icons.Lock size={13}/>
      <span style={{ flex: 1 }}>
        {st === 'revoked' ? 'Access removed. ' : ''}
        {s.email ? 'No sign-in.' : 'Add an email to invite them to Ivy.'}
        {s.email && seatsLeft === 0 ? ' Both helper spots are in use.' : ''}
      </span>
      {s.email && (
        <button className="btn btn-outline" disabled={busy || !canInvite} onClick={onInvite} style={small}>
          {st === 'revoked' ? 'Invite again' : 'Invite to Ivy'}
        </button>
      )}
    </div>
  );
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return ''; }
}

function StaffForm({ draft, setDraft, onSave, onCancel, busy, err, helper = false }) {
  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {helper && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          We will email them a link to create their own sign-in. They see only the sessions you assign to them and can mark those done.
        </div>
      )}
      <Row>
        <Field label="Name" required>
          <input value={draft.name || ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={inputSty} autoFocus placeholder="Sam Johnson"/>
        </Field>
        <Field label="Role">
          <input value={draft.role || ''} onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            style={inputSty} placeholder="Stylist, Trainer, Assistant…"/>
        </Field>
      </Row>
      <Row>
        <Field label="Email" required={helper}>
          <input type="email" value={draft.email || ''} onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            style={inputSty} placeholder="sam@yourshop.com"/>
        </Field>
        <Field label="Phone">
          <input type="tel" value={draft.phone || ''} onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            style={inputSty} placeholder="+1 555-555-5555"/>
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
          {busy ? (helper ? 'Sending…' : 'Saving…') : (helper ? 'Save and send invite' : 'Save')}
        </button>
      </div>
    </div>
  );
}

function Row({ children }) {
  return <div className="form-2col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{children}</div>;
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
