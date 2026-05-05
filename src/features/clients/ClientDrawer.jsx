// Right-side drawer for editing one client.
// Inline-editable: name, email, lifetime value. Stage, tags, notes also editable.
// Shows a "Saved" / error banner after each save so failures aren't silent.
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function ClientDrawer({ client, onClose, onUpdate, onDelete }) {
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
          <div style={{
            width: 52, height: 52, borderRadius: 99, flexShrink: 0,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, fontWeight: 600,
          }}>{initials}</div>
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
