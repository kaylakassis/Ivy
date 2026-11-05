// /book/:slug - public booking page. Reads sanitized state from /api/calendar/public/:slug,
// posts to /api/calendar/public/:slug to confirm.
//
// Also rendered as /embed/book/:slug with embedded=true. In embed mode
// we shrink chrome (no business header, no reviews, no memberships /
// packages / programs), use a transparent background, never remember the
// visitor on the device, and post our rendered height to the parent window
// for iframe auto-sizing.
//
// Layout (1.0.5): header with trust details → progress → 1. service →
// 2. date strip + times → "More from <business>" (packages, memberships,
// programs, gift cards as compact expandable rows) → reviews. On phones a
// sticky bar carries the picked time to the details step.
//
// Slots are computed here from the single GET payload (availability +
// current bookings + blocks), so any day up to the owner's booking horizon
// can be shown without another request.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';
import { useEmbedResize } from '../../lib/embedResize.js';
import { tzDisplay, browserTimeZone } from '../../lib/timezones.js';
import { haptic } from '../../lib/celebrate.js';
import ArchivedBusinessCard, { isArchivedError } from '../../components/ArchivedBusiness.jsx';
import { fmtDateISO, minToHM, parseISO, startOfToday } from './utils.js';
import {
  buildDays, findNextAvailable, stripLimit, waitlistSeed, resolveServiceParam, listedServices,
  fmtPrice, fmtDuration, longDate, dualTimeLabel, zoneTimes,
  readRemembered, writeRemembered, forgetRemembered,
} from './publicBookingHelpers.js';
import {
  BizHeader, Progress, ServiceList, DateTimePicker, PolicyNote, StickyBar, MoreFrom, BookingSkeleton,
} from './PublicBookingParts.jsx';
import PolicyConsent, { usePolicyConsent, CardOnFilePrompt } from './PolicyConsent.jsx';
import './publicBooking.css';

const DAYS_FIRST_LOAD = 28;
const DAYS_PER_LOAD = 28;

// localStorage can throw (private mode, blocked site data, sandboxed frames).
function safeStorage() {
  try { return window.localStorage; } catch { return null; }
}
function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export default function PublicBooking({ embedded = false }) {
  const { slug } = useParams();
  const [tweaks] = useTweaks();
  // Auto-resize the iframe when running inside the embed route. No-op
  // when the page is loaded standalone (the hook checks window.parent).
  useEmbedResize(slug);
  const [cal, setCal] = useState(null);
  const consent = usePolicyConsent(cal);
  const [loadErr, setLoadErr] = useState(null);
  const [loading, setLoading] = useState(true);
  // Owner's subscription lapsed: the API returns { archived, businessName }
  // instead of a calendar, and any POST answers 403 business_archived.
  const [archived, setArchived] = useState(null);

  const [serviceId, setServiceId] = useState(null);
  const [selectedDateISO, setSelectedDateISO] = useState(null);
  // Days rendered in the strip so far; grows as the visitor scrolls, up to
  // the owner's booking horizon.
  const [dayCount, setDayCount] = useState(DAYS_FIRST_LOAD);
  const [slot, setSlot] = useState(null);
  const [step, setStep] = useState('pick');     // 'pick' | 'details' | 'confirmed' | 'waitlisted' | 'deposit-paid'
  // True when the user picked a fully-booked day. Switches the details
  // step's primary button from "Confirm booking" to "Join the waitlist".
  const [waitlistMode, setWaitlistMode] = useState(false);
  const [name, setName]   = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  // Returning visitor on this device (standalone page only, never the embed).
  const [remember, setRemember] = useState(!embedded);
  const [prefilled, setPrefilled] = useState(false);
  // Selected add-ons (set of add-on ids) and custom-field answers
  // (id → value). Reset whenever the chosen service changes.
  const [selectedAddOns, setSelectedAddOns] = useState(new Set());
  const [customAnswers, setCustomAnswers]   = useState({});
  const [busy, setBusy]   = useState(false);
  const [bookErr, setBookErr] = useState(null);
  const [confirmedVideoUrl, setConfirmedVideoUrl] = useState(null);
  // Add-to-calendar links ({ google, ics, outlook? }) returned with the
  // confirmed booking.
  const [confirmedCalendar, setConfirmedCalendar] = useState(null);
  // Checkout returns land back here on a fresh page load.
  const [depositNotice, setDepositNotice] = useState(null); // 'paid' | 'cancelled' | null
  const [paymentNotice, setPaymentNotice] = useState(null); // 'giftcard' | 'package' | 'membership' | 'cancelled' | null
  const [paymentError, setPaymentError] = useState(null);
  // Deposit was required but no checkout could be minted: the confirmed
  // screen must say the deposit is still owed.
  const [depositPending, setDepositPending] = useState(0);
  const [scrollTarget, setScrollTarget] = useState(null); // 'times' | 'top' | null
  const timesRef = useRef(null);
  const topRef = useRef(null);
  const pushedRef = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  const viewerTz = useMemo(() => browserTimeZone(), []);
  const today = useMemo(() => startOfToday(), []);
  const [isNarrow] = useState(() => {
    try { return window.matchMedia('(max-width: 720px)').matches; } catch { return false; }
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('deposit');
    let dirty = false;
    if (d === 'paid' || d === 'cancelled') {
      setDepositNotice(d);
      if (d === 'paid') setStep('deposit-paid');
      params.delete('deposit');
      dirty = true;
    }
    if (params.get('giftcard') === 'ok')          { setPaymentNotice('giftcard');   params.delete('giftcard');   dirty = true; }
    if (params.get('package') === 'purchased')    { setPaymentNotice('package');    params.delete('package');    dirty = true; }
    if (params.get('membership') === 'joined')    { setPaymentNotice('membership'); params.delete('membership'); dirty = true; }
    if (params.get('giftcard') === 'cancel')      { setPaymentNotice('cancelled');  params.delete('giftcard');   dirty = true; }
    if (params.get('package') === 'cancel')       { setPaymentNotice('cancelled');  params.delete('package');    dirty = true; }
    if (params.get('payment') === 'error') {
      setPaymentError((params.get('msg') || 'Payment could not be completed.').slice(0, 160));
      params.delete('payment'); params.delete('msg'); dirty = true;
    }
    if (!dirty) return;
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);

  // Returning visitor: fill name / email / phone from this device. Never on
  // the embed (it runs inside someone else's website, where the visitor
  // does not expect Ivy to remember them).
  useEffect(() => {
    if (embedded) return;
    const r = readRemembered(safeStorage());
    if (r) {
      setName(r.name); setEmail(r.email); setPhone(r.phone);
      setPrefilled(true);
    }
  }, [embedded]);

  const [contactOpen, setContactOpen] = useState(false);
  const [joiningMembership, setJoiningMembership] = useState(null);
  const [buyingPackage, setBuyingPackage] = useState(null);
  const [buyingProgram, setBuyingProgram] = useState(null);
  const [giftCardOpen, setGiftCardOpen] = useState(false);
  // Gift card application at checkout.
  const [giftCodeOpen, setGiftCodeOpen] = useState(false);
  const [giftCardCode, setGiftCardCode] = useState('');
  const [giftCardChecked, setGiftCardChecked] = useState(null);
  const [giftCardErr, setGiftCardErr] = useState(null);

  // Pick a service: reset per-service answers and jump the strip to its
  // first open day so times are on screen straight away.
  const applyService = (calObj, s) => {
    setServiceId(s.id);
    setSelectedAddOns(new Set());
    setCustomAnswers({});
    setSlot(null);
    const limit = stripLimit(calObj.settings);
    const next = findNextAvailable(calObj, s, today, limit);
    setSelectedDateISO(next ? next.dateISO : fmtDateISO(today));
    if (next) setDayCount((c) => Math.max(c, Math.min(limit, next.index + 7)));
  };

  const load = (quiet = false) => {
    let live = true;
    if (!quiet) setLoading(true);
    api.get('/calendar/public/' + encodeURIComponent(slug))
      .then((r) => {
        if (!live) return;
        if (r.archived) {
          setArchived({ businessName: r.businessName });
          document.title = (r.businessName || slug) + ' · Ivy';
          return;
        }
        setCal(r.calendar);
        document.title = (r.calendar.settings.bizName || slug) + ' · Book';
        if (quiet) return;
        // ?service=<id or name slug> preselects a service (private ones
        // included: that is what a direct link is for) and scrolls to times.
        let param = null;
        try { param = new URLSearchParams(window.location.search).get('service'); } catch { /* no-op */ }
        const deep = resolveServiceParam(r.calendar.services, param);
        const listed = listedServices(r.calendar.services);
        const initial = deep || (listed.length === 1 ? listed[0] : null);
        if (initial) applyService(r.calendar, initial);
        if (deep) setScrollTarget('times');
      })
      .catch((e) => live && !quiet && setLoadErr(e))
      .finally(() => live && !quiet && setLoading(false));
    return () => { live = false; };
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [slug]);

  // Phone back gesture / browser back from the details step returns to the
  // time picker with every choice kept (standalone page only: inside an
  // iframe the host page owns the history).
  useEffect(() => {
    if (embedded) return undefined;
    const onPop = () => {
      pushedRef.current = false;
      if (stepRef.current !== 'details') return;
      setStep('pick');
      setWaitlistMode(false);
      setScrollTarget('times');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [embedded]);

  useEffect(() => {
    if (!scrollTarget) return;
    const target = scrollTarget;
    setScrollTarget(null);
    if (embedded) return; // never yank the host site around
    const el = target === 'times' ? timesRef.current : topRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      try { el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); }
      catch { /* old engines */ }
    });
  }, [scrollTarget, step, cal, embedded]);

  // Derived booking state (hooks must run before any early return).
  const svc = cal ? (cal.services.find((s) => s.id === serviceId) || null) : null;
  const limit = cal ? stripLimit(cal.settings) : 0;
  const shownCount = Math.min(dayCount, limit);
  const days = useMemo(
    () => (cal && svc ? buildDays(cal, svc, today, shownCount) : []),
    [cal, svc, today, shownCount],
  );
  const nextAvail = useMemo(
    () => (cal && svc ? findNextAvailable(cal, svc, today, limit) : null),
    [cal, svc, today, limit],
  );

  // SEO: structured data + Open Graph / Twitter card meta. Injected
  // dynamically because we're a SPA - Vite ships a single index.html.
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
    const tagline = cal.settings.tagline || `Book a session with ${biz} on Ivy.`;
    const url = window.location.href;
    upsertMeta('name', 'description', tagline);
    upsertMeta('property', 'og:title', biz);
    upsertMeta('property', 'og:description', tagline);
    upsertMeta('property', 'og:type', 'website');
    upsertMeta('property', 'og:url', url);
    upsertMeta('name', 'twitter:card', 'summary');
    upsertMeta('name', 'twitter:title', biz);
    upsertMeta('name', 'twitter:description', tagline);

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
    const offered = listedServices(cal.services);
    if (offered.length) {
      jsonLd.makesOffer = offered.slice(0, 20).map((s) => ({
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
      <PageWrap tweaks={tweaks} embedded={embedded}>
        <BookingSkeleton embedded={embedded}/>
      </PageWrap>
    );
  }

  if (archived) {
    return (
      <PageWrap tweaks={tweaks} embedded={embedded}>
        <ArchivedBusinessCard businessName={archived.businessName} compact={embedded}/>
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
      <PageWrap tweaks={tweaks} embedded={embedded}>
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

  const bizName = cal.settings.bizName || '';
  const bizTz = cal.settings.timezone || null;
  const listed = listedServices(cal.services, serviceId);
  const hasServices = listed.length > 0;
  const hasOfferings = (!embedded && (cal.packages?.length > 0 || cal.programs?.length > 0 || cal.memberships?.length > 0));
  // Address only helps when clients come to the business.
  const showAddress = !hasServices || listed.some((s) => (s.locationType || 'in_person') === 'in_person');
  const slotDate = slot ? parseISO(slot.dateISO) : null;
  const slotZone = slot ? zoneTimes({ dateISO: slot.dateISO, startMin: slot.start, bizTz, viewerTz }) : { differs: false };
  const slotDual = slot ? dualTimeLabel({ dateISO: slot.dateISO, startMin: slot.start, bizTz, viewerTz, bizName }) : '';
  const zoneDiffers = zoneTimes({ dateISO: fmtDateISO(today), startMin: 12 * 60, bizTz, viewerTz }).differs;
  const stepIdx = ['confirmed', 'waitlisted', 'deposit-paid'].includes(step) ? 3
    : step === 'details' ? 2 : svc ? 1 : 0;
  const addOnTotal = (svc?.addOns || [])
    .filter((a) => selectedAddOns.has(a.id))
    .reduce((sum, a) => sum + Number(a.price || 0), 0);
  const total = Number(svc?.price || 0) + addOnTotal;
  const where = !svc ? null
    : svc.locationType === 'virtual' ? 'Online'
    : svc.locationType === 'mobile' ? 'At your place'
    : (svc.locationLabel || cal.settings.addressLabel || null);

  const chooseService = (s) => {
    if (s.id !== serviceId) applyService(cal, s);
    setScrollTarget('times');
  };
  const selectDate = (iso) => {
    setSelectedDateISO(iso);
    if (!slot || slot.dateISO !== iso) setSlot(null);
  };
  const selectTime = (day, s) => {
    setSlot({ dateISO: day.dateISO, start: s.start, end: s.end });
    setWaitlistMode(false);
    haptic('light');
  };
  const goNextAvail = () => {
    if (!nextAvail) return;
    setDayCount((c) => Math.max(c, Math.min(limit, nextAvail.index + 7)));
    setSelectedDateISO(nextAvail.dateISO);
    setSlot({ dateISO: nextAvail.dateISO, start: nextAvail.slot.start, end: nextAvail.slot.end });
    setWaitlistMode(false);
  };
  const goDetails = () => {
    setBookErr(null);
    setStep('details');
    if (!embedded) {
      try { window.history.pushState({ pb: 'details' }, ''); pushedRef.current = true; } catch { /* no-op */ }
      setScrollTarget('top');
    }
  };
  const joinWaitlistFor = (day) => {
    const seed = waitlistSeed(day.allSlots);
    if (!seed) return;
    setSlot({ dateISO: day.dateISO, start: seed.start, end: seed.end });
    setWaitlistMode(true);
    goDetails();
  };
  const backToPick = () => {
    if (pushedRef.current) {
      window.history.back(); // popstate puts us back on 'pick'
      return;
    }
    setWaitlistMode(false);
    setStep('pick');
    setScrollTarget('times');
  };
  const notYou = () => {
    forgetRemembered(safeStorage());
    setName(''); setEmail(''); setPhone(''); setSmsOptIn(false);
    setPrefilled(false);
  };
  const bookAnother = () => {
    setStep('pick');
    consent.setChecked(false); consent.setCardUrl(null);
    setSlot(null);
    setWaitlistMode(false);
    setBookErr(null);
    setConfirmedCalendar(null);
    setConfirmedVideoUrl(null);
    setDepositPending(0);
    setSelectedAddOns(new Set());
    setCustomAnswers({});
    setGiftCardCode(''); setGiftCardChecked(null); setGiftCodeOpen(false);
    setScrollTarget('top');
    // The time just booked is no longer free: refresh the slots.
    load(true);
  };

  const book = async (joinWaitlist = false) => {
    if (!slot || !svc) return;
    setBusy(true);
    setBookErr(null);
    try {
      // Effective end-time includes selected add-ons (each adds its
      // durationMinutes). Server re-checks.
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
        locationAddress: svc?.locationType === 'mobile' ? address.trim() : null,
        addOnIds: Array.from(selectedAddOns),
        customFieldValues: customAnswers,
        giftCardCode: giftCardChecked ? giftCardCode : null,
        smsConsent: !!(smsOptIn && phone.trim()),
        joinWaitlist,
        ...consent.fields(),
      });
      if (!embedded) {
        const st = safeStorage();
        if (remember) writeRemembered(st, { name: name.trim(), email: email.trim(), phone: phone.trim() });
        else forgetRemembered(st);
      }
      // Deposit required + provider connected → hosted checkout. The slot
      // is already held by the booking.
      if (r.depositCheckoutUrl) {
        window.location.href = r.depositCheckoutUrl;
        return;
      }
      if (Number(r.booking?.depositRequired) > 0) {
        setDepositPending(Number(r.booking.depositRequired));
      }
      consent.setCardUrl(r.cardSetupUrl || null);
      if (r.booking?.videoRoomUrl) setConfirmedVideoUrl(r.booking.videoRoomUrl);
      setConfirmedCalendar(r.booking?.calendar || null);
      setStep(joinWaitlist ? 'waitlisted' : 'confirmed');
      setScrollTarget('top');
      haptic('success'); // a little "done!" tap on the client's phone
    } catch (e) {
      if (isArchivedError(e)) { setArchived({ businessName: cal?.settings?.bizName }); return; }
      consent.handleError(e);
      setBookErr(e.message || 'Could not confirm - try another slot.');
    } finally {
      setBusy(false);
    }
  };

  const tzName = bizTz ? tzDisplay(bizTz) : null;
  const tzNote = tzName
    ? (zoneDiffers
      ? `Times are in ${bizName || 'the business'}'s time zone (${tzName}). We'll show your own time when you pick one.`
      : `Times are in ${tzName}.`)
    : 'Times are in the business’s local time zone.';

  return (
    <PageWrap tweaks={tweaks} embedded={embedded} accentColor={cal.settings.brandAccentColor}>
      {!embedded && (
        <BizHeader settings={cal.settings} reviews={cal.reviews} phone={cal.contactPhone || null}
          showAddress={showAddress} onMessage={() => setContactOpen(true)}/>
      )}
      <div ref={topRef} style={{ scrollMarginTop: 12 }}/>

      {depositNotice === 'cancelled' && step === 'pick' && (
        <Notice icon={<Icons.Clock size={15} stroke="var(--accent)"/>} onDismiss={() => setDepositNotice(null)}>
          Your deposit payment was cancelled, but your spot is still reserved.
          {' '}{bizName || 'The business'} will follow up about the deposit.
        </Notice>
      )}
      {paymentError && step === 'pick' && (
        <Notice tone="danger" onDismiss={() => setPaymentError(null)}>
          Payment didn't go through: {paymentError} You haven't been charged - try again or pick another way to pay.
        </Notice>
      )}
      {paymentNotice && step === 'pick' && (
        <Notice tone={paymentNotice === 'cancelled' ? null : 'ok'}
          icon={paymentNotice !== 'cancelled' ? <Icons.Check size={15} stroke="var(--ok)"/> : null}
          onDismiss={() => setPaymentNotice(null)}>
          {paymentNotice === 'giftcard' && <>Payment received - the gift card is on its way to the recipient's inbox (check spam if it doesn't arrive in a few minutes).</>}
          {paymentNotice === 'package' && <>Payment received - your package credits are ready. Book below, or sign in to your client portal to use them.</>}
          {paymentNotice === 'membership' && <>You're in! Your membership is active - a confirmation email is on its way.</>}
          {paymentNotice === 'cancelled' && <>Checkout cancelled - nothing was charged. You can try again whenever you're ready.</>}
        </Notice>
      )}

      {hasServices && <Progress current={stepIdx}/>}

      {contactOpen && (
        <ContactModal slug={slug} bizName={bizName} onClose={() => setContactOpen(false)}/>
      )}
      {giftCardOpen && (
        <BuyGiftCardModal slug={slug} bizName={bizName} onClose={() => setGiftCardOpen(false)}/>
      )}
      {buyingProgram && (
        <ProgramBuyModal program={buyingProgram} bizName={bizName} onClose={() => setBuyingProgram(null)}/>
      )}
      {buyingPackage && (
        <BuyPackageModal slug={slug} pkg={buyingPackage} bizName={bizName} onClose={() => setBuyingPackage(null)}/>
      )}
      {joiningMembership && (
        <JoinMembershipModal slug={slug} membership={joiningMembership} bizName={bizName}
          onClose={() => setJoiningMembership(null)}/>
      )}

      {step === 'waitlisted' ? (
        <section className="pb-card pb-done" aria-labelledby="pb-done-h">
          <div className="pb-done-icon" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
            <Icons.Clock size={28} sw={2.4}/>
          </div>
          <h2 id="pb-done-h" tabIndex={-1}>You're on the list.</h2>
          <p>
            We'll email <b>{email}</b> the moment a spot opens up for{' '}
            <b>{longDate(parseISO(slot.dateISO))}</b> at <b>{minToHM(slot.start)}</b>.
            You'll be auto-booked - no action needed on your end.
          </p>
          <div className="pb-done-actions">
            <button type="button" className="pb-btn outline" onClick={bookAnother}>Pick another time</button>
          </div>
        </section>
      ) : step === 'confirmed' ? (
        <section className="pb-card pb-done" aria-labelledby="pb-done-h">
          <div className="pb-done-icon"><Icons.Check size={30} sw={2.6}/></div>
          <h2 id="pb-done-h" tabIndex={-1}>You're booked.</h2>
          <p>A confirmation is on its way to <b>{email}</b>.</p>
          <div className="pb-done-card">
            <div className="row"><span>What</span><b>{svc?.name}</b></div>
            <div className="row"><span>When</span>
              <span>{longDate(parseISO(slot.dateISO))}, {slotDual}</span>
            </div>
            {svc?.locationType === 'mobile' && address.trim()
              ? <div className="row"><span>Where</span><span>{address.trim()}</span></div>
              : where && <div className="row"><span>Where</span><span>{where}</span></div>}
          </div>
          <CardOnFilePrompt url={consent.cardUrl} svc={svc} bizName={bizName}/>
          {depositPending > 0 && (
            <div className="pb-done-card">
              One more thing: a <b>${depositPending.toFixed(2)} deposit</b> is due for this
              booking. Online payment isn't set up yet, so {bizName || 'the business'} will
              follow up with you about it directly.
            </div>
          )}
          {confirmedCalendar?.google && confirmedCalendar?.ics && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>Add it to your calendar</div>
              <div className="pb-cal-btns">
                <a className="pb-btn outline" href={confirmedCalendar.ics}>
                  <Icons.Calendar size={14} sw={2}/> Apple
                </a>
                <a className="pb-btn outline" href={confirmedCalendar.google} target="_blank" rel="noopener noreferrer">
                  <Icons.Calendar size={14} sw={2}/> Google
                </a>
                <a className="pb-btn outline" href={confirmedCalendar.outlook || confirmedCalendar.ics}
                  {...(confirmedCalendar.outlook ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                  <Icons.Calendar size={14} sw={2}/> Outlook
                </a>
              </div>
            </div>
          )}
          {confirmedVideoUrl && (
            <div style={{
              marginTop: 20, padding: 18, textAlign: 'left',
              background: 'color-mix(in srgb, var(--accent-soft) 60%, var(--surface))',
              border: '1px solid var(--accent)', borderRadius: 12,
            }}>
              <div className="metric-label" style={{ marginBottom: 6, color: 'var(--accent)' }}>
                Your meeting link
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 10, lineHeight: 1.5 }}>
                Save this - it's also in the confirmation email. Open it at the start of your session.
              </div>
              <a href={confirmedVideoUrl} target="_blank" rel="noopener noreferrer" className="pb-btn primary">
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
            <div className="pb-done-card">
              <div className="metric-label" style={{ marginBottom: 6 }}>Before your appointment</div>
              <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {svc.prepInstructions}
              </div>
            </div>
          )}
          <div className="pb-done-actions">
            <button type="button" className="pb-btn primary" onClick={bookAnother}>Book another</button>
            <a className="pb-btn outline" href="/signin?next=/me/bookings"
              {...(embedded ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
              Manage or cancel
            </a>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>
            To change or cancel, sign in with {email}. New here? Your confirmation email has a link to set up your free account.
          </p>
        </section>
      ) : step === 'deposit-paid' ? (
        <section className="pb-card pb-done" aria-labelledby="pb-done-h">
          <div className="pb-done-icon"><Icons.Check size={30} sw={2.6}/></div>
          <h2 id="pb-done-h" tabIndex={-1}>Deposit received - you're all set.</h2>
          <p>
            Thank you! Your spot with <b>{bizName || 'us'}</b> is
            confirmed and your deposit is paid. A confirmation email with all the details is on its way.
          </p>
          <div className="pb-done-actions">
            <button type="button" className="pb-btn outline" onClick={() => { setStep('pick'); setDepositNotice(null); }}>
              Book another
            </button>
          </div>
        </section>
      ) : step === 'details' && svc && slot ? (
        <section className="pb-card" aria-labelledby="pb-details-h">
          <h2 className="pb-h2" id="pb-details-h">
            <span className="pb-num">3</span> {waitlistMode ? 'Join the waitlist' : 'Your details'}
          </h2>
          <div className="pb-recap">
            {svc.photoUrl && <img className="pb-svc-photo pb-recap-photo" src={svc.photoUrl} alt="" width="64" height="64"/>}
            <div className="pb-recap-text">
              <div className="pb-recap-top">
                <b>{svc.name}</b>
                <button type="button" className="pb-link-btn" onClick={backToPick}>Change</button>
              </div>
              <span>
                {longDate(slotDate)}
                {!waitlistMode && `, ${minToHM(slot.start)}`}
              </span>
              {!waitlistMode && slotZone.differs && (
                <span style={{ fontSize: 13 }}>That's {slotZone.viewerFull} your time</span>
              )}
              <span style={{ fontSize: 13 }}>{fmtDuration(svc.durationMinutes)} · {fmtPrice(svc.price)}</span>
              {where && <span style={{ fontSize: 13 }}>{where}</span>}
            </div>
          </div>
          {waitlistMode && (
            <p style={{ margin: '0 0 18px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              Every slot for this day is booked. Drop your details and we'll
              auto-book you the moment a spot opens up - no action needed
              on your end.
            </p>
          )}

          <form noValidate={false} onSubmit={(e) => { e.preventDefault(); if (!busy && name.trim() && email.trim()) book(waitlistMode); }}>
            {prefilled && (name || email) && (
              <div className="pb-remembered">
                <span>Welcome back{name ? `, ${name.split(' ')[0]}` : ''}. We filled in your details from last time.</span>
                <button type="button" className="pb-link-btn" onClick={notYou}>Not you?</button>
              </div>
            )}
            <Field label="Your name">
              <input className="pb-input" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Ana Beltrán" autoComplete="name" required maxLength={120}/>
            </Field>
            <Field label="Email" hint="Your confirmation goes here.">
              <input className="pb-input" type="email" inputMode="email" value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com"
                autoComplete="email" required maxLength={200}/>
            </Field>
            <Field label="Mobile" hint="Optional - needed if you'd like text reminders.">
              <input className="pb-input" type="tel" inputMode="tel" value={phone}
                onChange={(e) => setPhone(e.target.value)} placeholder="(555) 123-4567"
                autoComplete="tel" maxLength={40}/>
            </Field>
            {phone.trim() && (
              <label className="pb-check" style={{ marginTop: -6, marginBottom: 10 }}>
                <input type="checkbox" checked={smsOptIn} onChange={(e) => setSmsOptIn(e.target.checked)}/>
                <span>
                  Text me reminders about this booking. Standard messaging rates may apply;
                  reply STOP at any time to opt out.
                </span>
              </label>
            )}

            {svc.locationType === 'mobile' && (
              <Field label="Where should we come?" hint="Street address, city, ZIP. Apartment / suite + parking notes if relevant.">
                <textarea className="pb-input" value={address} onChange={(e) => setAddress(e.target.value)}
                  rows={2} placeholder="123 Main St, Apt 4B, Brooklyn NY 11201" autoComplete="street-address" required/>
              </Field>
            )}

            {svc.addOns?.length > 0 && (
              <Field group label="Add anything?" hint="Optional extras, charged with the service.">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {svc.addOns.map((a) => {
                    const checked = selectedAddOns.has(a.id);
                    return (
                      <label key={a.id} className="pb-check" style={{
                        alignItems: 'center', padding: '8px 12px', borderRadius: 10,
                        background: checked ? 'var(--accent-soft)' : 'var(--surface-2)',
                        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                      }}>
                        <input type="checkbox" checked={checked} style={{ marginTop: 0 }}
                          onChange={(e) => {
                            setSelectedAddOns((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(a.id); else next.delete(a.id);
                              return next;
                            });
                          }}/>
                        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{a.name}</span>
                        <span style={{ fontSize: 13 }}>
                          +${Number(a.price).toFixed(2)}
                          {Number(a.durationMinutes) > 0 && ` · +${a.durationMinutes}min`}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </Field>
            )}

            {/* Custom intake fields. Required ones block submit; types
                determine the input shape. */}
            {svc.customFields?.length > 0 && svc.customFields.map((f) => (
              f.type === 'checkbox' ? (
                <Field key={f.id} group label={f.label + (f.required ? ' *' : '')}>
                  <label className="pb-check">
                    <input type="checkbox" checked={!!customAnswers[f.id]}
                      onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.checked }))}/>
                    <span>Yes</span>
                  </label>
                </Field>
              ) : (
                <Field key={f.id} label={f.label + (f.required ? ' *' : '')}>
                  {f.type === 'textarea' ? (
                    <textarea className="pb-input" value={customAnswers[f.id] || ''}
                      onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.value }))}
                      rows={3} required={f.required}/>
                  ) : f.type === 'number' ? (
                    <input className="pb-input" type="number" inputMode="decimal" value={customAnswers[f.id] || ''}
                      onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.value }))}
                      required={f.required}/>
                  ) : f.type === 'select' ? (
                    <select className="pb-input" value={customAnswers[f.id] || ''}
                      onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.value }))}
                      required={f.required}>
                      <option value="">- Choose -</option>
                      {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input className="pb-input" value={customAnswers[f.id] || ''}
                      onChange={(e) => setCustomAnswers((m) => ({ ...m, [f.id]: e.target.value }))}
                      required={f.required}/>
                  )}
                </Field>
              )
            ))}

            {/* Gift card apply: tucked behind a link so most visitors see
                fewer fields. The applied card is redeemed server-side. */}
            {!giftCodeOpen && !giftCardChecked ? (
              <div style={{ margin: '-4px 0 10px' }}>
                <button type="button" className="pb-link-btn" onClick={() => setGiftCodeOpen(true)}>
                  Have a gift card code?
                </button>
              </div>
            ) : (
              <div className="pb-field">
                <label className="pb-label" htmlFor="pb-gift-code">Gift card (optional)</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input id="pb-gift-code" className="pb-input" value={giftCardCode}
                    onChange={(e) => { setGiftCardCode(e.target.value); setGiftCardChecked(null); setGiftCardErr(null); }}
                    placeholder="ABCD-1234-EFGH" disabled={!!giftCardChecked} autoComplete="off"
                    style={{ fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase', opacity: giftCardChecked ? 0.6 : 1 }}/>
                  {giftCardChecked ? (
                    <button type="button" className="pb-btn outline"
                      onClick={() => { setGiftCardChecked(null); setGiftCardCode(''); }}>
                      Remove
                    </button>
                  ) : (
                    <button type="button" className="pb-btn outline" disabled={!giftCardCode.trim()}
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
                <div className="pb-hint">
                  {giftCardChecked
                    ? `Balance available: $${(giftCardChecked.balanceCents / 100).toFixed(2)}. We'll redeem up to your booking total from this card the moment you book.`
                    : 'Paste a gift card code to apply credit.'}
                </div>
                {giftCardErr && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>{giftCardErr}</div>}
              </div>
            )}

            <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
              Already have a package or membership with {bizName || 'this business'}?{' '}
              <a href="/signin?next=/me" style={{ color: 'var(--accent)', fontWeight: 600 }}
                {...(embedded ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>Sign in</a>{' '}
              to book with your credits instead.
            </div>

            {!embedded && (
              <label className="pb-check" style={{ marginBottom: 8 }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}/>
                <span>Remember my name, email and phone on this device</span>
              </label>
            )}

            {/* Money summary + policy BEFORE the commit button: nobody should
                tap "Confirm booking" without seeing the total, what their
                gift card covers, and what happens next payment-wise. */}
            {!waitlistMode && (() => {
              if (total <= 0) return null;
              const giftApplied = giftCardChecked
                ? Math.min(Number(giftCardChecked.balanceCents || 0) / 100, total) : 0;
              let deposit = 0;
              if (svc.depositType === 'percent') deposit = total * Number(svc.depositAmount || 0) / 100;
              else if (svc.depositType === 'fixed') deposit = Math.min(Number(svc.depositAmount || 0), total);
              else if (svc.depositType === 'full') deposit = total;
              const depositDue = Math.max(0, Math.round((deposit - giftApplied) * 100) / 100);
              return (
                <div className="pb-total">
                  <div className="row"><span>{svc.name}{addOnTotal > 0 ? ' + add-ons' : ''}</span><b>${total.toFixed(2)}</b></div>
                  {giftApplied > 0 && (
                    <div className="row" style={{ color: 'var(--ok)' }}>
                      <span>Gift card (applied when you book)</span><b>-${giftApplied.toFixed(2)}</b>
                    </div>
                  )}
                  <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 4 }}>
                    <span>Due now</span>
                    <b>{depositDue > 0 ? `$${depositDue.toFixed(2)} deposit` : '$0.00'}</b>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                    {depositDue > 0
                      ? "You'll be taken to a secure payment page after confirming. The rest is due at your appointment."
                      : giftApplied >= total
                        ? 'Fully covered by your gift card - nothing due at your appointment.'
                        : 'Nothing due now - pay at your appointment.'}
                  </div>
                  <PolicyNote svc={svc} total={total}/>
                </div>
              );
            })()}
            {(waitlistMode || total <= 0) && <div style={{ marginBottom: 14 }}><PolicyNote svc={svc} total={total}/></div>}
            <PolicyConsent consent={consent} svc={svc} total={total} bizName={bizName}/>

            {bookErr && (
              <div className="pb-error" role="alert">
                <span style={{ flex: 1 }}>{bookErr}</span>
                {/full|taken|just/i.test(bookErr) && (
                  <button type="button" onClick={() => book(true)} disabled={busy} className="pb-btn outline">
                    {busy ? '…' : 'Join the waitlist'}
                  </button>
                )}
              </div>
            )}
            <div className="pb-form-actions">
              <button type="button" className="pb-btn outline" onClick={backToPick}>
                <Icons.ArrowLeft size={14}/> Back
              </button>
              <button type="submit" className="pb-btn primary" disabled={!name.trim() || !email.trim() || busy || !consent.ready}>
                {busy
                  ? (waitlistMode ? 'Joining…' : 'Confirming…')
                  : (waitlistMode ? 'Join the waitlist' : 'Confirm booking')}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <>
          {/* No services but things to buy: show those first. */}
          {!hasServices && hasOfferings && (
            <MoreFrom cal={cal} embedded={embedded} defaultOpen heading={null}
              onBuyPackage={setBuyingPackage} onJoinMembership={setJoiningMembership}
              onBuyProgram={setBuyingProgram} onGiftCard={() => setGiftCardOpen(true)}/>
          )}
          {!hasServices && (cal.businessType === 'product' || !hasOfferings) && (
            <NoServices cal={cal}/>
          )}

          {hasServices && (
            <section className="pb-card" aria-labelledby="pb-svc-h">
              <h2 className="pb-h2" id="pb-svc-h"><span className="pb-num">1</span> Choose a service</h2>
              <ServiceList services={listed} selectedId={serviceId} onSelect={chooseService}/>
            </section>
          )}

          {hasServices && (
            <section className="pb-card" ref={timesRef} aria-labelledby="pb-time-h">
              <h2 className="pb-h2" id="pb-time-h">
                <span className="pb-num">2</span> {svc ? `Pick a time for ${svc.name}` : 'Pick a time'}
              </h2>
              {!svc ? (
                <div className="pb-empty-day">Choose a service above to see open times.</div>
              ) : (
                <>
                  {!nextAvail && (
                    <div className="pb-empty-day" style={{ marginBottom: 14 }}>
                      No open times in the next {limit} days.
                      {!embedded && <> <button type="button" className="pb-link-btn" onClick={() => setContactOpen(true)}>Message {bizName || 'the business'}</button> to ask about other times.</>}
                    </div>
                  )}
                  <DateTimePicker
                    days={days}
                    selectedDateISO={selectedDateISO}
                    onSelectDate={selectDate}
                    slot={slot}
                    onSelectTime={selectTime}
                    nextAvail={nextAvail}
                    onNextAvail={goNextAvail}
                    canLoadMore={shownCount < limit}
                    onLoadMore={() => setDayCount((c) => Math.min(limit, c + DAYS_PER_LOAD))}
                    onWaitlist={joinWaitlistFor}
                    bizTz={bizTz}
                    viewerTz={viewerTz}
                    bizName={bizName}
                  />
                  <div className="pb-tz">{tzNote} Instant confirmation.</div>
                  <PolicyNote svc={svc}/>
                  {slot && (
                    <div className="pb-picked">
                      <div className="pb-picked-text">
                        <b>{svc.name} · {fmtPrice(svc.price)}</b>
                        <small>{longDate(slotDate)}, {slotDual}</small>
                      </div>
                      <button type="button" className="pb-btn primary" onClick={goDetails}>
                        Continue <Icons.Arrow size={14}/>
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {hasServices && (
            <MoreFrom cal={cal} embedded={embedded} defaultOpen={!isNarrow}
              heading={`More from ${bizName || 'this business'}`}
              onBuyPackage={setBuyingPackage} onJoinMembership={setJoiningMembership}
              onBuyProgram={setBuyingProgram} onGiftCard={() => setGiftCardOpen(true)}/>
          )}

          {step === 'pick' && !embedded && (
            <StickyBar svc={svc} slot={slot} dateObj={slotDate}
              extra={slotZone.differs ? `That's ${slotZone.viewerFull} your time` : null}
              onContinue={goDetails}/>
          )}
        </>
      )}

      {/* Reviews: social proof while the visitor is still deciding. */}
      {step !== 'confirmed' && step !== 'waitlisted' && cal.reviews?.count > 0 && !embedded && (
        <ReviewsBlock summary={cal.reviews}/>
      )}
    </PageWrap>
  );
}

function Notice({ tone = null, icon = null, onDismiss, children }) {
  const style = tone === 'danger'
    ? { background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)', color: 'var(--danger)' }
    : tone === 'ok'
      ? { background: 'color-mix(in srgb, var(--ok) 10%, var(--surface))', border: '1px solid color-mix(in srgb, var(--ok) 40%, var(--border))', color: 'var(--fg-2)' }
      : { background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--fg-2)' };
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '11px 14px', borderRadius: 10, marginBottom: 14,
      fontSize: 13.5, lineHeight: 1.5, ...style,
    }}>
      {icon}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="btn btn-ghost"
        style={{ padding: 8, color: 'var(--muted)', marginTop: -6, marginRight: -6 }}>
        <Icons.X size={14}/>
      </button>
    </div>
  );
}

function NoServices({ cal }) {
  return (
    <section className="pb-card">
      {cal.businessType === 'product' ? (
        <div style={{ padding: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
            This business doesn't take appointments.
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.55 }}>
            They sell products - visit their shop to see what's in stock.
          </div>
          {cal.websiteHandle && (
            <a className="pb-btn primary" href={`/site/${encodeURIComponent(cal.websiteHandle)}`}>
              Visit shop →
            </a>
          )}
        </div>
      ) : (
        <div style={{ color: 'var(--muted)', fontSize: 14 }}>
          This business hasn't published any services yet.
          {cal.websiteHandle && (
            <> <a href={`/site/${encodeURIComponent(cal.websiteHandle)}`} style={{ color: 'var(--accent)' }}>
              Visit their site →
            </a></>
          )}
        </div>
      )}
    </section>
  );
}

function ReviewsBlock({ summary }) {
  const avg = summary.avg ? Number(summary.avg).toFixed(1) : null;
  return (
    <section id="reviews" className="card" style={{ padding: 22, marginTop: 18, scrollMarginTop: 16 }}>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 12 }}>
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
              - {r.reviewerName}
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
    </section>
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

// Only accept a plain 3/6/8-digit hex so an owner's stored value can never
// inject arbitrary CSS. Returns null when it doesn't match.
function safeHex(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?$/.test(c.trim())
    ? c.trim() : null;
}
// Readable ink (text) color on top of a given accent, by luminance.
function inkFor(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#111111' : '#ffffff';
}

function PageWrap({ tweaks, embedded, accentColor, children }) {
  // Embed mode: transparent background + tight padding so the host site's
  // container styling shows through (see .pb-embedded).
  //
  // Owner branding: when a valid accent color is set we override the theme
  // --accent (plus a readable --accent-ink and a soft tint) for the whole
  // booking page, so buttons and highlights match the owner's brand.
  const accent = safeHex(accentColor);
  const brandVars = accent ? {
    '--accent': accent,
    '--accent-ink': inkFor(accent),
    '--accent-soft': `color-mix(in srgb, ${accent} 16%, var(--surface))`,
  } : undefined;
  return (
    <div className={`app-root dir-${tweaks.direction} pb-root${embedded ? ' pb-embedded' : ''}`} style={brandVars}>
      <div className="pb-wrap">{children}</div>
    </div>
  );
}

// Form field. Text inputs are wrapped in their <label>; a group of controls
// (checkboxes) uses a fieldset + legend instead.
function Field({ label, hint, children, group = false }) {
  if (group) {
    return (
      <fieldset className="pb-field">
        <legend className="pb-label">{label}</legend>
        {children}
        {hint && <div className="pb-hint">{hint}</div>}
      </fieldset>
    );
  }
  return (
    <div className="pb-field">
      <label>
        <span className="pb-label">{label}</span>
        {children}
      </label>
      {hint && <div className="pb-hint">{hint}</div>}
    </div>
  );
}

const inputSty = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};

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
          Card details are entered on Stripe's secure checkout - never on this page.
        </div>
      </form>
    </div>
  );
}

function BuyPackageModal({ slug, pkg, bizName, onClose }) {
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
      const res = await fetch('/api/packages/checkout', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          packageId: pkg.id,
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
          }}><Icons.Gift size={16} sw={1.8}/></div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Buy {pkg.name}</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              ${Number(pkg.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              {' · '}{pkg.sessionCount} session{pkg.sessionCount === 1 ? '' : 's'}
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
        <Field label="Email" hint="Your package + receipt are sent here.">
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
          Card details are entered on Stripe's secure checkout - never on this page.
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
          <div style={{
            display: 'grid',
            // 4 cols on tablet+, 2 cols on phones so each amount
            // button has a sane touch target without needing to
            // shrink the font.
            gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))',
            gap: 6,
          }}>
            {[2500, 5000, 7500, 10000, 15000, 20000, 25000, 50000].map((cents) => (
              <button key={cents} type="button" onClick={() => setAmount(cents)}
                style={{
                  padding: '12px 8px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  minHeight: 44,
                  border: `1px solid ${amount === cents ? 'var(--accent)' : 'var(--border-strong)'}`,
                  background: amount === cents ? 'var(--accent)' : 'var(--surface-2)',
                  color: amount === cents ? 'var(--accent-ink)' : 'var(--fg-2)',
                  cursor: 'pointer',
                }}>${(cents / 100).toFixed(0)}</button>
            ))}
          </div>
        </Field>

        <div className="form-2col" style={{ marginTop: 12 }}>
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
          {busy ? 'Opening checkout…' : `Continue - $${(amount / 100).toFixed(2)}`}
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
                We'll reply by email - usually within a day.
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
              Got it - your message is on its way to <b>{bizName || 'them'}</b>.
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


// ── Programs (courses, plans, communities) sold from the booking page ──
const fmtProgramPrice = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 }).format((cents || 0) / 100);
const programBilling = (b) => b === 'month' ? '/ month' : b === 'year' ? '/ year' : 'one-time';

function ProgramBuyModal({ program, bizName, onClose }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) { setErr('Both fields are required'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/programs/checkout', {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId: program.id, name: name.trim(), email: email.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      window.location.href = j.url;
    } catch (ex) { setErr(ex.message); setBusy(false); }
  };
  return (
    <div role="dialog" aria-modal="true" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card" style={{ width: '100%', maxWidth: 420, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{program.title}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{fmtProgramPrice(program.priceCents)} {programBilling(program.billing)} · paid to {bizName} through Stripe</div>
        <input className="input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus/>
        <input className="input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"/>
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Opening checkout…' : program.billing === 'one_time' ? 'Continue to payment' : 'Subscribe'}</button>
        </div>
      </form>
    </div>
  );
}
