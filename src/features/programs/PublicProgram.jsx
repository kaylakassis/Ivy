// /p/:id - the public sales page for a published program. Shows the
// outline (module and lesson titles, plus any free-preview lessons), the price, and a name + email form that sends
// the buyer to Stripe Checkout on the coach's account. Access is granted
// by the webhook after payment; the buyer then signs in to the client
// portal with the same email.
//
// The buy box also offers what the coach set up: a free trial on a
// subscription ("Start your N-day free trial"), a start date for cohort
// programs, an included or optional add-on package of sessions, and an
// "Apply a code" field checked by the server before checkout.
import React, { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';
import { Icons } from '../../components/Icons.jsx';
import { fmtPrice, billingLabel } from './ProgramContent.jsx';
import SalesOutline from './SalesOutline.jsx';
import ArchivedBusinessCard, { isArchivedError } from '../../components/ArchivedBusiness.jsx';

export default function PublicProgram() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [tweaks] = useTweaks();
  const [data, setData] = useState(null); const [err, setErr] = useState(null);
  // Coach's subscription lapsed: the API answers { archived, businessName }.
  const [archived, setArchived] = useState(null);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [busy, setBusy] = useState(false); const [formErr, setFormErr] = useState(null);
  const [cohortId, setCohortId] = useState(''); const [addOn, setAddOn] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false); const [code, setCode] = useState(''); const [coupon, setCoupon] = useState(null);
  const [codeErr, setCodeErr] = useState(null); const [codeBusy, setCodeBusy] = useState(false);
  const [fullPrice, setFullPrice] = useState(null);
  useEffect(() => {
    api.get(`/programs/public/${id}`)
      .then((r) => { if (r.archived) setArchived({ businessName: r.businessName }); else setData(r); })
      .catch((e) => setErr(e.message));
  }, [id]);
  const purchased = params.get('purchased') === '1';
  // Stripe cancel_url lands back here with ?cancelled=1 (api/programs/checkout.js).
  const [cancelled, setCancelled] = useState(() => params.get('cancelled') === '1');
  const applyCode = async () => {
    if (!code.trim()) return;
    setCodeBusy(true); setCodeErr(null);
    try { setCoupon(await api.post('/programs/coupon-check', { programId: id, code })); }
    catch (ex) { setCoupon(null); setCodeErr(ex.message); } finally { setCodeBusy(false); }
  };
  const buy = async (e) => {
    e.preventDefault(); setBusy(true); setFormErr(null);
    try {
      const r = await api.post('/programs/checkout', { programId: id, name, email, couponCode: coupon?.code || undefined, cohortId: cohortId || undefined, addOn: addOn || undefined });
      // A free trial was already used with this email: say so before the
      // buyer meets the full price on the checkout page.
      if (r.trialUsed) { setFullPrice(r.url); setBusy(false); return; }
      window.location.assign(r.url);
    }
    catch (ex) {
      if (isArchivedError(ex)) { setArchived({ businessName: data?.business?.name }); return; }
      setFormErr(ex.message); setBusy(false);
    }
  };
  const shell = (children) => (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', padding: '24px 16px 48px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>{children}</div>
    </div>
  );
  if (archived) return shell(<ArchivedBusinessCard businessName={archived.businessName}/>);
  if (err) return shell(<div className="card" style={{ padding: 24, textAlign: 'center' }}><div style={{ fontSize: 18, fontWeight: 600 }}>This program isn't available.</div><div style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 6 }}>{err}</div></div>);
  if (!data) return shell(<div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>);
  const { program, outline, business, currency } = data;
  const free = !program.priceCents;
  const trialDays = data.trialDays || null;
  const cohorts = Array.isArray(data.cohorts) ? data.cohorts : null;
  const closed = cohorts && cohorts.length === 0;
  const bundle = data.bundle || null;
  const subtotal = program.priceCents + (bundle?.mode === 'addon' && addOn ? bundle.priceCents : 0);
  const off = coupon ? Math.min(subtotal, coupon.kind === 'percent' ? Math.round((subtotal * coupon.percentOff) / 100) : coupon.amountOffCents) : 0;
  const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric' });
  return shell(<>
    <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>{business.name}</div>
    <div>
      <h1 className="page-title" style={{ margin: 0, fontSize: 34 }}>{program.title}</h1>
      {program.description && <p style={{ margin: '10px 0 0', fontSize: 15.5, lineHeight: 1.6, color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>{program.description}</p>}
    </div>
    {purchased ? (
      <div className="card" style={{ padding: 20, borderColor: 'var(--ok)' }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>You're in.</div>
        <div style={{ fontSize: 14, color: 'var(--fg-2)', marginTop: 6, lineHeight: 1.55 }}>Your payment went through. Sign in (or create a free client account) with the same email you used at checkout and the program will be waiting under <b>Programs</b>.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <Link to={`/signup?mode=client&next=${encodeURIComponent('/me/programs')}`} className="btn btn-primary">Create your account</Link>
          <Link to={`/signin?next=${encodeURIComponent('/me/programs')}`} className="btn btn-outline">Sign in</Link>
        </div>
      </div>
    ) : (<>
      {cancelled && (
        <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, color: 'var(--fg-2)' }}>
          <span style={{ flex: 1 }}>Checkout cancelled. Nothing was charged. You can try again whenever you're ready.</span>
          <button type="button" onClick={() => setCancelled(false)} aria-label="Dismiss" className="btn btn-ghost" style={{ padding: 2, color: 'var(--muted)' }}>
            <Icons.X size={13}/>
          </button>
        </div>
      )}
      <form onSubmit={buy} className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          {off > 0 && <span style={{ fontSize: 18, color: 'var(--muted)', textDecoration: 'line-through' }}>{fmtPrice(subtotal, currency)}</span>}
          <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-.02em' }}>{free ? 'Free' : fmtPrice(subtotal - off, currency)}</span>
          {!free && <span style={{ color: 'var(--muted)', fontSize: 14 }}>{billingLabel(program.billing)}{off > 0 && program.billing !== 'one_time' && coupon?.duration !== 'forever' ? ' for the first payment' : ''}</span>}
        </div>
        {!free && trialDays && <div style={{ fontSize: 14, color: 'var(--fg-2)' }}><b>{trialDays}-day free trial.</b> You are not charged until it ends, and you can cancel before then.</div>}
        {!free && bundle?.mode === 'included' && (
          <div style={{ fontSize: 13.5, color: 'var(--fg-2)', display: 'flex', gap: 8, alignItems: 'center' }}><Icons.Gift size={14}/> Includes {bundle.name}: {bundle.sessions} session{bundle.sessions === 1 ? '' : 's'} with {business.name}.</div>
        )}
        {free ? (
          <div style={{ fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5 }}>This program is free. Ask {business.name} to add you and it will appear in your client portal.</div>
        ) : (<>
          {cohorts && (closed ? (
            <div style={{ fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5 }}>Enrollment is closed right now. Check back soon for the next start date.</div>
          ) : cohorts.length === 1 ? (
            <div style={{ fontSize: 14, color: 'var(--fg-2)', display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ flexShrink: 0, display: 'inline-flex' }}><Icons.Calendar size={14}/></span> Next group starts {fmtDate(cohorts[0].startDate)}{cohorts[0].spotsLeft != null ? ` · ${cohorts[0].spotsLeft} spot${cohorts[0].spotsLeft === 1 ? '' : 's'} left` : ''}</div>
          ) : (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--fg-2)' }}>Start date
              <select className="input" value={cohortId || cohorts[0].id} onChange={(e) => setCohortId(e.target.value)}>
                {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name}: starts {fmtDate(c.startDate)}{c.spotsLeft != null ? ` (${c.spotsLeft} left)` : ''}</option>)}
              </select>
            </label>
          ))}
          {bundle?.mode === 'addon' && !closed && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={addOn} onChange={(e) => setAddOn(e.target.checked)} style={{ marginTop: 3 }}/>
              <span><b>Add {bundle.name}</b> for {fmtPrice(bundle.priceCents, currency)}<span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{bundle.sessions} session{bundle.sessions === 1 ? '' : 's'} with {business.name}{bundle.expiryDays ? `, to use within ${bundle.expiryDays} days` : ''}.</span></span>
            </label>
          )}
          <input className="input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name"/>
          <input className="input" type="email" placeholder="Email" value={email} onChange={(e) => { setEmail(e.target.value); setFullPrice(null); }} required autoComplete="email"/>
          {coupon ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--ok)' }}>
              <Icons.Check size={14}/> <span style={{ flex: 1 }}><b>{coupon.code}</b>: {coupon.label}</span>
              <button type="button" className="btn btn-ghost" onClick={() => { setCoupon(null); setCode(''); }} style={{ fontSize: 12.5, padding: '4px 8px', minHeight: 30 }}>Remove</button>
            </div>
          ) : codeOpen ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Code" aria-label="Discount code" autoCapitalize="characters" style={{ flex: 1 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCode(); } }}/>
                <button type="button" className="btn btn-outline" onClick={applyCode} disabled={codeBusy || !code.trim()}>{codeBusy ? 'Checking…' : 'Apply'}</button>
              </div>
              {codeErr && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{codeErr}</div>}
            </div>
          ) : (
            <button type="button" onClick={() => setCodeOpen(true)} style={{ alignSelf: 'flex-start', fontSize: 13, color: 'var(--accent)' }}>Apply a code</button>
          )}
          {formErr && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{formErr}</div>}
          {fullPrice ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>A free trial has already been used with this email, so this subscription starts at the full price today.</div>
              <a href={fullPrice} className="btn btn-primary" style={{ justifyContent: 'center', padding: 14, fontSize: 15 }}>Continue to checkout</a>
            </div>
          ) : (
            <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: 14, fontSize: 15 }} disabled={busy || closed}>{busy ? 'Opening checkout…' : program.billing === 'one_time' ? 'Buy now' : trialDays ? `Start your ${trialDays}-day free trial` : 'Subscribe'}</button>
          )}
          <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>Secure checkout by Stripe. Paid directly to {business.name}.{program.billing !== 'one_time' ? ' Cancel any time.' : ''}</div>
        </>)}
      </form>
    </>)}
    <SalesOutline outline={outline} modules={data.modules || []} previews={data.previews || []}/>
    {program.communityEnabled && <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', gap: 8, alignItems: 'center' }}><Icons.Users size={14}/> Includes a private members community.</div>}
  </>);
}
