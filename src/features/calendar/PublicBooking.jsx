// /book/:slug — public booking page. Reads sanitized state from /api/calendar/public/:slug,
// posts to /api/calendar/public/:slug/book to confirm.
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';
import {
  addDays, fmtDateISO, minToHM, parseISO, slotsForDate, startOfWeek, WEEKDAYS_SHORT,
} from './utils.js';

export default function PublicBooking() {
  const { slug } = useParams();
  const [tweaks] = useTweaks();
  const [cal, setCal] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const [serviceId, setServiceId] = useState(null);
  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeek(new Date()));
  const [slot, setSlot] = useState(null);
  const [step, setStep] = useState('pick');     // 'pick' | 'details' | 'confirmed' | 'waitlisted'
  // True when the user picked a fully-booked day card. Switches the
  // details step's primary button from "Confirm booking" to "Join the
  // waitlist" so we skip the failed-book → error → waitlist double tap.
  const [waitlistMode, setWaitlistMode] = useState(false);
  const [name, setName]   = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  // Selected add-ons (set of add-on ids) and custom-field answers
  // (id → value). Reset whenever the chosen service changes so a
  // visitor doesn't carry stale picks across services.
  const [selectedAddOns, setSelectedAddOns] = useState(new Set());
  const [customAnswers, setCustomAnswers]   = useState({});
  const [busy, setBusy]   = useState(false);
  const [bookErr, setBookErr] = useState(null);
  // Video room URL returned from the confirmed booking response. Shown
  // on the success screen for virtual services.
  const [confirmedVideoUrl, setConfirmedVideoUrl] = useState(null);

  // "Have a question?" prospect-message modal state. Lets a visitor
  // talk to the business before committing to a slot.
  const [contactOpen, setContactOpen] = useState(false);
  // Membership subscribe modal — separate from the booking flow.
  const [joiningMembership, setJoiningMembership] = useState(null);
  // Gift card buy modal.
  const [giftCardOpen, setGiftCardOpen] = useState(false);
  // Gift card application at checkout.
  const [giftCardCode, setGiftCardCode] = useState('');
  const [giftCardChecked, setGiftCardChecked] = useState(null);
  const [giftCardErr, setGiftCardErr] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/calendar/public/' + encodeURIComponent(slug))
      .then((r) => {
        if (!live) return;
        setCal(r.calendar);
        setServiceId(r.calendar.services[0]?.id || null);
        document.title = (r.calendar.settings.bizName || slug) + ' · Book';
      })
      .catch((e) => live && setLoadErr(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [slug]);

  // SEO: structured data + Open Graph / Twitter card meta. Injected
  // dynamically because we're a SPA — Vite ships a single index.html.
  // Crawlers that execute JS (Google, Bing, Twitterbot, Slackbot,
  // Facebook's link previewer) all see these tags and use the
  // aggregateRating + reviews block to render rich snippets in the SERP.
  useEffect(() => {
    if (!cal) return;
    const cleanups = [];

    const upsertMeta = (attr, key, value) => {
      let el = document.querySelector(`meta[${attr}="${key}"]`);
      const created = !el;
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      const prev = el.getAttribute('content');
      el.setAttribute('content', value);
      cleanups.push(() => {
        if (created) el.remove();
        else if (prev != null) el.setAttribute('content', prev);
      });
    };

    const biz = cal.settings.bizName || slug;
    const tagline = cal.settings.tagline || `Book a session with ${biz} on THRYVE.`;
    const url = window.location.href;
    upsertMeta('name', 'description', tagline);
    upsertMeta('property', 'og:title', biz);
    upsertMeta('property', 'og:description', tagline);
    upsertMeta('property', 'og:type', 'website');
    upsertMeta('property', 'og:url', url);
    upsertMeta('name', 'twitter:card', 'summary');
    upsertMeta('name', 'twitter:title', biz);
    upsertMeta('name', 'twitter:description', tagline);

    // JSON-LD: LocalBusiness + aggregateRating + recent Review nodes.
    // Schema.org-compliant; Google uses this to render stars + count
    // beside the SERP listing once the domain has search history.
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: biz,
      url,
      description: tagline,
    };
    if (cal.reviews?.count > 0 && cal.reviews?.avg) {
      jsonLd.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: cal.reviews.avg,
        reviewCount: cal.reviews.count,
        bestRating: 5,
        worstRating: 1,
      };
    }
    if (cal.reviews?.recent?.length) {
      jsonLd.review = cal.reviews.recent.slice(0, 5).map((r) => ({
        '@type': 'Review',
        reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5 },
        author: { '@type': 'Person', name: r.reviewerName },
        datePublished: r.createdAt,
        ...(r.text ? { reviewBody: r.text } : {}),
      }));
    }
    if (cal.services?.length) {
      jsonLd.makesOffer = cal.services.slice(0, 20).map((s) => ({
        '@type': 'Offer',
        name: s.name,
        ...(typeof s.price === 'number' && s.price > 0
          ? { price: s.price, priceCurrency: 'USD' } : {}),
      }));
    }
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(jsonLd);
    document.head.appendChild(script);
    cleanups.push(() => script.remove());

    return () => { cleanups.forEach((fn) => fn()); };
  }, [cal, slug]);

  if (loading) {
    return (
      <PageWrap tweaks={tweaks}>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      </PageWrap>
    );
  }

  if (loadErr || !cal) {
    const status = loadErr?.status;
    const title  = status === 404
      ? "Booking page not found"
      : status >= 500
        ? "Booking page is having trouble"
        : "Couldn't load this booking page";
    const hint = status === 404
      ? `No public calendar for "${slug}". The owner may not have published their handle yet.`
      : (loadErr?.message || `Status ${status || 'unknown'}.`);
    return (
      <PageWrap tweaks={tweaks}>
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Calendar" title={title} hint={hint}/>
          {status >= 500 && loadErr?.message && (
            <div style={{
              marginTop: 14, padding: 10, borderRadius: 8,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace',
            }}>
              {loadErr.message}
            </div>
          )}
        </div>
      </PageWrap>
    );
  }

  const svc = cal.services.find((s) => s.id === serviceId);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i));

  const book = async (joinWaitlist = false) => {
    if (!slot || !svc) return;
    setBusy(true);
    setBookErr(null);
    try {
      // Same URL as the GET; method is POST. Avoids a sibling [slug]/ dir
      // that would conflict with [slug].js in Vercel's function bundling.
      // Compute the slot's effective end-time given selected add-ons
      // (each adds its durationMinutes). Server re-checks; this is for
      // the request payload + slot conflict math.
      const addOnDurDelta = (svc?.addOns || [])
        .filter((a) => selectedAddOns.has(a.id))
        .reduce((s, a) => s + Number(a.durationMinutes || 0), 0);
      const effectiveEnd = slot.start + (svc?.durationMinutes || 0) + addOnDurDelta;

      const r = await api.post('/calendar/public/' + encodeURIComponent(slug), {
        serviceId: svc.id,
        date: slot.dateISO,
        startMin: slot.start,
        endMin: effectiveEnd,
        clientName: name,
        clientEmail: email,
        clientPhone: phone.trim() || null,
        // Mobile services need an address — only forwarded when the
        // service is mobile so the server can validate it's there.
        locationAddress: svc?.locationType === 'mobile' ? address.trim() : null,
        addOnIds: Array.from(selectedAddOns),
        customFieldValues: customAnswers,
        // Optional gift card application at booking time.
        giftCardCode: giftCardChecked ? giftCardCode : null,
        smsConsent: !!(smsOptIn && phone.trim()),
        joinWaitlist,
      });
      // If the service requires a deposit AND the workspace has Stripe
      // connected, the server returned a Checkout URL — redirect there.
      // The slot is already held by the booking, so a cancelled deposit
      // payment doesn't release it (owner can still chase the deposit).
      if (r.depositCheckoutUrl) {
        window.location.href = r.depositCheckoutUrl;
        return;
      }
      if (r.booking?.videoRoomUrl) setConfirmedVideoUrl(r.booking.videoRoomUrl);
      setStep(joinWaitlist ? 'waitlisted' : 'confirmed');
    } catch (e) {
      setBookErr(e.message || 'Could not confirm — try another slot.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageWrap tweaks={tweaks}>
      <Header bizName={cal.settings.bizName} tagline={cal.settings.tagline}/>

      {/* "Have a question?" CTA — pinned just under the header on the
          slot picker step. We hide it on the success/confirmed/details
          steps to avoid distracting from the active booking flow. */}
      {step === 'pick' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 13, color: 'var(--fg-2)',
        }}>
          <Icons.Chat size={14} stroke="var(--accent)"/>
          <span style={{ flex: 1, minWidth: 200 }}>
            Have a question before booking? Send {cal.settings.bizName || 'them'} a message.
          </span>
          <button onClick={() => setContactOpen(true)}
            className="btn btn-outline" style={{ fontSize: 12.5, padding: '6px 12px' }}>
            Message us
          </button>
        </div>
      )}

      {contactOpen && (
        <ContactModal
          slug={slug}
          bizName={cal.settings.bizName}
          onClose={() => setContactOpen(false)}
        />
      )}

      {/* Memberships card — only when the business has at least one
          active tier with a Stripe price. Visitors click a tier to
          open the join modal. */}
      {step === 'pick' && cal.memberships?.length > 0 && (
        <MembershipsBlock
          memberships={cal.memberships}
          bizName={cal.settings.bizName}
          onJoin={(m) => setJoiningMembership(m)}
        />
      )}

      {/* Gift card CTA — same step as the slot picker so it doesn't
          get in the way of someone who's actively trying to book. */}
      {step === 'pick' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: 10, marginTop: 14,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 13, color: 'var(--fg-2)',
        }}>
          <Icons.Gift size={14} stroke="var(--accent)"/>
          <span style={{ flex: 1, minWidth: 200 }}>
            Send a gift card to a friend — they'll get it in their inbox right away.
          </span>
          <button onClick={() => setGiftCardOpen(true)}
            className="btn btn-outline" style={{ fontSize: 12.5, padding: '6px 12px' }}>
            Buy a gift card
          </button>
        </div>
      )}

      {giftCardOpen && (
        <BuyGiftCardModal
          slug={slug}
          bizName={cal.settings.bizName}
          onClose={() => setGiftCardOpen(false)}
        />
      )}

      {joiningMembership && (
        <JoinMembershipModal
          slug={slug}
          membership={joiningMembership}
          bizName={cal.settings.bizName}
          onClose={() => setJoiningMembership(null)}
        />
      )}

      {step === 'waitlisted' ? (
        <div className="card" style={{ padding: 36 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 56, height: 56, borderRadius: 99, background: 'var(--accent)', color: 'var(--accent-ink)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
            }}><Icons.Clock size={26} sw={2.4}/></div>
            <h2 className="page-title" style={{ fontSize: 24, margin: '0 0 8px' }}>You're on the list.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 14, margin: 0, lineHeight: 1.5 }}>
              We'll email <b style={{ color: 'var(--fg-2)' }}>{email}</b>
              {smsOptIn && phone.trim() ? <> and text <b style={{ color: 'var(--fg-2)' }}>{phone}</b></> : null}
              {' '}the moment a spot opens up for{' '}
              <b style={{ color: 'var(--fg-2)' }}>
                {parseISO(slot.dateISO).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </b>{' '}at <b style={{ color: 'var(--fg-2)' }}>{minToHM(slot.start)}</b>.
              You'll be auto-booked — no action needed on your end.
            </p>
          </div>
        </div>
      ) : step === 'confirmed' ? (
        <div className="card" style={{ padding: 36 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 56, height: 56, borderRadius: 99, background: 'var(--ok)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
            }}><Icons.Check size={26} sw={2.4}/></div>
            <h2 className="page-title" style={{ fontSize: 24, margin: '0 0 8px' }}>You're booked.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 14, margin: 0, lineHeight: 1.5 }}>
              A confirmation is on its way to <b style={{ color: 'var(--fg-2)' }}>{email}</b>. See you on{' '}
              <b style={{ color: 'var(--fg-2)' }}>
                {parseISO(slot.dateISO).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </b>{' '}at <b style={{ color: 'var(--fg-2)' }}>{minToHM(slot.start)}</b>.
            </p>
          </div>
          {confirmedVideoUrl && (
            <div style={{
              marginTop: 24, padding: 18,
              background: 'color-mix(in srgb, var(--accent-soft) 60%, var(--surface))',
              border: '1px solid var(--accent)', borderRadius: 12,
            }}>
              <div className="metric-label" style={{ marginBottom: 6, color: 'var(--accent)' }}>
                Your meeting link
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 10, lineHeight: 1.5 }}>
                Save this — it's also in the confirmation email. Open it at the start of your session.
              </div>
              <a href={confirmedVideoUrl} target="_blank" rel="noopener noreferrer"
                className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Icons.Globe size={13}/> Join meeting
              </a>
              <div style={{
                marginTop: 10, padding: '8px 10px', borderRadius: 8,
                background: 'var(--surface)', border: '1px solid var(--border)',
                fontSize: 11.5, color: 'var(--muted)', wordBreak: 'break-all',
              }}>{confirmedVideoUrl}</div>
            </div>
          )}
          {svc?.prepInstructions && (
            <div style={{
              marginTop: 28, padding: 18,
              background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12,
            }}>
              <div className="metric-label" style={{ marginBottom: 8 }}>Before your appointment</div>
              <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {svc.prepInstructions}
              </div>
            </div>
          )}
        </div>
      ) : step === 'details' ? (
        <div className="card" style={{ padding: 28 }}>
          <div className="metric-label" style={{ marginBottom: 4 }}>
            {waitlistMode ? 'Join waitlist' : 'Confirm'}
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: waitlistMode ? 8 : 18 }}>
            {svc?.name} · {parseISO(slot.dateISO).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            {!waitlistMode && <> · {minToHM(slot.start)}</>}
          </div>
          {waitlistMode && (
            <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              Every slot for this day is booked. Drop your details and we'll
              auto-book you the moment a spot opens up — no action needed
              on your end.
            </p>
          )}
          <Field label="Your name">
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputSty} placeholder="Ana Beltrán"/>
          </Field>
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputSty} placeholder="you@email.com"/>
          </Field>
          <Field label="Mobile" hint="Optional — needed if you'd like text reminders.">
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              style={inputSty} placeholder="(555) 123-4567" autoComplete="tel"/>
          </Field>
          {/* Mobile-service address. Only required when the chosen
              service is delivered at the client's location. */}
          {svc?.locationType === 'mobile' && (
            <Field label="Where should we come?" hint="Street address, city, ZIP. Apartment / suite + parking notes if relevant.">
              <textarea value={address} onChange={(e) => setAddress(e.target.value)}
                rows={2}
                placeholder="123 Main St, Apt 4B, Brooklyn NY 11201"
                style={{ ...inputSty, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.45 }}
                autoComplete="street-address"/>
            </Field>
          )}

          {/* Add-ons. Listed as checkboxes; each shows price + any
              extra duration so the visitor sees what they're agreeing
              to. Total updates inline. */}
          {svc?.addOns?.length > 0 && (
            <Field label="Add anything?" hint="Optional extras, charged with the service.">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {svc.addOns.map((a) => {
                  const checked = selectedAddOns.has(a.id);
                  return (
                    <label key={a.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                      borderRadius: 10, cursor: 'pointer',
                      background: checked ? 'var(--accent-soft)' : 'var(--surface-2)',
                      border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                    }}>
                      <input type="checkbox" checked={checked}
                        onChange={(e) => {
                          setSelectedAddOns((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(a.id); else next.delete(a.id);
                            return next;
                          });
                        }}/>
                      <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{a.name}</span>
                      <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                        +${Number(a.price).toFixed(2)}
                        {Number(a.durationMinutes) > 0 && ` · +${a.durationMinutes}min`}
                      </span>
                    </label>
                  );
                })}
              </div>
            </Field>
          )}

          {/* Gift card apply: visitors paste a code, we ping the
              public check endpoint to confirm balance. The applied
              card is forwarded with the booking POST and atomically
              redeemed server-side so concurrent uses can't overspend. */}
          <Field label="Gift card (optional)"
            hint={giftCardChecked
              ? `Balance available: $${(giftCardChecked.balanceCents / 100).toFixed(2)}. Applied to this booking.`
              : 'Paste a gift card code to apply credit.'}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={giftCardCode}
                onChange={(e) => { setGiftCardCode(e.target.value); setGiftCardChecked(null); setGiftCardErr(null); }}
                placeholder="ABCD-1234-EFGH"
                disabled={!!giftCardChecked}
                style={{
                  ...inputSty,
                  fontFamily: 'ui-monospace, monospace',
                  textTransform: 'uppercase',
                  opacity: giftCardChecked ? 0.6 : 1,
                }}/>
              {giftCardChecked ? (
                <button type="button" className="btn btn-outline"
                  onClick={() => { setGiftCardChecked(null); setGiftCardCode(''); }}
                  style={{ fontSize: 12 }}>
                  Remove
                </button>
              ) : (
                <button type="button" className="btn btn-outline"
                  disabled={!giftCardCode.trim()}
                  style={{ fontSize: 12 }}
                  onClick={async () => {
                    setGiftCardErr(null);
                    try {
                      const res = await fetch('/api/gift-cards/check', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ slug, code: giftCardCode.trim() }),
                      });
                      const j = await res.json().catch(() => ({}));
                      if (!res.ok) throw new Error(j.error || 'Invalid code');
                      setGiftCardChecked(j.card);
                    } catch (ex) {
                      setGiftCardErr(ex.message || 'Could not check that code');
                    }
                  }}>
                  Apply
                </button>
              )}
            </div>
            {giftCardErr && (
              <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6 }}>{giftCardErr}</div>
            )}
          </Field>

          {/* Custom intake fields. Required ones block submit; types
              determine the input shape. */}
          {svc?.customFields?.length > 0 && (
            <>
              {svc.customFields.map((f) => (
                <Field key={f.id} label={f.label + (f.required ? ' *' : '')}>
                  {f.type === 'textarea' ? (
                    <textarea value={customAnswers[f.id] || ''}
                      onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.value }))}
                      rows={3} required={f.required}
                      style={{ ...inputSty, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.45 }}/>
                  ) : f.type === 'number' ? (
                    <input type="number" value={customAnswers[f.id] || ''}
                      onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.value }))}
                      required={f.required} style={inputSty}/>
                  ) : f.type === 'select' ? (
                    <select value={customAnswers[f.id] || ''}
                      onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.value }))}
                      required={f.required} style={inputSty}>
                      <option value="">— Choose —</option>
                      {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : f.type === 'checkbox' ? (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg-2)' }}>
                      <input type="checkbox" checked={!!customAnswers[f.id]}
                        onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.checked }))}/>
                      Yes
                    </label>
                  ) : (
                    <input value={customAnswers[f.id] || ''}
                      onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.value }))}
                      required={f.required} style={inputSty}/>
                  )}
                </Field>
              ))}
            </>
          )}
          {phone.trim() && (
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14,
              fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, cursor: 'pointer',
            }}>
              <input type="checkbox" checked={smsOptIn}
                onChange={(e) => setSmsOptIn(e.target.checked)}
                style={{ marginTop: 3 }}/>
              <span>
                Text me reminders about this booking. Standard messaging rates may apply;
                reply STOP at any time to opt out.
              </span>
            </label>
          )}
          {bookErr && (
            <div style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5, marginBottom: 14,
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            }}>
              <span style={{ flex: 1 }}>{bookErr}</span>
              {/* If the failure was a full / taken slot, offer to queue
                  instead of forcing the client to pick another time. */}
              {/full|taken|just/i.test(bookErr) && (
                <button onClick={() => book(true)} disabled={busy}
                  className="btn btn-outline" style={{ fontSize: 12 }}>
                  {busy ? '…' : 'Join the waitlist'}
                </button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => { setWaitlistMode(false); setStep('pick'); }}>
              ← Back
            </button>
            <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}
              disabled={!name.trim() || !email.trim() || busy} onClick={() => book(waitlistMode)}>
              {busy
                ? (waitlistMode ? 'Joining…' : 'Confirming…')
                : (waitlistMode ? 'Join the waitlist' : 'Confirm booking')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Service picker */}
          <div className="card" style={{ padding: 18, marginBottom: 18 }}>
            <div className="metric-label" style={{ marginBottom: 12 }}>Choose a service</div>
            {cal.services.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 13, padding: 12 }}>
                This business hasn't published any services yet.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                {cal.services.map((s) => {
                  const selected = serviceId === s.id;
                  return (
                    <button key={s.id} onClick={() => {
                      setServiceId(s.id);
                      // Reset per-service state — picks shouldn't carry
                      // across services.
                      setSelectedAddOns(new Set());
                      setCustomAnswers({});
                    }} style={{
                      padding: 0, borderRadius: 12, textAlign: 'left', cursor: 'pointer',
                      background: selected ? 'var(--accent-soft)' : 'var(--surface-2)',
                      border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                      overflow: 'hidden',
                      display: 'flex', flexDirection: 'column',
                    }}>
                      {s.photoUrl ? (
                        <div style={{
                          height: 90, background: `url(${s.photoUrl}) center/cover`,
                          borderBottom: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                        }}/>
                      ) : null}
                      <div style={{ padding: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 600, fontSize: 13, color: selected ? 'var(--accent)' : 'var(--fg)', flex: 1 }}>{s.name}</span>
                          {s.capacity > 1 && (
                            <span style={{
                              padding: '1px 7px', borderRadius: 99,
                              fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                              background: 'var(--accent-soft)', color: 'var(--accent)',
                            }}>Group · {s.capacity}</span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                          {s.durationMinutes} min · ${Number(s.price).toLocaleString()}
                        </div>
                        {/* Location-type chip: tells visitors up-front whether
                            this service comes to them, happens at the owner's
                            place, or runs over video. */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                          {s.locationType && s.locationType !== 'in_person' && (
                            <div style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              padding: '2px 7px', borderRadius: 99,
                              fontSize: 10, fontWeight: 600,
                              background: 'var(--accent-soft)', color: 'var(--accent)',
                            }}>
                              {s.locationType === 'mobile' ? 'Comes to you' : 'Online'}
                            </div>
                          )}
                          {s.depositType && s.depositType !== 'none' && Number(s.depositAmount) > 0 && (
                            <div style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              padding: '2px 7px', borderRadius: 99,
                              fontSize: 10, fontWeight: 600,
                              background: 'var(--surface)',
                              color: 'var(--fg-2)', border: '1px solid var(--border-strong)',
                            }}>
                              <Icons.Lock size={9} sw={1.8}/>
                              Deposit: {s.depositType === 'percent'
                                ? `${Number(s.depositAmount)}%`
                                : `$${Number(s.depositAmount).toFixed(2)}`}
                            </div>
                          )}
                        </div>
                        {(false) && (
                          <div/>
                        )}
                        {s.description && (
                          <p style={{
                            margin: '8px 0 0', fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.45,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                          }}>{s.description}</p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Week navigation */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 8 }}>
            <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setWeekAnchor(addDays(weekAnchor, -7))}>
              <Icons.Arrow size={14} style={{ transform: 'rotate(180deg)' }}/>
            </button>
            <div style={{ flex: 1, textAlign: 'center', fontWeight: 500, fontSize: 14, color: 'var(--fg-2)' }}>
              {weekAnchor.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – {addDays(weekAnchor, 6).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </div>
            <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setWeekAnchor(addDays(weekAnchor, 7))}>
              <Icons.Arrow size={14}/>
            </button>
          </div>

          {/* Day cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 10 }}>
            {weekDays.map((d, i) => {
              const allSlots = svc ? slotsForDate(cal, d, svc) : [];
              const slots = allSlots.filter((s) => s.available);
              const today = new Date(); today.setHours(0, 0, 0, 0);
              const isPast = d < today;
              // Differentiate "closed that day" (no windows produced any
              // slots) from "fully booked" (windows existed but every
              // slot is taken). The latter gets a Join-waitlist CTA.
              const isClosed     = !isPast && allSlots.length === 0;
              const isFullyBooked = !isPast && allSlots.length > 0 && slots.length === 0;
              return (
                <div key={i} className="card" style={{
                  padding: 10, display: 'flex', flexDirection: 'column', gap: 6,
                  opacity: isPast ? 0.4 : 1,
                }}>
                  <div style={{ textAlign: 'center', paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                    <div className="metric-label" style={{ fontSize: 10 }}>{WEEKDAYS_SHORT[d.getDay()]}</div>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 500 }}>{d.getDate()}</div>
                  </div>
                  {isPast ? null : isClosed ? (
                    <div style={{ fontSize: 10, color: 'var(--muted-2)', textAlign: 'center', padding: '8px 0' }}>Closed</div>
                  ) : isFullyBooked ? (
                    /* Hot day — every slot taken. Surface waitlist as
                       the obvious next step instead of letting the user
                       wander away. */
                    <button onClick={() => {
                      // Drop into the details step in waitlist mode —
                      // the primary button becomes "Join the waitlist"
                      // and the submit goes straight to the queue.
                      const first = allSlots[0];
                      if (!first) return;
                      setSlot({ dateISO: fmtDateISO(d), start: first.start, end: first.end });
                      setWaitlistMode(true);
                      setStep('details');
                    }} style={{
                      padding: '8px 4px', borderRadius: 6,
                      fontSize: 10.5, fontWeight: 600, lineHeight: 1.35,
                      background: 'color-mix(in srgb, var(--warn) 14%, transparent)',
                      border: '1px solid var(--warn)',
                      color: 'var(--warn)', cursor: 'pointer',
                      textAlign: 'center',
                    }}>
                      Fully booked<br/><span style={{ fontWeight: 500 }}>Join waitlist →</span>
                    </button>
                  ) : slots.slice(0, 8).map((s, si) => (
                    <button key={si} onClick={() => {
                      setSlot({ dateISO: fmtDateISO(d), start: s.start, end: s.end });
                      setStep('details');
                    }} style={{
                      padding: '6px 4px', borderRadius: 6, fontSize: 11, fontWeight: 550,
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      color: 'var(--fg)', cursor: 'pointer',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                    }}>
                      <span>{minToHM(s.start)}</span>
                      {s.seatsLeft != null && (
                        <span style={{
                          fontSize: 9, fontWeight: 600,
                          color: s.seatsLeft <= 2 ? 'var(--warn)' : 'var(--accent)',
                        }}>
                          {s.seatsLeft} left
                        </span>
                      )}
                    </button>
                  ))}
                  {slots.length > 8 && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>+{slots.length - 8} more</div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 20 }}>
            Times in your local timezone · Free cancellation up to 24h before
          </div>
        </>
      )}

      {/* Reviews block. Hidden on the confirmed/waitlisted screens so
          the focus stays on the success state, but visible during the
          pick + details steps for social proof while the visitor is
          still deciding. */}
      {step !== 'confirmed' && step !== 'waitlisted' && cal.reviews?.count > 0 && (
        <ReviewsBlock summary={cal.reviews}/>
      )}
    </PageWrap>
  );
}

function ReviewsBlock({ summary }) {
  const avg = summary.avg ? Number(summary.avg).toFixed(1) : null;
  return (
    <div className="card" style={{ padding: 22, marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="metric-label">Reviews</div>
        {avg && (
          <>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 22, letterSpacing: '-0.01em' }}>
              {avg}
            </span>
            <Stars rating={Number(avg)} size={14}/>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {summary.count} review{summary.count === 1 ? '' : 's'}
            </span>
          </>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {summary.recent.slice(0, 6).map((r) => (
          <div key={r.id} style={{
            padding: 14, borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Stars rating={r.rating} size={11}/>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
              </span>
            </div>
            {r.text && (
              <div style={{ fontSize: 13.5, color: 'var(--fg)', lineHeight: 1.5 }}>
                "{r.text}"
              </div>
            )}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              — {r.reviewerName}
            </div>
            {r.ownerResponse && (
              <div style={{
                marginTop: 6, paddingTop: 8, borderTop: '1px dashed var(--border)',
                fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5,
              }}>
                <span style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Owner replied
                </span>
                <div style={{ marginTop: 3 }}>{r.ownerResponse}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stars({ rating, size = 12 }) {
  const full = Math.round(rating);
  return (
    <span aria-label={`${rating} out of 5`} style={{ display: 'inline-flex', gap: 1.5, color: 'var(--accent)' }}>
      {[1,2,3,4,5].map((i) => (
        <span key={i} style={{
          fontSize: size, lineHeight: 1,
          color: i <= full ? 'var(--accent)' : 'var(--border-strong)',
        }}>★</span>
      ))}
    </span>
  );
}

function PageWrap({ tweaks, children }) {
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', padding: '40px 24px 80px', background: 'var(--page)',
    }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

function Header({ bizName, tagline }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
      <div style={{
        width: 52, height: 52, borderRadius: 14, background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 22,
      }}>{(bizName || 'T')[0].toUpperCase()}</div>
      <div style={{ minWidth: 0 }}>
        <div className="metric-label">Book an appointment</div>
        <h1 className="page-title" style={{ margin: '4px 0 0', fontSize: 28 }}>{bizName || 'Your business'}</h1>
        {tagline && (
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
            {tagline}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

const inputSty = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};

// Memberships block — listed as cards below the slot picker. Each
// card opens the join modal; the modal POSTs to /api/memberships/checkout
// and redirects to Stripe Checkout.
function MembershipsBlock({ memberships, bizName, onJoin }) {
  return (
    <div className="card" style={{ padding: 18, marginTop: 18 }}>
      <div className="metric-label" style={{ marginBottom: 10 }}>
        Memberships {bizName ? `at ${bizName}` : ''}
      </div>
      <div style={{
        display: 'grid', gap: 10,
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
      }}>
        {memberships.map((m) => (
          <button key={m.id} type="button" onClick={() => onJoin(m)}
            style={{
              padding: 16, borderRadius: 12, textAlign: 'left', cursor: 'pointer',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', gap: 6,
              transition: 'border-color .1s, background .1s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)';
              e.currentTarget.style.background = 'var(--accent-soft)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border)';
              e.currentTarget.style.background = 'var(--surface-2)';
            }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</div>
            <div style={{ fontSize: 18, fontWeight: 600, fontFamily: 'var(--font-display)' }}>
              ${(Number(m.priceCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
              <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500, fontFamily: 'inherit', marginLeft: 4 }}>
                / {m.interval === 'quarter' ? '3 mo' : m.interval}
              </span>
            </div>
            {m.description && (
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {m.description}
              </div>
            )}
            {Array.isArray(m.perks) && m.perks.length > 0 && (
              <ul style={{ margin: '4px 0 0', padding: '0 0 0 14px', fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                {m.perks.slice(0, 6).map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            )}
            <div style={{
              marginTop: 8, padding: '6px 12px', borderRadius: 8,
              background: 'var(--accent)', color: 'var(--accent-ink)',
              fontSize: 12, fontWeight: 600, textAlign: 'center',
            }}>Join — secure checkout</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function JoinMembershipModal({ slug, membership, bizName, onClose }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) {
      setErr('Both fields are required'); return;
    }
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/memberships/checkout', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          membershipId: membership.id,
          name: name.trim(),
          email: email.trim(),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      window.location.href = j.url;
    } catch (ex) {
      setErr(ex.message || 'Could not start checkout');
      setBusy(false);
    }
  };

  return (
    <div onClick={busy ? null : onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card"
        style={{ width: '100%', maxWidth: 460, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Heart size={16} sw={1.8}/></div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Join {membership.name}</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              ${(Number(membership.priceCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / {membership.interval === 'quarter' ? '3 mo' : membership.interval}
              {bizName ? ` · ${bizName}` : ''}
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <Field label="Your name">
          <input value={name} onChange={(e) => setName(e.target.value)}
            required autoFocus style={inputSty}/>
        </Field>
        <Field label="Email" hint="Renewal receipts go here.">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            required style={inputSty} autoComplete="email"/>
        </Field>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 14,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button type="button" className="btn btn-outline"
            onClick={onClose} disabled={busy}
            style={{ flex: 1, justifyContent: 'center' }}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}
            style={{ flex: 2, justifyContent: 'center' }}>
            {busy ? 'Opening checkout…' : 'Continue to checkout'}
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, textAlign: 'center' }}>
          Card details are entered on Stripe's secure checkout — never on this page.
        </div>
      </form>
    </div>
  );
}

// Buy-a-gift-card modal. Locked to a fixed amount ladder for safety;
// builds a Stripe Checkout session via /api/gift-cards/checkout.
function BuyGiftCardModal({ slug, bizName, onClose }) {
  const [amount, setAmount] = useState(5000);
  const [senderName, setSenderName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!senderName.trim() || !senderEmail.trim() || !recipientName.trim() || !recipientEmail.trim()) {
      setErr('All fields except message are required');
      return;
    }
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/gift-cards/checkout', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          amountCents: amount,
          senderName: senderName.trim(),
          senderEmail: senderEmail.trim(),
          recipientName: recipientName.trim(),
          recipientEmail: recipientEmail.trim(),
          message: message.trim() || null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      window.location.href = j.url;
    } catch (ex) {
      setErr(ex.message || 'Could not start checkout');
      setBusy(false);
    }
  };

  return (
    <div onClick={busy ? null : onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card scroll"
        style={{ width: '100%', maxWidth: 480, padding: 24, maxHeight: 'calc(100vh - 40px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Gift size={16} sw={1.8}/></div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Send a gift card</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {bizName ? `For use at ${bizName}.` : 'Redeemable on this booking page.'}
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <Field label="Amount">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {[2500, 5000, 7500, 10000, 15000, 20000, 25000, 50000].map((cents) => (
              <button key={cents} type="button" onClick={() => setAmount(cents)}
                style={{
                  padding: '8px 6px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                  border: `1px solid ${amount === cents ? 'var(--accent)' : 'var(--border-strong)'}`,
                  background: amount === cents ? 'var(--accent)' : 'var(--surface-2)',
                  color: amount === cents ? 'var(--accent-ink)' : 'var(--fg-2)',
                  cursor: 'pointer',
                }}>${(cents / 100).toFixed(0)}</button>
            ))}
          </div>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          <Field label="From (your name)">
            <input value={senderName} onChange={(e) => setSenderName(e.target.value)} required
              style={inputSty}/>
          </Field>
          <Field label="Your email">
            <input type="email" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)}
              required style={inputSty} autoComplete="email"/>
          </Field>
          <Field label="Recipient name">
            <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)}
              required style={inputSty}/>
          </Field>
          <Field label="Recipient email">
            <input type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)}
              required style={inputSty}/>
          </Field>
        </div>

        <Field label="Message (optional)">
          <textarea value={message} onChange={(e) => setMessage(e.target.value.slice(0, 1000))}
            rows={3}
            placeholder={`Happy birthday! Treat yourself.`}
            style={{ ...inputSty, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}/>
        </Field>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 14,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <button type="submit" className="btn btn-primary"
          disabled={busy}
          style={{ width: '100%', justifyContent: 'center', padding: '12px' }}>
          {busy ? 'Opening checkout…' : `Continue — $${(amount / 100).toFixed(2)}`}
        </button>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, textAlign: 'center' }}>
          Recipient gets the code by email immediately after payment.
        </div>
      </form>
    </div>
  );
}

// Pre-booking message modal. Hits the public contact endpoint, which
// auto-creates a "lead" client + thread on the owner's side. The
// owner gets push + email; replies email the prospect back through
// the existing /api/messages/:id reply path (now branding-aware).
function ContactModal({ slug, bizName, onClose }) {
  const [name, setName]       = useState('');
  const [email, setEmail]     = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) {
      setErr('Please fill in all fields'); return;
    }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(
        '/api/calendar/public/contact?slug=' + encodeURIComponent(slug),
        {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim(),
            message: message.trim(),
          }),
        }
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setDone(true);
    } catch (ex) {
      setErr(ex.message || 'Could not send');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={busy ? null : onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: '100%', maxWidth: 480, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Chat size={16} sw={1.8}/></div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
              {done ? 'Message sent' : `Message ${bizName || 'us'}`}
            </h3>
            {!done && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                We'll reply by email — usually within a day.
              </div>
            )}
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {done ? (
          <>
            <p style={{ margin: '0 0 18px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              Got it — your message is on its way to <b>{bizName || 'them'}</b>.
              Keep an eye on <b>{email}</b> for their reply, usually within a day.
              You can come back here any time to book once you've heard back.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <Field label="Your name">
              <input value={name} onChange={(e) => setName(e.target.value)}
                required autoFocus style={inputSty}/>
            </Field>
            <Field label="Email" hint="We'll reply here.">
              <input type="email" value={email}
                onChange={(e) => setEmail(e.target.value)}
                required style={inputSty}/>
            </Field>
            <Field label="What's your question?">
              <textarea value={message} onChange={(e) => setMessage(e.target.value)}
                rows={5} maxLength={4000} required
                placeholder="Hi! I'm wondering about…"
                style={{ ...inputSty, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}/>
            </Field>
            {err && (
              <div style={{
                padding: '8px 12px', borderRadius: 8, marginBottom: 14,
                background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
                color: 'var(--danger)', fontSize: 12.5,
              }}>{err}</div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button type="button" className="btn btn-outline"
                onClick={onClose} disabled={busy}
                style={{ flex: 1, justifyContent: 'center' }}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary"
                disabled={busy}
                style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Sending…' : 'Send message'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
