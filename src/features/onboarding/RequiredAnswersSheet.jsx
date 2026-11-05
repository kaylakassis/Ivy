// Required "A few quick questions" sheet over the owner app.
//
// Any owner whose business is still missing a required onboarding answer
// (how they heard about Ivy, where they are based, business stage, a goal,
// what is draining them) gets this sheet until they answer. It asks only
// what is missing, uses the same questions and checks as the wizard's About
// step (aboutFields.jsx: "Other" must be typed), saves through
// PATCH /api/onboarding/profile, and then goes away. There is no "Not now"
// and no close button: it is required.
//
// Never shown to clients or helpers (they never reach the owner shell), in
// the onboarding wizard (its own route), while an admin is viewing as the
// owner, or while the paywall is up (AppShell passes enabled=false; the
// questions come after the paywall).
//
// Who is missing what is decided by the server: /api/me sends
// onboardingAnswersMissing, and GET /api/onboarding/profile confirms it
// (and fills in the answers already given, which the save sends back
// because the endpoint replaces the whole answer set).
import React, { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useUserContext } from '../../lib/userContext.jsx';
import {
  OTHER, REQUIRED_KEYS, ERROR_KEY, validateAbout, missingFromAbout, aboutFromProfile, aboutPayload,
  scrollToFirstError, ChoiceField, LocationField, HeardFromField,
  GOAL_OPTIONS, CHALLENGE_OPTIONS, STAGE_OPTIONS,
} from './aboutFields.jsx';

export default function RequiredAnswersSheet({ enabled, onOpenChange }) {
  const { ctx, refresh } = useUserContext();
  const flagged = !!enabled && !!ctx?.isOwner
    && Array.isArray(ctx?.onboardingAnswersMissing) && ctx.onboardingAnswersMissing.length > 0;

  const [ask, setAsk] = useState(null);      // server keys to ask, in REQUIRED_KEYS order
  const [about, setAbout] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const headingRef = useRef(null);

  // Confirm with the server and load the answers already given.
  useEffect(() => {
    if (!flagged || saved) return undefined;
    let live = true;
    api.get('/onboarding/profile').then((r) => {
      if (!live) return;
      const a = aboutFromProfile(r?.profile || null);
      const missing = Array.isArray(r?.missing) ? r.missing : missingFromAbout(a);
      const keys = REQUIRED_KEYS.filter((k) => missing.includes(k));
      if (!keys.length) { Promise.resolve(refresh?.()).catch(() => {}); return; } // /me was stale
      setAbout(a);
      setAsk(keys);
    }).catch(() => { /* stay hidden; asked again next launch */ });
    return () => { live = false; };
  }, [flagged, saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = flagged && !saved && !!ask && !!about;
  useEffect(() => { onOpenChange?.(open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock the page behind the sheet and move focus into it.
  useEffect(() => {
    if (!open) return undefined;
    document.body.classList.add('app-walled');
    const t = setTimeout(() => headingRef.current?.focus?.(), 30);
    return () => { clearTimeout(t); document.body.classList.remove('app-walled'); };
  }, [open]);

  if (!open) return null;

  const allErrs = validateAbout(about);
  const errs = {};
  for (const k of ask) if (allErrs[ERROR_KEY[k]]) errs[ERROR_KEY[k]] = allErrs[ERROR_KEY[k]];
  const shown = showErrors ? errs : {};

  const set = (patch) => setAbout((a) => ({ ...a, ...patch }));
  const toggle = (key) => (id) => setAbout((a) => {
    const cur = a[key] || [];
    return { ...a, [key]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
  });

  const save = async () => {
    setErr(null);
    if (Object.keys(errs).length) { setShowErrors(true); scrollToFirstError(); return; }
    setBusy(true);
    try {
      const r = await api.patch('/onboarding/profile', aboutPayload(about));
      const still = Array.isArray(r?.missing) ? r.missing : [];
      if (still.length) {
        setErr('Something did not save. Please try again.');
        return;
      }
      setSaved(true);
      Promise.resolve(refresh?.()).catch(() => {});
    } catch (e) {
      setErr(e?.message || 'Could not save. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const count = ask.length;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="required-answers-title"
      aria-describedby="required-answers-desc" data-testid="required-answers-sheet"
      // Escape does nothing on purpose: these questions are required.
      onKeyDown={(e) => { if (e.key === 'Escape') e.stopPropagation(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 280,
        background: 'rgba(10, 12, 8, 0.55)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'calc(env(safe-area-inset-top, 0px) + 12px) 12px calc(env(safe-area-inset-bottom, 0px) + 12px)',
      }}>
      <div className="card" style={{
        width: '100%', maxWidth: 520, maxHeight: '100%', overflowY: 'auto',
        padding: 'clamp(18px, 5vw, 26px)', display: 'flex', flexDirection: 'column', gap: 18,
        boxShadow: '0 30px 70px rgba(0,0,0,0.28)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span aria-hidden="true" style={{
            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--accent-soft)', color: 'var(--accent)',
          }}><Icons.Spark size={17}/></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="required-answers-title" ref={headingRef} tabIndex={-1} style={{
              margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500,
              fontSize: 21, lineHeight: 1.2, letterSpacing: '-0.01em', outline: 'none',
            }}>A few quick questions</h2>
            <p id="required-answers-desc" style={{ margin: '5px 0 0', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              {count === 1 ? 'One answer' : `${count} answers`} and you're back in. It helps Ivy give advice that fits your business.
            </p>
          </div>
        </div>

        {ask.includes('goals') && (
          <ChoiceField id="goal" required error={shown.goal}
            label="What are your goals with Ivy?" hint="Pick all that apply."
            options={GOAL_OPTIONS} values={about.goalIds} other={about.goalOther}
            onToggle={toggle('goalIds')} onOtherToggle={() => toggle('goalIds')(OTHER)}
            onOtherText={(v) => set({ goalOther: v })} otherPlaceholder="What's your goal?"/>
        )}
        {ask.includes('challenges') && (
          <ChoiceField id="challenge" required error={shown.challenge}
            label="What's draining you most right now?" hint="Pick all that apply."
            options={CHALLENGE_OPTIONS} values={about.challengeIds} other={about.challengeOther}
            onToggle={toggle('challengeIds')} onOtherToggle={() => toggle('challengeIds')(OTHER)}
            onOtherText={(v) => set({ challengeOther: v })} otherPlaceholder="What else is draining you?"/>
        )}
        {ask.includes('stage') && (
          <ChoiceField id="stage" required error={shown.stage}
            label="Where's your business at?" hint="Pick all that apply."
            options={STAGE_OPTIONS} values={about.stageIds} onToggle={toggle('stageIds')}/>
        )}
        {ask.includes('location') && (
          <LocationField value={about} error={shown.location}
            onChange={(next) => set({
              locationState: next.locationState,
              locationCountry: next.locationCountry,
              locationCountryOther: next.locationCountryOther,
            })}/>
        )}
        {ask.includes('heardFrom') && (
          <HeardFromField about={about} error={shown.heardFrom}
            onToggle={toggle('heardFromIds')}
            onOtherText={(v) => set({ heardFromOther: v })}
            onReferralName={(v) => set({ referralName: v })}/>
        )}

        {err && <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{err}</div>}
        <button type="button" onClick={save} className="btn btn-primary" disabled={busy}
          style={{ width: '100%', justifyContent: 'center', padding: '11px 16px', fontSize: 14 }}>
          {busy ? 'Saving…' : 'Save and continue'}
        </button>
      </div>
    </div>
  );
}
