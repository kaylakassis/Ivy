// Calendar → Waitlist. Who is waiting (by service, with what they asked
// for), the offer each one last got, "Offer a time" (pick a date + start;
// the person gets a one-tap claim link by email and, with consent, text)
// and Remove. The switches at the top are the owner's waitlist settings
// (calendar_settings): on/off, fill cancellations automatically, how long a
// claim link lasts.
import React, { useEffect, useState } from 'react';
import Drawer, { TimeInput, inputSty } from './Drawer.jsx';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { minToHM, parseISO } from './utils.js';

const OFFER_OPTIONS = [
  { v: 1, label: '1 hour' },
  { v: 2, label: '2 hours' },
  { v: 4, label: '4 hours' },
  { v: 12, label: '12 hours' },
  { v: 24, label: '1 day' },
];

const STATUS_WORD = {
  waiting: 'Waiting', offered: 'Offer sent', fulfilled: 'Booked', promoted: 'Booked',
  cancelled: 'Removed', expired: 'Expired',
};

export default function WaitlistDrawer({ services, settings, onPatchSettings, onClose }) {
  const [entries, setEntries] = useState(null);
  const [summary, setSummary] = useState([]);
  const [err, setErr] = useState(null);
  const [offering, setOffering] = useState(null); // entry id
  const [notice, setNotice] = useState(null);
  const [savingSetting, setSavingSetting] = useState(false);

  const load = () => api.get('/waitlist')
    .then((r) => { setEntries(r.entries || []); setSummary(r.summary || []); })
    .catch((e) => setErr(e.message || 'Could not load the waitlist'));
  useEffect(() => { load(); }, []);

  const patch = async (p) => {
    setSavingSetting(true); setErr(null);
    try { await onPatchSettings(p); } catch (e) { setErr(e.message || 'Could not save'); } finally { setSavingSetting(false); }
  };
  const remove = async (e) => {
    setErr(null);
    try { await api.del('/waitlist/' + e.id); setNotice(`${e.clientName} was taken off the list.`); await load(); }
    catch (x) { setErr(x.message || 'Could not remove'); }
  };

  const enabled = settings?.waitlistEnabled !== false;
  const autoFill = settings?.waitlistAutoFill !== false;
  const offerHours = Number(settings?.waitlistOfferHours) || 2;

  return (
    <Drawer title="Waitlist" subtitle="People who asked to be told when a spot opens up" onClose={onClose}>
      <div style={{ padding: 14, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SwitchRow checked={enabled} disabled={savingSetting} onChange={(v) => patch({ waitlistEnabled: v })}
          label="Offer a waitlist on your booking page"
          hint="When a day is full, clients can join the waitlist instead of leaving."/>
        <SwitchRow checked={enabled && autoFill} disabled={savingSetting || !enabled} onChange={(v) => patch({ waitlistAutoFill: v })}
          label="Fill cancellations from the waitlist automatically"
          hint="When a booking is cancelled, the first match gets a one-tap link to take the spot. First to tap gets it."/>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Claim link lasts</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 6px' }}>After this, the spot is offered to the next person on the list.</div>
          <select value={offerHours} disabled={savingSetting} onChange={(e) => patch({ waitlistOfferHours: Number(e.target.value) })}
            style={{ ...inputSty, width: '100%' }}>
            {OFFER_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {summary.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {summary.map((s) => (
            <span key={s.serviceId} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 99, background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 600 }}>
              {s.waiting} waiting for {s.serviceName}
            </span>
          ))}
        </div>
      )}

      {notice && <div role="status" style={{ fontSize: 12.5, color: 'var(--ok)', marginBottom: 10 }}>{notice}</div>}
      {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger)', marginBottom: 10 }}>{err}</div>}

      {entries === null ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : entries.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--border-strong)', borderRadius: 10 }}>
          Nobody is waiting right now. When a day fills up, clients can join from your booking page.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {entries.map((e) => (
            <div key={e.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--surface)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {e.clientName}
                    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 99,
                      background: e.status === 'offered' ? 'var(--accent-soft)' : 'var(--surface-2)', color: e.status === 'offered' ? 'var(--accent)' : 'var(--muted)' }}>
                      {STATUS_WORD[e.status] || e.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginTop: 2 }}>{e.serviceName} · wants {e.preferenceLabel}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, wordBreak: 'break-word' }}>
                    {e.clientEmail}{e.clientPhone ? ` · ${e.clientPhone}${e.smsConsent ? ' (texts ok)' : ''}` : ''}
                  </div>
                  {e.lastOffer && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                      Last offer: {parseISO(e.lastOffer.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at {minToHM(e.lastOffer.startMin)}
                      {' · '}{e.lastOffer.status === 'open' || e.lastOffer.status === 'claiming' ? `link open until ${new Date(e.lastOffer.expiresAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : e.lastOffer.status === 'claimed' ? 'booked' : e.lastOffer.status === 'slot_gone' ? 'spot was taken' : e.lastOffer.status}
                    </div>
                  )}
                  {e.notes && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>"{e.notes}"</div>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12.5 }}
                  onClick={() => setOffering(offering === e.id ? null : e.id)}>
                  <Icons.Calendar size={13}/> Offer a time
                </button>
                <button type="button" className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12.5, color: 'var(--danger)' }} onClick={() => remove(e)}>
                  Remove
                </button>
              </div>
              {offering === e.id && (
                <OfferForm entry={e} service={(services || []).find((s) => s.id === e.serviceId)}
                  onDone={(msg) => { setOffering(null); setNotice(msg); load(); }}
                  onCancel={() => setOffering(null)}/>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
        <button className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Close</button>
      </div>
    </Drawer>
  );
}

function OfferForm({ entry, service, onDone, onCancel }) {
  const dur = Number(service?.durationMinutes) || Math.max(15, Number(entry.endMin) - Number(entry.startMin) || 60);
  const [date, setDate] = useState(entry.flexible ? '' : entry.date);
  const [start, setStart] = useState(entry.flexible ? (entry.preferredStartMin ?? 9 * 60) : entry.startMin);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/waitlist/' + entry.id, { offer: { date, startMin: start, endMin: start + dur } });
      onDone(`Offer sent to ${entry.clientName}. The link lasts until it expires or they book.`);
    } catch (e) {
      setErr(e.message || 'Could not send the offer');
    } finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 10, padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
        Pick a free time for {service?.name || 'this service'} ({dur} min). {entry.clientName.split(' ')[0]} gets a one-tap link by email{entry.clientPhone && entry.smsConsent ? ' and text' : ''}.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputSty, flex: '1 1 140px' }} aria-label="Date"/>
        <TimeInput minutes={start} onChange={setStart}/>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>to {minToHM(start + dur)}</span>
      </div>
      {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy} style={{ padding: '6px 10px', fontSize: 12.5 }}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !date} style={{ padding: '6px 12px', fontSize: 12.5 }}>
          {busy ? 'Sending…' : 'Send the offer'}
        </button>
      </div>
    </div>
  );
}

function SwitchRow({ checked, disabled, onChange, label, hint }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{hint}</div>}
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
        onClick={() => onChange(!checked)} style={{
          width: 38, height: 22, borderRadius: 99, flexShrink: 0, marginTop: 2,
          background: checked ? 'var(--accent)' : 'var(--surface-2)',
          border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
          position: 'relative', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
        }}>
        <span style={{
          position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: 99,
          background: checked ? 'var(--accent-ink)' : '#fff', transition: 'left .12s',
        }}/>
      </button>
    </div>
  );
}
