// Time tracking surface. One running timer per workspace; recent
// entries below; "Bill selected" rolls unbilled rows into a fresh
// draft invoice.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useTimeEntries } from './timeState.js';

const STATUS_META = {
  running: { label: 'Running', color: 'var(--accent)' },
  stopped: { label: 'Logged',  color: 'var(--fg-2)' },
  billed:  { label: 'Billed',  color: 'var(--ok)' },
};

export default function Time() {
  const nav = useNavigate();
  const { entries, defaultRate, loading, error, start, stop, update, remove, bill } = useTimeEntries();

  // Active running entry (server enforces at-most-one).
  const running = entries.find((e) => e.status === 'running') || null;
  const stopped = entries.filter((e) => e.status === 'stopped');
  const billed  = entries.filter((e) => e.status === 'billed');

  const [tab, setTab] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [editingId, setEditingId] = useState(null);

  // ── Live ticker for running entry. Re-renders every 1s while a
  //    timer is running; stays idle otherwise.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running?.id]);

  const visible = useMemo(() => {
    if (tab === 'running') return running ? [running] : [];
    if (tab === 'stopped') return stopped;
    if (tab === 'billed')  return billed;
    return [...(running ? [running] : []), ...stopped, ...billed];
  }, [tab, running, stopped, billed]);

  const toggleSel = (id) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSel = () => setSelected(new Set());

  const selectedEntries = useMemo(() =>
    entries.filter((e) => selected.has(e.id)), [entries, selected]);

  // Aggregate selection helpers.
  const selStats = useMemo(() => {
    const billable = selectedEntries.filter((e) => e.status === 'stopped' && e.billable);
    const totalSeconds = billable.reduce((n, e) => n + (e.durationSeconds || 0), 0);
    const totalAmount = billable.reduce((n, e) => n + Number(e.amount || 0), 0);
    const clients = Array.from(new Set(billable.map((e) => e.clientId).filter(Boolean)));
    return { count: billable.length, totalSeconds, totalAmount, clientIds: clients };
  }, [selectedEntries]);

  const billSelected = async () => {
    if (selStats.count === 0) return;
    let clientId = selStats.clientIds[0] || null;
    if (selStats.clientIds.length > 1) {
      window.alert('Pick entries for a single client at a time, or assign them to clients first.');
      return;
    }
    if (!clientId) {
      window.alert('These entries don\'t have a client. Set one before billing.');
      return;
    }
    try {
      const inv = await bill(Array.from(selected).filter((id) => {
        const e = entries.find((x) => x.id === id);
        return e && e.status === 'stopped' && e.billable;
      }), clientId);
      clearSel();
      nav('/finance');
      window.alert(`Created invoice ${inv.number} from ${selStats.count} entr${selStats.count === 1 ? 'y' : 'ies'}.`);
    } catch (ex) {
      window.alert(ex.message || 'Could not bill');
    }
  };

  if (loading) return <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13 }}>Loading time entries…</div>;
  if (error) {
    return (
      <div className="card" style={{ padding: 32 }}>
        <EmptyNote icon="Clock" title="Couldn't load time entries" hint={error.message || 'Try refreshing.'}/>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Timer running={running} defaultRate={defaultRate} onStart={start} onStop={stop}/>

      {selStats.count > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: 10,
          background: 'color-mix(in srgb, var(--accent) 7%, var(--surface-2))',
          border: '1px solid var(--accent)', fontSize: 13,
        }}>
          <span><strong>{selStats.count}</strong> selected · <strong>{fmtDuration(selStats.totalSeconds)}</strong> · <strong>{fmtMoney(selStats.totalAmount)}</strong></span>
          <div style={{ flex: 1 }}/>
          <button className="btn btn-ghost" onClick={clearSel} style={{ fontSize: 12 }}>Clear</button>
          <button className="btn btn-primary" onClick={billSelected}>
            <Icons.Receipt size={13}/> Create invoice
          </button>
        </div>
      )}

      <div className="tab-row">
        {[
          { id: 'all',     label: 'All',          n: entries.length },
          { id: 'running', label: 'Running',      n: running ? 1 : 0 },
          { id: 'stopped', label: 'Ready to bill', n: stopped.length },
          { id: 'billed',  label: 'Billed',       n: billed.length },
        ].map(({ id, label, n }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            background: tab === id ? 'var(--surface)' : 'transparent',
            color: tab === id ? 'var(--fg)' : 'var(--muted)',
            boxShadow: tab === id ? 'var(--shadow-sm)' : 'none',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {label}
            <span style={{
              fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
              background: tab === id ? 'var(--surface-2)' : 'var(--surface)',
              color: 'var(--muted)', fontWeight: 600,
            }}>{n}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Clock" title={`No ${tab === 'all' ? '' : tab + ' '}entries yet`}
            hint={tab === 'all' ? "Hit 'Start timer' above to track your first session." : 'Try a different tab.'}/>
        </div>
      ) : (
        <div className="card table-scroll" style={{ overflow: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '32px 2fr 140px 100px 100px 100px 40px',
            padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div/>
            <div>Description</div>
            <div>Client</div>
            <div>Started</div>
            <div>Duration</div>
            <div style={{ textAlign: 'right' }}>Amount</div>
            <div/>
          </div>
          {visible.map((e, i) => (
            <EntryRow key={e.id} entry={e} first={i === 0}
              selected={selected.has(e.id)}
              onToggle={() => toggleSel(e.id)}
              onOpen={() => setEditingId(e.id)}/>
          ))}
        </div>
      )}

      {editingId && (
        <EntryEditor entry={entries.find((e) => e.id === editingId)}
          defaultRate={defaultRate}
          onClose={() => setEditingId(null)}
          onSave={async (patch) => {
            await update(editingId, patch);
            setEditingId(null);
          }}
          onDelete={async () => { await remove(editingId); setEditingId(null); }}/>
      )}
    </div>
  );
}

// ── Big-button timer card ────────────────────────────────────────
function Timer({ running, defaultRate, onStart, onStop }) {
  const [description, setDescription] = useState('');
  const [clientId, setClientId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [clients, setClients] = useState([]);
  const [services, setServices] = useState([]);

  useEffect(() => {
    api.get('/clients').then((r) => setClients(r.clients || [])).catch(() => {});
    api.get('/calendar/services').then((r) => setServices(r.services || [])).catch(() => {});
  }, []);

  // Pre-fill controls from the running entry so the user sees what's
  // actually being tracked.
  useEffect(() => {
    if (running) {
      setDescription(running.description || '');
      setClientId(running.clientId || '');
      setServiceId(running.serviceId || '');
      setHourlyRate(String(running.hourlyRate || ''));
    }
  }, [running?.id]);

  const liveSeconds = (() => {
    if (!running) return 0;
    const start = new Date(running.startedAt).getTime();
    return Math.max(0, Math.floor((Date.now() - start) / 1000));
  })();

  const start = async () => {
    setBusy(true);
    try {
      await onStart({
        description: description.trim() || null,
        clientId: clientId || null,
        serviceId: serviceId || null,
        hourlyRate: Number(hourlyRate) || defaultRate || 0,
      });
    } catch (ex) {
      window.alert(ex.message || 'Could not start');
    } finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { await onStop(); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{
      padding: 22,
      background: running
        ? 'color-mix(in srgb, var(--accent) 5%, var(--surface))'
        : 'var(--surface)',
      border: running ? '1px solid var(--accent)' : '1px solid var(--border)',
      transition: 'background .2s, border-color .2s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="metric-label" style={{ marginBottom: 4 }}>
            {running ? 'Tracking' : 'Idle — start a timer'}
          </div>
          <div style={{
            fontSize: 38, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
            color: running ? 'var(--accent)' : 'var(--fg-2)', lineHeight: 1.1,
          }}>{fmtDuration(liveSeconds)}</div>
          {running && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Started at {new Date(running.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              {' · '}
              {fmtMoney(((liveSeconds / 3600) * Number(running.hourlyRate || 0)))}
              {' '}so far
            </div>
          )}
        </div>
        {running ? (
          <button className="btn btn-primary" onClick={stop} disabled={busy}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)', padding: '14px 28px', fontSize: 15 }}>
            <Icons.Lock size={16}/> Stop
          </button>
        ) : (
          <button className="btn btn-primary" onClick={start} disabled={busy}
            style={{ padding: '14px 28px', fontSize: 15 }}>
            <Icons.Clock size={16}/> Start timer
          </button>
        )}
      </div>

      <div style={{
        marginTop: 16,
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
      }}>
        <input value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="What are you working on?"
          style={{ ...inputS, gridColumn: '1 / -1' }}/>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} style={inputS}>
          <option value="">— No client —</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={inputS}>
          <option value="">— No service —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 12px', borderRadius: 10,
          border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
        }}>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>$</span>
          <input value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)}
            type="number" min="0" step="0.01"
            placeholder={defaultRate ? `${defaultRate}/hr (default)` : 'Hourly rate'}
            style={{
              flex: 1, padding: '10px 0', background: 'transparent', border: 0,
              outline: 'none', color: 'var(--fg)', fontSize: 14,
            }}/>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>/ hr</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>
          Defaults can be set in Account → Subscription (and per workspace)
        </div>
      </div>
    </div>
  );
}

// ── Row + editor ────────────────────────────────────────────────
function EntryRow({ entry, first, selected, onToggle, onOpen }) {
  const meta = STATUS_META[entry.status] || STATUS_META.stopped;
  const canSelect = entry.status === 'stopped' && entry.billable;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '32px 2fr 140px 100px 100px 100px 40px',
      padding: '12px 20px', alignItems: 'center', cursor: 'pointer',
      borderTop: first ? 'none' : '1px solid var(--border)',
      background: selected ? 'color-mix(in srgb, var(--accent) 5%, var(--surface))' : 'transparent',
    }}
      onClick={onOpen}
      onMouseEnter={(e) => !selected && (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => !selected && (e.currentTarget.style.background = 'transparent')}
    >
      <div onClick={(e) => { e.stopPropagation(); if (canSelect) onToggle(); }}>
        {canSelect ? (
          <input type="checkbox" checked={selected} onChange={() => {}}
            style={{ cursor: 'pointer' }}/>
        ) : <span style={{ color: 'var(--muted-2)', fontSize: 14 }}>·</span>}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {entry.description || <span style={{ color: 'var(--muted-2)' }}>No description</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: meta.color }}>
            <span style={{ width: 5, height: 5, borderRadius: 99, background: meta.color }}/>
            {meta.label}
          </span>
          {entry.serviceName && ` · ${entry.serviceName}`}
          {!entry.billable && ' · non-billable'}
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {entry.clientName || <span style={{ color: 'var(--muted-2)' }}>—</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {new Date(entry.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </div>
      <div className="mono-num" style={{ fontSize: 13, fontWeight: 600 }}>
        {fmtDuration(entry.durationSeconds || 0)}
      </div>
      <div className="mono-num" style={{ fontSize: 13, fontWeight: 600, textAlign: 'right' }}>
        {entry.billable ? fmtMoney(entry.amount) : '—'}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Icons.Arrow size={13} stroke="var(--muted)"/>
      </div>
    </div>
  );
}

function EntryEditor({ entry, defaultRate, onClose, onSave, onDelete }) {
  const [description, setDescription] = useState(entry.description || '');
  const [clientId, setClientId] = useState(entry.clientId || '');
  const [serviceId, setServiceId] = useState(entry.serviceId || '');
  const [hourlyRate, setHourlyRate] = useState(String(entry.hourlyRate || ''));
  const [billable, setBillable] = useState(entry.billable !== false);
  const [hours, setHours]       = useState(((entry.durationSeconds || 0) / 3600).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [clients, setClients] = useState([]);
  const [services, setServices] = useState([]);

  useEffect(() => {
    api.get('/clients').then((r) => setClients(r.clients || [])).catch(() => {});
    api.get('/calendar/services').then((r) => setServices(r.services || [])).catch(() => {});
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const seconds = Math.max(0, Math.round(Number(hours) * 3600));
      await onSave({
        description: description.trim() || null,
        clientId: clientId || null,
        serviceId: serviceId || null,
        hourlyRate: Number(hourlyRate) || 0,
        billable,
        durationSeconds: seconds,
      });
    } catch (ex) {
      window.alert(ex.message || 'Save failed');
    } finally { setBusy(false); }
  };

  const isLocked = entry.status === 'billed';

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="scroll" style={{
        width: '100%', maxWidth: 540, background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="metric-label">Time entry · {entry.status}</div>
            <h3 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 600 }}>
              {description || 'Untitled entry'}
            </h3>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {isLocked && (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 12.5, color: 'var(--muted)',
            }}>
              <Icons.Lock size={11}/> This entry is on invoice and can't be edited.
            </div>
          )}
          <Field label="Description">
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              disabled={isLocked} style={inputS}/>
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Client">
              <select value={clientId} onChange={(e) => setClientId(e.target.value)}
                disabled={isLocked} style={inputS}>
                <option value="">— No client —</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Service">
              <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}
                disabled={isLocked} style={inputS}>
                <option value="">— No service —</option>
                {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Hours">
              <input type="number" min="0" step="0.01"
                value={hours} onChange={(e) => setHours(e.target.value)}
                disabled={isLocked} style={inputS}/>
            </Field>
            <Field label="Rate ($/hr)" hint={defaultRate ? `Workspace default: $${defaultRate}` : null}>
              <input type="number" min="0" step="0.01"
                value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)}
                disabled={isLocked} style={inputS}/>
            </Field>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg-2)' }}>
            <input type="checkbox" checked={billable}
              onChange={(e) => setBillable(e.target.checked)} disabled={isLocked}/>
            Billable
          </label>
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>Delete this entry?</span>
              <button className="btn btn-ghost" onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}
                style={{ background: 'var(--danger)', color: '#fff' }}
                onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }}>
                Delete
              </button>
            </>
          ) : (
            <>
              {!isLocked && (
                <button className="btn btn-ghost" onClick={() => setConfirmDel(true)}
                  style={{ color: 'var(--danger)' }}>
                  <Icons.Trash size={13}/> Delete
                </button>
              )}
              <div style={{ flex: 1 }}/>
              <button className="btn btn-outline" onClick={onClose} disabled={busy}>Close</button>
              {!isLocked && (
                <button className="btn btn-primary" onClick={submit} disabled={busy}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const inputS = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};
