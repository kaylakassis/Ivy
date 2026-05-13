// /onboarding — the universal save-and-resume setup wizard.
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
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';
import { useAuth } from '../../lib/auth.jsx';
import { publicOrigin } from '../../lib/publicUrl.js';
import { CATEGORIES, SERVICE_PACKS } from '../../lib/categories.js';

const STEPS = [
  { id: 'welcome',      label: 'Welcome',         optional: false },
  { id: 'business',     label: 'Business',        optional: false },
  { id: 'services',     label: 'Services',        optional: false },
  { id: 'availability', label: 'Availability',    optional: false },
  { id: 'payments',     label: 'Payments',        optional: true  },
  { id: 'branding',     label: 'Branding',        optional: true  },
  { id: 'first_client', label: 'First client',    optional: true  },
  { id: 'website',      label: 'Website',         optional: true  },
  { id: 'tour',         label: 'Quick tour',      optional: false },
  { id: 'done',         label: 'Done',            optional: false },
];

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
  const nav = useNavigate();

  // Navigational state — synced to /api/onboarding/state. completedSteps
  // grows as the owner advances; skippedSteps tracks explicit "do this
  // later" actions; currentStep is the step the resume-on-signin path
  // jumps to.
  const [stateLoaded, setStateLoaded] = useState(false);
  const [currentStep, setCurrentStep] = useState('welcome');
  const [completedSteps, setCompletedSteps] = useState([]);
  const [skippedSteps, setSkippedSteps]     = useState([]);

  // Form state — pre-filled from existing settings on mount so re-
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
    ]).then(([stateRes, calRes, clientsRes, stripeRes, webRes]) => {
      if (!live) return;
      const st = stateRes?.state;
      if (st) {
        setCurrentStep(st.currentStep || 'welcome');
        setCompletedSteps(st.completedSteps || []);
        setSkippedSteps(st.skippedSteps || []);
      }
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
  // below — that's the path a click on "Let's go" goes through. This
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

  const stepIdx = STEPS.findIndex((s) => s.id === currentStep);
  const stepSpec = STEPS[stepIdx] || STEPS[0];

  // Persists the nav state synchronously and ONLY advances the wizard
  // when the server confirms. If the PATCH fails (cold-start migration
  // failure, network blip, anything), the user sees a real error and
  // can retry — not a silent "looked like it worked, didn't actually."
  const flushAndAdvance = async ({ markCompleted, markSkipped }) => {
    const nextCompleted = markCompleted
      ? Array.from(new Set([...completedSteps, currentStep]))
      : completedSteps.filter((s) => s !== currentStep);
    const nextSkipped = markSkipped
      ? Array.from(new Set([...skippedSteps, currentStep]))
      : skippedSteps.filter((s) => s !== currentStep);
    const next = STEPS[stepIdx + 1];
    const nextStepId = next ? next.id : currentStep;

    setBusy(true); setErr(null);
    try {
      // Retry once on transient failure. Cold-started serverless
      // functions can blip while ensureSchemaApplied runs the full
      // migration on the first hit; a second attempt usually lands
      // post-bootstrap.
      const body = {
        currentStep: nextStepId,
        completedSteps: nextCompleted,
        skippedSteps: nextSkipped,
      };
      try {
        await api.patch('/onboarding/state', body);
      } catch (firstErr) {
        await new Promise((r) => setTimeout(r, 600));
        await api.patch('/onboarding/state', body);
      }
      setCompletedSteps(nextCompleted);
      setSkippedSteps(nextSkipped);
      if (next) setCurrentStep(next.id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[onboarding] flushAndAdvance failed:', e);
      setErr("Couldn't save your progress — please try again, or refresh and continue.");
    } finally {
      setBusy(false);
    }
  };

  const goNext = () => flushAndAdvance({ markCompleted: true,  markSkipped: false });
  const skipStep = () => flushAndAdvance({ markCompleted: false, markSkipped: true });
  const goBack = () => {
    const prev = STEPS[stepIdx - 1];
    if (prev) setCurrentStep(prev.id);
  };

  // "Save & exit" — flushes state and bounces to dashboard WITHOUT
  // marking onboarded_at. The next sign-in detects un-onboarded and
  // routes back to /onboarding, picking up at currentStep.
  const saveAndExit = async () => {
    setBusy(true);
    try {
      await api.patch('/onboarding/state', {
        currentStep, completedSteps, skippedSteps,
      });
    } catch { /* still bounce — best effort */ }
    finally {
      setExitedAt(Date.now());
      nav('/dashboard?onboarding=resume', { replace: true });
    }
  };

  // "Finish" — marks workspaces.onboarded_at + bounces. Final step CTA.
  const finish = async () => {
    setBusy(true); setErr(null);
    try {
      // Capture final state first so the dashboard checklist knows
      // exactly which steps were skipped.
      await api.patch('/onboarding/state', {
        currentStep: 'done',
        completedSteps: Array.from(new Set([...completedSteps, currentStep, 'done'])),
        skippedSteps,
      });
      await api.post('/onboarding/complete');
      nav('/dashboard?walkthrough=1', { replace: true });
    } catch (e) { setErr(prettifyError(e)); setBusy(false); }
  };

  // ─── Per-step save helpers ──────────────────────────────────────────
  // Each writes to its real API + advances the wizard. Saving is
  // idempotent — re-clicking Continue doesn't duplicate work.

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

  const saveServices = async () => {
    setBusy(true); setErr(null);
    try {
      await api.put('/calendar/services', { services });
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
      <ProgressRow steps={STEPS} currentStep={currentStep} completed={completedSteps} skipped={skippedSteps}
        onJump={(id) => {
          // Allow jumping to any step that's already been visited
          // (completed OR skipped OR ≤ currentIdx). Future steps stay
          // gated until the owner gets there normally.
          const targetIdx = STEPS.findIndex((s) => s.id === id);
          const visited = completedSteps.includes(id) || skippedSteps.includes(id) || targetIdx <= stepIdx;
          if (visited) setCurrentStep(id);
        }}/>

      <div className="card" style={{
        padding: '32px 36px', marginTop: 18,
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        {currentStep === 'welcome'      && <WelcomeStep user={user}/>}
        {currentStep === 'business'     && <BusinessStep
          bizName={bizName} setBizName={setBizName}
          slug={slug} setSlug={setSlug} setSlugTouched={setSlugTouched}
          tagline={tagline} setTagline={setTagline}
          category={category} setCategory={setCategory}/>}
        {currentStep === 'services'     && <ServicesStep
          services={services} setServices={setServices}
          draft={draft} setDraft={setDraft} category={category}/>}
        {currentStep === 'availability' && <AvailabilityStep
          availability={availability} setAvailability={setAvailability}/>}
        {currentStep === 'payments'     && <PaymentsStep stripeStatus={stripeStatus} setStripeStatus={setStripeStatus}/>}
        {currentStep === 'branding'     && <BrandingStep branding={branding} setBranding={setBranding}/>}
        {currentStep === 'first_client' && <FirstClientStep clientDraft={clientDraft} setClientDraft={setClientDraft}
          clientsCount={clientsCount}/>}
        {currentStep === 'website'      && <WebsiteStep websiteStatus={websiteStatus}/>}
        {currentStep === 'tour'         && <TourStep/>}
        {currentStep === 'done'         && <DoneStep skippedCount={skippedSteps.length}/>}

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.10)', border: '1px solid rgba(155,44,44,0.30)',
            color: 'var(--danger)', fontSize: 13,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          {stepIdx > 0 && stepIdx < STEPS.length - 1 && (
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
              if (currentStep === 'services')     return saveServices();
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

function WelcomeStep({ user }) {
  const name = (user?.name || '').split(/\s+/)[0] || 'there';
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
      <p style={{ color: 'var(--muted)', fontSize: 14.5, lineHeight: 1.6, maxWidth: 520, margin: '0 auto' }}>
        Let's get THRYVE working for your business. We'll set up the basics
        in 10 quick steps — your business profile, services, availability,
        payments, branding, your first client, and your website.
        <br/><br/>
        <strong>Auto-saves at every step</strong> — close the tab anytime and we'll
        pick up where you left off. You can also skip any step you're not
        ready for; we'll remind you later.
      </p>
    </div>
  );
}

function BusinessStep({ bizName, setBizName, slug, setSlug, setSlugTouched, tagline, setTagline, category, setCategory }) {
  return (
    <>
      <StepHeader title="What's your business?"
        subtitle="The basics — clients see this on your booking page and in any reviews."/>
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
            We've got a starter pack for {category} — load it as a starting point?
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
      return { ...prev, [idx]: [{ ...cur, [field]: val }] };
    });
  };
  const fmt = (m) => {
    const h = Math.floor(m / 60), mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  const parse = (s) => {
    const [h, m] = String(s || '').split(':').map((x) => parseInt(x, 10));
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };

  return (
    <>
      <StepHeader title="When are you available?"
        subtitle="Pick the weekdays you take bookings + your working window. Override per-day later from Calendar → Availability."/>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {WEEKDAYS.map((d) => {
          const win = availability[d.idx]?.[0];
          const on = !!win;
          return (
            <div key={d.idx} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '8px 12px', borderRadius: 8,
              background: on ? 'var(--surface-2)' : 'transparent',
              border: '1px solid ' + (on ? 'var(--border)' : 'transparent'),
            }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 90 }}>
                <input type="checkbox" checked={on} onChange={() => toggleDay(d.idx)}/>
                {d.long}
              </label>
              {on && (
                <>
                  <input type="time" value={fmt(win.start)}
                    onChange={(e) => updateWindow(d.idx, 'start', parse(e.target.value))}
                    style={{ ...inputStyle, padding: '6px 8px', width: 110 }}/>
                  <span style={{ color: 'var(--muted)' }}>→</span>
                  <input type="time" value={fmt(win.end)}
                    onChange={(e) => updateWindow(d.idx, 'end', parse(e.target.value))}
                    style={{ ...inputStyle, padding: '6px 8px', width: 110 }}/>
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
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
                Stripe is still verifying. You can keep setting up THRYVE; charges work as soon as verification finishes.
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 14 }}>
              Stripe handles the cards. Connect once — funds settle to your own bank account.
            </div>
            <a href="/api/finance/stripe-oauth-init" className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}>
              <Icons.Spark size={13} sw={1.8}/> Connect Stripe
            </a>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Takes ~3 minutes. We never see your bank info — it goes direct to Stripe.
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
        subtitle="Logo + an accent color so your booking page, invoices, and emails feel branded. Both optional — defaults look great too."/>
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
          ? `You already have ${clientsCount} client${clientsCount === 1 ? '' : 's'}! Add another, or skip — we'll keep going.`
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
        subtitle="Pick a template, drag-edit your sections, and publish in 10 minutes. Skip if you already have a site — you can embed a THRYVE booking widget onto it instead."/>
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
              Templates included — Clean, Modern, Lush, Lean.
              Build at <code style={{ background: 'var(--surface)', padding: '1px 5px', borderRadius: 4, fontSize: 12.5 }}>/website</code> any time.
            </div>
            <a href="/website" target="_blank" rel="noreferrer" className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}>
              <Icons.Arrow size={13} sw={1.8}/> Open Website builder
            </a>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Opens in a new tab so you can keep this onboarding open. Hit "Continue" here once you've published — or "Skip for now" if you already have a site.
            </div>
          </>
        )}
      </div>
    </>
  );
}

function TourStep() {
  const stops = [
    { tab: 'Dashboard', icon: 'Home',     desc: 'The home page. Today\'s bookings, revenue this month, unread messages — at a glance.' },
    { tab: 'Clients',   icon: 'Users',    desc: 'Every client + lead. Add, search, tag, drop notes. Click into a profile for their bookings + invoices.' },
    { tab: 'Calendar',  icon: 'Calendar', desc: 'Schedule. Click any slot to add a booking. Share drawer copies your booking link + QR.' },
    { tab: 'Finance',   icon: 'Dollar',   desc: 'Invoices, quotes, expenses, time tracking, memberships, gift cards. Year-end CSV export under "Export ▾".' },
    { tab: 'Messages',  icon: 'Chat',     desc: 'Text + email threads with each client. Voice memos auto-transcribe.' },
    { tab: 'Documents', icon: 'Doc',      desc: 'Contracts + intake forms. Send for e-signature, audit trail included.' },
    { tab: 'Workflows', icon: 'Spark',    desc: 'Automate follow-ups — birthday emails, win-back nudges, new-lead sequences. Build from /workflows.' },
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

function DoneStep({ skippedCount }) {
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
        Everything's wired up. Hit Finish to land on your dashboard.
        {skippedCount > 0 && (
          <>
            <br/><br/>
            You skipped {skippedCount} step{skippedCount === 1 ? '' : 's'} — they'll
            stay in the "Finish setup" checklist on your dashboard so you can come
            back when you're ready.
          </>
        )}
      </p>
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
