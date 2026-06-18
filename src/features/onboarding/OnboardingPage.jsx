// /onboarding - the universal save-and-resume setup wizard.
//
// Ten steps. Each is independent and auto-saves through its real API
// (PATCH /calendar for business basics, PUT /calendar/services, etc.)
// AND posts a tiny navigational state update to /api/onboarding/state
// so closing the tab mid-flow resumes exactly where the owner left off
// on next sign-in.
//
// Step ids (kept in sync with VALID_STEPS in api/onboarding/state.js):
//   welcome      → intro slide, "let's get you set up"
//   business     → name, handle (slug), tagline, category
//   services     → at least one service to be bookable
//   availability → weekday windows
//   payments     → Stripe Connect (optional, can skip)
//   branding     → logo + accent color (optional)
//   first_client → manual add OR import (optional)
//   website      → pick template + publish (optional)
//   tour         → quick walk through the main tabs
//   done         → celebrate + route to dashboard
//
// "Skip" on any optional step records the step into skippedSteps so
// the dashboard checklist can keep nudging until it's actually done.
// "Save & exit" exits without marking the wizard complete; the next
// sign-in resumes here.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';
import { useAuth } from '../../lib/auth.jsx';
import { useUserContext } from '../../lib/userContext.jsx';
import { publicOrigin } from '../../lib/publicUrl.js';
import { CATEGORIES, SERVICE_PACKS } from '../../lib/categories.js';
import { TRIAL_DAYS, IVY_PRICE } from '../../lib/pricing.js';

// Step set per business type. 'both' keeps every step so existing
// workspaces aren't affected; 'service' removes the first_product
// step (irrelevant to pure-service); 'product' removes services +
// availability (they don't take appointments) and inserts a
// lightweight first_product step in their place.
// UI sentinel for "Other" on a preset question - kept in the same state
// slot as a preset id. The server's allowlist maps it to null and keeps
// the free-text answer, so no special handling is needed at save time.
const OTHER = '__other__';

function stepsFor(businessType) {
  const base = [
    { id: 'welcome',      label: 'Welcome',         optional: false },
    { id: 'business',     label: 'Business',        optional: false },
    { id: 'about',        label: 'About you',       optional: false },
  ];
  if (businessType === 'product') {
    base.push({ id: 'first_product', label: 'First product', optional: false });
  } else {
    base.push({ id: 'services',     label: 'Services',     optional: false });
    base.push({ id: 'availability', label: 'Availability', optional: false });
    if (businessType === 'both') {
      base.push({ id: 'first_product', label: 'First product', optional: true });
    }
  }
  base.push(
    { id: 'payments',     label: 'Payments',        optional: true  },
    { id: 'branding',     label: 'Branding',        optional: true  },
    { id: 'first_client', label: 'First client',    optional: true  },
    { id: 'website',      label: 'Website',         optional: true  },
    { id: 'tour',         label: 'Quick tour',      optional: false },
    { id: 'done',         label: 'Done',            optional: false },
  );
  return base;
}

// Legacy export - defaults to the full set so any unrelated import
// (none today, but defense-in-depth) keeps working.
const STEPS = stepsFor('both');

const WEEKDAYS = [
  { idx: 1, short: 'Mon', long: 'Monday' },
  { idx: 2, short: 'Tue', long: 'Tuesday' },
  { idx: 3, short: 'Wed', long: 'Wednesday' },
  { idx: 4, short: 'Thu', long: 'Thursday' },
  { idx: 5, short: 'Fri', long: 'Friday' },
  { idx: 6, short: 'Sat', long: 'Saturday' },
  { idx: 0, short: 'Sun', long: 'Sunday' },
];

const DEFAULT_AVAIL = {
  1: [{ start: 540, end: 1020 }], 2: [{ start: 540, end: 1020 }],
  3: [{ start: 540, end: 1020 }], 4: [{ start: 540, end: 1020 }],
  5: [{ start: 540, end: 1020 }],
};

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function prettifyError(e) {
  return e?.message || 'Something went wrong.';
}

export default function OnboardingPage() {
  const [tweaks] = useTweaks();
  const { user } = useAuth();
  const { ctx } = useUserContext();
  const nav = useNavigate();
  const location = useLocation();

  // Navigational state - synced to /api/onboarding/state. completedSteps
  // grows as the owner advances; skippedSteps tracks explicit "do this
  // later" actions; currentStep is the step the resume-on-signin path
  // jumps to.
  const [stateLoaded, setStateLoaded] = useState(false);
  const [currentStep, setCurrentStep] = useState('welcome');
  const [completedSteps, setCompletedSteps] = useState([]);
  const [skippedSteps, setSkippedSteps]     = useState([]);
  const [businessType, setBusinessType]     = useState('both');
  // First-product draft (only used when businessType !== 'service').
  const [productDraft, setProductDraft]     = useState({ name: '', price: '', description: '' });
  const [productCreated, setProductCreated] = useState(false);

  // Form state - pre-filled from existing settings on mount so re-
  // entering doesn't blow away earlier work.
  const [bizName, setBizName]   = useState('');
  const [slug, setSlug]         = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [tagline, setTagline]   = useState('');
  const [category, setCategory] = useState(null);
  const [services, setServices] = useState([]);
  const [draft, setDraft] = useState({ name: '', durationMinutes: 60, price: '' });
  const [availability, setAvailability] = useState(DEFAULT_AVAIL);
  const [stripeStatus, setStripeStatus] = useState(null);
  const [branding, setBranding] = useState({ logoUrl: '', accent: '' });
  const [clientDraft, setClientDraft] = useState({ name: '', email: '', phone: '' });
  const [clientsCount, setClientsCount] = useState(0);
  const [websiteStatus, setWebsiteStatus] = useState(null);
  // "About you" answers - preset ids + free text. Persisted to
  // workspace_profile; feeds Ivy personalization + admin aggregates.
  const [about, setAbout] = useState({
    goal: null, goalOther: '', challenge: null, challengeOther: '',
    idealClient: '', heardFrom: null, heardFromOther: '', stage: null,
  });

  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [exitedAt, setExitedAt] = useState(null);

  // Load saved navigational state + existing settings on mount.
  useEffect(() => {
    let live = true;
    Promise.all([
      api.get('/onboarding/state').catch(() => ({ state: null })),
      api.get('/calendar').catch(() => ({ cal: null })),
      api.get('/clients?limit=1').catch(() => ({ clients: [] })),
      api.get('/finance/stripe-status').catch(() => null),
      api.get('/website').catch(() => null),
      api.get('/onboarding/profile').catch(() => ({ profile: null })),
    ]).then(([stateRes, calRes, clientsRes, stripeRes, webRes, profileRes]) => {
      if (!live) return;
      const st = stateRes?.state;
      if (st) {
        setCurrentStep(st.currentStep || 'welcome');
        setCompletedSteps(st.completedSteps || []);
        setSkippedSteps(st.skippedSteps || []);
      }
      if (stateRes?.businessType) setBusinessType(stateRes.businessType);
      const s = calRes?.cal?.settings || {};
      if (s.bizName && s.bizName !== 'My business') setBizName(s.bizName);
      if (s.slug)     { setSlug(s.slug); setSlugTouched(true); }
      if (s.tagline)  setTagline(s.tagline);
      if (s.category) setCategory(s.category);
      if (s.brandLogoUrl || s.brandAccentColor) {
        setBranding({ logoUrl: s.brandLogoUrl || '', accent: s.brandAccentColor || '' });
      }
      if (Array.isArray(calRes?.cal?.services) && calRes.cal.services.length > 0) {
        setServices(calRes.cal.services);
      }
      if (s.availability && Object.keys(s.availability).length > 0) {
        setAvailability(s.availability);
      }
      setClientsCount((clientsRes?.clients || []).length);
      setStripeStatus(stripeRes);
      setWebsiteStatus(webRes);
      const p = profileRes?.profile;
      if (p) {
        // Reconstruct the OTHER sentinel when a free-text answer was
        // stored without a preset (the server stores them as preset=null
        // + *_other text).
        setAbout({
          goal: p.goal || (p.goalOther ? OTHER : null), goalOther: p.goalOther || '',
          challenge: p.challenge || (p.challengeOther ? OTHER : null), challengeOther: p.challengeOther || '',
          idealClient: p.idealClient || '',
          heardFrom: p.heardFrom || (p.heardFromOther ? OTHER : null), heardFromOther: p.heardFromOther || '',
          stage: p.stage || null,
        });
      }
      setStateLoaded(true);
    });
    return () => { live = false; };
  }, []);

  // Auto-suggest a slug from the business name until the user types one.
  useEffect(() => {
    if (slugTouched) return;
    setSlug(slugify(bizName));
  }, [bizName, slugTouched]);

  // Backstop debounced save for incidental state changes. The PRIMARY
  // persistence path is the explicit flush inside goNext / skipStep
  // below - that's the path a click on "Let's go" goes through. This
  // effect catches anything else (e.g. a step change that bypassed
  // those helpers). We log errors so they're not invisible: silent
  // failure here was the original "Let's go" bug.
  const saveStateTimer = useRef(null);
  useEffect(() => {
    if (!stateLoaded) return;
    if (saveStateTimer.current) clearTimeout(saveStateTimer.current);
    saveStateTimer.current = setTimeout(() => {
      api.patch('/onboarding/state', {
        currentStep, completedSteps, skippedSteps,
      }).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[onboarding] auto-save failed (non-blocking):', e);
      });
    }, 400);
    return () => { if (saveStateTimer.current) clearTimeout(saveStateTimer.current); };
  }, [currentStep, completedSteps, skippedSteps, stateLoaded]);

  // Derived step set - depends on business_type chosen at Welcome.
  // useMemo so identity is stable across renders even though the
  // array is computed on the fly.
  const steps = useMemo(() => stepsFor(businessType), [businessType]);
  const stepIdx = steps.findIndex((s) => s.id === currentStep);
  const stepSpec = steps[stepIdx] || steps[0];

  // Advance the wizard. We try to persist the navigational state to
  // the server, but we DO NOT block progress on it - the nav state is
  // metadata for the dashboard checklist; the user being able to move
  // forward is essential. If the PATCH consistently fails (broken
  // schema, etc.) the user still advances and we surface a soft
  // warning so they know to reach out - but they're never trapped.
  const flushAndAdvance = async ({ markCompleted, markSkipped }) => {
    const nextCompleted = markCompleted
      ? Array.from(new Set([...completedSteps, currentStep]))
      : completedSteps.filter((s) => s !== currentStep);
    const nextSkipped = markSkipped
      ? Array.from(new Set([...skippedSteps, currentStep]))
      : skippedSteps.filter((s) => s !== currentStep);
    const next = steps[stepIdx + 1];
    const nextStepId = next ? next.id : currentStep;

    setBusy(true); setErr(null);

    // Advance the local UI immediately so the user is never trapped
    // by a server-side issue. The save below is best-effort.
    setCompletedSteps(nextCompleted);
    setSkippedSteps(nextSkipped);
    if (next) setCurrentStep(next.id);

    // Fire-and-forget the nav-state save with one retry on transient
    // failure. We log + surface a soft warning if both attempts fail
    // but we do not roll back the UI.
    const body = {
      currentStep: nextStepId,
      completedSteps: nextCompleted,
      skippedSteps: nextSkipped,
      // Carry businessType on every PATCH so a user who picks Products
      // on Welcome AND a returning user whose row still reads 'both'
      // both end up with their selection persisted. The server only
      // writes if the value passes validation, so this is safe.
      businessType,
    };
    try {
      try {
        await api.patch('/onboarding/state', body);
      } catch (firstErr) {
        await new Promise((r) => setTimeout(r, 600));
        await api.patch('/onboarding/state', body);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[onboarding] flushAndAdvance: save failed (advanced anyway):', e);
      setErr("Heads up: your progress couldn't be saved server-side, but you can keep going. If this persists please email hello@getivyos.com.");
    } finally {
      setBusy(false);
    }
  };

  const goNext = () => flushAndAdvance({ markCompleted: true,  markSkipped: false });
  const skipStep = () => flushAndAdvance({ markCompleted: false, markSkipped: true });
  const goBack = () => {
    const prev = steps[stepIdx - 1];
    if (prev) setCurrentStep(prev.id);
  };

  // "Save & exit" - get them OUT of the wizard, no matter what.
  //
  // Old behavior PATCHed /onboarding/state and then nav'd to /dashboard,
  // but if the user wasn't actually marked onboarded the RoleRouter
  // would bounce them right back to /onboarding - making the button
  // appear broken. And if /onboarding/state itself was 500ing (the
  // exact bug a stuck owner is hitting), the nav still fired but they
  // landed back here.
  //
  // New behavior:
  //   1. Try /onboarding/state - best-effort progress save.
  //   2. Try /onboarding/complete - marks workspaces.onboarded_at so
  //      the dashboard gate lets them through. This endpoint has zero
  //      dependency on onboarding_state, so it works even when the
  //      other endpoint is broken.
  //   3. Set a localStorage escape hatch so even a fully-broken API
  //      lets the SPA reach the dashboard.
  //   4. Always nav to /dashboard.
  const saveAndExit = async () => {
    setBusy(true);
    setErr(null);
    // Best-effort progress save - non-blocking.
    api.patch('/onboarding/state', {
      currentStep, completedSteps, skippedSteps,
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[onboarding] save-state on exit failed (non-blocking):', e);
    });
    // Mark workspace onboarded so the dashboard gate doesn't bounce.
    // We tolerate failures here too - the localStorage flag below is
    // a final fallback.
    try {
      await api.post('/onboarding/complete');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[onboarding] complete failed on Save & exit:', e);
    }
    try {
      // SPA-level escape hatch: RoleRouter checks this and lets the
      // user through even if /me reports !onboardedAt. Valid for 24h
      // to handle the case where the user is mid-flow.
      localStorage.setItem('ivy_skip_onboarding_until', String(Date.now() + 24 * 3600_000));
    } catch { /* localStorage may be disabled in private mode */ }
    setExitedAt(Date.now());
    setBusy(false);
    nav('/dashboard?onboarding=resume', { replace: true });
  };

  // "Finish" - marks workspaces.onboarded_at + bounces. Final step CTA.
  // Save the navigational state best-effort (it's just metadata for
  // the dashboard checklist) but DO NOT block on it - the only thing
  // that actually matters is /onboarding/complete flipping onboarded_at.
  const finish = async () => {
    setBusy(true); setErr(null);
    api.patch('/onboarding/state', {
      currentStep: 'done',
      completedSteps: Array.from(new Set([...completedSteps, currentStep, 'done'])),
      skippedSteps,
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[onboarding] state save on finish failed (non-blocking):', e);
    });
    try {
      await api.post('/onboarding/complete');
      try { localStorage.setItem('ivy_skip_onboarding_until', String(Date.now() + 24 * 3600_000)); } catch {}
      nav('/dashboard?walkthrough=1', { replace: true });
    } catch (e) {
      setErr(prettifyError(e));
      setBusy(false);
    }
  };

  // ─── Per-step save helpers ──────────────────────────────────────────
  // Each writes to its real API + advances the wizard. Saving is
  // idempotent - re-clicking Continue doesn't duplicate work.

  const saveBusiness = async () => {
    setBusy(true); setErr(null);
    try {
      const patch = {};
      const name = bizName.trim();
      const cleanSlug = slug.trim().toLowerCase();
      if (name) patch.bizName = name;
      if (cleanSlug) patch.slug = cleanSlug;
      if (tagline.trim()) patch.tagline = tagline.trim();
      else if (tagline === '') patch.tagline = null;
      if (category) patch.category = category;
      if (Object.keys(patch).length > 0) await api.patch('/calendar', patch);
      await goNext();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  // "About you" step. All questions are optional (we never want this to
  // block finishing setup) - whatever's answered is persisted to the
  // workspace_profile and then we advance.
  const saveAbout = async () => {
    setBusy(true); setErr(null);
    try {
      await api.patch('/onboarding/profile', {
        goal: about.goal, goalOther: about.goalOther,
        challenge: about.challenge, challengeOther: about.challengeOther,
        idealClient: about.idealClient,
        heardFrom: about.heardFrom, heardFromOther: about.heardFromOther,
        stage: about.stage,
      });
      await goNext();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  const saveServices = async () => {
    setBusy(true); setErr(null);
    try {
      await api.put('/calendar/services', { services });
      await goNext();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  // First-product step (product / both flows). Idempotent - if the
  // owner already created the product (productCreated=true), skip the
  // POST so re-clicking Next doesn't add a duplicate row. Allows
  // skipping when the form is empty (matches the Services step's
  // "I'll add later" affordance).
  const saveFirstProduct = async () => {
    setBusy(true); setErr(null);
    try {
      const name = (productDraft.name || '').trim();
      const priceCents = Math.round(Number(productDraft.price || 0) * 100);
      if (!productCreated && name) {
        if (!Number.isFinite(priceCents) || priceCents < 0) {
          setBusy(false); setErr('Price must be a non-negative number'); return;
        }
        await api.post('/products', {
          name,
          price: priceCents / 100,
          description: productDraft.description || null,
          active: true,
        });
        setProductCreated(true);
      }
      await goNext();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  const saveAvailability = async () => {
    setBusy(true); setErr(null);
    try {
      await api.patch('/calendar', { availability });
      await goNext();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  const saveBranding = async () => {
    setBusy(true); setErr(null);
    try {
      const patch = {};
      if (branding.logoUrl !== undefined) patch.brandLogoUrl = branding.logoUrl || null;
      if (branding.accent !== undefined)  patch.brandAccentColor = branding.accent || null;
      if (Object.keys(patch).length > 0) await api.patch('/calendar', patch);
      await goNext();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  const saveFirstClient = async () => {
    setBusy(true); setErr(null);
    try {
      const name = clientDraft.name.trim();
      const email = clientDraft.email.trim();
      if (!name || !email) {
        setErr('Add the client\'s name + email, or skip for now.');
        setBusy(false); return;
      }
      await api.post('/clients', { name, email, phone: clientDraft.phone || null, stage: 'active' });
      setClientsCount((n) => n + 1);
      setClientDraft({ name: '', email: '', phone: '' });
      await goNext();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  // ─── Render ─────────────────────────────────────────────────────────

  if (!stateLoaded) {
    return (
      <Shell tweaks={tweaks}>
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>
          Loading your setup…
        </div>
      </Shell>
    );
  }

  return (
    <Shell tweaks={tweaks}>
      <StripeBounceBanner search={location.search} nav={nav}/>
      <ProgressRow steps={steps} currentStep={currentStep} completed={completedSteps} skipped={skippedSteps}
        onJump={(id) => {
          // Allow jumping to any step that's already been visited
          // (completed OR skipped OR ≤ currentIdx). Future steps stay
          // gated until the owner gets there normally.
          const targetIdx = steps.findIndex((s) => s.id === id);
          const visited = completedSteps.includes(id) || skippedSteps.includes(id) || targetIdx <= stepIdx;
          if (visited) setCurrentStep(id);
        }}/>

      <div className="card" style={{
        padding: '32px 36px', marginTop: 18,
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        {currentStep === 'welcome'      && <WelcomeStep user={user}
          businessType={businessType} setBusinessType={setBusinessType}/>}
        {currentStep === 'business'     && <BusinessStep
          bizName={bizName} setBizName={setBizName}
          slug={slug} setSlug={setSlug} setSlugTouched={setSlugTouched}
          tagline={tagline} setTagline={setTagline}
          category={category} setCategory={setCategory}/>}
        {currentStep === 'about'        && <AboutStep about={about} setAbout={setAbout}/>}
        {currentStep === 'services'     && <ServicesStep
          services={services} setServices={setServices}
          draft={draft} setDraft={setDraft} category={category}/>}
        {currentStep === 'first_product' && <FirstProductStep
          productDraft={productDraft} setProductDraft={setProductDraft}
          productCreated={productCreated} setProductCreated={setProductCreated}/>}
        {currentStep === 'availability' && <AvailabilityStep
          availability={availability} setAvailability={setAvailability}/>}
        {currentStep === 'payments'     && <PaymentsStep stripeStatus={stripeStatus} setStripeStatus={setStripeStatus}/>}
        {currentStep === 'branding'     && <BrandingStep branding={branding} setBranding={setBranding}/>}
        {currentStep === 'first_client' && <FirstClientStep clientDraft={clientDraft} setClientDraft={setClientDraft}
          clientsCount={clientsCount}/>}
        {currentStep === 'website'      && <WebsiteStep websiteStatus={websiteStatus}/>}
        {currentStep === 'tour'         && <TourStep/>}
        {currentStep === 'done'         && <DoneStep skippedCount={skippedSteps.length}
          trialEndsAt={ctx?.subscription?.trialEndsAt || null}/>}

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.10)', border: '1px solid rgba(155,44,44,0.30)',
            color: 'var(--danger)', fontSize: 13,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          {stepIdx > 0 && stepIdx < steps.length - 1 && (
            <button onClick={goBack} className="btn btn-ghost" disabled={busy}>
              <Icons.ArrowLeft size={13}/> Back
            </button>
          )}
          <div style={{ flex: 1 }}/>
          {stepSpec.optional && currentStep !== 'done' && (
            <button onClick={skipStep} className="btn btn-ghost" disabled={busy}
              style={{ color: 'var(--muted)' }}>
              Skip for now
            </button>
          )}
          {currentStep !== 'done' && currentStep !== 'tour' && (
            <button onClick={saveAndExit} className="btn btn-outline" disabled={busy}
              style={{ color: 'var(--muted)' }}>
              Save & exit
            </button>
          )}
          <PrimaryCTA
            currentStep={currentStep}
            busy={busy}
            onContinue={() => {
              if (currentStep === 'welcome')      return goNext();
              if (currentStep === 'business')     return saveBusiness();
              if (currentStep === 'about')        return saveAbout();
              if (currentStep === 'services')     return saveServices();
              if (currentStep === 'first_product') return saveFirstProduct();
              if (currentStep === 'availability') return saveAvailability();
              if (currentStep === 'payments')     return goNext();
              if (currentStep === 'branding')     return saveBranding();
              if (currentStep === 'first_client') return saveFirstClient();
              if (currentStep === 'website')      return goNext();
              if (currentStep === 'tour')         return goNext();
              if (currentStep === 'done')         return finish();
            }}/>
        </div>
      </div>
    </Shell>
  );
}

// ─── Step components ──────────────────────────────────────────────────

function WelcomeStep({ user, businessType, setBusinessType }) {
  const name = (user?.name || '').split(/\s+/)[0] || 'there';
  const options = [
    { id: 'service', label: 'Services', sub: 'Appointments, sessions, classes.' },
    { id: 'product', label: 'Products', sub: 'Physical goods, retail, makers.' },
    { id: 'both',    label: 'Both',     sub: 'Services AND products.' },
  ];
  return (
    <div style={{ textAlign: 'center', padding: '14px 0' }}>
      <div style={{
        width: 56, height: 56, borderRadius: 18, margin: '0 auto 18px',
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Spark size={26} sw={1.7}/></div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 30, fontWeight: 600, margin: '0 0 8px' }}>
        Welcome, {name}.
      </h1>
      <p style={{ color: 'var(--muted)', fontSize: 14.5, lineHeight: 1.6, maxWidth: 520, margin: '0 auto 22px' }}>
        Let's set up Ivy OS for your business. First - what do you sell?
        We'll tailor the next steps based on your answer.
      </p>

      <div style={{
        display: 'grid', gap: 10, maxWidth: 520, margin: '0 auto',
        gridTemplateColumns: 'repeat(3, 1fr)',
      }}>
        {options.map((o) => {
          const active = businessType === o.id;
          return (
            <button key={o.id} type="button" onClick={() => setBusinessType(o.id)}
              style={{
                textAlign: 'left', padding: '14px 14px', borderRadius: 12,
                border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border-strong)'),
                background: active ? 'var(--accent-soft)' : 'var(--surface)',
                color: active ? 'var(--accent)' : 'var(--fg)',
                cursor: 'pointer',
              }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{o.label}</div>
              <div style={{ fontSize: 12, color: active ? 'var(--accent)' : 'var(--muted)', lineHeight: 1.5 }}>
                {o.sub}
              </div>
            </button>
          );
        })}
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 18, maxWidth: 460, margin: '18px auto 0' }}>
        Don't worry - you can change this later in your account settings.
        <strong> Auto-saves at every step.</strong>
      </p>
    </div>
  );
}

function FirstProductStep({ productDraft, setProductDraft, productCreated }) {
  return (
    <>
      <StepHeader title="Add your first product"
        subtitle="The thing you sell. You can add the full catalog later in Finance → Products."/>
      <Field label="Product name" required>
        <input className="input" value={productDraft.name}
          onChange={(e) => setProductDraft({ ...productDraft, name: e.target.value })}
          placeholder="e.g. Vanilla Soy Candle (8oz)" autoFocus
          style={inputStyle}/>
      </Field>
      <Field label="Price" hint="In whole dollars, e.g. 24.00">
        <div style={{
          display: 'flex', alignItems: 'center',
          border: '1px solid var(--border-strong)', borderRadius: 10, background: 'var(--surface)',
          overflow: 'hidden',
        }}>
          <span style={{ padding: '10px 12px', background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 14 }}>$</span>
          <input type="number" min="0" step="0.01" value={productDraft.price}
            onChange={(e) => setProductDraft({ ...productDraft, price: e.target.value })}
            placeholder="24.00"
            style={{ flex: 1, padding: '10px 12px', background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', fontSize: 14 }}/>
        </div>
      </Field>
      <Field label="Short description (optional)">
        <input className="input" value={productDraft.description}
          onChange={(e) => setProductDraft({ ...productDraft, description: e.target.value.slice(0, 280) })}
          placeholder="One line shoppers will see on your store page."
          style={inputStyle}/>
      </Field>
      {productCreated && (
        <div style={{ fontSize: 12, color: 'var(--ok)' }}>
          ✓ Product saved. You can edit or add more in Finance → Products anytime.
        </div>
      )}
    </>
  );
}

function BusinessStep({ bizName, setBizName, slug, setSlug, setSlugTouched, tagline, setTagline, category, setCategory }) {
  return (
    <>
      <StepHeader title="What's your business?"
        subtitle="The basics - clients see this on your booking page and in any reviews."/>
      <Field label="Business name" required>
        <input className="input" value={bizName} onChange={(e) => setBizName(e.target.value)}
          placeholder="e.g. Maya's Massage Studio" autoFocus
          style={inputStyle}/>
      </Field>
      <Field label="Booking page handle" required
        hint={`Your public link will be ${publicOrigin()}/book/${slug || 'your-handle'}`}>
        <div style={{
          display: 'flex', alignItems: 'center',
          border: '1px solid var(--border-strong)', borderRadius: 10, background: 'var(--surface)',
          overflow: 'hidden',
        }}>
          <span style={{ padding: '10px 12px', background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 13 }}>
            /book/
          </span>
          <input value={slug}
            onChange={(e) => { setSlug(slugify(e.target.value)); setSlugTouched(true); }}
            placeholder="your-handle"
            style={{ flex: 1, padding: '10px 12px', background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', fontSize: 14 }}/>
        </div>
      </Field>
      <Field label="Tagline (optional)" hint="One line. Shown under your business name on the booking page.">
        <input className="input" value={tagline} onChange={(e) => setTagline(e.target.value.slice(0, 140))}
          placeholder="Massage therapy in downtown Austin" maxLength={140}
          style={inputStyle}/>
      </Field>
      <Field label="Category (optional)" hint="Helps clients find you in our discovery directory.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button type="button" onClick={() => setCategory(null)}
            className={`btn ${!category ? 'btn-primary' : 'btn-outline'}`}
            style={{ padding: '5px 11px', fontSize: 12 }}>None</button>
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" onClick={() => setCategory(c.id)}
              className={`btn ${category === c.id ? 'btn-primary' : 'btn-outline'}`}
              style={{ padding: '5px 11px', fontSize: 12 }}>
              {c.label}
            </button>
          ))}
        </div>
      </Field>
    </>
  );
}

function ServicesStep({ services, setServices, draft, setDraft, category }) {
  const pack = SERVICE_PACKS[category] || null;

  const addService = () => {
    if (!draft.name.trim()) return;
    const price = Number(draft.price) || 0;
    setServices((p) => [...p, {
      id: 'tmp_' + Date.now(),
      name: draft.name.trim(),
      durationMinutes: Math.max(15, Number(draft.durationMinutes) || 60),
      price,
      visibility: 'public',
    }]);
    setDraft({ name: '', durationMinutes: 60, price: '' });
  };
  const removeService = (id) => setServices((p) => p.filter((s) => s.id !== id));
  const applyPack = () => {
    if (!pack) return;
    setServices(pack.map((s, i) => ({
      id: 'pk_' + i,
      name: s.name,
      durationMinutes: s.durationMinutes,
      price: s.price,
      visibility: 'public',
    })));
  };

  return (
    <>
      <StepHeader title="What do you offer?"
        subtitle="Add 1–3 services to start. You can refine pricing + duration later from the Calendar tab."/>

      {services.length === 0 && pack && (
        <div style={{
          padding: 12, borderRadius: 10, background: 'var(--surface-2)',
          border: '1px solid var(--border)', display: 'flex',
          alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)' }}>
            We've got a starter pack for {category} - load it as a starting point?
          </div>
          <button onClick={applyPack} className="btn btn-outline" style={{ fontSize: 12, padding: '5px 11px' }}>
            Load starter pack
          </button>
        </div>
      )}

      {services.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {services.map((s) => (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px', borderRadius: 8,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
            }}>
              <div style={{ flex: 1, fontSize: 13.5, fontWeight: 550 }}>{s.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.durationMinutes}m · ${Number(s.price).toFixed(0)}</div>
              <button onClick={() => removeService(s.id)} className="btn btn-ghost"
                style={{ padding: 4, color: 'var(--danger)' }}>
                <Icons.X size={12}/>
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{
        padding: 14, borderRadius: 10, border: '1px dashed var(--border-strong)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Add a service
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8 }}>
          <input className="input" value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Service name" style={inputStyle}/>
          <input className="input" type="number" min={15} step={15} value={draft.durationMinutes}
            onChange={(e) => setDraft({ ...draft, durationMinutes: Number(e.target.value) })}
            placeholder="Minutes" style={inputStyle}/>
          <input className="input" type="number" min={0} step="0.01" value={draft.price}
            onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            placeholder="$ price" style={inputStyle}/>
          <button onClick={addService} className="btn btn-primary" disabled={!draft.name.trim()}
            style={{ padding: '0 14px', fontSize: 13 }}>
            Add
          </button>
        </div>
      </div>
    </>
  );
}

// 30-min slot options across a working day (6 AM – 11 PM). Stored as
// minutes-since-midnight so the existing API shape is unchanged.
const TIME_SLOTS = (() => {
  const out = [];
  for (let m = 6 * 60; m <= 23 * 60; m += 30) out.push(m);
  return out;
})();

function fmtTime(m) {
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

function AvailabilityStep({ availability, setAvailability }) {
  const toggleDay = (idx) => {
    setAvailability((prev) => {
      const has = (prev[idx] || []).length > 0;
      const next = { ...prev };
      if (has) delete next[idx];
      else next[idx] = [{ start: 540, end: 1020 }];
      return next;
    });
  };
  const updateWindow = (idx, field, val) => {
    setAvailability((prev) => {
      const cur = prev[idx]?.[0] || { start: 540, end: 1020 };
      let { start, end } = cur;
      if (field === 'start') start = val;
      if (field === 'end') end = val;
      // Auto-fix invalid ranges so a bad pick can't get persisted -
      // if the user picks a start after the end, push end forward an hour;
      // if end before start, pull start back.
      if (start >= end) {
        if (field === 'start') end = Math.min(start + 60, 23 * 60 + 30);
        else                   start = Math.max(end - 60, 6 * 60);
      }
      return { ...prev, [idx]: [{ start, end }] };
    });
  };

  // Quick-set presets - one tap to fill weekdays / every day / weekends.
  const applyPreset = (kind) => {
    const win = { start: 540, end: 1020 }; // 9–5
    if (kind === 'weekdays') {
      setAvailability({ 1: [win], 2: [win], 3: [win], 4: [win], 5: [win] });
    } else if (kind === 'all') {
      setAvailability({ 0: [win], 1: [win], 2: [win], 3: [win], 4: [win], 5: [win], 6: [win] });
    } else if (kind === 'weekends') {
      setAvailability({ 0: [win], 6: [win] });
    } else if (kind === 'clear') {
      setAvailability({});
    }
  };

  // Spread the currently-shown windows to other enabled days. Saves the
  // user from setting "10am to 6pm" five times if they want the same hours.
  const copyToAllEnabled = (sourceIdx) => {
    setAvailability((prev) => {
      const src = prev[sourceIdx]?.[0];
      if (!src) return prev;
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (Number(k) !== sourceIdx) next[k] = [{ ...src }];
      }
      return next;
    });
  };

  const anyEnabled = WEEKDAYS.some((d) => (availability[d.idx] || []).length > 0);
  const enabledCount = WEEKDAYS.filter((d) => (availability[d.idx] || []).length > 0).length;

  return (
    <>
      <StepHeader title="When are you available?"
        subtitle="Pick the days you take bookings and your working window. You can override individual days from Calendar → Availability later."/>

      {/* Quick-set presets */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '12px 14px', borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        marginBottom: 12,
      }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 500, marginRight: 4 }}>
          Quick set
        </span>
        <PresetChip label="Weekdays 9–5"  onClick={() => applyPreset('weekdays')}/>
        <PresetChip label="Every day 9–5" onClick={() => applyPreset('all')}/>
        <PresetChip label="Weekends only" onClick={() => applyPreset('weekends')}/>
        {anyEnabled && (
          <PresetChip label="Clear" onClick={() => applyPreset('clear')} tone="ghost"/>
        )}
      </div>

      {/* Per-day rows */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 4,
        border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden',
      }}>
        {WEEKDAYS.map((d, idx) => {
          const win = availability[d.idx]?.[0];
          const on = !!win;
          const last = idx === WEEKDAYS.length - 1;
          return (
            <div key={d.idx} style={{
              display: 'flex', alignItems: 'center',
              gap: 12, padding: '12px 14px', minHeight: 56,
              background: on ? 'var(--surface)' : 'var(--surface-2)',
              borderBottom: last ? 'none' : '1px solid var(--border)',
              transition: 'background 120ms ease',
            }}>
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 10,
                fontSize: 14, fontWeight: on ? 600 : 500,
                color: on ? 'var(--fg)' : 'var(--fg-2)',
                minWidth: 130, cursor: 'pointer',
              }}>
                <input type="checkbox" checked={on} onChange={() => toggleDay(d.idx)}
                  style={{ accentColor: 'var(--accent)', width: 16, height: 16, cursor: 'pointer' }}/>
                {d.long}
              </label>
              {on ? (
                <>
                  <TimeSelect value={win.start} onChange={(v) => updateWindow(d.idx, 'start', v)}/>
                  <span style={{ color: 'var(--muted)', fontSize: 13 }}>to</span>
                  <TimeSelect value={win.end} onChange={(v) => updateWindow(d.idx, 'end', v)} min={win.start}/>
                  {enabledCount > 1 && (
                    <button onClick={() => copyToAllEnabled(d.idx)}
                      title={`Copy ${d.long}'s hours to every selected day`}
                      style={{
                        marginLeft: 'auto', padding: '4px 10px', borderRadius: 6,
                        background: 'transparent', color: 'var(--muted)',
                        border: '1px solid var(--border)', fontSize: 11.5, cursor: 'pointer',
                      }}>
                      Copy to all
                    </button>
                  )}
                </>
              ) : (
                <span style={{ fontSize: 13, color: 'var(--muted-2)', fontStyle: 'italic' }}>Closed</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Helpful footer summary so the user knows what'll be saved. */}
      <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--muted)' }}>
        {enabledCount === 0
          ? "You haven't picked any days yet. Pick at least one before continuing."
          : `${enabledCount} day${enabledCount === 1 ? '' : 's'} a week. You can override individual days from Calendar → Availability anytime.`}
      </div>
    </>
  );
}

// Compact pill-shaped quick-set button.
function PresetChip({ label, onClick, tone = 'normal' }) {
  return (
    <button onClick={onClick} type="button" style={{
      padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 500,
      cursor: 'pointer',
      background: tone === 'ghost' ? 'transparent' : 'var(--surface)',
      color: tone === 'ghost' ? 'var(--muted)' : 'var(--fg)',
      border: '1px solid var(--border)',
    }}>{label}</button>
  );
}

// Custom dark-themed time picker built on <select>. Avoids the native
// <input type="time"> control which renders white in dark mode, sizes
// inconsistently across browsers, and clips the AM/PM suffix at
// narrow widths.
function TimeSelect({ value, onChange, min = -Infinity }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        padding: '8px 28px 8px 12px',
        background: 'var(--surface-2)',
        color: 'var(--fg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        fontSize: 13, fontVariantNumeric: 'tabular-nums',
        appearance: 'none',
        // Inline chevron so the dropdown indicator matches our theme
        backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%2385827B\' stroke-width=\'1.8\'><path d=\'M6 9l6 6 6-6\'/></svg>")',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center',
        backgroundSize: '14px',
        cursor: 'pointer',
        minWidth: 108,
      }}>
      {TIME_SLOTS.map((m) => (
        <option key={m} value={m} disabled={m <= min}>{fmtTime(m)}</option>
      ))}
    </select>
  );
}

function PaymentsStep({ stripeStatus }) {
  const connected = !!stripeStatus?.connected;
  const pending = !!stripeStatus?.pending;
  return (
    <>
      <StepHeader title="Take payments (optional)"
        subtitle="Connect Stripe to take cards on your booking page + auto-charge deposits, tips, no-show fees. Skip if you're collecting in person for now."/>
      <div className="card" style={{
        padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
        background: connected ? 'color-mix(in srgb, var(--ok) 8%, transparent)' : 'var(--surface-2)',
        border: '1px solid ' + (connected ? 'color-mix(in srgb, var(--ok) 30%, transparent)' : 'var(--border)'),
      }}>
        {connected ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icons.Check size={16} sw={2.4} stroke="var(--ok)"/>
              <strong style={{ fontSize: 14 }}>Stripe connected</strong>
              {stripeStatus?.accountLabel && (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>· {stripeStatus.accountLabel}</span>
              )}
            </div>
            {pending && (
              <div style={{ fontSize: 12.5, color: 'var(--warn)' }}>
                Stripe is still verifying. You can keep setting up Ivy OS; charges work as soon as verification finishes.
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 14 }}>
              Stripe handles the cards. Connect once - funds settle to your own bank account.
            </div>
            <a href="/api/finance/stripe-oauth-init?from=onboarding" className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}>
              <Icons.Spark size={13} sw={1.8}/> Connect Stripe
            </a>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Takes ~3 minutes. We never see your bank info - it goes direct to Stripe.
            </div>
          </>
        )}
      </div>
    </>
  );
}

function BrandingStep({ branding, setBranding }) {
  return (
    <>
      <StepHeader title="Make it yours"
        subtitle="Logo + an accent color so your booking page, invoices, and emails feel branded. Both optional - defaults look great too."/>
      <Field label="Logo URL (optional)" hint="Paste a public URL or upload via Account → Branding. We'll wire upload here in the next pass.">
        <input className="input" type="url" value={branding.logoUrl}
          onChange={(e) => setBranding({ ...branding, logoUrl: e.target.value })}
          placeholder="https://…" style={inputStyle}/>
      </Field>
      <Field label="Accent color">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="color" value={branding.accent || '#8E826A'}
            onChange={(e) => setBranding({ ...branding, accent: e.target.value })}
            style={{ width: 50, height: 38, padding: 2, border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}/>
          <input className="input" value={branding.accent}
            onChange={(e) => setBranding({ ...branding, accent: e.target.value })}
            placeholder="#8E826A" style={{ ...inputStyle, fontFamily: 'monospace' }}/>
        </div>
      </Field>
    </>
  );
}

function FirstClientStep({ clientDraft, setClientDraft, clientsCount }) {
  return (
    <>
      <StepHeader title="Add your first client"
        subtitle={clientsCount > 0
          ? `You already have ${clientsCount} client${clientsCount === 1 ? '' : 's'}! Add another, or skip - we'll keep going.`
          : "Walking through with a real client makes the rest of the setup click. Add one now or skip to add later in bulk via Clients → Import."}/>
      <Field label="Name" required>
        <input className="input" value={clientDraft.name}
          onChange={(e) => setClientDraft({ ...clientDraft, name: e.target.value })}
          placeholder="Sarah Johnson" autoFocus style={inputStyle}/>
      </Field>
      <Field label="Email" required>
        <input className="input" type="email" value={clientDraft.email}
          onChange={(e) => setClientDraft({ ...clientDraft, email: e.target.value })}
          placeholder="sarah@example.com" style={inputStyle}/>
      </Field>
      <Field label="Phone (optional)">
        <input className="input" type="tel" value={clientDraft.phone}
          onChange={(e) => setClientDraft({ ...clientDraft, phone: e.target.value })}
          placeholder="+1 555 555-5555" style={inputStyle}/>
      </Field>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
        We'll email them a portal invite so they can see their bookings + invoices in one place.
      </div>
    </>
  );
}

function WebsiteStep({ websiteStatus }) {
  const launched = !!websiteStatus?.website?.launched;
  return (
    <>
      <StepHeader title="Build your website (optional)"
        subtitle="Pick a template, drag-edit your sections, and publish in 10 minutes. Skip if you already have a site - you can embed an Ivy OS booking widget onto it instead."/>
      <div className="card" style={{
        padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
        background: launched ? 'color-mix(in srgb, var(--ok) 8%, transparent)' : 'var(--surface-2)',
        border: '1px solid ' + (launched ? 'color-mix(in srgb, var(--ok) 30%, transparent)' : 'var(--border)'),
      }}>
        {launched ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icons.Check size={16} sw={2.4} stroke="var(--ok)"/>
            <strong style={{ fontSize: 14 }}>Website is live</strong>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 14 }}>
              Templates included - Clean, Modern, Lush, Lean.
              Build at <code style={{ background: 'var(--surface)', padding: '1px 5px', borderRadius: 4, fontSize: 12.5 }}>/website</code> any time.
            </div>
            <a href="/website" target="_blank" rel="noreferrer" className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}>
              <Icons.Arrow size={13} sw={1.8}/> Open Website builder
            </a>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Opens in a new tab so you can keep this onboarding open. Hit "Continue" here once you've published - or "Skip for now" if you already have a site.
            </div>
          </>
        )}
      </div>
    </>
  );
}

function TourStep() {
  const stops = [
    { tab: 'Dashboard', icon: 'Home',     desc: 'The home page. Today\'s bookings, revenue this month, unread messages - at a glance.' },
    { tab: 'Clients',   icon: 'Users',    desc: 'Every client + lead. Add, search, tag, drop notes. Click into a profile for their bookings + invoices.' },
    { tab: 'Calendar',  icon: 'Calendar', desc: 'Schedule. Click any slot to add a booking. Share drawer copies your booking link + QR.' },
    { tab: 'Finance',   icon: 'Dollar',   desc: 'Invoices, quotes, expenses, time tracking, memberships, gift cards. Year-end CSV export under "Export ▾".' },
    { tab: 'Messages',  icon: 'Chat',     desc: 'Text + email threads with each client. Voice memos auto-transcribe.' },
    { tab: 'Documents', icon: 'Doc',      desc: 'Contracts + intake forms. Send for e-signature, audit trail included.' },
    { tab: 'Workflows', icon: 'Spark',    desc: 'Automate follow-ups - birthday emails, win-back nudges, new-lead sequences. Build from /workflows.' },
    { tab: 'Ivy Pro',   icon: 'Spark',    desc: 'Your AI business coach. Ask questions grounded in your real data: "why am I losing clients?"' },
  ];
  return (
    <>
      <StepHeader title="Quick tour"
        subtitle="A 30-second walkthrough of where everything lives, so you know exactly where to go after this."/>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {stops.map((s) => {
          const Icon = Icons[s.icon] || Icons.Check;
          return (
            <div key={s.tab} style={{
              display: 'flex', alignItems: 'flex-start', gap: 12,
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Icon size={15} sw={1.7}/>
              </div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{s.tab}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>{s.desc}</div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function DoneStep({ skippedCount, trialEndsAt }) {
  return (
    <div style={{ textAlign: 'center', padding: '14px 0' }}>
      <div style={{
        width: 64, height: 64, borderRadius: 32, margin: '0 auto 18px',
        background: 'color-mix(in srgb, var(--ok) 18%, transparent)',
        color: 'var(--ok)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Check size={32} sw={2.4}/></div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 30, fontWeight: 600, margin: '0 0 8px' }}>
        You're ready.
      </h1>
      <p style={{ color: 'var(--muted)', fontSize: 14.5, lineHeight: 1.6, maxWidth: 480, margin: '0 auto' }}>
        Everything's wired up. Here's how your free trial works - then hit
        Finish to land on your dashboard.
        {skippedCount > 0 && (
          <>
            <br/><br/>
            You skipped {skippedCount} step{skippedCount === 1 ? '' : 's'} - they'll
            stay in the "Finish setup" checklist on your dashboard so you can come
            back when you're ready.
          </>
        )}
      </p>

      <TrialTimeline trialEndsAt={trialEndsAt}/>
    </div>
  );
}

// Trial-priming timeline shown on the final onboarding step - sets
// expectations (and pre-sells the reminder emails) at the moment trust is
// highest, the way top funnels prime the paywall before it ever appears.
// Dates are derived from the workspace's real trial_ends_at; if it isn't
// loaded yet we fall back to TRIAL_DAYS from today so the screen never
// renders empty.
function TrialTimeline({ trialEndsAt }) {
  const fmt = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const ends = trialEndsAt ? new Date(trialEndsAt) : new Date(Date.now() + TRIAL_DAYS * 86_400_000);
  const remind = new Date(ends.getTime() - 7 * 86_400_000);
  const today = new Date();

  const rows = [
    { when: `Today, ${fmt(today)}`, icon: 'Spark',
      text: 'Full access to everything - clients, calendar, invoices, messaging, your booking site. No card required.' },
    { when: fmt(remind), icon: 'Bell',
      text: "We'll email you a friendly heads-up that your trial is ending - no surprises." },
    { when: fmt(ends), icon: 'Clock',
      text: `Your ${TRIAL_DAYS}-day trial ends. Keep everything running for $${IVY_PRICE}/mo, or cancel anytime - your data's always yours.` },
  ];

  return (
    <div style={{
      maxWidth: 460, margin: '22px auto 0', textAlign: 'left',
      border: '1px solid var(--border)', borderRadius: 14,
      background: 'var(--surface-2)', padding: '18px 18px 8px',
    }}>
      {rows.map((r, i) => {
        const Icon = Icons[r.icon] || Icons.Check;
        const last = i === rows.length - 1;
        return (
          <div key={i} style={{ display: 'flex', gap: 12, position: 'relative', paddingBottom: last ? 10 : 16 }}>
            {/* Connector line down the rail between markers */}
            {!last && (
              <span style={{
                position: 'absolute', left: 15, top: 30, bottom: 0, width: 2,
                background: 'var(--border)',
              }}/>
            )}
            <div style={{
              flex: '0 0 auto', width: 32, height: 32, borderRadius: 99, zIndex: 1,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icon size={15} sw={1.8}/>
            </div>
            <div style={{ paddingTop: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{r.when}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginTop: 2 }}>{r.text}</div>
            </div>
          </div>
        );
      })}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        fontSize: 11.5, color: 'var(--muted)', padding: '8px 0 4px',
        borderTop: '1px solid var(--border)', marginTop: 4,
      }}>
        <Icons.Check size={12} sw={2.4} stroke="var(--ok)"/>
        No card required · Cancel anytime
      </div>
    </div>
  );
}

// ─── Reusable bits ────────────────────────────────────────────────────

function PrimaryCTA({ currentStep, onContinue, busy }) {
  const label = currentStep === 'welcome' ? "Let's go"
              : currentStep === 'done'    ? 'Finish'
              : currentStep === 'tour'    ? 'Almost there'
              : 'Save & continue';
  return (
    <button onClick={onContinue} className="btn btn-primary" disabled={busy}>
      {busy ? 'Saving…' : label}
      {!busy && <Icons.Arrow size={13} sw={1.8}/>}
    </button>
  );
}

function ProgressRow({ steps, currentStep, completed, skipped, onJump }) {
  const stepIdx = steps.findIndex((s) => s.id === currentStep);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {steps.map((s, i) => {
        const isCurrent = s.id === currentStep;
        const isDone    = completed.includes(s.id);
        const isSkip    = skipped.includes(s.id);
        const visited   = isDone || isSkip || i <= stepIdx;
        return (
          <button key={s.id} onClick={() => onJump(s.id)} disabled={!visited}
            title={s.label}
            style={{
              flex: 1, height: 6, borderRadius: 3,
              background: isCurrent ? 'var(--accent)'
                       : isDone    ? 'color-mix(in srgb, var(--ok) 60%, transparent)'
                       : isSkip    ? 'color-mix(in srgb, var(--warn) 40%, transparent)'
                       : visited   ? 'var(--border-strong)'
                       :             'var(--border)',
              cursor: visited ? 'pointer' : 'default',
              border: 0,
              transition: 'background 0.2s',
            }}/>
        );
      })}
    </div>
  );
}

// "About you" - marketing + intent questions. Every answer is optional;
// we never block finishing setup on them. Preset answers roll up into
// admin aggregates; the free-text + answers feed Ivy's personalization.
function AboutStep({ about, setAbout }) {
  const set = (patch) => setAbout((a) => ({ ...a, ...patch }));
  return (
    <>
      <StepHeader
        title="A little about you"
        subtitle="This tailors your dashboard and lets Ivy - your built-in AI assistant - give advice that actually fits your business. All optional."
      />

      <ChoiceField
        label="What's your #1 goal with Ivy OS?"
        options={[
          { id: 'grow_revenue', label: 'Grow revenue' },
          { id: 'more_clients', label: 'Get more clients' },
          { id: 'save_time',    label: 'Save time on admin' },
          { id: 'look_pro',     label: 'Look more professional' },
        ]}
        value={about.goal} other={about.goalOther}
        onPick={(id) => set({ goal: id, goalOther: '' })}
        onOther={() => set({ goal: OTHER })}
        onOtherText={(v) => set({ goalOther: v })}
      />

      <ChoiceField
        label="What's your biggest challenge right now?"
        options={[
          { id: 'leads',        label: 'Not enough leads' },
          { id: 'no_shows',     label: 'No-shows & cancellations' },
          { id: 'getting_paid', label: 'Getting paid on time' },
          { id: 'organized',    label: 'Staying organized' },
          { id: 'marketing',    label: 'Marketing myself' },
        ]}
        value={about.challenge} other={about.challengeOther}
        onPick={(id) => set({ challenge: id, challengeOther: '' })}
        onOther={() => set({ challenge: OTHER })}
        onOtherText={(v) => set({ challengeOther: v })}
      />

      <Field
        label="Who's your ideal client?"
        hint="Ivy uses this to tailor advice - e.g. “busy professionals who want monthly massages.”">
        <input className="input" style={inputStyle} value={about.idealClient}
          onChange={(e) => set({ idealClient: e.target.value.slice(0, 500) })}
          placeholder="Describe your dream customer…"/>
      </Field>

      <ChoiceField
        label="How did you hear about us?"
        options={[
          { id: 'instagram', label: 'Instagram' },
          { id: 'tiktok',    label: 'TikTok' },
          { id: 'google',    label: 'Google' },
          { id: 'referral',  label: 'Friend / referral' },
        ]}
        value={about.heardFrom} other={about.heardFromOther}
        onPick={(id) => set({ heardFrom: id, heardFromOther: '' })}
        onOther={() => set({ heardFrom: OTHER })}
        onOtherText={(v) => set({ heardFromOther: v })}
      />

      <ChoiceField
        label="Where's your business at?"
        options={[
          { id: 'starting',    label: 'Just starting out' },
          { id: 'side_hustle', label: 'Side hustle' },
          { id: 'established', label: 'Established & steady' },
          { id: 'scaling',     label: 'Ready to scale' },
        ]}
        value={about.stage}
        onPick={(id) => set({ stage: id })}
      />
    </>
  );
}

// Preset chips with an optional "Other" free-text. When onOther is
// provided, an "Other" chip toggles a text input; selecting it parks the
// OTHER sentinel in `value` so exactly one choice is ever active.
function ChoiceField({ label, hint, options, value, other, onPick, onOther, onOtherText }) {
  const otherActive = value === OTHER;
  return (
    <Field label={label} hint={hint}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {options.map((o) => (
          <button key={o.id} type="button" onClick={() => onPick(o.id)}
            className={`btn ${value === o.id ? 'btn-primary' : 'btn-outline'}`}
            style={{ padding: '7px 13px', fontSize: 12.5 }}>
            {o.label}
          </button>
        ))}
        {onOther && (
          <button type="button" onClick={onOther}
            className={`btn ${otherActive ? 'btn-primary' : 'btn-outline'}`}
            style={{ padding: '7px 13px', fontSize: 12.5 }}>
            Other
          </button>
        )}
      </div>
      {onOther && otherActive && (
        <input className="input" autoFocus style={{ ...inputStyle, marginTop: 8 }}
          value={other || ''}
          onChange={(e) => onOtherText(e.target.value.slice(0, 500))}
          placeholder="Tell us…"/>
      )}
    </Field>
  );
}

function StepHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <h2 style={{
        fontFamily: 'var(--font-display)', fontStyle: 'italic',
        fontSize: 24, fontWeight: 600, margin: '0 0 6px',
      }}>{title}</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: 0, lineHeight: 1.55 }}>{subtitle}</p>
    </div>
  );
}

function Field({ label, hint, required, children }) {
  return (
    <div>
      <label style={{
        display: 'block', fontSize: 11.5, fontWeight: 600,
        color: 'var(--muted)', letterSpacing: '0.04em',
        textTransform: 'uppercase', marginBottom: 6,
      }}>{label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}</label>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

const inputStyle = { padding: '10px 12px', fontSize: 14, width: '100%' };

function Shell({ tweaks, children }) {
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', padding: '40px 24px',
      background: 'var(--page)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
    }}>
      <div style={{ width: '100%', maxWidth: 680 }}>{children}</div>
    </div>
  );
}

// Banner shown at the top of the wizard when a Stripe Connect attempt
// bounces back here with a status / error param. Success cases are
// short-and-positive ("You're connected - keep going"); failures point
// at the env var or Connect activation flow.
const STRIPE_BOUNCE_MSGS = {
  connected:  { tone: 'ok',   title: 'Stripe is connected.',         body: 'You\'re ready to take cards. You can keep going with onboarding.' },
  pending:    { tone: 'warn', title: 'Stripe is verifying your account', body: 'You can continue setting up Ivy OS. Charges work as soon as Stripe finishes verification.' },
  incomplete: { tone: 'warn', title: 'Stripe form not finished',     body: 'You left the Stripe form before submitting. Click Connect Stripe again to resume - your account is saved.' },
  no_key:     { tone: 'err',  title: 'Stripe isn\'t configured yet', body: 'Your STRIPE_SECRET_KEY env var is missing. Skip this step for now - you can connect Stripe later from Finance.' },
  bad_key:    { tone: 'err',  title: 'Stripe rejected the API key',  body: 'The STRIPE_SECRET_KEY in Vercel isn\'t a valid Stripe secret key. Skip for now - you can connect later.' },
  connect_not_enabled: { tone: 'err', title: 'Stripe Connect isn\'t enabled', body: 'Visit dashboard.stripe.com/connect/accounts/overview and click "Get started", then come back. Skip for now if you want.' },
  wrong_mode: { tone: 'err',  title: 'Stripe mode mismatch',         body: 'A Stripe account from a different mode is saved. Open Finance after onboarding to disconnect + reconnect.' },
  unsupported_country: { tone: 'err', title: 'Country not supported yet', body: 'Ivy OS currently only supports US Stripe accounts. Email hello@getivyos.com to enable your region.' },
  error:      { tone: 'err',  title: 'Couldn\'t finish the Stripe step', body: 'Something went wrong. You can skip this and try again from Finance once you\'re in.' },
};
function StripeBounceBanner({ search, nav }) {
  const params = new URLSearchParams(search);
  const status  = params.get('stripe');         // connected | pending | incomplete | error
  const errCode = params.get('stripeError');    // no_key | bad_key | …
  const code = errCode || status;
  if (!code) return null;
  const info = STRIPE_BOUNCE_MSGS[code] || STRIPE_BOUNCE_MSGS.error;
  const detail = params.get('detail') || params.get('stripeMsg') || '';
  const dismiss = () => nav('/onboarding', { replace: true });
  const palette = {
    ok:   { bg: 'rgba(58,141,68,0.12)',  border: 'rgba(58,141,68,0.35)',  fg: 'var(--ok)' },
    warn: { bg: 'rgba(214,158,46,0.12)', border: 'rgba(214,158,46,0.35)', fg: 'var(--warn)' },
    err:  { bg: 'rgba(214,88,80,0.12)',  border: 'rgba(214,88,80,0.35)',  fg: 'var(--danger)' },
  }[info.tone];
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 10, marginBottom: 14,
      background: palette.bg, border: '1px solid ' + palette.border,
      display: 'flex', alignItems: 'flex-start', gap: 10,
    }}>
      <div style={{ marginTop: 1, color: palette.fg, fontWeight: 700, fontSize: 14, minWidth: 16 }}>
        {info.tone === 'ok' ? '✓' : info.tone === 'warn' ? '!' : '×'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' }}>{info.title}</div>
        <div style={{ marginTop: 2, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>{info.body}</div>
        {detail && (
          <details style={{ marginTop: 4, fontSize: 11.5, color: 'var(--muted)' }}>
            <summary style={{ cursor: 'pointer' }}>Technical detail</summary>
            <code style={{ display: 'block', marginTop: 4, padding: 6, background: 'var(--surface-2)', borderRadius: 6, wordBreak: 'break-word' }}>{detail}</code>
          </details>
        )}
      </div>
      <button onClick={dismiss} aria-label="Dismiss"
        style={{
          flexShrink: 0, padding: '4px 8px', fontSize: 11, cursor: 'pointer',
          background: 'transparent', color: 'var(--muted)',
          border: '1px solid var(--border)', borderRadius: 6,
        }}>Dismiss</button>
    </div>
  );
}
