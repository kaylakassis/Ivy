// Recurring invoices: list of schedules + create/edit modal. Each
// schedule defines a template (line items, tax/discount, notes,
// client) plus a cadence (weekly / biweekly / monthly / quarterly /
// yearly) that the daily cron uses to mint a real invoice at every
// interval. Status flips between active / paused / ended; when
// auto_send is on, generated invoices are emailed automatically.
import React, { useState, useEffect, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { fmtDateOnly, localISODate } from '../../lib/dateOnly.js';
import { useRecurring } from './recurringState.js';
import { seriesAutopayLabel, fmtAmount, fmtDay, cardShort } from '../../lib/autopayRules.js';

const CADENCE_LABEL = {
  weekly:    'Weekly',
  biweekly:  'Every 2 weeks',
  monthly:   'Monthly',
  quarterly: 'Every 3 months',
  yearly:    'Yearly',
};
const STATUS_META = {
  active: { label: 'Active', color: 'var(--ok)' },
  paused: { label: 'Paused', color: 'var(--warn)' },
  ended:  { label: 'Ended',  color: 'var(--muted-2)' },
};

export default function Recurring() {
  const { schedules, loading, error, create, update, remove, runNow, setAutopay } = useRecurring();
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const editing = schedules.find((s) => s.id === editingId) || null;

  if (loading) return <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13 }}>Loading recurring invoices…</div>;
  if (error) {
    return (
      <div className="card" style={{ padding: 32 }}>
        <EmptyNote icon="Repeat" title="Couldn't load recurring invoices" hint={error.message || 'Try refreshing.'}/>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 16px', borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5,
      }}>
        <Icons.Repeat size={14} stroke="var(--accent)"/>
        <span>
          Recurring schedules auto-create a fresh invoice on each cycle. New
          invoices land as drafts unless <b>auto-send</b> is on, in which case
          they email the client immediately.
        </span>
        <div style={{ flex: 1 }}/>
        <button className="btn btn-primary" onClick={() => setCreatingOpen(true)}>
          <Icons.Plus size={13}/> New schedule
        </button>
      </div>

      {schedules.length === 0 ? (
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote
            icon="Repeat"
            title="No recurring invoices yet"
            hint="Set up a monthly retainer or weekly billing - invoices will be generated and (optionally) sent for you."
          />
        </div>
      ) : (
        <div className="card table-scroll" style={{ overflow: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '2fr 130px 130px 130px 110px 100px 40px',
            padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div>Schedule</div><div>Cadence</div><div>Next run</div><div>Per cycle</div>
            <div>Status</div><div>Run</div><div/>
          </div>
          {schedules.map((s, i) => (
            <ScheduleRow key={s.id} schedule={s} first={i === 0}
              onOpen={() => setEditingId(s.id)}
              onRunNow={async () => {
                if (s.status !== 'active') return;
                setBusyId(s.id);
                try { await runNow(s.id); }
                finally { setBusyId(null); }
              }}
              busy={busyId === s.id}/>
          ))}
        </div>
      )}

      {creatingOpen && (
        <ScheduleEditor onClose={() => setCreatingOpen(false)}
          onSave={async (input, { autopay } = {}) => {
            const made = await create(input);
            // Turning autopay on for a new series sends the client the
            // approval request right after it exists.
            if (autopay && made?.id) {
              try { await setAutopay(made.id, 'request'); } catch { /* shown on the series */ }
            }
            setCreatingOpen(false);
          }}/>
      )}
      {editing && (
        <ScheduleEditor schedule={editing}
          onAutopay={(action) => setAutopay(editing.id, action)}
          onClose={() => setEditingId(null)}
          onSave={async (patch) => { await update(editing.id, patch); setEditingId(null); }}
          onDelete={async () => { await remove(editing.id); setEditingId(null); }}/>
      )}
    </div>
  );
}

function ScheduleRow({ schedule, first, onOpen, onRunNow, busy }) {
  const meta = STATUS_META[schedule.status] || STATUS_META.active;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '2fr 130px 130px 130px 110px 100px 40px',
      padding: '14px 20px', alignItems: 'center', cursor: 'pointer',
      borderTop: first ? 'none' : '1px solid var(--border)',
      transition: 'background .1s',
    }}
      onClick={onOpen}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {schedule.name}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {schedule.clientName || 'No client yet'}
          {schedule.autoSend ? ' · auto-sends' : ' · creates as draft'}
          {' · '}{schedule.occurrencesRun} cycle{schedule.occurrencesRun === 1 ? '' : 's'} run
        </div>
        <AutopayChip autopay={schedule.autopay}/>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
        {CADENCE_LABEL[schedule.cadence] || schedule.cadence}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
        {schedule.nextRunAt ? fmtDateOnly(schedule.nextRunAt) : '-'}
      </div>
      <div className="mono-num" style={{ fontSize: 13.5, fontWeight: 600 }}>
        {fmtMoney(schedule.total)}
      </div>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 99,
        fontSize: 11, fontWeight: 600, justifySelf: 'flex-start',
        background: 'var(--surface-2)', border: '1px solid var(--border)', color: meta.color,
      }}>
        <span style={{ width: 5, height: 5, borderRadius: 99, background: meta.color }}/>{meta.label}
      </span>
      <button className="btn btn-ghost"
        disabled={schedule.status !== 'active' || busy}
        onClick={(e) => { e.stopPropagation(); onRunNow(); }}
        style={{ fontSize: 11, padding: '4px 10px', justifySelf: 'flex-start',
          opacity: schedule.status !== 'active' ? 0.4 : 1 }}>
        {busy ? '…' : 'Run now'}
      </button>
      <Icons.Arrow size={13} stroke="var(--muted)"/>
    </div>
  );
}

function AutopayChip({ autopay }) {
  const state = autopay?.state || 'off';
  const color = state === 'on' ? 'var(--ok)' : state === 'waiting' ? 'var(--warn)' : 'var(--muted)';
  return (
    <div data-testid="autopay-chip" style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 5,
      fontSize: 11, fontWeight: 600, color,
    }}>
      <Icons.Repeat size={11} stroke={color}/>
      {seriesAutopayLabel(autopay)}
    </div>
  );
}

function Switch({ checked, disabled, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={onChange} disabled={disabled}
      style={{
        flexShrink: 0, width: 36, height: 22, borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--border-strong)',
        border: 0, padding: 2, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}>
      <span className="switch-thumb" style={{
        display: 'block', width: 18, height: 18, borderRadius: 999, background: '#fff',
        transform: checked ? 'translateX(14px)' : 'translateX(0)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }}/>
    </button>
  );
}

const ENDED_BY = {
  client: 'Your client turned autopay off',
  owner: 'You turned autopay off',
  system: 'Autopay stopped',
};

// Owner control for one series. The owner can only ASK: charging starts
// once the client approves in their portal (amount, how often, start date,
// how to cancel), and stops the moment either side turns it off.
function AutopayField({ schedule, isNew, wantNew, setWantNew, onAutopay }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const ap = schedule?.autopay || { state: 'off' };
  // A brand-new series hasn't asked the server yet; assume available and
  // let the request explain if it isn't.
  const available = isNew ? true : schedule?.autopayAvailable !== false;
  const reason = schedule?.autopayUnavailableReason;
  const on = isNew ? wantNew : ap.state !== 'off';

  const act = async (action) => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await onAutopay(action);
      if (action === 'request') setNote(r?.emailed ? 'Request sent. We emailed your client.' : null);
    } catch (e) { setErr(e.message || 'Something went wrong'); }
    finally { setBusy(false); }
  };
  const toggle = () => {
    if (isNew) { setWantNew(!wantNew); return; }
    if (on) {
      if (ap.state === 'on' && !window.confirm('Turn off autopay? Your client will be told, and the next invoices will be emailed for them to pay.')) return;
      act('off');
    } else {
      act('request');
    }
  };

  return (
    <div data-testid="autopay-field" style={{
      padding: 14, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' }}>Charge automatically to the client's saved card</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>
            {available
              ? "Your client gets an email to approve it first. Until they do, invoices are emailed with a pay link as usual."
              : reason}
          </div>
        </div>
        <Switch checked={!!on && available} disabled={!available || busy} onChange={toggle} label="Charge automatically"/>
      </div>

      {!isNew && available && ap.state === 'waiting' && (
        <StatusLine tone="warn" text="Waiting for client to authorize"
          sub={ap.requestEmailedAt ? `Request emailed ${fmtDay(ap.requestEmailedAt, { year: false })}.` : null}
          action={<button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act('request')} style={smallBtn}>Send again</button>}/>
      )}
      {!isNew && ap.state === 'on' && (
        <StatusLine tone="ok" text={seriesAutopayLabel(ap)}
          sub={`Approved ${fmtDay(ap.authorizedAt, { year: false })} for up to ${fmtAmount(ap.maxAmountCents, ap.currency || 'USD')} per invoice. Each new invoice is charged the day it is created.`}/>
      )}
      {!isNew && ap.state === 'on' && (ap.overApproved || ap.cardChanged) && !ap.reapprovalRequested && (
        <StatusLine tone="warn"
          text={ap.overApproved ? 'The total is now higher than your client approved.' : 'Your client saved a different card.'}
          sub="Until they approve again, invoices are emailed with a pay link."
          action={<button type="button" className="btn btn-outline" disabled={busy} onClick={() => act('request')} style={smallBtn}>Ask to approve again</button>}/>
      )}
      {!isNew && ap.state === 'on' && ap.reapprovalRequested && (
        <StatusLine tone="warn" text="Asked your client to approve the new details" sub={ap.card ? `Meanwhile the ${cardShort(ap.card.brand, ap.card.last4)} approval stays as it was.` : null}/>
      )}
      {!isNew && ap.state === 'off' && ap.lastEnded && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {ENDED_BY[ap.lastEnded.by] || 'Autopay stopped'} on {fmtDay(ap.lastEnded.at, { year: false })}.
        </div>
      )}
      {note && <div role="status" style={{ fontSize: 12, color: 'var(--ok)' }}>{note}</div>}
      {err && <div role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

const smallBtn = { fontSize: 12, padding: '5px 10px', flexShrink: 0 };

function StatusLine({ tone, text, sub, action }) {
  const color = tone === 'ok' ? 'var(--ok)' : 'var(--warn)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: color, flexShrink: 0 }}/>{text}
        </div>
        {sub && <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 2, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      {action}
    </div>
  );
}

function ScheduleEditor({ schedule, onClose, onSave, onDelete, onAutopay }) {
  const isNew = !schedule;
  const [name, setName]       = useState(schedule?.name || '');
  const [clientId, setClientId] = useState(schedule?.clientId || '');
  const [items, setItems]     = useState(() =>
    (schedule?.items?.length ? schedule.items : [{ id: 'li1', description: '', quantity: 1, rate: 0 }]).map((it) => ({ ...it }))
  );
  const [taxRate, setTaxRate]   = useState(schedule?.taxRate ?? 0);
  const [discount, setDiscount] = useState(schedule?.discount ?? 0);
  const [notes, setNotes]     = useState(schedule?.notes || '');
  const [cadence, setCadence] = useState(schedule?.cadence || 'monthly');
  const [nextRunAt, setNextRunAt] = useState(
    schedule?.nextRunAt || localISODate()
  );
  const [endDate, setEndDate] = useState(schedule?.endDate || '');
  const [autoSend, setAutoSend] = useState(schedule ? !!schedule.autoSend : true);
  const [status, setStatus] = useState(schedule?.status || 'active');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [wantAutopay, setWantAutopay] = useState(false);

  const [clients, setClients] = useState([]);
  useEffect(() => {
    api.get('/clients').then((r) => setClients(r.clients || [])).catch(() => {});
  }, []);

  const subtotal = useMemo(() => items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.rate) || 0), 0), [items]);
  const taxable  = Math.max(0, subtotal - Number(discount || 0));
  const tax      = taxable * (Number(taxRate || 0) / 100);
  const total    = taxable + tax;

  const updateItem = (i, patch) => setItems((xs) => xs.map((it, j) => j === i ? { ...it, ...patch } : it));
  const removeItem = (i) => setItems((xs) => xs.filter((_, j) => j !== i));
  const addItem    = () => setItems((xs) => [
    ...xs,
    { id: `li${Date.now().toString(36)}`, description: '', quantity: 1, rate: 0 },
  ]);

  const submit = async () => {
    if (!name.trim()) { setErr('Name is required'); return; }
    if (!clientId) { setErr('Pick a client'); return; }
    if (!items.length) { setErr('Add at least one line item'); return; }
    setBusy(true); setErr(null);
    try {
      await onSave({
        name: name.trim(),
        clientId,
        items,
        taxRate: Number(taxRate) || 0,
        discount: Number(discount) || 0,
        notes: notes || null,
        cadence,
        nextRunAt,
        endDate: endDate || null,
        autoSend,
        ...(isNew ? {} : { status }),
      }, { autopay: isNew && wantAutopay });
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="scroll" style={{
        width: '100%', maxWidth: 720, background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="metric-label">{isNew ? 'New schedule' : 'Edit schedule'}</div>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Monthly retainer - Jane"
              style={{
                background: 'transparent', border: 0, outline: 'none',
                fontSize: 20, fontWeight: 600, color: 'var(--fg)', width: '100%',
                fontFamily: 'inherit',
              }}/>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Client */}
          <Field label="Client">
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} style={inputS}>
              <option value="">- Select a client -</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.email ? ` · ${c.email}` : ''}
                </option>
              ))}
            </select>
          </Field>

          {/* Cadence */}
          <div className="form-2col" style={{ gap: 12 }}>
            <Field label="Cadence">
              <select value={cadence} onChange={(e) => setCadence(e.target.value)} style={inputS}>
                {Object.entries(CADENCE_LABEL).map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </Field>
            <Field label={schedule ? 'Next run' : 'First run'}>
              <input type="date" value={nextRunAt} onChange={(e) => setNextRunAt(e.target.value)} style={inputS}/>
            </Field>
            <Field label="End date (optional)" hint="Leave blank to recur forever.">
              <input type="date" value={endDate || ''} onChange={(e) => setEndDate(e.target.value)} style={inputS}/>
            </Field>
            <Field label="Auto-send">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--fg-2)' }}>
                <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)}/>
                Email the client automatically when each invoice is generated
              </label>
            </Field>
          </div>

          <Field label="Automatic payment">
            <AutopayField schedule={schedule} isNew={isNew}
              wantNew={wantAutopay} setWantNew={setWantAutopay} onAutopay={onAutopay}/>
          </Field>

          {!isNew && (
            <Field label="Status">
              <div style={{ display: 'flex', gap: 6 }}>
                {Object.entries(STATUS_META).map(([id, m]) => (
                  <button key={id} type="button" onClick={() => setStatus(id)}
                    style={{
                      padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                      border: '1px solid var(--border-strong)',
                      background: status === id ? m.color : 'var(--surface-2)',
                      color: status === id ? '#fff' : 'var(--fg-2)',
                      cursor: 'pointer',
                    }}>{m.label}</button>
                ))}
              </div>
            </Field>
          )}

          {/* Line items */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <div className="metric-label" style={{ flex: 1 }}>Line items</div>
              <button className="btn btn-ghost" onClick={addItem} style={{ fontSize: 12, padding: '4px 8px' }}>
                <Icons.Plus size={12}/> Add line
              </button>
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: '2fr 80px 90px 90px 30px',
              fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase',
              fontWeight: 600, color: 'var(--muted)', padding: '0 12px 6px',
            }}>
              <div>Description</div><div>Qty</div><div>Rate</div>
              <div style={{ textAlign: 'right' }}>Amount</div><div/>
            </div>
            {items.map((it, i) => (
              <div key={it.id || i} style={{
                display: 'grid', gridTemplateColumns: '2fr 80px 90px 90px 30px', gap: 8,
                padding: 10, marginBottom: 6, borderRadius: 10,
                border: '1px solid var(--border)', background: 'var(--surface-2)',
              }}>
                <input value={it.description} onChange={(e) => updateItem(i, { description: e.target.value })}
                  placeholder="Service / item" style={{ ...inputS, padding: '7px 10px' }}/>
                <input type="number" min="0" step="0.01"
                  value={it.quantity} onChange={(e) => updateItem(i, { quantity: e.target.value })}
                  style={{ ...inputS, padding: '7px 10px', textAlign: 'right' }}/>
                <input type="number" min="0" step="0.01"
                  value={it.rate} onChange={(e) => updateItem(i, { rate: e.target.value })}
                  style={{ ...inputS, padding: '7px 10px', textAlign: 'right' }}/>
                <div className="mono-num" style={{
                  fontSize: 13, fontWeight: 600, color: 'var(--fg)',
                  textAlign: 'right', alignSelf: 'center',
                }}>{fmtMoney((Number(it.quantity) || 0) * (Number(it.rate) || 0))}</div>
                <button className="btn btn-ghost" onClick={() => removeItem(i)} style={{ padding: '8px 10px', minHeight: 36, color: 'var(--danger)' }}>
                  <Icons.X size={13}/>
                </button>
              </div>
            ))}
          </div>

          {/* Tax / discount */}
          <div className="form-2col" style={{ gap: 12 }}>
            <Field label="Tax rate (%)">
              <input type="number" min="0" max="100" step="0.001"
                value={taxRate} onChange={(e) => setTaxRate(e.target.value)} style={inputS}/>
            </Field>
            <Field label="Discount ($)">
              <input type="number" min="0" step="0.01"
                value={discount} onChange={(e) => setDiscount(e.target.value)} style={inputS}/>
            </Field>
          </div>

          {/* Totals */}
          <div style={{
            padding: 14, borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>
            <Row label="Subtotal" value={fmtMoney(subtotal)}/>
            {Number(discount) > 0 && <Row label="Discount" value={`− ${fmtMoney(Number(discount))}`}/>}
            {Number(taxRate) > 0 && <Row label={`Tax (${taxRate}%)`} value={fmtMoney(tax)}/>}
            <Row label="Total" value={fmtMoney(total)} bold/>
          </div>

          <Field label="Notes (optional)" hint="Shown on every generated invoice.">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              placeholder="Payment terms, billing context, etc."
              style={{ ...inputS, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}/>
          </Field>
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          {confirmDel ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>Delete this schedule?</span>
              <button className="btn btn-ghost" onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}
                style={{ background: 'var(--danger)', color: '#fff' }}
                onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }}>
                Delete
              </button>
            </>
          ) : (
            <>
              {!isNew && (
                <button className="btn btn-ghost" onClick={() => setConfirmDel(true)}
                  style={{ color: 'var(--danger)' }}>
                  <Icons.Trash size={13}/> Delete
                </button>
              )}
              <div style={{ flex: 1 }}/>
              {err && <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</span>}
              <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" onClick={submit} disabled={busy}>
                {busy ? 'Saving…' : (isNew ? 'Create schedule' : 'Save')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '4px 0', fontSize: bold ? 14.5 : 13,
      fontWeight: bold ? 700 : 500,
      color: bold ? 'var(--fg)' : 'var(--fg-2)',
      borderTop: bold ? '1px solid var(--border)' : 'none',
      paddingTop: bold ? 10 : 4,
      marginTop: bold ? 6 : 0,
    }}>
      <span>{label}</span>
      <span className="mono-num">{value}</span>
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

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const inputS = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};
