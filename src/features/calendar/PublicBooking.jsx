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
  const [step, setStep] = useState('pick');     // 'pick' | 'details' | 'confirmed'
  const [name, setName]   = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [busy, setBusy]   = useState(false);
  const [bookErr, setBookErr] = useState(null);

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
      const r = await api.post('/calendar/public/' + encodeURIComponent(slug), {
        serviceId: svc.id,
        date: slot.dateISO,
        startMin: slot.start,
        endMin: slot.end,
        clientName: name,
        clientEmail: email,
        clientPhone: phone.trim() || null,
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
          <div className="metric-label" style={{ marginBottom: 4 }}>Confirm</div>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 18 }}>
            {svc?.name} · {parseISO(slot.dateISO).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · {minToHM(slot.start)}
          </div>
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
            <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setStep('pick')}>
              ← Back
            </button>
            <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}
              disabled={!name.trim() || !email.trim() || busy} onClick={() => book(false)}>
              {busy ? 'Confirming…' : 'Confirm booking'}
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
                    <button key={s.id} onClick={() => setServiceId(s.id)} style={{
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
              const slots = svc ? slotsForDate(cal, d, svc).filter((s) => s.available) : [];
              const today = new Date(); today.setHours(0, 0, 0, 0);
              const isPast = d < today;
              return (
                <div key={i} className="card" style={{
                  padding: 10, display: 'flex', flexDirection: 'column', gap: 6,
                  opacity: isPast ? 0.4 : 1,
                }}>
                  <div style={{ textAlign: 'center', paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                    <div className="metric-label" style={{ fontSize: 10 }}>{WEEKDAYS_SHORT[d.getDay()]}</div>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 500 }}>{d.getDate()}</div>
                  </div>
                  {isPast ? null : slots.length === 0 ? (
                    <div style={{ fontSize: 10, color: 'var(--muted-2)', textAlign: 'center', padding: '8px 0' }}>No slots</div>
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
