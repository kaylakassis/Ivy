// Event drawer — for both blocks (editable) and bookings (view + cancel options).
import React, { useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import Drawer, { TimeInput, inputSty } from './Drawer.jsx';
import { minToHM, hmToMin, parseISO, RECURRENCE_OPTIONS, isOccurrencePast } from './utils.js';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import CollectInPersonModal from '../finance/CollectInPersonModal.jsx';

export default function EventDrawer({
  event, services,
  onSaveBlock, onUpdateBooking, onCancelOccurrence,
  onCompleteBooking, onEditCompletion, onClearCompletion,
  onDelete, onClose,
}) {
  if (event.kind === 'booking') {
    return (
      <BookingView
        event={event}
        services={services}
        onUpdateBooking={onUpdateBooking}
        onCancelOccurrence={onCancelOccurrence}
        onCompleteBooking={onCompleteBooking}
        onEditCompletion={onEditCompletion}
        onClearCompletion={onClearCompletion}
        onCancelSeries={onDelete}
        onClose={onClose}
      />
    );
  }
  return <BlockEdit event={event} onSave={onSaveBlock} onDelete={onDelete} onClose={onClose}/>;
}

function BookingView({ event, services, onUpdateBooking, onCancelOccurrence, onCompleteBooking, onEditCompletion, onClearCompletion, onCancelSeries, onClose }) {
  const svc = services.find((s) => s.id === event.serviceId);
  const isRecurring = !!event.recurrenceRule;
  const masterId = event.recurrenceMasterId || event.id;
  const occurrenceISO = event.occurrenceDate || event.date;

  const [busy, setBusy] = useState(false);
  const [confirmKind, setConfirmKind] = useState(null); // 'occurrence' | 'series'
  const [editingRecurrence, setEditingRecurrence] = useState(false);
  const [draftRule, setDraftRule]   = useState(event.recurrenceRule || null);
  const [draftUntil, setDraftUntil] = useState(event.recurrenceUntil || '');
  // Reschedule editor — only visible for single (non-recurring) bookings.
  // Recurring bookings can't be rescheduled wholesale; owner must cancel
  // the occurrence + book a new one (same constraint as the client portal).
  //
  // Time inputs use HH:MM 24-hour format (HTML input[type=time]).
  // toTimeInput() converts our internal minute-of-day to that format.
  // Defensive null/NaN coercion — a malformed event row with missing
  // startMin/endMin would otherwise render "NaN:NaN" which the time
  // input rejects silently. Default to 09:00 / 10:00 so the editor is
  // at least usable.
  const toTimeInput = (m) => {
    const n = Number(m);
    const safe = Number.isFinite(n) ? Math.max(0, Math.min(24 * 60 - 1, Math.floor(n))) : 0;
    const h = Math.floor(safe / 60).toString().padStart(2, '0');
    const mm = (safe % 60).toString().padStart(2, '0');
    return `${h}:${mm}`;
  };
  const [editingReschedule, setEditingReschedule] = useState(false);
  const [rescheduleDate, setRescheduleDate]   = useState(typeof occurrenceISO === 'string' ? occurrenceISO.slice(0, 10) : '');
  const [rescheduleStart, setRescheduleStart] = useState(toTimeInput(event.startMin));
  const [rescheduleEnd, setRescheduleEnd]     = useState(toTimeInput(event.endMin));
  const [rescheduleErr, setRescheduleErr]     = useState(null);

  const saveReschedule = async () => {
    setRescheduleErr(null);
    const startMin = hmToMin(rescheduleStart);
    const endMin = hmToMin(rescheduleEnd);
    if (!Number.isInteger(startMin) || !Number.isInteger(endMin) || endMin <= startMin) {
      setRescheduleErr('End time must be after start time.');
      return;
    }
    setBusy(true);
    try {
      await onUpdateBooking(event.id, {
        rescheduleTo: { date: rescheduleDate, startMin, endMin },
      });
      // Close the whole drawer on success — the booking has moved,
      // there's nothing else to act on here. Matches the cancel /
      // delete flow.
      onClose();
    } catch (e) {
      setRescheduleErr(e.message || 'Could not reschedule');
    } finally { setBusy(false); }
  };

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

      {/* Mobile address (from client) + in-person venue (from service)
          + video room URL surfaced for the owner so they know where to
          go or how to dial in. */}
      {event.locationAddress && (
        <InfoRow label="Address" value={event.locationAddress}/>
      )}
      {!event.locationAddress && svc?.locationType === 'in_person' && svc?.locationLabel && (
        <InfoRow label="Where" value={svc.locationLabel}/>
      )}
      {event.videoRoomUrl && (
        <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10,
          background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--surface-2))',
          border: '1px solid var(--accent)' }}>
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
            Meeting room
          </div>
          <a href={event.videoRoomUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 12.5, color: 'var(--fg)', wordBreak: 'break-all', textDecoration: 'underline' }}>
            {event.videoRoomUrl}
          </a>
        </div>
      )}
      {event.customFieldValues && Object.keys(event.customFieldValues).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="metric-label" style={{ marginBottom: 6 }}>Intake</div>
          {Object.entries(event.customFieldValues).map(([k, v]) => (
            <InfoRow key={k} label={k} value={String(v)}/>
          ))}
        </div>
      )}

      {/* Reschedule — single-occurrence bookings only. The API rejects
          reschedules on recurring series (cancel-occurrence-then-book
          is the documented path), so the UI hides it for those. */}
      {!isRecurring && !event.cancelledAt && (
        <div style={{ marginTop: 18 }}>
          <div className="metric-label" style={{ marginBottom: 8 }}>Reschedule</div>
          {!editingReschedule ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
            }}>
              <span style={{ fontSize: 13, color: 'var(--muted)', flex: 1 }}>
                Move this booking to a different date or time.
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => setEditingReschedule(true)}>
                Reschedule
              </button>
            </div>
          ) : (
            <div style={{
              padding: 12, borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ flex: '1 1 130px', minWidth: 130 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Date</div>
                  <input
                    type="date"
                    value={rescheduleDate}
                    onChange={(e) => setRescheduleDate(e.target.value)}
                    style={inputSty}/>
                </label>
                <label style={{ flex: '1 1 100px', minWidth: 100 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Start</div>
                  <input
                    type="time"
                    value={rescheduleStart}
                    onChange={(e) => setRescheduleStart(e.target.value)}
                    style={inputSty}/>
                </label>
                <label style={{ flex: '1 1 100px', minWidth: 100 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>End</div>
                  <input
                    type="time"
                    value={rescheduleEnd}
                    onChange={(e) => setRescheduleEnd(e.target.value)}
                    style={inputSty}/>
                </label>
              </div>
              {rescheduleErr && (
                <div style={{ fontSize: 12, color: 'var(--danger)' }}>{rescheduleErr}</div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setEditingReschedule(false); setRescheduleErr(null); }}
                  disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={saveReschedule}
                  disabled={busy}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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

      {/* Booking status: no-show / fee / tip. Surfaced before the
          destructive cancel actions so they aren't visually grouped
          with "Cancel booking." */}
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

      {!event.cancelledAt && !event.noShowAt && (
        <CompletionSection
          event={event}
          occurrenceISO={occurrenceISO}
          masterId={masterId}
          onComplete={onCompleteBooking}
          onEdit={onEditCompletion}
          onClear={onClearCompletion}
        />
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
  // Collect-in-person flow: hits /api/calendar/bookings/collect, gets
  // back an invoice row + a fresh pay-link URL, then hands the invoice
  // to the shared CollectInPersonModal which renders the QR + share
  // shortcuts. The modal itself re-mints the token on open, so we pass
  // the invoice through and let it handle the rest.
  const [collectInvoice, setCollectInvoice] = useState(null);
  const [collectErr, setCollectErr] = useState(null);

  const total       = Number(event.bookingTotal || 0);
  const depositPaid = Number(event.depositPaid || 0);
  const balance     = Math.max(0, total - depositPaid);
  const canCollect  = balance > 0 && !event.cancelledAt;

  const startCollect = async () => {
    if (!canCollect) return;
    setCollectErr(null);
    setBusy(true);
    try {
      const r = await api.post('/calendar/bookings/collect', { id: event.id });
      // The endpoint returns an invoice; CollectInPersonModal will mint
      // its own fresh pay-link on open via /api/invoices/pay-link.
      setCollectInvoice(r.invoice);
    } catch (e) {
      setCollectErr(e.message || 'Could not generate pay link');
    } finally {
      setBusy(false);
    }
  };

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
      // r.chargeAmount comes back as a number; `amount` here is the raw
      // form-input string. Coerce so the success toast doesn't crash on
      // "0.toFixed is not a function" when the server omits chargeAmount.
      const charged = Number(r.chargeAmount || amount) || 0;
      setSuccess(`Charged $${charged.toFixed(2)} to the card on file.`);
      setTimeout(close, 2500);
    } catch (e) {
      setError(e.message || 'Charge failed');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Quick actions</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
        {canCollect && (
          <button className="btn btn-primary" onClick={startCollect} disabled={busy}
            style={{ fontSize: 12, padding: '8px 10px', justifyContent: 'center', gridColumn: '1 / -1' }}
            title={`Collect $${balance.toFixed(2)} in person via QR / SMS link`}>
            {busy ? 'Generating link…' : `Collect $${balance.toFixed(2)} in person`}
          </button>
        )}
        <button className="btn btn-outline" onClick={() => setOpenAction('no_show')}
          style={{ fontSize: 12, padding: '8px 10px', justifyContent: 'center' }}>
          No-show
        </button>
        <button className="btn btn-outline" onClick={() => setOpenAction('late_cancel')}
          style={{ fontSize: 12, padding: '8px 10px', justifyContent: 'center' }}>
          Charge fee
        </button>
        <button className="btn btn-outline" onClick={() => setOpenAction('tip')}
          style={{ fontSize: 12, padding: '8px 10px', justifyContent: 'center', gridColumn: '1 / -1' }}>
          Add tip
        </button>
      </div>

      {collectErr && (
        <div style={{
          marginTop: 10, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12,
        }}>{collectErr}</div>
      )}
      {collectInvoice && (
        <CollectInPersonModal
          invoice={collectInvoice}
          onClose={() => setCollectInvoice(null)}
        />
      )}

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

// Service-completion log for a single occurrence. Renders one of:
//   - an auto-prompt banner (booking is past + not yet completed)
//   - the "Mark complete" button row (always available pre-completion)
//   - the editable form when the owner clicks in
//   - a green completion read-card when this occurrence has been logged
//
// State storage is per-occurrence — looked up on the booking's
// `completionLog` map keyed by occurrence ISO date.
function CompletionSection({ event, occurrenceISO, masterId, onComplete, onEdit, onClear }) {
  const log = event.completionLog || {};
  const entry = log[occurrenceISO] || null;
  const isPast = isOccurrencePast(occurrenceISO, event.endMin);
  const [mode, setMode] = useState(null); // null | 'form'
  const [dismissed, setDismissed] = useState(false);

  if (entry) {
    return <CompletionReadView entry={entry} masterId={masterId} occurrenceISO={occurrenceISO}
      onEdit={onEdit} onClear={onClear} onOpenForm={() => setMode('form')}
      editing={mode === 'form'} onCloseForm={() => setMode(null)}/>;
  }

  if (mode === 'form') {
    return <CompletionForm masterId={masterId} occurrenceISO={occurrenceISO} initial={null}
      onSubmit={async (body) => { await onComplete(masterId, occurrenceISO, body); setMode(null); }}
      onCancel={() => setMode(null)}/>;
  }

  return (
    <div style={{ marginTop: 18 }}>
      {isPast && !dismissed && (
        <div style={{
          marginBottom: 10, padding: '10px 12px', borderRadius: 10,
          background: 'color-mix(in srgb, #d4a017 14%, var(--surface))',
          border: '1px solid color-mix(in srgb, #d4a017 45%, var(--border))',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ flex: 1, fontSize: 12.5, color: 'var(--fg)', lineHeight: 1.45 }}>
            <b>Did this happen?</b> Log details for your records.
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 8px' }}
            onClick={() => setDismissed(true)}>Dismiss</button>
        </div>
      )}
      <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
        onClick={() => setMode('form')}>
        <Icons.Check size={14} sw={2}/> Mark complete
      </button>
    </div>
  );
}

function CompletionReadView({ entry, masterId, occurrenceISO, onEdit, onClear, onOpenForm, editing, onCloseForm }) {
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  if (editing) {
    return <CompletionForm masterId={masterId} occurrenceISO={occurrenceISO} initial={entry}
      onSubmit={async (body) => { await onEdit(masterId, occurrenceISO, body); onCloseForm(); }}
      onCancel={onCloseForm}/>;
  }

  const clear = async () => {
    setBusy(true);
    try { await onClear(masterId, occurrenceISO); } finally { setBusy(false); }
  };

  const visible = entry.visibleToClient !== false;
  return (
    <div style={{
      marginTop: 18, padding: 12, borderRadius: 12,
      background: 'color-mix(in srgb, var(--ok, #2c8a4a) 9%, var(--surface))',
      border: '1px solid color-mix(in srgb, var(--ok, #2c8a4a) 38%, var(--border))',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1, fontSize: 12, color: 'var(--ok, #2c8a4a)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          <Icons.Check size={12} sw={2.4}/> Completed
          <span style={{ fontWeight: 400, color: 'var(--muted)', textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
            {entry.completedAt ? new Date(entry.completedAt).toLocaleString() : ''}
          </span>
        </div>
        <button className="btn btn-ghost" style={{ padding: 4 }} onClick={onOpenForm}
          title="Edit completion" aria-label="Edit completion">
          <Icons.Edit size={14}/>
        </button>
      </div>
      {entry.notes && (
        <div style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.55, whiteSpace: 'pre-wrap', marginBottom: 8 }}>
          {entry.notes}
        </div>
      )}
      {Array.isArray(entry.attachments) && entry.attachments.length > 0 && (
        <AttachmentGrid attachments={entry.attachments}/>
      )}
      {!visible && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted)' }}>
          Hidden from client portal.
        </div>
      )}
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        {confirmClear ? (
          <>
            <button className="btn btn-ghost" disabled={busy} style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => setConfirmClear(false)}>Keep it</button>
            <button className="btn btn-outline" disabled={busy} style={{ flex: 1, justifyContent: 'center', color: 'var(--danger)' }}
              onClick={clear}>{busy ? 'Clearing…' : 'Yes, un-mark'}</button>
          </>
        ) : (
          <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--muted)' }}
            onClick={() => setConfirmClear(true)}>Un-mark complete</button>
        )}
      </div>
    </div>
  );
}

function CompletionForm({ masterId, occurrenceISO, initial, onSubmit, onCancel }) {
  const fileRef = useRef(null);
  const [notes, setNotes] = useState(initial?.notes || '');
  const [attachments, setAttachments] = useState(Array.isArray(initial?.attachments) ? initial.attachments : []);
  const [visibleToClient, setVisibleToClient] = useState(initial?.visibleToClient !== false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const addFile = async (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setErr('Each file must be under 10 MB'); return; }
    if (attachments.length >= 20) { setErr('Maximum 20 attachments per completion'); return; }
    setErr(null); setUploading(true);
    try {
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase().slice(0, 5);
      const blob = await upload(`bookings/${masterId}/completion-${Date.now()}.${ext}`, file, {
        access: 'public',
        handleUploadUrl: '/api/calendar/bookings/upload-token',
        contentType: file.type || 'application/octet-stream',
      });
      setAttachments((prev) => [
        ...prev,
        {
          url: blob.url,
          blobPathname: blob.pathname,
          mimeType: file.type || 'application/octet-stream',
          filename: file.name,
          uploadedAt: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      setErr(e.message || 'Upload failed');
    } finally { setUploading(false); }
  };

  const removeAt = (i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await onSubmit({
        completionNotes: notes,
        completionAttachments: attachments,
        completionVisibleToClient: visibleToClient,
      });
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally { setBusy(false); }
  };

  return (
    <div style={{
      marginTop: 18, padding: 14, borderRadius: 12,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div className="metric-label">Session notes</div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value.slice(0, 8000))}
        placeholder="What you did, what the client reported, follow-up notes…"
        rows={5}
        style={{ ...inputSty, resize: 'vertical', minHeight: 110, fontFamily: 'inherit' }}/>
      <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right', marginTop: -8 }}>
        {notes.length} / 8000
      </div>

      <div>
        <div className="metric-label" style={{ marginBottom: 6 }}>Photos & files</div>
        <input ref={fileRef} type="file"
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
          onChange={(e) => { addFile(e.target.files?.[0]); e.target.value = ''; }}
          style={{ display: 'none' }}/>
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {attachments.map((a, i) => {
              const isImage = (a.mimeType || '').startsWith('image/');
              return (
                <div key={a.url + i} style={{
                  position: 'relative', width: 64, height: 64, borderRadius: 8,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  overflow: 'hidden',
                }}>
                  {isImage ? (
                    <img src={a.url} alt={a.filename || ''}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: '100%', height: '100%', color: 'var(--muted)' }}>
                      <Icons.FileIcon size={20} sw={1.6}/>
                    </div>
                  )}
                  <button type="button" onClick={() => removeAt(i)}
                    title="Remove" aria-label="Remove"
                    style={{
                      position: 'absolute', top: 2, right: 2,
                      width: 20, height: 20, borderRadius: '50%', border: 'none',
                      background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                    }}>
                    <Icons.X size={11} sw={2.2}/>
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <button type="button" className="btn btn-outline"
          onClick={() => fileRef.current?.click()} disabled={uploading || attachments.length >= 20}>
          <Icons.Paperclip size={13}/> {uploading ? 'Uploading…' : 'Add photo or file'}
        </button>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg-2)' }}>
        <input type="checkbox" checked={visibleToClient}
          onChange={(e) => setVisibleToClient(e.target.checked)}/>
        Share this entry with the client in their portal
      </label>

      {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || uploading}>
          {busy ? 'Saving…' : (initial ? 'Save changes' : 'Mark complete')}
        </button>
      </div>
    </div>
  );
}

function AttachmentGrid({ attachments }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {attachments.map((a, i) => {
        const isImage = (a.mimeType || '').startsWith('image/');
        return (
          <a key={a.url + i} href={a.url} target="_blank" rel="noopener noreferrer"
            style={{ textDecoration: 'none' }}>
            {isImage ? (
              <img src={a.url} alt={a.filename || ''}
                style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover',
                  border: '1px solid var(--border)' }}/>
            ) : (
              <div style={{
                width: 64, height: 64, borderRadius: 8,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 4, padding: 4,
                background: 'var(--surface)', border: '1px solid var(--border)',
                color: 'var(--muted)', fontSize: 9, textAlign: 'center',
              }}>
                <Icons.FileIcon size={18} sw={1.6}/>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 56 }}>
                  {a.filename || ''}
                </span>
              </div>
            )}
          </a>
        );
      })}
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
