// The richer client record as form fields: address, birthday, gender or
// pronouns, emergency contact, preferred contact, work, how they found you,
// and the business's custom fields. Used by the Add client form ("More
// details") and the client profile (ClientDetails.jsx).
//
// Drafts are plain strings; detailsPatch() turns a draft into the API body
// (only the keys that changed, so a save never touches the rest).
import React from 'react';
import { birthdayLabel } from '../../lib/clientColumns.js';

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const PREFERRED = [
  { id: '', label: 'No preference' },
  { id: 'text', label: 'Text' },
  { id: 'call', label: 'Call' },
  { id: 'email', label: 'Email' },
];

export function draftFrom(client = {}) {
  const a = client.addressParts || {};
  // Older records only have the one-line address: show it as the street.
  const street = a.street || (!client.addressParts && client.address) || '';
  const m = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(client.birthday || '');
  const em = client.emergencyContact || {};
  const custom = {};
  for (const [k, v] of Object.entries(client.customFields || {})) {
    custom[k] = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? '');
  }
  return {
    street, city: a.city || '', region: a.region || '', postalCode: a.postalCode || '', country: a.country || '',
    bMonth: m ? String(Number(m[2])) : '', bDay: m ? String(Number(m[3])) : '', bYear: m && m[1] ? m[1] : '',
    pronouns: client.pronouns || '',
    emName: em.name || '', emPhone: em.phone || '', emRel: em.relationship || '',
    preferredContact: client.preferredContact || '',
    occupation: client.occupation || '',
    source: client.source || '',
    custom,
  };
}

export function birthdayFromDraft(d) {
  if (!d.bMonth || !d.bDay) return null;
  const mm = String(d.bMonth).padStart(2, '0');
  const dd = String(d.bDay).padStart(2, '0');
  return /^\d{4}$/.test(d.bYear) ? `${d.bYear}-${mm}-${dd}` : `--${mm}-${dd}`;
}

// A birthday that is half filled in (month without day, a 2-digit year).
export function draftProblem(d) {
  if ((d.bMonth && !d.bDay) || (!d.bMonth && d.bDay)) return 'Pick both the month and the day of the birthday.';
  if (d.bYear && !/^\d{4}$/.test(d.bYear)) return 'Write the birth year with 4 digits, or leave it empty.';
  return null;
}

function customValue(def, raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  if (def.type === 'boolean') return v === 'yes';
  if (def.type === 'number') return Number(v);
  return v;
}

// Only what differs from `base` (another draft). For a new client pass
// draftFrom({}) as base.
export function detailsPatch(d, base, fields = []) {
  const out = {};
  const addrKeys = ['street', 'city', 'region', 'postalCode', 'country'];
  if (addrKeys.some((k) => d[k].trim() !== base[k].trim())) {
    out.addressParts = Object.fromEntries(addrKeys.map((k) => [k, d[k].trim() || null]));
  }
  const b = birthdayFromDraft(d);
  if (b !== birthdayFromDraft(base)) out.birthday = b;
  if (d.pronouns.trim() !== base.pronouns.trim()) out.pronouns = d.pronouns.trim() || null;
  if (d.occupation.trim() !== base.occupation.trim()) out.occupation = d.occupation.trim() || null;
  if (d.source.trim() !== base.source.trim()) out.source = d.source.trim() || null;
  if (d.preferredContact !== base.preferredContact) out.preferredContact = d.preferredContact || null;
  if (['emName', 'emPhone', 'emRel'].some((k) => d[k].trim() !== base[k].trim())) {
    out.emergencyContact = { name: d.emName.trim() || null, phone: d.emPhone.trim() || null, relationship: d.emRel.trim() || null };
  }
  const cf = {};
  for (const def of fields) {
    const now = d.custom[def.id] ?? '';
    const was = base.custom[def.id] ?? '';
    if (String(now).trim() !== String(was).trim()) cf[def.id] = customValue(def, now);
  }
  if (Object.keys(cf).length) out.customFields = cf;
  return out;
}

const labelS = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 5 };
const groupS = { fontSize: 11, fontWeight: 650, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: '4px 0 8px' };
const selS = { width: '100%', minWidth: 0 };

function L({ label, children, style }) {
  return (
    <label style={{ display: 'block', minWidth: 0, ...style }}>
      <span style={labelS}>{label}</span>
      {children}
    </label>
  );
}

// draft + onChange(nextDraft). `showSource` hides "How they found you" in
// the add form, which has its own source chips.
export function DetailsFields({ draft, onChange, fields = [], showSource = true }) {
  const set = (k) => (e) => onChange({ ...draft, [k]: e.target.value });
  const setCustom = (id, v) => onChange({ ...draft, custom: { ...draft.custom, [id]: v } });
  const days = draft.bMonth ? (Number(draft.bMonth) === 2 ? 29 : [4, 6, 9, 11].includes(Number(draft.bMonth)) ? 30 : 31) : 31;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={groupS}>Address</div>
      <L label="Street"><input className="input" value={draft.street} onChange={set('street')} maxLength={200} autoComplete="off" placeholder="Street and number" style={selS}/></L>
      <div className="form-2col">
        <L label="City"><input className="input" value={draft.city} onChange={set('city')} maxLength={100} autoComplete="off" style={selS}/></L>
        <L label="State or region"><input className="input" value={draft.region} onChange={set('region')} maxLength={100} autoComplete="off" style={selS}/></L>
      </div>
      <div className="form-2col">
        <L label="Postal code"><input className="input" value={draft.postalCode} onChange={set('postalCode')} maxLength={20} autoComplete="off" style={selS}/></L>
        <L label="Country"><input className="input" value={draft.country} onChange={set('country')} maxLength={80} autoComplete="off" style={selS}/></L>
      </div>

      <div style={groupS}>About them</div>
      <div>
        <span style={labelS}>Birthday</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 0.8fr) minmax(0, 1fr)', gap: 8 }}>
          <select className="input" value={draft.bMonth} onChange={set('bMonth')} aria-label="Birthday month" style={selS}>
            <option value="">Month</option>
            {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
          </select>
          <select className="input" value={draft.bDay} onChange={set('bDay')} aria-label="Birthday day" style={selS}>
            <option value="">Day</option>
            {Array.from({ length: days }, (_, i) => <option key={i} value={String(i + 1)}>{i + 1}</option>)}
          </select>
          <input className="input" value={draft.bYear} onChange={set('bYear')} inputMode="numeric" maxLength={4}
            placeholder="Year" aria-label="Birth year" style={selS}/>
        </div>
      </div>
      <div className="form-2col">
        <L label="Gender or pronouns"><input className="input" value={draft.pronouns} onChange={set('pronouns')} maxLength={60} placeholder="Optional" style={selS}/></L>
        <L label="Company or occupation"><input className="input" value={draft.occupation} onChange={set('occupation')} maxLength={120} style={selS}/></L>
      </div>
      <div>
        <span style={labelS}>Best way to reach them</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PREFERRED.map((p) => {
            const on = draft.preferredContact === p.id;
            return (
              <button key={p.id || 'none'} type="button" onClick={() => onChange({ ...draft, preferredContact: p.id })}
                aria-pressed={on}
                style={{
                  padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 550, cursor: 'pointer',
                  border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                  background: on ? 'var(--accent-soft)' : 'var(--surface)',
                  color: on ? 'var(--accent)' : 'var(--fg-2)',
                }}>{p.label}</button>
            );
          })}
        </div>
      </div>
      {showSource && (
        <L label="How they found you"><input className="input" value={draft.source} onChange={set('source')} maxLength={60} placeholder="Referral, Instagram, a friend's name…" style={selS}/></L>
      )}

      <div style={groupS}>Emergency contact</div>
      <div className="form-2col">
        <L label="Name"><input className="input" value={draft.emName} onChange={set('emName')} maxLength={120} autoComplete="off" style={selS}/></L>
        <L label="Phone"><input className="input" value={draft.emPhone} onChange={set('emPhone')} maxLength={40} type="tel" inputMode="tel" autoComplete="off" style={selS}/></L>
      </div>
      <L label="Relationship"><input className="input" value={draft.emRel} onChange={set('emRel')} maxLength={60} placeholder="Partner, parent, friend…" style={selS}/></L>

      {fields.length > 0 && (
        <>
          <div style={groupS}>Your fields</div>
          {fields.map((def) => (
            <CustomInput key={def.id} def={def} value={draft.custom[def.id] ?? ''} onChange={(v) => setCustom(def.id, v)}/>
          ))}
        </>
      )}
    </div>
  );
}

function CustomInput({ def, value, onChange }) {
  const ch = (e) => onChange(e.target.value);
  let input;
  if (def.type === 'boolean') {
    input = (
      <select className="input" value={value} onChange={ch} style={selS}>
        <option value="">Not set</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  } else if (def.type === 'select') {
    const opts = def.options || [];
    input = (
      <select className="input" value={value} onChange={ch} style={selS}>
        <option value="">Not set</option>
        {value && !opts.includes(value) && <option value={value}>{value}</option>}
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (def.type === 'date') {
    input = <input className="input" type="date" value={value} onChange={ch} style={selS}/>;
  } else if (def.type === 'number') {
    input = <input className="input" type="number" inputMode="decimal" value={value} onChange={ch} style={selS}/>;
  } else {
    input = value.length > 60 || value.includes('\n')
      ? <textarea className="input" rows={3} value={value} onChange={ch} maxLength={1000} style={{ ...selS, resize: 'vertical' }}/>
      : <input className="input" value={value} onChange={ch} maxLength={1000} style={selS}/>;
  }
  return <L label={def.label}>{input}</L>;
}

// Read-only lines for the profile: [{ label, value }] for what is filled.
export function detailLines(client, fields = []) {
  const out = [];
  const a = client.addressParts;
  const addr = a
    ? [a.street, a.city, [a.region, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ')
    : client.address;
  if (addr) out.push({ label: 'Address', value: addr });
  if (client.birthday) out.push({ label: 'Birthday', value: birthdayLabel(client.birthday) });
  if (client.pronouns) out.push({ label: 'Gender or pronouns', value: client.pronouns });
  if (client.occupation) out.push({ label: 'Work', value: client.occupation });
  if (client.preferredContact) out.push({ label: 'Best way to reach them', value: PREFERRED.find((p) => p.id === client.preferredContact)?.label || client.preferredContact });
  if (client.source) out.push({ label: 'How they found you', value: client.source });
  const em = client.emergencyContact;
  if (em) {
    out.push({ label: 'Emergency contact', value: [em.name, em.relationship ? `(${em.relationship})` : '', em.phone].filter(Boolean).join(' ') });
  }
  for (const def of fields) {
    const v = client.customFields?.[def.id];
    if (v === undefined || v === null || v === '') continue;
    out.push({ label: def.label, value: typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v) });
  }
  return out;
}
