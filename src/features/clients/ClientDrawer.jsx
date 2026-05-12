// Right-side drawer for editing one client.
// Inline-editable: name, email, lifetime value. Stage, tags, notes also editable.
// Shows a "Saved" / error banner after each save so failures aren't silent.
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { upload } from '@vercel/blob/client';
import ClientGallery from './ClientGallery.jsx';

export default function ClientDrawer({ client, onClose, onUpdate, onDelete, analyticsWindowDays }) {
  const initials = (client.name || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();
  const [confirmDel, setConfirmDel] = useState(false);
  const [busyDel, setBusyDel] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // { kind: 'ok' | 'error', text }
  const [actBusy, setActBusy] = useState(null); // 'message' | 'invoice' | 'book' | null
  const statusTimer = useRef(null);
  const navigate = useNavigate();

  // Quick actions from the drawer footer. Each routes to the right page
  // with a deep-link param so the destination can prefill / open
  // straight to the right modal.
  const startMessage = async () => {
    setActBusy('message');
    try {
      // POST /api/messages upserts a thread for this client and returns
      // it. /messages?threadId=X already opens that thread automatically.
      const r = await api.post('/messages', { clientId: client.id });
      const tid = r.thread?.id;
      navigate(tid ? `/messages?threadId=${tid}` : '/messages');
    } catch {
      navigate('/messages');
    } finally { setActBusy(null); }
  };
  const startInvoice = () => {
    navigate(`/finance?newInvoice=${client.id}`);
  };
  const startBooking = () => {
    navigate(`/calendar?newBooking=${client.id}`);
  };

  // Wrap onUpdate so we always show a status indicator for saves.
  const safeUpdate = async (patch) => {
    clearTimeout(statusTimer.current);
    setSaveStatus({ kind: 'pending', text: 'Saving…' });
    try {
      await onUpdate(patch);
      setSaveStatus({ kind: 'ok', text: 'Saved' });
    } catch (e) {
      setSaveStatus({ kind: 'error', text: e.message || 'Save failed — try again' });
    } finally {
      statusTimer.current = setTimeout(() => setSaveStatus(null), 2400);
    }
  };

  useEffect(() => () => clearTimeout(statusTimer.current), []);

  const stageButton = (s) => ({
    flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 550,
    textTransform: 'capitalize', cursor: 'pointer',
    border: '1px solid ' + (client.stage === s ? 'var(--accent)' : 'var(--border)'),
    background: client.stage === s ? 'var(--accent-soft)' : 'var(--surface)',
    color: client.stage === s ? 'var(--accent)' : 'var(--fg-2)',
  });

  const handleDelete = async () => {
    setBusyDel(true);
    try {
      await onDelete();
      // Parent closes the drawer on successful delete.
    } catch (e) {
      setBusyDel(false);
      setSaveStatus({ kind: 'error', text: e.message || 'Delete failed — try again' });
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 110,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="scroll" style={{
        width: '100%', maxWidth: 560, background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header — name + email inline-editable */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', gap: 14,
        }}>
          <ClientAvatar
            initials={initials}
            photoUrl={client.photoUrl}
            onChange={(photoUrl) => safeUpdate({ photoUrl })}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <InlineText
              value={client.name || ''}
              onSave={(v) => safeUpdate({ name: v.trim() || client.name })}
              placeholder="Name"
              style={{ fontSize: 18, fontWeight: 600 }}
              editStyle={{ fontSize: 18, fontWeight: 600 }}
              required
            />
            <InlineText
              value={client.email || ''}
              onSave={(v) => safeUpdate({ email: v.trim() || null })}
              placeholder="Add email"
              style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}
              editStyle={{ fontSize: 13 }}
              type="email"
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <InlineText
                value={client.phone || ''}
                onSave={(v) => safeUpdate({ phone: v.trim() || null })}
                placeholder="Add phone"
                style={{ fontSize: 12.5, color: 'var(--muted)' }}
                editStyle={{ fontSize: 13 }}
                type="tel"
              />
              {client.phone && (
                <SmsConsentToggle
                  consentAt={client.smsConsentAt}
                  onToggle={(next) => safeUpdate({ smsConsent: next })}
                />
              )}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {/* Status banner */}
        {saveStatus && (
          <div style={{
            padding: '8px 24px', fontSize: 12.5, fontWeight: 500,
            background: saveStatus.kind === 'error'
              ? 'rgba(155,44,44,0.10)'
              : saveStatus.kind === 'ok'
                ? 'color-mix(in srgb, var(--ok) 12%, transparent)'
                : 'var(--surface-2)',
            color: saveStatus.kind === 'error' ? 'var(--danger)'
                  : saveStatus.kind === 'ok' ? 'var(--ok)'
                  : 'var(--muted)',
            borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {saveStatus.kind === 'ok'   && <Icons.Check size={13} sw={2.4}/>}
            {saveStatus.kind === 'error' && <Icons.X size={13} sw={2.4}/>}
            {saveStatus.text}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Stage */}
          <div>
            <Section label="Stage"/>
            <div style={{ display: 'flex', gap: 6 }}>
              {['active', 'lead', 'paused'].map((s) => (
                <button key={s} onClick={() => safeUpdate({ stage: s })} style={stageButton(s)}>{s}</button>
              ))}
            </div>
          </div>

          {/* KPIs — lifetime value editable, others read-only */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <EditableMoneyStat
              label="Lifetime"
              value={client.lifetimeValue || 0}
              onSave={(v) => safeUpdate({ lifetimeValue: v })}
            />
            <MiniStat label="Since"     value={client.joinedAt ? new Date(client.joinedAt).toLocaleDateString([], { month: 'short', year: '2-digit' }) : '—'}/>
            <MiniStat label="Last seen" value={client.lastSeenAt ? Math.round((Date.now() - new Date(client.lastSeenAt).getTime()) / 86400e3) + 'd ago' : '—'}/>
          </div>

          {/* Tags */}
          <Tags client={client} onSave={safeUpdate}/>

          {/* Packages */}
          <ClientPackages client={client}/>

          {/* Projects tied to this client — read-only summary list with
              a "+ New project" shortcut. Full management lives at the
              /projects tab; this section gives the client-centric view
              for owners who think client-first. */}
          <ClientProjectsBlock client={client}/>

          {/* Per-client analytics — fetched fresh from
              /api/clients/analytics so show rate / cadence / signed-doc
              count reflect the current state every time the drawer
              opens. Skipped for fresh leads (no bookings yet). */}
          <ClientAnalyticsBlock client={client} windowDays={analyticsWindowDays}/>

          {/* Photo gallery — active clients only. Trainers stash
              before/after, stylists keep transformation albums,
              contractors document job-site progress. Leads don't
              get a gallery per the product spec. */}
          {client.stage === 'active' && (
            <ClientGallery client={client} onSave={safeUpdate}/>
          )}

          {/* Documents — files attached directly to this client. Per-row
              shape: { url, type, name, uploadedAt }. Trainers stash
              before/after photos here; intake-form scans, consent
              forms, and similar live here too. */}
          <ClientAttachments client={client} onSave={safeUpdate}/>

          {/* Notes */}
          <Notes client={client} onSave={safeUpdate}/>
        </div>

        <div style={{
          padding: '14px 16px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        }}>
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>Permanently delete this client?</span>
              <button className="btn btn-ghost" onClick={() => setConfirmDel(false)} disabled={busyDel}>Cancel</button>
              <button className="btn btn-primary" style={{ background: 'var(--danger)', color: 'white', opacity: busyDel ? 0.6 : 1 }}
                disabled={busyDel} onClick={handleDelete}>
                {busyDel ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={() => setConfirmDel(true)}
                style={{ color: 'var(--danger)', padding: '8px 12px' }}>
                <Icons.Trash size={13}/>Delete
              </button>
              <div style={{ flex: 1 }}/>
              <button className="btn btn-outline" onClick={startMessage} disabled={!!actBusy}>
                <Icons.Chat size={13}/>{actBusy === 'message' ? '…' : 'Message'}
              </button>
              <button className="btn btn-outline" onClick={startInvoice} disabled={!!actBusy}>
                <Icons.Dollar size={13}/>Invoice
              </button>
              <button className="btn btn-primary" onClick={startBooking} disabled={!!actBusy}>
                <Icons.Calendar size={13}/>Book
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ label }) {
  return <div className="metric-label" style={{ marginBottom: 8 }}>{label}</div>;
}

function MiniStat({ label, value }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div className="metric-label" style={{ fontSize: 10 }}>{label}</div>
      <div className="mono-num" style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function EditableMoneyStat({ label, value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => { setDraft(String(value || 0)); }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0 && n !== value) onSave(n);
    setEditing(false);
  };

  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: editing ? 'var(--surface)' : 'var(--surface-2)',
      border: editing ? '1px solid var(--accent)' : '1px solid var(--border)',
      cursor: 'text',
    }} onClick={() => !editing && setEditing(true)}>
      <div className="metric-label" style={{ fontSize: 10 }}>{label}</div>
      {editing ? (
        <input
          type="number" min={0} step={1}
          autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') { setDraft(String(value || 0)); setEditing(false); }
          }}
          style={{
            width: '100%', marginTop: 3,
            border: 0, outline: 'none',
            background: 'transparent', color: 'var(--fg)',
            fontSize: 14, fontWeight: 600,
            fontFamily: 'inherit',
            fontVariantNumeric: 'tabular-nums',
          }}
        />
      ) : (
        <div className="mono-num" style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>
          {value > 0 ? '$' + Number(value).toLocaleString() : '—'}
        </div>
      )}
    </div>
  );
}

// Inline-editable text. Click to edit; Enter or blur saves; Esc cancels.
function InlineText({ value, onSave, placeholder, style, editStyle, required, type = 'text' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => { setDraft(value); }, [value]);

  const commit = () => {
    const v = (draft || '').trim();
    if (required && !v) { setDraft(value); setEditing(false); return; }
    if (v !== (value || '')) onSave(v);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        type={type}
        autoFocus value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        placeholder={placeholder}
        style={{
          width: '100%',
          border: 0, outline: 'none',
          background: 'transparent', color: 'var(--fg)',
          padding: '2px 0', borderBottom: '1px solid var(--accent)',
          fontFamily: 'inherit', ...editStyle,
        }}
      />
    );
  }

  return (
    <button onClick={() => setEditing(true)} title="Click to edit" style={{
      display: 'block', width: '100%', textAlign: 'left',
      padding: '2px 0', border: 0, background: 'transparent', cursor: 'text',
      ...style,
    }}>
      {value || <span style={{ color: 'var(--muted-2)', fontStyle: 'italic' }}>{placeholder}</span>}
    </button>
  );
}

function Tags({ client, onSave }) {
  const [tagInput, setTagInput] = useState('');

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if ((client.tags || []).includes(t)) { setTagInput(''); return; }
    onSave({ tags: [...(client.tags || []), t] });
    setTagInput('');
  };
  const removeTag = (t) => onSave({ tags: (client.tags || []).filter((x) => x !== t) });

  return (
    <div>
      <Section label="Tags"/>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {(client.tags || []).map((t) => (
          <span key={t} style={{
            padding: '3px 10px', borderRadius: 99, background: 'var(--surface-2)',
            border: '1px solid var(--border)', fontSize: 11.5,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {t}
            <button onClick={() => removeTag(t)} className="btn btn-ghost" style={{ padding: 0, color: 'var(--muted)' }}>
              <Icons.X size={10}/>
            </button>
          </span>
        ))}
        <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTag()}
          onBlur={addTag}
          placeholder="+ add tag"
          style={{
            padding: '3px 10px', borderRadius: 99, border: '1px dashed var(--border-strong)',
            background: 'transparent', fontSize: 11.5, outline: 0, width: 100, color: 'var(--fg)',
          }}/>
      </div>
    </div>
  );
}

function Notes({ client, onSave }) {
  const [draft, setDraft] = useState(client.notes || '');
  useEffect(() => { setDraft(client.notes || ''); }, [client.id, client.notes]);

  return (
    <div>
      <Section label="Private note"/>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== (client.notes || '') && onSave({ notes: draft })}
        placeholder="Anything useful to remember about this client…"
        style={{
          width: '100%', padding: 12, borderRadius: 10,
          fontFamily: 'inherit', fontSize: 13,
          border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
          color: 'var(--fg)', minHeight: 80, resize: 'vertical', outline: 0,
        }}/>
    </div>
  );
}

// Tiny chip + toggle: shows "SMS on/off" next to the phone number.
// Clicking flips smsConsent on the parent. Owners use this to record
// consent collected on paper / verbally; the public booking form sets
// it at booking time too.
function SmsConsentToggle({ consentAt, onToggle }) {
  const on = !!consentAt;
  return (
    <button type="button" onClick={() => onToggle(!on)}
      title={on
        ? `SMS consent recorded ${new Date(consentAt).toLocaleDateString([], { dateStyle: 'medium' })}. Click to revoke.`
        : 'No SMS consent on file. Click to record consent.'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', borderRadius: 99,
        background: on ? 'color-mix(in srgb, var(--ok) 14%, transparent)' : 'var(--surface-2)',
        border: `1px solid ${on ? 'color-mix(in srgb, var(--ok) 35%, transparent)' : 'var(--border)'}`,
        color: on ? 'var(--ok)' : 'var(--muted)',
        fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em',
        textTransform: 'uppercase', cursor: 'pointer',
      }}>
      <span style={{
        width: 6, height: 6, borderRadius: 99,
        background: on ? 'var(--ok)' : 'var(--muted)',
      }}/>
      SMS {on ? 'on' : 'off'}
    </button>
  );
}

// Per-client packages list + sell button. Loads on mount, refreshes
// after each sale / edit. Renders as a section inside the drawer body.
function ClientPackages({ client }) {
  const [packages, setPackages] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [showSell, setShowSell] = useState(false);

  const load = async () => {
    try {
      const [cp, tp] = await Promise.all([
        api.get(`/clients/${client.id}/packages`),
        api.get('/packages'),
      ]);
      setPackages(cp.packages || []);
      setTemplates((tp.packages || []).filter((p) => p.active));
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [client.id]);

  const sell = async (body) => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/clients/${client.id}/packages`, body);
      await load();
      setShowSell(false);
    } catch (e) { setErr(e.message || 'Could not sell package'); }
    finally { setBusy(false); }
  };

  const adjustCredits = async (cpId, delta) => {
    try {
      await api.patch(`/clients/${client.id}/packages/${cpId}`, { addCredits: delta });
      await load();
    } catch (e) { setErr(e.message); }
  };

  const cancel = async (cpId) => {
    if (!window.confirm('Cancel this package? Outstanding credits will be lost.')) return;
    try {
      await api.del(`/clients/${client.id}/packages/${cpId}`);
      await load();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Section label="Packages"/>
        <button onClick={() => setShowSell(!showSell)} className="btn btn-ghost"
          style={{ padding: '4px 10px', fontSize: 12, color: 'var(--accent)' }}>
          {showSell ? 'Cancel' : '+ Sell package'}
        </button>
      </div>

      {err && (
        <div style={{
          padding: '6px 10px', borderRadius: 8, marginBottom: 10,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12,
        }}>{err}</div>
      )}

      {showSell && templates !== null && (
        <SellPackageForm templates={templates} busy={busy}
          onSubmit={sell} onCancel={() => setShowSell(false)}/>
      )}

      {packages === null ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading packages…</div>
      ) : packages.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          No packages yet. Sell one to give them upfront credits.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {packages.map((p) => {
            const tone =
              p.status === 'active'    ? 'var(--ok)' :
              p.status === 'exhausted' ? 'var(--muted)' :
              p.status === 'expired'   ? 'var(--warn)' :
                                         'var(--danger)';
            return (
              <div key={p.id} style={{
                padding: 12, borderRadius: 10,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p.name}</span>
                  <span style={{
                    fontSize: 10, padding: '1px 7px', borderRadius: 99,
                    background: 'color-mix(in srgb, ' + tone + ' 14%, transparent)',
                    color: tone, fontWeight: 600,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>{p.status}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
                    ${Number(p.price).toFixed(0)}
                  </span>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12, marginTop: 8,
                  fontSize: 12.5, color: 'var(--fg-2)',
                }}>
                  <span>
                    <strong>{p.creditsRemaining}</strong> of {p.creditsTotal} sessions left
                  </span>
                  {p.expiresAt && (
                    <span style={{ color: 'var(--muted)' }}>
                      {p.daysToExpiry > 0 ? `expires in ${p.daysToExpiry}d` : 'expired'}
                    </span>
                  )}
                </div>
                {p.status === 'active' && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button onClick={() => adjustCredits(p.id, +1)}
                      className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 8px' }}>
                      +1 credit
                    </button>
                    <button onClick={() => adjustCredits(p.id, -1)}
                      className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 8px' }}>
                      −1 credit
                    </button>
                    <button onClick={() => cancel(p.id)}
                      className="btn btn-ghost"
                      style={{ fontSize: 11.5, padding: '3px 8px', color: 'var(--danger)', marginLeft: 'auto' }}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SellPackageForm({ templates, busy, onSubmit, onCancel }) {
  const [mode, setMode] = useState(templates.length > 0 ? 'template' : 'custom');
  const [packageId, setPackageId] = useState(templates[0]?.id || '');
  const [name, setName] = useState('');
  const [sessionCount, setSessionCount] = useState(5);
  const [price, setPrice] = useState('');
  const [expiryDays, setExpiryDays] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (mode === 'template') {
      if (!packageId) return;
      onSubmit({ packageId });
    } else {
      onSubmit({
        name: name.trim(),
        sessionCount: Number(sessionCount),
        price: Number(price || 0),
        expiryDays: expiryDays === '' ? null : Number(expiryDays),
      });
    }
  };

  return (
    <form onSubmit={submit} style={{
      padding: 12, marginBottom: 12, borderRadius: 10,
      background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
    }}>
      {templates.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {[
            { id: 'template', label: 'From template' },
            { id: 'custom',   label: 'One-off' },
          ].map((t) => (
            <button key={t.id} type="button" onClick={() => setMode(t.id)}
              style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 99, cursor: 'pointer',
                background: mode === t.id ? 'var(--fg)' : 'transparent',
                color: mode === t.id ? 'var(--page)' : 'var(--fg-2)',
                border: '1px solid ' + (mode === t.id ? 'var(--fg)' : 'var(--border)'),
              }}>{t.label}</button>
          ))}
        </div>
      )}

      {mode === 'template' ? (
        <select value={packageId} onChange={(e) => setPackageId(e.target.value)}
          style={{
            width: '100%', padding: '7px 10px', borderRadius: 8,
            border: '1px solid var(--border-strong)', background: 'var(--surface)',
            color: 'var(--fg)', fontSize: 13,
          }}>
          {templates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.sessionCount} sessions · ${Number(p.price).toFixed(0)}
            </option>
          ))}
        </select>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. 5 comp sessions)" required
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-strong)',
              background: 'var(--surface)', color: 'var(--fg)', fontSize: 13 }}/>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            <input type="number" min="1" value={sessionCount}
              onChange={(e) => setSessionCount(e.target.value)} placeholder="Sessions"
              style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-strong)',
                background: 'var(--surface)', color: 'var(--fg)', fontSize: 13 }}/>
            <input type="number" min="0" step="0.01" value={price}
              onChange={(e) => setPrice(e.target.value)} placeholder="Price"
              style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-strong)',
                background: 'var(--surface)', color: 'var(--fg)', fontSize: 13 }}/>
            <input type="number" min="1" value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)} placeholder="Expiry days"
              style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-strong)',
                background: 'var(--surface)', color: 'var(--fg)', fontSize: 13 }}/>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" onClick={onCancel}
          className="btn btn-outline" style={{ flex: 1, fontSize: 12 }}>Cancel</button>
        <button type="submit" disabled={busy}
          className="btn btn-primary" style={{ flex: 2, fontSize: 12 }}>
          {busy ? 'Selling…' : 'Sell to client'}
        </button>
      </div>
    </form>
  );
}


// ─── Profile photo + attachments ────────────────────────────────────

// Avatar that doubles as a photo upload trigger. Click → file picker;
// a long-press would be nice on mobile but the regular tap is enough
// for the v1. Falls back to the initials chip when no photo is set.
function ClientAvatar({ initials, photoUrl, onChange }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const pick = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setErr("Pick an image"); return; }
    if (file.size > 10 * 1024 * 1024) { setErr("Under 10 MB"); return; }
    setErr(null); setBusy(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 5);
      const blob = await upload(`clients/photo-${Date.now()}.${ext}`, file, {
        access: "public",
        handleUploadUrl: "/api/clients/upload-token",
        contentType: file.type || "image/jpeg",
      });
      onChange(blob.url);
    } catch (e) {
      setErr(e.message || "Upload failed");
    } finally { setBusy(false); }
  };

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <input ref={fileRef} type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }}
        style={{ display: "none" }}/>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
        title={photoUrl ? "Replace photo" : "Add photo"}
        aria-label={photoUrl ? "Replace photo" : "Add photo"}
        style={{
          width: 52, height: 52, borderRadius: 99, padding: 0,
          background: photoUrl ? `url(${photoUrl}) center/cover` : "var(--accent-soft)",
          color: "var(--accent)",
          border: photoUrl ? "1px solid var(--border)" : "none",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 18, fontWeight: 600,
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}>
        {!photoUrl && initials}
      </button>
      {photoUrl && (
        <button type="button" onClick={() => onChange("")} disabled={busy}
          title="Remove photo" aria-label="Remove photo"
          style={{
            position: "absolute", bottom: -4, right: -4,
            width: 20, height: 20, borderRadius: 999,
            border: "1px solid var(--border)",
            background: "var(--surface)", color: "var(--muted)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer",
          }}>
          <Icons.X size={10}/>
        </button>
      )}
      {err && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 4,
          fontSize: 10.5, color: "var(--danger)", whiteSpace: "nowrap",
        }}>{err}</div>
      )}
    </div>
  );
}

function ClientAttachments({ client, onSave }) {
  const fileRef = useRef(null);
  const items = Array.isArray(client.attachments) ? client.attachments : [];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const addFile = async (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setErr("Each file must be under 10 MB"); return; }
    setErr(null); setBusy(true);
    try {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 5);
      const blob = await upload(`clients/${client.id}-${Date.now()}.${ext}`, file, {
        access: "public",
        handleUploadUrl: "/api/clients/upload-token",
        contentType: file.type || "application/octet-stream",
      });
      const next = [
        ...items,
        { url: blob.url, type: file.type || "application/octet-stream", name: file.name, uploadedAt: new Date().toISOString() },
      ];
      await onSave({ attachments: next });
    } catch (e) {
      setErr(e.message || "Upload failed");
    } finally { setBusy(false); }
  };

  const removeAt = async (i) => {
    const next = items.filter((_, idx) => idx !== i);
    await onSave({ attachments: next });
  };

  return (
    <div style={{ marginTop: 22 }}>
      <Section label="Documents"/>
      <div style={{
        marginTop: 8, padding: 12, borderRadius: 12,
        background: "var(--surface-2)", border: "1px solid var(--border)",
      }}>
        <input ref={fileRef} type="file"
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
          onChange={(e) => { addFile(e.target.files?.[0]); e.target.value = ""; }}
          style={{ display: "none" }}/>

        {items.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.55, marginBottom: 10 }}>
            No documents yet. Add intake forms, before / after photos, signed agreements — anything you need to keep with this client.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((a, i) => {
              const isImage = (a.type || "").startsWith("image/");
              return (
                <li key={a.url + i} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", borderRadius: 10,
                  background: "var(--surface)", border: "1px solid var(--border)",
                }}>
                  {isImage ? (
                    <a href={a.url} target="_blank" rel="noreferrer"
                      style={{ flexShrink: 0, lineHeight: 0 }}>
                      <img src={a.url} alt={a.name || ""}
                        style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover" }}/>
                    </a>
                  ) : (
                    <div style={{
                      width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                      background: "var(--surface-2)", color: "var(--muted)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}><Icons.FileIcon size={18} sw={1.6}/></div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <a href={a.url} target="_blank" rel="noreferrer"
                      style={{
                        fontSize: 13, fontWeight: 500, color: "var(--fg)",
                        textDecoration: "none",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        display: "block",
                      }}>
                      {a.name || "Untitled"}
                    </a>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                      {a.uploadedAt ? new Date(a.uploadedAt).toLocaleDateString() : ""}
                    </div>
                  </div>
                  <button type="button" onClick={() => removeAt(i)}
                    title="Remove" aria-label="Remove"
                    className="btn btn-ghost"
                    style={{ padding: 4, color: "var(--muted)" }}>
                    <Icons.X size={13}/>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
          className="btn btn-outline"
          style={{
            marginTop: items.length === 0 ? 0 : 10,
            fontSize: 12.5, padding: "6px 12px",
          }}>
          <Icons.Plus size={11} sw={2.2}/> {busy ? "Uploading…" : "Add file"}
        </button>

        {err && (
          <div style={{
            marginTop: 8, fontSize: 11.5, color: "var(--danger)",
          }}>{err}</div>
        )}
      </div>
    </div>
  );
}

// ─── Per-client analytics ───────────────────────────────────────────
//
// Fetches /api/clients/analytics?id=<id> on mount and renders a tight
// 4-cell stats grid (show rate, total bookings, no-shows, avg cadence)
// + a list of every signed document tied to this client. Skipped for
// fresh leads who have no bookings to roll up.
function ClientAnalyticsBlock({ client, windowDays }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null); setErr(null);
    const qs = '/clients/analytics?id=' + encodeURIComponent(client.id)
      + (windowDays ? '&windowDays=' + encodeURIComponent(windowDays) : '');
    api.get(qs)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [client.id, windowDays]);

  if (err) return null; // silent — analytics are nice-to-have, never block the drawer
  if (!data) {
    return (
      <div style={{ marginTop: 18 }}>
        <Section label="Activity"/>
        <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 2px' }}>Loading…</div>
      </div>
    );
  }

  // Hide the whole block if the client genuinely has nothing to report
  // (a brand-new lead with no bookings + no signed docs).
  const empty = data.totalBookings === 0 && data.signedDocumentsCount === 0;
  if (empty) return null;

  const showRatePct = data.showRate == null
    ? '—'
    : Math.round(data.showRate * 100) + '%';

  return (
    <div style={{ marginTop: 18 }}>
      <Section label="Activity"/>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
        marginTop: 6,
      }}>
        <MiniStat label="Show rate"   value={showRatePct}/>
        <MiniStat label="Bookings"    value={String(data.totalBookings)}/>
        <MiniStat label="No-shows"    value={String(data.noShowBookings)}/>
        <MiniStat
          label="Cadence"
          value={data.averageDaysBetweenBookings != null
            ? `${data.averageDaysBetweenBookings}d`
            : '—'}
        />
      </div>

      {data.totalBookings >= 3 && (
        <div style={{
          marginTop: 8, padding: '8px 10px',
          background: 'var(--surface-2)', borderRadius: 8,
          fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5,
        }}>
          {data.completedBookings} completed
          {data.cancelledBookings > 0 ? ` · ${data.cancelledBookings} cancelled` : ''}
          {data.totalRevenue > 0 ? ` · $${Math.round(data.totalRevenue).toLocaleString()} earned` : ''}
        </div>
      )}

      {data.signedDocumentsCount > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{
            fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase',
            letterSpacing: '0.06em', fontWeight: 600, marginBottom: 6,
          }}>
            Signed documents · {data.signedDocumentsCount}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.signedDocuments.map((d) => (
              <div key={d.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px', borderRadius: 8,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                fontSize: 12.5,
              }}>
                <Icons.Doc size={13} sw={1.7} stroke="var(--muted)"/>
                <span style={{
                  flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: 'var(--fg)',
                }}>{d.name}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {d.signedAt
                    ? new Date(d.signedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' })
                    : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Projects tied to this client ──────────────────────────────────
// Lightweight summary that lists every project bound to this client_id
// and a button to create a new one inline. Full project editor lives
// at /projects — clicking a row jumps there with the row pre-opened
// via the same ?id= deep-link pattern the rest of the app uses.
function ClientProjectsBlock({ client }) {
  const [projects, setProjects] = useState(null);
  const [adding, setAdding]     = useState(false);
  const [name, setName]         = useState('');
  const [busy, setBusy]         = useState(false);

  const load = () => {
    api.get('/projects?clientId=' + encodeURIComponent(client.id))
      .then((r) => setProjects(r.projects || []))
      .catch(() => setProjects([]));
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [client.id]);

  const createInline = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.post('/projects', { name: name.trim(), clientId: client.id });
      setName(''); setAdding(false);
      load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Section label="Projects"/>
        {!adding && (
          <button onClick={() => setAdding(true)} className="btn btn-ghost"
            style={{ padding: '4px 8px', fontSize: 11.5, color: 'var(--muted)' }}>
            + New
          </button>
        )}
      </div>

      {adding && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Project name (e.g. Smith wedding)"
            autoFocus disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter') createInline(); if (e.key === 'Escape') { setAdding(false); setName(''); } }}
            style={{
              flex: 1, padding: '7px 10px', fontSize: 13,
              border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--surface-2)', outline: 'none',
            }}/>
          <button onClick={createInline} disabled={busy || !name.trim()} className="btn btn-primary"
            style={{ padding: '6px 10px', fontSize: 12 }}>
            {busy ? 'Saving…' : 'Create'}
          </button>
          <button onClick={() => { setAdding(false); setName(''); }} className="btn btn-ghost"
            style={{ padding: '6px 8px', fontSize: 12 }}>
            ×
          </button>
        </div>
      )}

      {projects === null ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '4px 2px' }}>Loading…</div>
      ) : projects.length === 0 ? (
        !adding && (
          <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '4px 2px' }}>
            No projects yet for this client.
          </div>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {projects.map((p) => {
            // Build the counts subtitle once so we can skip the
            // orphan " · " separator when every count is zero.
            const countParts = p.counts
              ? Object.entries(p.counts)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => `${v} ${k}`)
              : [];
            return (
              <button key={p.id}
                onClick={() => navigate(`/projects?id=${encodeURIComponent(p.id)}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 8,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  color: 'var(--fg)', textAlign: 'left', cursor: 'pointer',
                }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 550 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    {[p.status, ...countParts].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
