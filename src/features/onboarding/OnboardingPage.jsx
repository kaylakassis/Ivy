// /onboarding — first-run wizard for new business owners.
//
// Five steps, each saves on advance so closing mid-wizard doesn't lose work:
//   1. Welcome
//   2. Your business — name, slug, category, tagline
//   3. Services — starter pack per category + ability to add/remove
//   4. Availability — pick weekly windows; defaults to Mon–Fri 9-5
//   5. You're set — booking link copy, install PWA hint, what's next
//
// Final "Finish" sets workspaces.onboarded_at via /api/onboarding/complete
// and bounces to /dashboard.
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';
import { useAuth } from '../../lib/auth.jsx';

const STEPS = [
  { id: 'welcome',      label: 'Welcome' },
  { id: 'business',     label: 'Your business' },
  { id: 'services',     label: 'Services' },
  { id: 'availability', label: 'Availability' },
  { id: 'done',         label: "You're set" },
];

const CATEGORIES = [
  { id: 'Wellness',     label: 'Wellness',     icon: 'Spark',  hint: 'Massage, acupuncture, energy work' },
  { id: 'Beauty',       label: 'Beauty',       icon: 'Gift',   hint: 'Hair, nails, skin, brows, lashes' },
  { id: 'Fitness',      label: 'Fitness',      icon: 'Trending', hint: 'Personal training, yoga, pilates' },
  { id: 'Health',       label: 'Health',       icon: 'Check',  hint: 'Therapy, nutrition, coaching' },
  { id: 'Professional', label: 'Professional', icon: 'Doc',    hint: 'Consulting, design, freelance work' },
];

// Starter packs the wizard offers when a category is picked. The user
// can add any subset to their workspace in one click. Prices are
// placeholders — we want them tweaked, not blindly accepted.
const SERVICE_PACKS = {
  Wellness: [
    { name: '60-min massage',  durationMinutes: 60, price: 120 },
    { name: '90-min massage',  durationMinutes: 90, price: 170 },
    { name: 'Initial consult', durationMinutes: 30, price: 0 },
  ],
  Beauty: [
    { name: 'Cut & style',  durationMinutes: 60, price: 90 },
    { name: 'Color',        durationMinutes: 120, price: 180 },
    { name: 'Manicure',     durationMinutes: 45, price: 50 },
  ],
  Fitness: [
    { name: '60-min training session', durationMinutes: 60, price: 95 },
    { name: 'Group class',             durationMinutes: 60, price: 25 },
    { name: 'Free consultation',       durationMinutes: 30, price: 0 },
  ],
  Health: [
    { name: 'Initial intake',     durationMinutes: 60, price: 150 },
    { name: 'Follow-up session',  durationMinutes: 50, price: 120 },
    { name: 'Discovery call',     durationMinutes: 20, price: 0 },
  ],
  Professional: [
    { name: 'Discovery call',     durationMinutes: 30, price: 0 },
    { name: '60-min consult',     durationMinutes: 60, price: 200 },
    { name: 'Strategy workshop',  durationMinutes: 120, price: 600 },
  ],
};

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

  // Form state — pulled from existing settings so re-entering doesn't blow away.
  const [bizName, setBizName] = useState('');
  const [slug, setSlug]       = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [tagline, setTagline] = useState('');
  const [category, setCategory] = useState(null);
  const [services, setServices] = useState([]);
  const [draft, setDraft] = useState({ name: '', durationMinutes: 60, price: '' });
  const [availability, setAvailability] = useState(DEFAULT_AVAIL);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/calendar')
      .then((r) => {
        if (!live) return;
        const s = r.cal?.settings || {};
        if (s.bizName && s.bizName !== 'My business') setBizName(s.bizName);
        if (s.slug)     { setSlug(s.slug); setSlugTouched(true); }
        if (s.tagline)  setTagline(s.tagline);
        if (s.category) setCategory(s.category);
        if (Array.isArray(r.cal?.services) && r.cal.services.length > 0) {
          setServices(r.cal.services);
        }
        if (s.availability && Object.keys(s.availability).length > 0) {
          setAvailability(s.availability);
        }
      })
      .catch(() => { /* fresh workspace — fine */ });
    return () => { live = false; };
  }, []);

  // Auto-suggest a slug from the business name until the user types one.
  useEffect(() => {
    if (slugTouched) return;
    setSlug(slugify(bizName));
  }, [bizName, slugTouched]);

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  // ---- Per-step save helpers ----

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
      next();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  const saveServices = async () => {
    setBusy(true); setErr(null);
    try {
      // Always PUT — server replaces the list in one shot. Pass the
      // current services array even if empty so a user who removed
      // everything has the empty state respected.
      await api.put('/calendar/services', { services });
      next();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  const saveAvailability = async () => {
    setBusy(true); setErr(null);
    try {
      await api.patch('/calendar', { availability });
      next();
    } catch (e) { setErr(prettifyError(e)); }
    finally { setBusy(false); }
  };

  const finish = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/onboarding/complete');
      nav('/dashboard?walkthrough=1', { replace: true });
    } catch (e) { setErr(prettifyError(e)); setBusy(false); }
  };

  const skipAll = async () => {
    setBusy(true);
    try { await api.post('/onboarding/complete'); }
    finally { nav('/dashboard', { replace: true }); }
  };

  return (
    <div className={`app-root dir-${tweaks.direction}`}
      style={{ minHeight: '100vh', background: 'var(--page)', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
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
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Step {step + 1} of {STEPS.length}
        </span>
        <button onClick={skipAll} disabled={busy}
          className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
          Skip for now
        </button>
      </div>

      {/* Progress bar */}
      <div style={{ padding: '14px 24px 0' }}>
        <div style={{ height: 4, borderRadius: 99, background: 'var(--border)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${((step + 1) / STEPS.length) * 100}%`,
            background: 'var(--accent)', transition: 'width .3s ease',
          }}/>
        </div>
        <div className="onboard-step-labels" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          {STEPS.map((s, i) => (
            <div key={s.id} style={{
              fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
              color: i <= step ? 'var(--accent)' : 'var(--muted)',
            }}>
              {s.label}
            </div>
          ))}
        </div>
      </div>

      {/* Step body */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '32px 24px',
      }}>
        <div className="card" style={{
          width: '100%', maxWidth: 600, padding: 32,
          display: 'flex', flexDirection: 'column', gap: 18,
        }}>
          {step === 0 && <Welcome user={user} onNext={next}/>}
          {step === 1 && (
            <Business
              bizName={bizName} setBizName={setBizName}
              slug={slug} setSlug={(v) => { setSlug(v); setSlugTouched(true); }}
              tagline={tagline} setTagline={setTagline}
              category={category} setCategory={setCategory}
              onBack={back} onSave={saveBusiness} busy={busy}
            />
          )}
          {step === 2 && (
            <Services
              services={services} setServices={setServices}
              category={category}
              draft={draft} setDraft={setDraft}
              onBack={back} onSave={saveServices} busy={busy}
            />
          )}
          {step === 3 && (
            <Availability
              availability={availability} setAvailability={setAvailability}
              onBack={back} onSave={saveAvailability} busy={busy}
            />
          )}
          {step === 4 && (
            <Done slug={slug} bizName={bizName} servicesCount={services.length}
              onFinish={finish} onBack={back} busy={busy}/>
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
  const first = user?.name ? user.name.split(' ')[0] : null;
  return (
    <>
      <div style={{
        width: 64, height: 64, borderRadius: 16, alignSelf: 'center',
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Spark size={32} sw={1.8}/></div>
      <div style={{ textAlign: 'center' }}>
        <h1 className="page-title" style={{ margin: 0, fontSize: 28, letterSpacing: '-0.02em' }}>
          Welcome to THRYVE{first ? `, ${first}` : ''}.
        </h1>
        <p style={{ margin: '12px auto 0', fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.6, maxWidth: 460 }}>
          Three minutes to set up the basics — your business, your services,
          and when you're available. We'll prefill what we can. Everything
          changes anytime.
        </p>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 10, marginTop: 4,
      }}>
        <Bullet icon="Calendar" label="Bookings" hint="Public link · auto-confirmations"/>
        <Bullet icon="Dollar"   label="Invoices" hint="Stripe checkout · refunds"/>
        <Bullet icon="Spark"    label="Ivy"      hint="AI coach on your data"/>
      </div>

      <button onClick={onNext} className="btn btn-primary"
        style={{ justifyContent: 'center', padding: '12px 14px', alignSelf: 'stretch', marginTop: 8 }}>
        Let's go <Icons.Arrow size={14} sw={2}/>
      </button>
    </>
  );
}
function Bullet({ icon, label, hint }) {
  const Icon = Icons[icon] || Icons.Check;
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <Icon size={16} sw={1.7} stroke="var(--accent)"/>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>{hint}</div>
    </div>
  );
}

// ---- Step 1: Business name + slug + tagline + category ----
function Business({ bizName, setBizName, slug, setSlug, tagline, setTagline,
                    category, setCategory, onBack, onSave, busy }) {
  const origin = (typeof window !== 'undefined' ? window.location.origin : '');
  const validSlug = /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug || '');
  const canSave = !busy && bizName.trim().length > 0 && validSlug;

  return (
    <>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 22 }}>Tell us about your business.</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          Drives your booking page, your invoices, and Ivy's recommendations.
        </p>
      </div>

      <Field label="Business name">
        <input value={bizName} onChange={(e) => setBizName(e.target.value)}
          placeholder="e.g. Maple Massage Therapy" autoFocus style={inputS}/>
      </Field>

      <Field label="Your booking link"
        hint="Lowercase letters, numbers, and dashes — 2–40 characters.">
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
      </Field>

      <Field label="What do you do?" hint="Drives Ivy's coaching tone and which sample services we suggest next.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
          {CATEGORIES.map((c) => {
            const Icon = Icons[c.icon] || Icons.Check;
            const active = category === c.id;
            return (
              <button key={c.id} type="button" onClick={() => setCategory(c.id)}
                style={{
                  padding: 12, borderRadius: 10, textAlign: 'left',
                  background: active ? 'color-mix(in srgb, var(--accent-soft) 60%, var(--surface))' : 'var(--surface-2)',
                  border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
                  cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                <Icon size={15} sw={1.7} stroke={active ? 'var(--accent)' : 'var(--fg-2)'}/>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>{c.hint}</div>
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Tagline (optional)" hint="One short line above your services on the booking page.">
        <input value={tagline} onChange={(e) => setTagline(e.target.value.slice(0, 140))}
          placeholder="Therapeutic massage in downtown Portland" style={inputS}/>
      </Field>

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
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

// ---- Step 2: Services with starter pack ----
function Services({ services, setServices, category, draft, setDraft, onBack, onSave, busy }) {
  const pack = (category && SERVICE_PACKS[category]) || [];
  const isInList = (name) => services.some((s) => s.name.toLowerCase() === name.toLowerCase());

  const addStarter = (s) => {
    if (isInList(s.name)) return;
    setServices((xs) => [...xs, { ...s }]);
  };
  const addAllStarters = () => {
    setServices((xs) => {
      const next = [...xs];
      for (const s of pack) {
        if (!next.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) next.push({ ...s });
      }
      return next;
    });
  };
  const addCustom = () => {
    const name = draft.name.trim();
    const dur  = Number(draft.durationMinutes);
    const price = Number(draft.price || 0);
    if (!name || !Number.isInteger(dur) || dur <= 0) return;
    setServices((xs) => [...xs, { name, durationMinutes: dur, price }]);
    setDraft({ name: '', durationMinutes: 60, price: '' });
  };

  return (
    <>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 22 }}>What can clients book?</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          Add a few — pick from the starter pack, or write your own. Tweak names and prices anytime.
        </p>
      </div>

      {pack.length > 0 && (
        <div style={{
          padding: 14, borderRadius: 10,
          background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--surface-2))',
          border: '1px solid var(--accent)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icons.Spark size={14} sw={1.8} stroke="var(--accent)"/>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Starter pack · {category}
            </span>
            <button onClick={addAllStarters} type="button"
              style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--accent)', background: 'transparent', border: 0, cursor: 'pointer', fontWeight: 600 }}>
              Add all
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pack.map((s, i) => {
              const used = isInList(s.name);
              return (
                <button key={i} type="button" onClick={() => addStarter(s)} disabled={used}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '8px 10px', borderRadius: 8, textAlign: 'left',
                    background: used ? 'transparent' : 'var(--surface)',
                    border: '1px solid ' + (used ? 'transparent' : 'var(--border)'),
                    cursor: used ? 'default' : 'pointer',
                    opacity: used ? 0.55 : 1,
                  }}>
                  <span style={{ fontSize: 13, fontWeight: 550, flex: 1 }}>{s.name}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.durationMinutes} min</span>
                  <span style={{ fontSize: 12, color: 'var(--fg-2)', fontWeight: 600, minWidth: 44, textAlign: 'right' }}>
                    {s.price > 0 ? `$${s.price}` : 'Free'}
                  </span>
                  {used
                    ? <Icons.Check size={12} sw={2.4} stroke="var(--ok)"/>
                    : <Icons.Plus size={12} sw={2} stroke="var(--accent)"/>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {services.length > 0 && (
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Your services ({services.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {services.map((s, i) => (
              <div key={s.id || i} style={{
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
        </div>
      )}

      <div style={{
        padding: 14, borderRadius: 10, background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Add a custom service
        </div>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Service name" style={inputS}/>
        <div className="form-2col" style={{ gap: 8 }}>
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
        <button onClick={addCustom} disabled={!draft.name.trim()}
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

// ---- Step 3: Weekly availability ----
function Availability({ availability, setAvailability, onBack, onSave, busy }) {
  // Render-friendly state derived from availability map.
  const isOn = (day) => Array.isArray(availability[day]) && availability[day].length > 0;
  const window = (day) => (availability[day] && availability[day][0]) || { start: 540, end: 1020 };

  const toggle = (day) => {
    setAvailability((prev) => {
      const next = { ...prev };
      if (next[day]) delete next[day];
      else next[day] = [{ start: 540, end: 1020 }];
      return next;
    });
  };
  const setRange = (day, key, value) => {
    setAvailability((prev) => {
      const cur = prev[day]?.[0] || { start: 540, end: 1020 };
      return { ...prev, [day]: [{ ...cur, [key]: Number(value) }] };
    });
  };

  return (
    <>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 22 }}>When are you open?</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          Default is Monday–Friday, 9 AM–5 PM. Toggle days off and adjust hours.
          You can add multiple windows per day later from calendar settings.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {WEEKDAYS.map((d) => {
          const on = isOn(d.idx);
          const w = window(d.idx);
          return (
            <div key={d.idx} style={{
              padding: '10px 12px', borderRadius: 10,
              background: on ? 'var(--surface)' : 'var(--surface-2)',
              border: '1px solid ' + (on ? 'var(--border-strong)' : 'var(--border)'),
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <button type="button" onClick={() => toggle(d.idx)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '4px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: 'transparent', border: 0, cursor: 'pointer',
                  color: on ? 'var(--fg)' : 'var(--muted)', minWidth: 90,
                }}>
                <span style={{
                  display: 'inline-block', width: 14, height: 14, borderRadius: 4,
                  background: on ? 'var(--accent)' : 'transparent',
                  border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border-strong)'),
                  position: 'relative',
                }}>
                  {on && (
                    <span style={{
                      position: 'absolute', inset: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--accent-ink)', fontSize: 10, fontWeight: 800,
                    }}>✓</span>
                  )}
                </span>
                {d.short}
              </button>
              {on ? (
                <>
                  <TimeSelect value={w.start} onChange={(v) => setRange(d.idx, 'start', v)}/>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
                  <TimeSelect value={w.end}   onChange={(v) => setRange(d.idx, 'end', v)}/>
                </>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Closed</span>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button onClick={onBack} type="button" className="btn btn-outline"
          style={{ flex: 1, justifyContent: 'center' }}>Back</button>
        <button onClick={onSave} type="button" className="btn btn-primary"
          disabled={busy}
          style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Continue'} {!busy && <Icons.Arrow size={14} sw={2}/>}
        </button>
      </div>
    </>
  );
}

function TimeSelect({ value, onChange }) {
  // 30-minute increments from 6 AM to 11:30 PM.
  const opts = [];
  for (let m = 6 * 60; m <= 23 * 60 + 30; m += 30) opts.push(m);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '6px 10px', borderRadius: 8, fontSize: 13,
        background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
        color: 'var(--fg)', outline: 'none', cursor: 'pointer',
      }}>
      {opts.map((m) => <option key={m} value={m}>{minToHM(m)}</option>)}
    </select>
  );
}
function minToHM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ---- Step 4: Done ----
function Done({ slug, bizName, servicesCount, onFinish, onBack, busy }) {
  const origin = (typeof window !== 'undefined' ? window.location.origin : '');
  const link = slug ? `${origin}/book/${slug}` : null;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  return (
    <>
      <div style={{
        width: 64, height: 64, borderRadius: 99, alignSelf: 'center',
        background: 'var(--ok)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Check size={32} sw={2.4}/></div>

      <div style={{ textAlign: 'center' }}>
        <h2 className="page-title" style={{ margin: 0, fontSize: 26 }}>You're set.</h2>
        <p style={{ margin: '10px auto 0', fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55, maxWidth: 460 }}>
          {bizName ? <strong>{bizName}</strong> : 'Your workspace'} is live with
          {' '}{servicesCount} service{servicesCount === 1 ? '' : 's'}. Share your booking
          link to take your first appointment.
        </p>
      </div>

      {link && (
        <div style={{
          padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)',
          border: '1px solid var(--border-strong)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Icons.Globe size={15} stroke="var(--accent)" sw={1.7}/>
          <code style={{
            fontSize: 13, color: 'var(--fg)', flex: 1, minWidth: 0,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{link}</code>
          <button onClick={copy} className="btn btn-outline"
            style={{ padding: '5px 12px', fontSize: 12 }}>
            {copied ? <><Icons.Check size={11} sw={2.4}/> Copied</> : 'Copy link'}
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <NextCard icon="Users" label="Add clients" hint="Bulk import from CSV."/>
        <NextCard icon="Spark" label="Meet Ivy"     hint="AI coach grounded in your numbers."/>
        <NextCard icon="Bell"  label="Notifications" hint="Push for messages, paid invoices, signed docs."/>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button onClick={onBack} type="button" className="btn btn-outline"
          style={{ flex: 1, justifyContent: 'center' }}>Back</button>
        <button onClick={onFinish} disabled={busy}
          className="btn btn-primary" style={{ flex: 2, justifyContent: 'center', padding: '12px 14px' }}>
          {busy ? 'Finishing…' : 'Open my dashboard'} {!busy && <Icons.Arrow size={14} sw={2}/>}
        </button>
      </div>
    </>
  );
}
function NextCard({ icon, label, hint }) {
  const Icon = Icons[icon] || Icons.Check;
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <Icon size={14} sw={1.7} stroke="var(--accent)"/>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>{hint}</div>
    </div>
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

function prettifyError(e) {
  const msg = e?.message || 'Something went wrong';
  // The api wrapper formats as "STATUS: detail" — strip the prefix for UI.
  return msg.replace(/^\d+:\s*/, '');
}
