// /onboarding — first-run wizard for new business owners. 4 small steps:
//   1. Welcome
//   2. Business name + booking-link slug
//   3. First service (skippable)
//   4. Done — quick links to import clients / share booking link
//
// Each step saves to its existing API endpoint as the user advances, so
// closing the tab mid-wizard doesn't lose work. Final "Finish" sets
// workspaces.onboarded_at via /api/onboarding/complete and bounces to
// /dashboard.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';
import { useAuth } from '../../lib/auth.jsx';

const STEPS = [
  { id: 'welcome',  label: 'Welcome' },
  { id: 'business', label: 'Your business' },
  { id: 'service',  label: 'First service' },
  { id: 'done',     label: 'You\'re set' },
];

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export default function OnboardingPage() {
  const [tweaks] = useTweaks();
  const { user } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState(0);

  // Load existing settings so we don't blow them away if the user comes
  // back to /onboarding later.
  const [bizName, setBizName] = useState('');
  const [slug, setSlug]       = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [services, setServices]       = useState([]);
  const [draftService, setDraftService] = useState({ name: '', durationMinutes: 60, price: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/calendar')
      .then((r) => {
        if (!live) return;
        const s = r.cal?.settings || {};
        if (s.bizName && s.bizName !== 'My business') setBizName(s.bizName);
        if (s.slug) { setSlug(s.slug); setSlugTouched(true); }
        if (Array.isArray(r.cal?.services)) setServices(r.cal.services);
      })
      .catch(() => { /* fine — fresh workspace */ });
    return () => { live = false; };
  }, []);

  // Auto-suggest a slug from the business name until the user types one.
  useEffect(() => {
    if (slugTouched) return;
    setSlug(slugify(bizName));
  }, [bizName, slugTouched]);

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const saveBusiness = async () => {
    setBusy(true); setErr(null);
    try {
      const trimmed = bizName.trim();
      const cleanSlug = slug.trim().toLowerCase();
      const patch = {};
      if (trimmed) patch.bizName = trimmed;
      if (cleanSlug) patch.slug = cleanSlug;
      if (Object.keys(patch).length > 0) await api.patch('/calendar', patch);
      next();
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  const addService = () => {
    const name = draftService.name.trim();
    const dur = Number(draftService.durationMinutes);
    const price = Number(draftService.price || 0);
    if (!name || !Number.isInteger(dur) || dur <= 0) return;
    setServices((xs) => [...xs, { name, durationMinutes: dur, price }]);
    setDraftService({ name: '', durationMinutes: 60, price: '' });
  };

  const saveServices = async () => {
    if (services.length === 0) { next(); return; }
    setBusy(true); setErr(null);
    try {
      await api.put('/calendar/services', { services });
      next();
    } catch (e) { setErr(e.message || 'Could not save services'); }
    finally { setBusy(false); }
  };

  const finish = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/onboarding/complete');
      nav('/dashboard', { replace: true });
    } catch (e) { setErr(e.message || 'Could not complete'); setBusy(false); }
  };

  const skipAll = async () => {
    setBusy(true);
    try { await api.post('/onboarding/complete'); }
    finally { nav('/dashboard', { replace: true }); }
  };

  return (
    <div className={`app-root dir-${tweaks.direction}`}
      style={{ minHeight: '100vh', background: 'var(--page)', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar — minimal: brand + skip */}
      <div style={{
        padding: '14px 24px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Logo size={20} color="currentColor"/></div>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 18 }}>thryve</span>
        <div style={{ flex: 1 }}/>
        <button onClick={skipAll} disabled={busy}
          className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
          Skip for now
        </button>
      </div>

      {/* Progress dots */}
      <div style={{
        padding: '20px 24px 0',
        display: 'flex', justifyContent: 'center', gap: 8,
      }}>
        {STEPS.map((s, i) => (
          <div key={s.id} title={s.label} style={{
            width: i === step ? 28 : 8, height: 8, borderRadius: 99,
            background: i <= step ? 'var(--accent)' : 'var(--border-strong)',
            transition: 'width .2s, background .2s',
          }}/>
        ))}
      </div>

      {/* Step body */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px',
      }}>
        <div className="card" style={{
          width: '100%', maxWidth: 540, padding: 32,
          display: 'flex', flexDirection: 'column', gap: 18,
        }}>
          {step === 0 && <Welcome user={user} onNext={next}/>}
          {step === 1 && (
            <Business
              bizName={bizName} setBizName={setBizName}
              slug={slug} setSlug={(v) => { setSlug(v); setSlugTouched(true); }}
              onBack={back} onSave={saveBusiness} busy={busy}
            />
          )}
          {step === 2 && (
            <FirstService
              services={services} setServices={setServices}
              draft={draftService} setDraft={setDraftService}
              addService={addService}
              onBack={back} onSave={saveServices} busy={busy}
            />
          )}
          {step === 3 && (
            <Done slug={slug} bizName={bizName}
              onFinish={finish} busy={busy}/>
          )}
          {err && (
            <div style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5,
            }}>{err}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Step 0: Welcome ----
function Welcome({ user, onNext }) {
  return (
    <>
      <div style={{
        width: 56, height: 56, borderRadius: 14, alignSelf: 'center',
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Spark size={28} sw={1.8}/></div>
      <div style={{ textAlign: 'center' }}>
        <h1 className="page-title" style={{ margin: 0, fontSize: 26 }}>
          Welcome to THRYVE{user?.name ? `, ${user.name.split(' ')[0]}` : ''}.
        </h1>
        <p style={{ margin: '10px 0 0', fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Two minutes to set up the basics — your business name, a booking link, and one service.
          You can change everything later.
        </p>
      </div>
      <button onClick={onNext} className="btn btn-primary"
        style={{ justifyContent: 'center', padding: '12px 14px', alignSelf: 'stretch' }}>
        Let's go <Icons.Arrow size={14} sw={2}/>
      </button>
    </>
  );
}

// ---- Step 1: Business name + booking slug ----
function Business({ bizName, setBizName, slug, setSlug, onBack, onSave, busy }) {
  const origin = (typeof window !== 'undefined' ? window.location.origin : '');
  const validSlug = /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug || '');
  const canSave = !busy && bizName.trim().length > 0 && validSlug;
  return (
    <>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 22 }}>Tell us about your business.</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          Both can change anytime from the calendar settings.
        </p>
      </div>

      <Field label="Business name">
        <input value={bizName} onChange={(e) => setBizName(e.target.value)}
          placeholder="e.g. Maple Massage Therapy" autoFocus style={inputS}/>
      </Field>

      <Field label="Your booking link"
        hint="Lowercase letters, numbers, and dashes. This is the URL you'll share with clients.">
        <div style={{
          display: 'flex', alignItems: 'stretch',
          border: '1px solid ' + (slug && !validSlug ? 'var(--danger)' : 'var(--border-strong)'),
          borderRadius: 10, overflow: 'hidden', background: 'var(--surface)',
        }}>
          <span style={{
            padding: '10px 12px', fontSize: 13, color: 'var(--muted)',
            background: 'var(--surface-2)', borderRight: '1px solid var(--border)',
            whiteSpace: 'nowrap',
          }}>{origin}/book/</span>
          <input value={slug} onChange={(e) => setSlug(e.target.value)}
            placeholder="your-business" autoCapitalize="off" autoCorrect="off" spellCheck="false"
            style={{ ...inputS, border: 0, padding: '10px 12px' }}/>
        </div>
        {slug && !validSlug && (
          <span style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 4 }}>
            Letters, numbers, and dashes only. 2–40 characters.
          </span>
        )}
      </Field>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onBack} type="button" className="btn btn-outline"
          style={{ flex: 1, justifyContent: 'center' }}>Back</button>
        <button onClick={onSave} type="button" className="btn btn-primary"
          disabled={!canSave}
          style={{ flex: 2, justifyContent: 'center', opacity: canSave ? 1 : 0.6 }}>
          {busy ? 'Saving…' : 'Continue'} {!busy && <Icons.Arrow size={14} sw={2}/>}
        </button>
      </div>
    </>
  );
}

// ---- Step 2: First service ----
function FirstService({ services, setServices, draft, setDraft, addService, onBack, onSave, busy }) {
  return (
    <>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 22 }}>Add your first service.</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          What do clients book with you for? You can add more later — or skip this step.
        </p>
      </div>

      {services.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {services.map((s, i) => (
            <div key={i} style={{
              padding: '10px 12px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{s.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {s.durationMinutes} min{s.price ? ` · $${Number(s.price).toFixed(0)}` : ''}
                </div>
              </div>
              <button onClick={() => setServices(services.filter((_, j) => j !== i))}
                className="btn btn-ghost" style={{ padding: 4, color: 'var(--muted)' }}>
                <Icons.X size={13}/>
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{
        padding: 14, borderRadius: 10, background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Service name (e.g. 60-min massage)" style={inputS}/>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Duration (min)">
            <input type="number" min={5} step={5} value={draft.durationMinutes}
              onChange={(e) => setDraft({ ...draft, durationMinutes: e.target.value })}
              style={inputS}/>
          </Field>
          <Field label="Price ($)">
            <input type="number" min={0} value={draft.price}
              onChange={(e) => setDraft({ ...draft, price: e.target.value })}
              placeholder="0" style={inputS}/>
          </Field>
        </div>
        <button onClick={addService} disabled={!draft.name.trim()}
          className="btn btn-outline" style={{ justifyContent: 'center', opacity: draft.name.trim() ? 1 : 0.5 }}>
          <Icons.Plus size={13} sw={2}/> Add to list
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onBack} type="button" className="btn btn-outline"
          style={{ flex: 1, justifyContent: 'center' }}>Back</button>
        <button onClick={onSave} type="button" className="btn btn-primary"
          disabled={busy}
          style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : services.length > 0 ? 'Continue' : 'Skip for now'}
          {!busy && <Icons.Arrow size={14} sw={2}/>}
        </button>
      </div>
    </>
  );
}

// ---- Step 3: Done ----
function Done({ slug, bizName, onFinish, busy }) {
  const origin = (typeof window !== 'undefined' ? window.location.origin : '');
  const link = slug ? `${origin}/book/${slug}` : null;
  return (
    <>
      <div style={{
        width: 56, height: 56, borderRadius: 99, alignSelf: 'center',
        background: 'var(--ok)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Check size={28} sw={2.4}/></div>

      <div style={{ textAlign: 'center' }}>
        <h2 className="page-title" style={{ margin: 0, fontSize: 24 }}>You're set.</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          {bizName ? <strong>{bizName}</strong> : 'Your workspace'} is live.
          Share your booking link to take your first appointment.
        </p>
      </div>

      {link && (
        <div style={{
          padding: 12, borderRadius: 10, background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Icons.Globe size={14} stroke="var(--muted)" sw={1.7}/>
          <code style={{
            fontSize: 12.5, color: 'var(--fg-2)', flex: 1, minWidth: 0,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{link}</code>
          <button onClick={() => navigator.clipboard?.writeText(link)}
            className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}>
            Copy
          </button>
        </div>
      )}

      <div style={{
        fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55,
        padding: 14, borderRadius: 10, background: 'var(--accent-soft)',
      }}>
        <strong style={{ color: 'var(--accent)' }}>What's next:</strong> add clients on the
        Clients tab, set your weekly availability under Calendar → Availability, and explore
        Ivy for AI-coached suggestions on what to focus on each week.
      </div>

      <button onClick={onFinish} disabled={busy}
        className="btn btn-primary" style={{ justifyContent: 'center', padding: '12px 14px' }}>
        {busy ? 'Finishing…' : 'Open my dashboard'} {!busy && <Icons.Arrow size={14} sw={2}/>}
      </button>
    </>
  );
}

const inputS = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  border: '1px solid var(--border-strong)', background: 'var(--surface)',
  outline: 'none', fontSize: 14, color: 'var(--fg)',
};

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 550, color: 'var(--fg-2)' }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{hint}</span>}
    </label>
  );
}
