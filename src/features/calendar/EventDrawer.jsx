// Event drawer — for both blocks (editable) and bookings (view + cancel options).
import React, { useState } from 'react';
import Drawer, { TimeInput, inputSty } from './Drawer.jsx';
import { minToHM, parseISO, RECURRENCE_OPTIONS } from './utils.js';
import { api } from '../../lib/api.js';

export default function EventDrawer({
  event, services,
  onSaveBlock, onUpdateBooking, onCancelOccurrence,
  onDelete, onClose,
}) {
  if (event.kind === 'booking') {
    return (
      <BookingView
        event={event}
        services={services}
        onUpdateBooking={onUpdateBooking}
        onCancelOccurrence={onCancelOccurrence}
        onCancelSeries={onDelete}
        onClose={onClose}
      />
    );
  }
  return <BlockEdit event={event} onSave={onSaveBlock} onDelete={onDelete} onClose={onClose}/>;
}

function BookingView({ event, services, onUpdateBooking, onCancelOccurrence, onCancelSeries, onClose }) {
  const svc = services.find((s) => s.id === event.serviceId);
  const isRecurring = !!event.recurrenceRule;
  const masterId = event.recurrenceMasterId || event.id;
  const occurrenceISO = event.occurrenceDate || event.date;

  const [busy, setBusy] = useState(false);
  const [confirmKind, setConfirmKind] = useState(null); // 'occurrence' | 'series'
  const [editingRecurrence, setEditingRecurrence] = useState(false);
  const [draftRule, setDraftRule]   = useState(event.recurrenceRule || null);
  const [draftUntil, setDraftUntil] = useState(event.recurrenceUntil || '');

  const cancelOccurrence = async () => {
    setBusy(true);
    try { await onCancelOccurrence(masterId, occurrenceISO); onClose(); } finally { setBusy(false); }
  };
  const cancelSeries = async () => {
    setBusy(true);
    try { await onCancelSeries({ ...event, id: masterId }); onClose(); } finally { setBusy(false); }
  };
  const saveRecurrence = async () => {
    setBusy(true);
    try {
      await onUpdateBooking(masterId, {
        recurrenceRule: draftRule,
        recurrenceUntil: draftUntil || null,
      });
      setEditingRecurrence(false);
    } finally { setBusy(false); }
  };

  return (
    <Drawer title="Booking details" subtitle={isRecurring ? 'Part of a recurring series.' : null} onClose={onClose}>
      <InfoRow label="Client"  value={event.clientName}/>
      <InfoRow label="Email"   value={event.clientEmail}/>
      <InfoRow label="Service" value={svc?.name || '—'}/>
      <InfoRow label="Date"    value={parseISO(occurrenceISO).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}/>
      <InfoRow label="Time"    value={`${minToHM(event.startMin)} – ${minToHM(event.endMin)}`}/>
      <InfoRow label="Price"   value={svc ? `$${Number(svc.price).toLocaleString()}` : '—'}/>
      {event.notes && <InfoRow label="Notes" value={event.notes}/>}

      {/* Recurrence editor */}
      <div style={{ marginTop: 18 }}>
        <div className="metric-label" style={{ marginBottom: 8 }}>Recurrence</div>
        {!editingRecurrence ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: 13, color: 'var(--fg-2)', flex: 1 }}>
              {isRecurring
                ? `${ruleLabel(event.recurrenceRule)}${event.recurrenceUntil ? `, until ${event.recurrenceUntil}` : ', no end date'}`
                : "Doesn't repeat"}
            </span>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 8px' }}
              onClick={() => setEditingRecurrence(true)}>
              {isRecurring ? 'Change' : 'Add recurrence'}
            </button>
          </div>
        ) : (
          <div style={{
            padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <select value={draftRule || ''} onChange={(e) => setDraftRule(e.target.value || null)} style={inputSty}>
              {RECURRENCE_OPTIONS.map((r) => (
                <option key={r.value || 'none'} value={r.value || ''}>{r.label}</option>
              ))}
            </select>
            {draftRule && (
              <input type="date" value={draftUntil} onChange={(e) => setDraftUntil(e.target.value)}
                placeholder="Until (optional)" style={inputSty}/>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => { setEditingRecurrence(false); setDraftRule(event.recurrenceRule || null); setDraftUntil(event.recurrenceUntil || ''); }} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={saveRecurrence} disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Booking-detail extras: location, no-show + tip + late-cancel
          fee. Surfaced before the destructive cancel actions so they
          aren't visually grouped with "Cancel booking." */}
      {event.locationAddress && (
        <InfoRow label="Address" value={event.locationAddress}/>
      )}
      {(event.noShowAt || Number(event.feeChargedAmount) > 0 || Number(event.tipAmount) > 0) && (
        <div style={{
          marginTop: 14, padding: '10px 12px', borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55,
        }}>
          {event.noShowAt && <div>No-show recorded {new Date(event.noShowAt).toLocaleDateString()}.</div>}
          {Number(event.feeChargedAmount) > 0 && (
            <div>
              {event.feeChargedKind === 'late_cancel' ? 'Late-cancel fee' : 'No-show fee'} charged:
              {' '}<b>${Number(event.feeChargedAmount).toFixed(2)}</b>
            </div>
          )}
          {Number(event.tipAmount) > 0 && (
            <div>Tip: <b>${Number(event.tipAmount).toFixed(2)}</b></div>
          )}
        </div>
      )}

      {!event.cancelledAt && !event.noShowAt && (
        <BookingExtraActions event={event}/>
      )}

      {/* Cancel actions */}
      <div style={{ display: 'flex', gap: 10, marginTop: 24, flexDirection: 'column' }}>
        {confirmKind === 'occurrence' ? (
          <ConfirmRow
            text={`Cancel just this appointment on ${parseISO(occurrenceISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}?`}
            onCancel={() => setConfirmKind(null)}
            onConfirm={cancelOccurrence}
            busy={busy}
          />
        ) : confirmKind === 'series' ? (
          <ConfirmRow
            text={isRecurring
              ? 'Cancel this booking AND every future occurrence in the series?'
              : "Cancel this booking? This can't be undone."}
            onCancel={() => setConfirmKind(null)}
            onConfirm={cancelSeries}
            busy={busy}
          />
        ) : (
          <>
            <button className="btn btn-outline" style={{ justifyContent: 'center' }} onClick={onClose}>Close</button>
            {isRecurring && (
              <button className="btn btn-primary"
                style={{ justifyContent: 'center', background: 'var(--danger)', color: '#fff' }}
                onClick={() => setConfirmKind('occurrence')}>
                Cancel just this appointment
              </button>
            )}
            <button className="btn btn-primary"
              style={{ justifyContent: 'center', background: 'var(--danger)', color: '#fff' }}
              onClick={() => setConfirmKind('series')}>
              {isRecurring ? 'Cancel entire series' : 'Cancel booking'}
            </button>
          </>
        )}
      </div>
    </Drawer>
  );
}

function ruleLabel(rule) {
  return RECURRENCE_OPTIONS.find((r) => r.value === rule)?.label || rule;
}

// No-show + tip + manual-fee actions. All hit endpoints that
// off-session-charge against the client's saved card; if no card is
// on file, the no-show endpoint still records the no-show but skips
// the charge, and the tip / fee endpoints surface a clear error.
function BookingExtraActions({ event }) {
  const [openAction, setOpenAction] = useState(null); // 'no_show' | 'tip' | 'late_cancel'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [tipAmount, setTipAmount] = useState('');
  const [feeAmount, setFeeAmount] = useState('');

  const close = () => {
    setOpenAction(null); setError(null); setSuccess(null);
    setTipAmount(''); setFeeAmount('');
  };

  const markNoShow = async (chargeFee) => {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/calendar/bookings/no-show', { id: event.id, chargeFee });
      setSuccess(r.charged
        ? `Marked no-show + charged $${r.chargeAmount.toFixed(2)}.`
        : (r.chargeError ? `Marked no-show — charge failed: ${r.chargeError}` : 'Marked no-show.'));
      setTimeout(close, 2500);
    } catch (e) {
      setError(e.message || 'Failed');
    } finally { setBusy(false); }
  };

  const charge = async (kind, amount) => {
    setBusy(true); setError(null);
    try {
      const path = kind === 'tip' ? '/calendar/bookings/tip' : '/calendar/bookings/charge-fee';
      const body = kind === 'tip'
        ? { id: event.id, amount: Number(amount) }
        : { id: event.id, kind, amount: Number(amount) || undefined };
      const r = await api.post(path, body);
      setSuccess(`Charged $${(r.chargeAmount || amount).toFixed(2)} to the card on file.`);
      setTimeout(close, 2500);
    } catch (e) {
      setError(e.message || 'Charge failed');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Quick actions</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        <button className="btn btn-outline" onClick={() => setOpenAction('no_show')}
          style={{ fontSize: 12, padding: '8px 10px', justifyContent: 'center' }}>
          No-show
        </button>
        <button className="btn btn-outline" onClick={() => setOpenAction('late_cancel')}
          style={{ fontSize: 12, padding: '8px 10px', justifyContent: 'center' }}>
          Charge fee
        </button>
        <button className="btn btn-outline" onClick={() => setOpenAction('tip')}
          style={{ fontSize: 12, padding: '8px 10px', justifyContent: 'center' }}>
          Add tip
        </button>
      </div>

      {openAction && (
        <div style={{
          marginTop: 10, padding: 12, borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {error && (
            <div style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12,
            }}>{error}</div>
          )}
          {success && (
            <div style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'color-mix(in srgb, var(--ok) 8%, var(--surface))',
              border: '1px solid var(--ok)',
              color: 'var(--ok)', fontSize: 12,
            }}>{success}</div>
          )}
          {!success && openAction === 'no_show' && (
            <>
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                Mark this booking as a no-show. If you set a no-show fee on the service AND there's a card on file, we'll auto-charge.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline" disabled={busy} onClick={() => markNoShow(false)}
                  style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}>
                  Mark only
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={() => markNoShow(true)}
                  style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}>
                  Mark + charge fee
                </button>
              </div>
            </>
          )}
          {!success && openAction === 'late_cancel' && (
            <>
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                Manually charge a late-cancel fee against the card on file. Leave amount blank to use the policy amount.
              </div>
              <input type="number" min="0" step="0.01"
                value={feeAmount} onChange={(e) => setFeeAmount(e.target.value)}
                placeholder="Amount in $ (optional)"
                style={inputSty}/>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline" disabled={busy} onClick={close}
                  style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}>Cancel</button>
                <button className="btn btn-primary" disabled={busy}
                  onClick={() => charge('late_cancel', feeAmount)}
                  style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}>Charge</button>
              </div>
            </>
          )}
          {!success && openAction === 'tip' && (
            <>
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                Charge a tip against the client's card on file.
              </div>
              <input type="number" min="0" step="0.01"
                value={tipAmount} onChange={(e) => setTipAmount(e.target.value)}
                placeholder="Tip amount in $"
                autoFocus
                style={inputSty}/>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline" disabled={busy} onClick={close}
                  style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}>Cancel</button>
                <button className="btn btn-primary" disabled={busy || !tipAmount}
                  onClick={() => charge('tip', tipAmount)}
                  style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}>Charge tip</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmRow({ text, onCancel, onConfirm, busy }) {
  return (
    <>
      <div style={{ fontSize: 12.5, color: 'var(--danger)', marginBottom: 4 }}>{text}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-outline" onClick={onCancel} disabled={busy} style={{ flex: 1, justifyContent: 'center' }}>
          Keep it
        </button>
        <button className="btn btn-primary" disabled={busy}
          style={{ flex: 1, justifyContent: 'center', background: 'var(--danger)', color: '#fff' }}
          onClick={onConfirm}>
          {busy ? 'Cancelling…' : 'Confirm cancel'}
        </button>
      </div>
    </>
  );
}

function BlockEdit({ event, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState({
    date: event.date,
    startMin: event.startMin,
    endMin: event.endMin,
    label: event.label || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave({ ...event, ...draft });
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!event.id) { onClose(); return; }
    setBusy(true);
    try { await onDelete(event); onClose(); } finally { setBusy(false); }
  };

  return (
    <Drawer
      title={event.id ? 'Edit blocked time' : 'Block time'}
      subtitle="Clients can't book during blocked periods."
      onClose={onClose}
    >
      <Field label="Reason (optional)">
        <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Lunch, vacation, personal…" style={inputSty}/>
      </Field>
      <Field label="Date">
        <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })}
          style={inputSty}/>
      </Field>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Start</div>
          <TimeInput minutes={draft.startMin} onChange={(v) => setDraft({ ...draft, startMin: v })}/>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>End</div>
          <TimeInput minutes={draft.endMin} onChange={(v) => setDraft({ ...draft, endMin: v })}/>
        </div>
      </div>

      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5, marginBottom: 12,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
        {event.id && (
          <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={remove} disabled={busy}>
            Delete
          </button>
        )}
        <div style={{ flex: 1 }}/>
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy} style={{ opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Drawer>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12 }}>
      <div style={{ width: 100, fontSize: 12, color: 'var(--muted)' }}>{label}</div>
      <div style={{ flex: 1, fontSize: 14, fontWeight: 500, wordBreak: 'break-word' }}>{value}</div>
    </div>
  );
}
