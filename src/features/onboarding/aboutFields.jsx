// The onboarding "About you" answers: sentinels, validation, the save
// payload for PATCH /api/onboarding/profile, and the question widgets.
// Shared by the wizard (OnboardingPage.jsx) and the required "A few quick
// questions" sheet the owner app shows to any owner still missing one of
// the required answers (onboarding/RequiredAnswersSheet.jsx).
//
// Required answers are enforced here in the UI. The server checks shape
// and allowlists, records whatever it gets (so older app builds that never
// send the newer answers keep working) and never lets an empty answer erase
// a stored one. Which answers are still missing is decided on the server
// (api/_lib/onboardingAnswers.js); missingFromAbout() below is its mirror.
import React from 'react';
import { US_STATES, COUNTRIES } from '../../lib/locations.js';

// "Other" on a preset question. Kept in the same array as the preset ids;
// never sent to the server (the typed text travels in *Other instead).
export const OTHER = '__other__';
// "Outside the US" in the state picker; then we ask for the country.
export const OUTSIDE_US = '__outside__';

export const HEARD_FROM_OPTIONS = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok',    label: 'TikTok' },
  { id: 'google',    label: 'Google' },
  { id: 'referral',  label: 'Friend / referral' },
];

export const GOAL_OPTIONS = [
  { id: 'grow_revenue', label: 'Grow revenue' },
  { id: 'more_clients', label: 'Get more clients' },
  { id: 'save_time',    label: 'Save time on admin' },
  { id: 'look_pro',     label: 'Look more professional' },
];
export const CHALLENGE_OPTIONS = [
  { id: 'leads',        label: 'Not enough leads' },
  { id: 'no_shows',     label: 'No-shows & cancellations' },
  { id: 'getting_paid', label: 'Chasing payments' },
  { id: 'organized',    label: 'Staying on top of it all' },
  { id: 'marketing',    label: 'Marketing myself' },
];
export const STAGE_OPTIONS = [
  { id: 'starting',    label: 'Just starting out' },
  { id: 'side_hustle', label: 'Side hustle' },
  { id: 'established', label: 'Established & steady' },
  { id: 'scaling',     label: 'Ready to scale' },
];

// Server's required-answer keys (api/_lib/onboardingAnswers.js) → the
// error key validateAbout() uses for that question.
export const REQUIRED_KEYS = ['goals', 'challenges', 'stage', 'location', 'heardFrom'];
export const ERROR_KEY = { goals: 'goal', challenges: 'challenge', stage: 'stage', location: 'location', heardFrom: 'heardFrom' };

const isOtherEmpty = (ids, text) => (ids || []).includes(OTHER) && !String(text || '').trim();
const picked = (ids) => (ids || []).length > 0;

export function locationError(a) {
  if (!a.locationState) return 'Pick your state, or choose Outside the US.';
  if (a.locationState === OUTSIDE_US) {
    if (!a.locationCountry) return 'Pick your country.';
    if (a.locationCountry === OTHER && !String(a.locationCountryOther || '').trim()) return 'Type your country.';
  }
  return null;
}

export function heardFromError(a) {
  if (!picked(a.heardFromIds)) return 'Tell us how you heard about Ivy.';
  if (isOtherEmpty(a.heardFromIds, a.heardFromOther)) return 'Tell us where you heard about Ivy.';
  return null;
}

// Every required About question still missing an answer, as
// { field: message }. Empty object means good to go. "Other" picked with
// nothing typed counts as missing, even when a preset is picked too.
export function validateAbout(about) {
  const a = about || {};
  const errs = {};
  if (!picked(a.goalIds)) errs.goal = 'Pick at least one goal.';
  else if (isOtherEmpty(a.goalIds, a.goalOther)) errs.goal = 'Tell us your other goal.';

  if (!picked(a.challengeIds)) errs.challenge = "Pick at least one thing that's draining you.";
  else if (isOtherEmpty(a.challengeIds, a.challengeOther)) errs.challenge = 'Tell us what else is draining you.';

  if (!picked(a.stageIds)) errs.stage = 'Pick where your business is at.';

  const loc = locationError(a);
  if (loc) errs.location = loc;
  const heard = heardFromError(a);
  if (heard) errs.heardFrom = heard;
  return errs;
}

// Required answers still missing from a form state, as server keys. The
// client mirror of missingRequiredAnswers() on the server.
export function missingFromAbout(about) {
  const errs = validateAbout(about);
  return REQUIRED_KEYS.filter((k) => errs[ERROR_KEY[k]]);
}

// Stored location → picker state.
export function locationFromProfile(p) {
  if (p?.locationState) {
    return { locationState: p.locationState, locationCountry: '', locationCountryOther: '' };
  }
  if (p?.locationCountry) {
    const known = COUNTRIES.includes(p.locationCountry);
    return {
      locationState: OUTSIDE_US,
      locationCountry: known ? p.locationCountry : OTHER,
      locationCountryOther: known ? '' : p.locationCountry,
    };
  }
  return { locationState: '', locationCountry: '', locationCountryOther: '' };
}

export function locationPayload(a) {
  const outside = a.locationState === OUTSIDE_US;
  return {
    locationState: a.locationState && !outside ? a.locationState : null,
    locationCountry: outside
      ? (a.locationCountry === OTHER ? String(a.locationCountryOther || '').trim() : a.locationCountry) || null
      : null,
  };
}

const stripOther = (ids) => (ids || []).filter((id) => id !== OTHER);
// Typed Other text only goes when the Other chip is actually picked, so a
// chip toggled off doesn't leave stale text behind.
const otherText = (ids, text) => ((ids || []).includes(OTHER) ? String(text || '').trim() : '');

// The full PATCH /api/onboarding/profile body. The endpoint replaces the
// whole answer set, so callers always send every field.
export function aboutPayload(about) {
  const a = about || {};
  return {
    goalIds:        stripOther(a.goalIds),
    goalOther:      otherText(a.goalIds, a.goalOther),
    challengeIds:   stripOther(a.challengeIds),
    challengeOther: otherText(a.challengeIds, a.challengeOther),
    idealClient:    a.idealClient || '',
    heardFromIds:   stripOther(a.heardFromIds),
    heardFromOther: otherText(a.heardFromIds, a.heardFromOther),
    referralName:   (a.heardFromIds || []).includes('referral') ? String(a.referralName || '').trim() : '',
    stageIds:       stripOther(a.stageIds),
    ...locationPayload(a),
  };
}

// Server profile → the About form's state (multi-select arrays carry the
// OTHER sentinel when free text was stored).
export function aboutFromProfile(p) {
  const withOther = (ids, other) => {
    const out = Array.isArray(ids) ? [...ids] : [];
    if (other && !out.includes(OTHER)) out.push(OTHER);
    return out;
  };
  return {
    goalIds:        withOther(p?.goalIds, p?.goalOther),
    goalOther:      p?.goalOther || '',
    challengeIds:   withOther(p?.challengeIds, p?.challengeOther),
    challengeOther: p?.challengeOther || '',
    idealClient:    p?.idealClient || '',
    heardFromIds:   withOther(p?.heardFromIds, p?.heardFromOther),
    heardFromOther: p?.heardFromOther || '',
    referralName:   p?.referralName || '',
    stageIds:       Array.isArray(p?.stageIds) ? p.stageIds : [],
    ...locationFromProfile(p),
  };
}

// ─── Widgets ──────────────────────────────────────────────────────────

const inputStyle = { padding: '10px 12px', fontSize: 16, width: '100%' };
const selectStyle = {
  ...inputStyle,
  appearance: 'none', WebkitAppearance: 'none', paddingRight: 34, cursor: 'pointer',
  backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%2385827B\' stroke-width=\'1.8\'><path d=\'M6 9l6 6 6-6\'/></svg>")',
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', backgroundSize: '16px',
};

// Label + required star + the inline "what's missing" message.
export function QField({ id, label, hint, required, error, children }) {
  return (
    <div data-question={id} data-has-error={error ? 'true' : undefined}>
      <label htmlFor={id ? `q-${id}` : undefined} style={{
        display: 'block', fontSize: 11.5, fontWeight: 600,
        color: 'var(--muted)', letterSpacing: '0.04em',
        textTransform: 'uppercase', marginBottom: 6,
      }}>{label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}</label>
      {children}
      {error && (
        <div id={id ? `q-${id}-error` : undefined} role="alert" style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12.5, color: 'var(--danger)', marginTop: 7, fontWeight: 500,
        }}>
          <span aria-hidden="true" style={{
            width: 15, height: 15, borderRadius: 99, flexShrink: 0, fontSize: 10, fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--danger)', color: '#fff',
          }}>!</span>
          {error}
        </div>
      )}
      {hint && !error && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

// Preset chips with multi-select. `values` holds the picked ids; the
// optional "Other" chip adds OTHER and reveals a text box.
export function ChoiceField({
  id, label, hint, required, error, options, values, other,
  onToggle, onOtherToggle, onOtherText, otherPlaceholder = 'Tell us…', children,
}) {
  const selected = Array.isArray(values) ? values : [];
  const otherActive = selected.includes(OTHER);
  const otherMissing = otherActive && !String(other || '').trim();
  return (
    <QField id={id} label={label} hint={hint} required={required} error={error}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }} role="group" aria-label={label}>
        {options.map((o) => {
          const on = selected.includes(o.id);
          return (
            <button key={o.id} type="button" onClick={() => onToggle(o.id)}
              aria-pressed={on}
              className={`btn ${on ? 'btn-primary' : 'btn-outline'}`}
              style={{ padding: '7px 13px', fontSize: 12.5 }}>
              {on && <span style={{ marginRight: 6, fontWeight: 700 }}>✓</span>}
              {o.label}
            </button>
          );
        })}
        {onOtherToggle && (
          <button type="button" onClick={onOtherToggle}
            aria-pressed={otherActive}
            className={`btn ${otherActive ? 'btn-primary' : 'btn-outline'}`}
            style={{ padding: '7px 13px', fontSize: 12.5 }}>
            {otherActive && <span style={{ marginRight: 6, fontWeight: 700 }}>✓</span>}
            Other
          </button>
        )}
      </div>
      {onOtherToggle && otherActive && (
        <input className="input" autoFocus
          style={{ ...inputStyle, marginTop: 8, ...(error && otherMissing ? { borderColor: 'var(--danger)' } : {}) }}
          value={other || ''}
          aria-label={`${label}: other`}
          aria-invalid={error && otherMissing ? 'true' : undefined}
          onChange={(e) => onOtherText(e.target.value.slice(0, 500))}
          placeholder={otherPlaceholder}/>
      )}
      {children}
    </QField>
  );
}

// "Where is your business based?" A US state (50 + DC + Puerto Rico) or
// "Outside the US", which then asks for the country (short list, or type
// it under "Somewhere else").
export function LocationField({ value, onChange, error, required = true }) {
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  const outside = v.locationState === OUTSIDE_US;
  const bad = (cond) => (error && cond ? { borderColor: 'var(--danger)' } : {});
  return (
    <QField id="location" label="Where is your business based?" required={required} error={error}
      hint="Your state, or your country if you're outside the US.">
      <select id="q-location" className="input" value={v.locationState || ''}
        aria-invalid={error && !v.locationState ? 'true' : undefined}
        onChange={(e) => set({ locationState: e.target.value })}
        style={{ ...selectStyle, ...bad(!v.locationState), color: v.locationState ? 'var(--fg)' : 'var(--muted)' }}>
        <option value="" disabled>Choose your state</option>
        <optgroup label="United States">
          {US_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </optgroup>
        <optgroup label="Not in the US?">
          <option value={OUTSIDE_US}>Outside the US</option>
        </optgroup>
      </select>
      {outside && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <select className="input" value={v.locationCountry || ''} aria-label="Country"
            onChange={(e) => set({ locationCountry: e.target.value })}
            style={{ ...selectStyle, ...bad(!v.locationCountry), color: v.locationCountry ? 'var(--fg)' : 'var(--muted)' }}>
            <option value="" disabled>Choose your country</option>
            {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value={OTHER}>Somewhere else</option>
          </select>
          {v.locationCountry === OTHER && (
            <input className="input" autoFocus value={v.locationCountryOther || ''}
              aria-label="Your country"
              onChange={(e) => set({ locationCountryOther: e.target.value.slice(0, 80) })}
              placeholder="Type your country"
              style={{ ...inputStyle, ...bad(!String(v.locationCountryOther || '').trim()) }}/>
          )}
        </div>
      )}
    </QField>
  );
}

// "How did you hear about us?" with the optional "Who referred you?" box
// that appears when Friend / referral is picked.
export function HeardFromField({ about, onToggle, onOtherText, onReferralName, error, required = true }) {
  const ids = about.heardFromIds || [];
  return (
    <ChoiceField
      id="heardFrom"
      label="How did you hear about Ivy?"
      hint={ids.includes('referral') ? null : 'Pick all that apply.'}
      required={required}
      error={error}
      options={HEARD_FROM_OPTIONS}
      values={ids} other={about.heardFromOther}
      onToggle={onToggle}
      onOtherToggle={() => onToggle(OTHER)}
      onOtherText={onOtherText}
      otherPlaceholder="Where did you hear about Ivy?">
      {ids.includes('referral') && (
        <div style={{ marginTop: 10 }}>
          <label htmlFor="q-referral-name" style={{ display: 'block', fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 5 }}>
            Who referred you? <span style={{ color: 'var(--muted)' }}>(optional)</span>
          </label>
          <input id="q-referral-name" className="input" value={about.referralName || ''}
            onChange={(e) => onReferralName(e.target.value.slice(0, 120))}
            placeholder="Their name or business" style={inputStyle}/>
        </div>
      )}
    </ChoiceField>
  );
}

// Scroll the first question with a missing answer into view.
export function scrollToFirstError() {
  try {
    requestAnimationFrame(() => {
      const el = document.querySelector('[data-has-error="true"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  } catch { /* non-browser */ }
}
