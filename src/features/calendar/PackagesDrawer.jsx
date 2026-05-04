// Owner-facing CRUD for package templates. New / Edit / Deactivate.
// Templates are workspace-wide; selling them to a specific client is a
// separate action from the ClientDrawer.
//
// Mounted from the Calendar action menu (next to Services + Availability)
// since packages are an extension of "what you offer", not "who you sold
// it to".
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { inputSty } from './Drawer.jsx';
import { api } from '../../lib/api.js';

export default function PackagesDrawer({ services, onClose }) {
  const [packages, setPackages] = useState(null);
  const [editing, setEditing]   = useState(null); // null = list view, {} = new, row = edit
  const [err, setErr]           = useState(null);

  const load = async () => {
    try {
      const r = await api.get('/packages');
      setPackages(r.packages || []);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    setErr(null);
    try { await api.del('/packages/' + id); await load(); }
    catch (e) { setErr(e.message); }
  };

  const sub = editing
    ? <PackageEditor pkg={editing} services={services} onCancel={() => setEditing(null)}
        onSaved={async () => { await load(); setEditing(null); }}/>
    : <PackageList packages={packages} services={services}
        onNew={() => setEditing({})} onEdit={(p) => setEditing(p)} onRemove={remove}/>;

  return (
    <Drawer title="Packages"
      subtitle="Bundle multiple sessions into one upfront purchase. Sell to clients from the client drawer."
      onClose={onClose}>
      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 12,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}
      {sub}
    </Drawer>
  );
}

function PackageList({ packages, services, onNew, onEdit, onRemove }) {
  const serviceById = new Map((services || []).map((s) => [s.id, s]));

  if (packages === null) {
    return <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading…</div>;
  }
  return (
    <>
      <button onClick={onNew} className="btn btn-primary"
        style={{ width: '100%', justifyContent: 'center', marginBottom: 14 }}>
        <Icons.Plus size={13} sw={2}/> New package
      </button>

      {packages.length === 0 ? (
        <div style={{
          padding: 24, borderRadius: 10, border: '1px dashed var(--border-strong)',
          textAlign: 'center', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5,
        }}>
          No packages yet. Common shapes:<br/>
          "5 sessions for $400" · "10-pack of any service" · "Monthly retainer"
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {packages.map((p) => (
            <div key={p.id} className="card" style={{
              padding: 14, display: 'flex', alignItems: 'center', gap: 12,
              opacity: p.active ? 1 : 0.55,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                  {!p.active && (
                    <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 99,
                      background: 'var(--surface-2)', color: 'var(--muted)',
                      letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>
                      Hidden
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                  {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'}
                  {' · '}${Number(p.price).toFixed(0)}
                  {p.expiryDays ? ` · expires after ${p.expiryDays}d` : ''}
                  {p.serviceIds?.length > 0
                    ? ` · ${p.serviceIds.map((id) => serviceById.get(id)?.name || '?').join(', ')}`
                    : ' · any service'}
                </div>
                {p.description && (
                  <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 4 }}>{p.description}</div>
                )}
              </div>
              <button onClick={() => onEdit(p)} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}>
                Edit
              </button>
              {p.active && (
                <button onClick={() => onRemove(p.id)} className="btn btn-ghost"
                  style={{ padding: '4px 10px', fontSize: 12, color: 'var(--muted)' }}>
                  Hide
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function PackageEditor({ pkg, services, onCancel, onSaved }) {
  const isNew = !pkg.id;
  const [name, setName]                 = useState(pkg.name || '');
  const [description, setDescription]   = useState(pkg.description || '');
  const [sessionCount, setSessionCount] = useState(pkg.sessionCount ?? 5);
  const [price, setPrice]               = useState(pkg.price ?? '');
  const [expiryDays, setExpiryDays]     = useState(pkg.expiryDays ?? '');
  const [serviceIds, setServiceIds]     = useState(pkg.serviceIds || []);
  const [active, setActive]             = useState(pkg.active !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        sessionCount: Number(sessionCount),
        price: Number(price || 0),
        expiryDays: expiryDays === '' ? null : Number(expiryDays),
        serviceIds,
        active,
      };
      if (isNew) await api.post('/packages', body);
      else       await api.patch('/packages/' + pkg.id, body);
      onSaved();
    } catch (e2) {
      setErr(e2.message || 'Could not save');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <button type="button" onClick={onCancel}
          className="btn btn-ghost" style={{ padding: 6 }}>
          <Icons.Arrow size={14} sw={2} style={{ transform: 'rotate(180deg)' }}/>
        </button>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>
          {isNew ? 'New package' : 'Edit package'}
        </span>
      </div>

      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value.slice(0, 120))}
          placeholder="10-pack of Cut & Style" style={inputSty} required/>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Sessions" hint="Total credits the bundle includes.">
          <input type="number" min="1" max="1000"
            value={sessionCount} onChange={(e) => setSessionCount(e.target.value)}
            style={inputSty} required/>
        </Field>
        <Field label="Price" hint="USD. Free packages are allowed (e.g. comp credits).">
          <input type="number" min="0" step="0.01"
            value={price} onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00" style={inputSty}/>
        </Field>
      </div>

      <Field label="Expires after" hint="Days from purchase. Leave blank for no expiry.">
        <input type="number" min="1" max="3650"
          value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)}
          placeholder="e.g. 90" style={inputSty}/>
      </Field>

      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
          rows={3} placeholder="Optional — what's included, who it's for…"
          style={{ ...inputSty, resize: 'vertical', fontFamily: 'inherit' }}/>
      </Field>

      <Field label="Valid for">
        <ServicePicker services={services} selected={serviceIds} onChange={setServiceIds}/>
      </Field>

      {!isNew && (
        <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, fontSize: 13 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}/>
          Active (uncheck to hide from sale)
        </label>
      )}

      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 14,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" onClick={onCancel}
          className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }}>
          Cancel
        </button>
        <button type="submit" disabled={busy}
          className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}>
          {busy ? 'Saving…' : (isNew ? 'Create package' : 'Save changes')}
        </button>
      </div>
    </form>
  );
}

function ServicePicker({ services, selected, onChange }) {
  const all = services || [];
  const allSelected = selected.length === 0;
  const toggle = (id) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button type="button" onClick={() => onChange([])}
        style={{
          textAlign: 'left', padding: '6px 10px', borderRadius: 8,
          background: allSelected ? 'var(--accent-soft)' : 'transparent',
          color: allSelected ? 'var(--accent)' : 'var(--fg-2)',
          fontSize: 12.5, fontWeight: allSelected ? 600 : 500, border: 0, cursor: 'pointer',
        }}>
        Any service in your workspace
      </button>
      {all.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 4px 4px' }}>
          Or limit to specific services:
        </div>
      )}
      {all.map((s) => {
        const on = selected.includes(s.id);
        return (
          <label key={s.id} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
            borderRadius: 8, background: on ? 'var(--surface-2)' : 'transparent',
            cursor: 'pointer', fontSize: 12.5,
          }}>
            <input type="checkbox" checked={on} onChange={() => toggle(s.id)}/>
            <span style={{ flex: 1 }}>{s.name}</span>
            <span style={{ color: 'var(--muted)' }}>${Number(s.price || 0).toFixed(0)}</span>
          </label>
        );
      })}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
