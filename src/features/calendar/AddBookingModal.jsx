// Owner-side "Add booking" modal - service, client, date/time, optional
// recurrence, optional package-credit consumption when the matching
// client has an active bundle covering the chosen service.
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../components/Icons.jsx';
import { TimeInput, inputSty } from './Drawer.jsx';
import { RECURRENCE_OPTIONS, fmtDateISO } from './utils.js';
import { api } from '../../lib/api.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';

export default function AddBookingModal({ services, onSubmit, onClose, defaultDate, defaultStart, defaultClientId }) {
  const [serviceId, setServiceId] = useState(services[0]?.id || '');
  const [clientName, setClientName]   = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientPhone, setClientPhone] = useState('');

  // Optional preset from "Book" quick-action in ClientDrawer. Looks up
  // the client by id and prefills name/email so the owner only needs
  // to pick service + time.
  // Load active staff for the picker - silent failure since the
  // picker is optional and stays hidden if there's no staff list.
  useEffect(() => {
    let cancelled = false;
    api.get('/staff').then((r) => {
      if (cancelled) return;
      setStaffOptions(r.staff || []);
    }).catch(() => { /* hide the picker if loading fails */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!defaultClientId) return;
    let cancelled = false;
    api.get(`/clients/${defaultClientId}`)
      .then((r) => {
        if (cancelled || !r.client) return;
        setClientName(r.client.name || '');
        setClientEmail(r.client.email || '');
      })
      .catch(() => { /* falls back to manual entry */ });
    return () => { cancelled = true; };
  }, [defaultClientId]);
  const [date, setDate]   = useState(defaultDate || fmtDateISO(new Date()));
  const [start, setStart] = useState(defaultStart ?? 9 * 60);
  const [notes, setNotes] = useState('');
  const [recurrenceRule, setRecurrenceRule]   = useState(null);
  const [recurrenceUntil, setRecurrenceUntil] = useState('');
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  // Package credit candidates for the client matching the typed email.
  // Empty array = lookup completed and there are no eligible packages;
  // null = haven't looked up yet.
  const [eligiblePackages, setEligiblePackages] = useState(null);
  const [clientPackageId, setClientPackageId]   = useState(null);
  // The client's packages for this service that can't be used any more
  // (used up / expired), so the owner sees why there's no package choice.
  const [spentPackages, setSpentPackages]       = useState([]);
  // Set once the owner picks "bill normally" so a later re-lookup doesn't
  // flip the choice back to the package.
  const [packageTouched, setPackageTouched]     = useState(false);
  const packageTouchedRef = useRef(false);
  packageTouchedRef.current = packageTouched;
  const [staffId, setStaffId]                   = useState(null);
  const [staffOptions, setStaffOptions]         = useState([]);

  // Look up the client by email after the owner has typed something
  // plausible, then load their active packages covering the selected
  // service. Debounced so each keystroke isn't a request.
  useEffect(() => {
    const email = clientEmail.trim().toLowerCase();
    if ((!email || !email.includes('@')) && !defaultClientId) {
      setEligiblePackages(null);
      setSpentPackages([]);
      setClientPackageId(null);
      return;
    }
    if (!serviceId) {
      setEligiblePackages(null);
      setSpentPackages([]);
      setClientPackageId(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        let cid = null;
        if (email && email.includes('@')) {
          const r = await api.get('/clients?email=' + encodeURIComponent(email));
          cid = r.clients?.[0]?.id || null;
        }
        if (!cid && defaultClientId) cid = defaultClientId;
        if (!cid) { if (!cancelled) { setEligiblePackages([]); setSpentPackages([]); } return; }
        const cp = await api.get(`/clients/${cid}/packages`);
        if (cancelled) return;
        const covers = (p) => !p.serviceIds?.length || p.serviceIds.includes(serviceId);
        const stateOf = (p) => p.state || (p.status === 'cancelled' ? 'ended'
          : (p.creditsRemaining <= 0 || p.status === 'exhausted') ? 'used_up'
          : (p.expiresAt && new Date(p.expiresAt).getTime() <= Date.now()) ? 'expired' : 'active');
        const eligible = (cp.packages || []).filter((p) => covers(p) && stateOf(p) === 'active');
        setEligiblePackages(eligible);
        setSpentPackages(eligible.length > 0 ? [] : (cp.packages || [])
          .filter((p) => covers(p) && (stateOf(p) === 'used_up' || stateOf(p) === 'expired'))
          .map((p) => ({ ...p, state: stateOf(p) })));
        // Default to the package (owners forget to pick it). Functional
        // form so a quick service change can't read a stale choice.
        setClientPackageId((current) => {
          if (current && eligible.some((p) => p.id === current)) return current;
          return packageTouchedRef.current ? null : (eligible[0]?.id || null);
        });
      } catch {
        if (!cancelled) { setEligiblePackages([]); setSpentPackages([]); }
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [clientEmail, serviceId, defaultClientId]);

  const svc = services.find((s) => s.id === serviceId);
  const end = svc ? start + svc.durationMinutes : start + 60;

  const submit = async (e) => {
    e.preventDefault();
    if (!svc) { setErr('Pick a service'); return; }
    if (!clientName.trim()) { setErr("Client's name is required"); return; }
    // Email OR phone - phone-only walk-ins are bookable. (No email just
    // means no confirmation email goes out.)
    if (!clientEmail.trim() && !clientPhone.trim()) {
      setErr('Add an email or phone number for the client'); return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({
        serviceId,
        clientName: clientName.trim(),
        clientEmail: clientEmail.trim() || null,
        clientPhone: clientPhone.trim() || null,
        date,
        startMin: start,
        endMin: end,
        notes: notes.trim() || null,
        // A package session pays for one visit, so a package booking
        // never repeats (the server refuses the combination too).
        recurrenceRule: clientPackageId ? null : recurrenceRule,
        recurrenceUntil: clientPackageId ? null : (recurrenceUntil || null),
        skipConflictCheck: override,
        clientPackageId: clientPackageId || null,
        staffId: staffId || null,
      });
      onClose();
    } catch (ex) {
      setErr(ex.message || 'Could not create booking');
    } finally {
      setBusy(false);
    }
  };

  // Portal to <body> so a transformed/filtered ancestor (the app shell
  // applies CSS transforms for its slide animations) can't capture the
  // position:fixed overlay and strand it mid-page. Without this the
  // modal rendered below the calendar content on some layouts and the
  // owner didn't realize it had opened.
  useEscapeKey(onClose);
  return createPortal((
    <div onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="add-booking-title" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card scroll" style={{
        padding: 24, width: '100%', maxWidth: 540, maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Calendar size={16} sw={1.8}/></div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>New booking</h3>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {services.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>
            Add a service first - bookings need to reference one.
          </div>
        ) : (
          <>
            <Field label="Service">
              <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={inputSty}>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.durationMinutes} min · ${Number(s.price).toLocaleString()}
                  </option>
                ))}
              </select>
            </Field>

            <div className="form-2col">
              <Field label="Client name">
                <input value={clientName} onChange={(e) => setClientName(e.target.value)} required style={inputSty}/>
              </Field>
              <Field label="Client email">
                <input type="email" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)}
                  placeholder="Email, or leave blank and add a phone" style={inputSty}/>
              </Field>
              <Field label="Client phone">
                <input type="tel" inputMode="tel" value={clientPhone}
                  onChange={(e) => setClientPhone(e.target.value)}
                  placeholder="For walk-ins without an email" style={inputSty}/>
              </Field>
            </div>

            <div className="form-2col">
              <Field label="Date">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputSty}/>
              </Field>
              <Field label="Start time">
                <TimeInput minutes={start} onChange={setStart}/>
              </Field>
            </div>

            <Field label="Notes (optional)">
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                placeholder="Anything to remember about this booking"
                style={{ ...inputSty, resize: 'vertical', fontFamily: 'inherit' }}/>
            </Field>

            {eligiblePackages && eligiblePackages.length > 0 && (
              <Field label="Payment"
                hint={clientPackageId
                  ? 'Uses one session from this package. Pick "Bill normally" to charge instead.'
                  : 'Pick a package to use one of their sessions for this visit.'}>
                <select value={clientPackageId || ''} aria-label="Payment"
                  onChange={(e) => { setPackageTouched(true); setClientPackageId(e.target.value || null); }}
                  style={inputSty}>
                  {eligiblePackages.map((p) => (
                    <option key={p.id} value={p.id}>
                      Use package: {p.name} ({p.creditsRemaining} left{p.sessionsBooked > 0 ? `, ${p.sessionsBooked} booked` : ''})
                      {p.expiresAt ? ` · expires ${new Date(p.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}
                    </option>
                  ))}
                  <option value="">Bill normally</option>
                </select>
              </Field>
            )}
            {(!eligiblePackages || eligiblePackages.length === 0) && spentPackages.length > 0 && (
              <div role="status" style={{
                marginBottom: 14, padding: '10px 12px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
                background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--fg-2)',
              }}>
                {spentPackages[0].name} is {spentPackages[0].state === 'expired' ? 'expired' : 'used up (0 sessions left)'}.
                {' '}This visit will be billed normally. Offer a new package from their client page.
              </div>
            )}

            <Field label="Repeats" hint={clientPackageId ? 'A package session covers one visit, so package bookings do not repeat.' : null}>
              <select value={clientPackageId ? '' : (recurrenceRule || '')} disabled={!!clientPackageId}
                onChange={(e) => setRecurrenceRule(e.target.value || null)} style={inputSty}>
                {RECURRENCE_OPTIONS.map((r) => (
                  <option key={r.value || 'none'} value={r.value || ''}>{r.label}</option>
                ))}
              </select>
            </Field>

            {recurrenceRule && !clientPackageId && (
              <Field label="Repeat until (optional)" hint="Leave blank for indefinite. Series stops on this date inclusive.">
                <input type="date" value={recurrenceUntil} onChange={(e) => setRecurrenceUntil(e.target.value)}
                  min={date} style={inputSty}/>
              </Field>
            )}

            {staffOptions.length > 0 && (
              <Field label="Staff (optional)"
                hint="Assign this booking to a specific practitioner. Leave blank for the owner.">
                <select value={staffId || ''}
                  onChange={(e) => setStaffId(e.target.value || null)}
                  style={inputSty}>
                  <option value="">- Owner / unassigned -</option>
                  {staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.role ? ` · ${s.role}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 14 }}>
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)}/>
              Override availability + conflict checks (book outside hours / on top of another)
            </label>

            {err && (
              <div style={{
                padding: '8px 12px', borderRadius: 8, marginBottom: 14,
                background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
                color: 'var(--danger)', fontSize: 12.5,
              }}>{err}</div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button type="button" className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}
                style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Creating…' : 'Create booking'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  ), document.body);
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
