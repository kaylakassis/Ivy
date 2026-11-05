// One-time "Two quick questions" card for owners who finished onboarding
// before "Where is your business based?" and "How did you hear about Ivy?"
// were required. Shows only the question(s) still unanswered. Saving or
// "Not now" hides it for good (onboarding_state.dismissedChecklistItems,
// so it follows the owner across devices). Nobody is sent back into the
// wizard.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useUserContext } from '../../lib/userContext.jsx';
import {
  aboutFromProfile, aboutPayload, locationError, heardFromError,
  LocationField, HeardFromField,
} from '../onboarding/aboutFields.jsx';

const DISMISS_ID = 'about_you_prompt';

export default function AboutYouPrompt() {
  const { ctx } = useUserContext();
  const eligible = !!ctx?.isOwner && !!ctx?.owns?.onboardedAt;
  const [state, setState] = useState(null);   // { about, dismissed[], needLocation, needHeard }
  const [about, setAbout] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!eligible) return undefined;
    let live = true;
    Promise.all([
      api.get('/onboarding/profile'),
      api.get('/onboarding/state'),
    ]).then(([pr, st]) => {
      if (!live) return;
      const dismissed = st?.state?.dismissedChecklistItems || [];
      if (dismissed.includes(DISMISS_ID)) return;
      const p = pr?.profile || null;
      const needLocation = !p?.locationState && !p?.locationCountry;
      const needHeard = !(p?.heardFromIds || []).length && !p?.heardFromOther;
      if (!needLocation && !needHeard) return;
      const a = aboutFromProfile(p);
      setAbout(a);
      setState({ dismissed, needLocation, needHeard });
    }).catch(() => { /* stay hidden */ });
    return () => { live = false; };
  }, [eligible]);

  if (!eligible || !state || !about || gone) return null;

  const errs = {
    location: state.needLocation ? locationError(about) : null,
    heardFrom: state.needHeard ? heardFromError(about) : null,
  };

  const remember = () => api.patch('/onboarding/state', {
    dismissedChecklistItems: Array.from(new Set([...state.dismissed, DISMISS_ID])),
  }).catch(() => {});

  const save = async () => {
    setErr(null);
    if (errs.location || errs.heardFrom) { setShowErrors(true); return; }
    setBusy(true);
    try {
      // The profile endpoint replaces the whole answer set, so send every
      // stored answer back along with the new ones.
      await api.patch('/onboarding/profile', aboutPayload(about));
      await remember();
      setGone(true);
    } catch (e) {
      setErr(e?.message || 'Could not save. Try again.');
    } finally { setBusy(false); }
  };
  const notNow = () => { remember(); setGone(true); };

  const toggleHeard = (id) => setAbout((a) => {
    const cur = a.heardFromIds || [];
    return { ...a, heardFromIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
  });
  const both = state.needLocation && state.needHeard;

  return (
    <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="about-you-prompt">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{
          width: 34, height: 34, borderRadius: 10, flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--accent-soft)', color: 'var(--accent)',
        }}><Icons.Spark size={16}/></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>{both ? 'Two quick questions' : 'One quick question'}</div>
          <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 3, lineHeight: 1.5 }}>
            It helps us make Ivy better for businesses like yours. Takes ten seconds.
          </div>
        </div>
      </div>
      {state.needLocation && (
        <LocationField value={about} error={showErrors ? errs.location : null}
          onChange={(next) => setAbout((a) => ({
            ...a,
            locationState: next.locationState,
            locationCountry: next.locationCountry,
            locationCountryOther: next.locationCountryOther,
          }))}/>
      )}
      {state.needHeard && (
        <HeardFromField about={about} error={showErrors ? errs.heardFrom : null}
          onToggle={toggleHeard}
          onOtherText={(v) => setAbout((a) => ({ ...a, heardFromOther: v }))}
          onReferralName={(v) => setAbout((a) => ({ ...a, referralName: v }))}/>
      )}
      {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}/>
        <button type="button" onClick={notNow} className="btn btn-ghost" disabled={busy}
          style={{ padding: '7px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
          Not now
        </button>
        <button type="button" onClick={save} className="btn btn-primary" disabled={busy}
          style={{ padding: '7px 14px', fontSize: 12.5 }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
