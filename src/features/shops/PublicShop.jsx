// /shop/:slug - the public page for one location with several independent
// Ivy businesses. One request (GET /api/shop/:slug/data) brings the shop,
// every listed pro with its own public booking data, and the honest,
// count-weighted rating. Everything live (next available per pro, first
// available across the shop, "any pro this week") is computed here with
// the booking page's own slot helpers, so it can never disagree with a
// pro's own page.
//
// Booking hands off to the pro's own booking page (/book/:slug?shop=...)
// with the chosen service and time, so their deposit, policy, intake and
// confirmation flow run exactly as they set them up. The pro is shown
// before anything is confirmed.
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';
import ArchivedBusinessCard from '../../components/ArchivedBusiness.jsx';
import { mapsUrl, telHref } from '../calendar/publicBookingHelpers.js';
import { TEMPLATES } from '../website/templates.js';
import {
  groupServices, sectionServices, nextForMember, nextForMemberAny, firstAvailable, weekSlots, nextLabel, relativeDay,
  openStatus, hoursLines, shopRating, searchTeam, minToHM, fmtPrice, fmtDuration, WEEKDAYS,
} from './shopHelpers.js';
import '../calendar/publicBooking.css';
import './publicShop.css';

const AMENITY_LABELS = {
  parking: 'Parking', street_parking: 'Street parking', walk_ins: 'Walk-ins welcome', by_appointment: 'By appointment only',
  wheelchair: 'Wheelchair access', kids_welcome: 'Kids welcome', card_payments: 'Card payments', wifi: 'Free Wi-Fi',
  restroom: 'Restroom', refreshments: 'Refreshments', pet_friendly: 'Pet friendly', transit: 'Near public transit',
  open_late: 'Open late', gender_neutral_pricing: 'Gender neutral pricing',
};

function safeHex(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?$/.test(c.trim()) ? c.trim() : null;
}
function inkFor(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#111111' : '#ffffff';
}

// The pro's own booking page, preloaded with service (+ time) and the shop.
export function bookHref(shop, member, service = null, slot = null) {
  const p = new URLSearchParams();
  p.set('shop', shop.slug);
  if (service) p.set('service', service.id);
  if (slot) { p.set('date', slot.dateISO); p.set('start', String(slot.start)); }
  return `${member.bookUrl}?${p.toString()}`;
}

export default function PublicShop() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [tweaks] = useTweaks();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let live = true;
    setLoading(true); setErr(null);
    api.get(`/shop/${encodeURIComponent(slug)}/data`)
      .then((r) => { if (live) { setData(r); setNow(new Date()); } })
      .catch((e) => live && setErr(e))
      .finally(() => live && setLoading(false));
    // One page view per visit; the server throttles repeats.
    api.post(`/shop/${encodeURIComponent(slug)}/pv`, {}).catch(() => {});
    return () => { live = false; };
  }, [slug]);

  // Keep "Next: today 3:30 pm" honest while the tab stays open.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (data?.shop?.name) document.title = `${data.shop.name}${data.shop.city ? ` · ${data.shop.city}` : ''}`;
  }, [data]);

  const accent = useMemo(() => {
    const theme = data?.shop?.settings?.theme;
    const tpl = TEMPLATES[theme];
    return safeHex(tpl?.vars?.['--site-accent']);
  }, [data]);
  const brandVars = accent ? {
    '--accent': accent, '--accent-ink': inkFor(accent),
    '--accent-soft': `color-mix(in srgb, ${accent} 16%, var(--surface))`,
  } : undefined;

  if (loading) {
    return (
      <div className={`app-root dir-${tweaks.direction} pb-root sh-root`}>
        <div className="pb-wrap" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading the shop…</div>
      </div>
    );
  }
  if (err || !data) {
    return (
      <div className={`app-root dir-${tweaks.direction} pb-root sh-root`}>
        <div className="pb-wrap"><div className="pb-card">
          <EmptyNote icon="Store" title="No shop page at this address"
            hint={err?.status === 404 ? 'Check the link, or ask the shop for their page.' : (err?.message || 'Please try again in a moment.')}/>
        </div></div>
      </div>
    );
  }
  if (data.archived) {
    return (
      <div className={`app-root dir-${tweaks.direction} pb-root sh-root`}>
        <div className="pb-wrap"><ArchivedBusinessCard businessName={data.shop?.name}/></div>
      </div>
    );
  }

  return (
    <div className={`app-root dir-${tweaks.direction} pb-root sh-root`} style={brandVars}>
      <div className="pb-wrap">
        <ShopBody data={data} now={now} navigate={navigate}/>
      </div>
    </div>
  );
}

function ShopBody({ data, now, navigate }) {
  const { shop, members, rating: ratingFromServer } = data;
  const settings = shop.settings || {};
  const groups = useMemo(() => groupServices(members), [members]);
  const sections = useMemo(() => sectionServices(groups), [groups]);
  const rating = ratingFromServer || shopRating(members);
  const status = openStatus(shop.hours, shop.timezone, now);
  const [groupKey, setGroupKey] = useState(null);
  const [who, setWho] = useState('any'); // 'any' | member id
  const [week, setWeek] = useState(false);
  const [ask, setAsk] = useState('');
  const [askDay, setAskDay] = useState(null);
  const [hoursOpen, setHoursOpen] = useState(false);

  const group = groups.find((g) => g.key === groupKey) || null;
  const nextByMember = useMemo(() => {
    const m = new Map();
    for (const mem of members) m.set(mem.id, nextForMemberAny(mem, now));
    return m;
  }, [members, now]);

  const search = useMemo(() => (ask.trim() || askDay != null ? searchTeam(members, ask, askDay) : null), [members, ask, askDay]);
  const shownMembers = search ? search.matches.map((x) => x.member) : members;

  const soonest = useMemo(() => {
    if (!group) return null;
    if (who === 'any') return firstAvailable(group, members, now);
    const m = members.find((x) => x.id === who);
    const entry = group.entries.find((e) => e.memberId === who);
    const svc = m?.services.find((s) => s.id === entry?.serviceId);
    return m && svc ? nextForMember(m, svc, now) : null;
  }, [group, who, members, now]);
  const weekList = useMemo(() => (group && week ? weekSlots(group, who === 'any' ? members : members.filter((m) => m.id === who), now, { days: 7, max: 40 }) : []), [group, week, who, members, now]);

  const pickGroup = (g) => {
    setGroupKey(g.key === groupKey ? null : g.key);
    setWho('any');
    setWeek(false);
  };
  const go = (pick) => {
    if (!pick) return;
    navigate(bookHref(shop, pick.member, pick.service, { dateISO: pick.dateISO, start: pick.slot ? pick.slot.start : pick.start }));
  };
  const scrollTo = (id) => {
    try { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* old engines */ }
  };
  const mapHref = shop.addressLabel ? mapsUrl(shop.addressLabel) : null;
  const tel = telHref(shop.phone);
  const allReviews = useMemo(() => members
    .flatMap((m) => (m.reviews?.recent || []).map((r) => ({ ...r, who: m.firstName || m.businessName })))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12), [members]);

  return (
    <>
      <header className="sh-hero">
        {shop.photos?.length > 0 && (
          <div className="sh-photos" aria-label={`Photos of ${shop.name}`}>
            {shop.photos.map((u, i) => <img key={u} src={u} alt={i === 0 ? shop.name : ''} loading={i === 0 ? 'eager' : 'lazy'}/>)}
          </div>
        )}
        <h1 className="sh-name">{shop.name}</h1>
        {shop.tagline && <p className="sh-tagline">{shop.tagline}</p>}
        <div className="sh-meta">
          {rating.count > 0 && rating.avg && (
            <a href="#reviews" className="sh-rating" aria-label={`Rated ${rating.avg.toFixed(1)} out of 5 from ${rating.count} reviews across the team`}>
              <span className="pb-stars" aria-hidden="true">★</span>
              <span><b>{rating.avg.toFixed(1)}</b> ({rating.count} review{rating.count === 1 ? '' : 's'} across the team)</span>
            </a>
          )}
          {mapHref && (
            <a href={mapHref} target="_blank" rel="noopener noreferrer"><Icons.Home size={13} sw={1.8}/><span>{shop.addressLabel}</span></a>
          )}
          {status.label && (
            <button type="button" className={`pb-link-btn ${status.open ? 'sh-open' : 'sh-closed'}`} onClick={() => setHoursOpen((o) => !o)} aria-expanded={hoursOpen}>
              <Icons.Clock size={13} sw={1.8}/> {status.label}
            </button>
          )}
          {tel && <a href={tel}><Icons.Phone size={13} sw={1.8}/><span>{shop.phone}</span></a>}
        </div>
        {hoursOpen && (
          <ul className="pb-policy" style={{ listStyle: 'none', padding: '10px 12px', margin: '10px 0 0' }}>
            {hoursLines(shop.hours).map((l) => (
              <li key={l.day} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>{l.day}</span><span>{l.text}</span></li>
            ))}
          </ul>
        )}
        {shop.amenities?.length > 0 && (
          <div className="sh-amenities">
            {shop.amenities.map((a) => <span key={a} className="pb-chip">{AMENITY_LABELS[a] || a}</span>)}
          </div>
        )}
        <div className="sh-hero-actions">
          <button type="button" className="pb-btn primary" onClick={() => scrollTo('book')}>Book now</button>
          <button type="button" className="pb-btn outline" onClick={() => scrollTo('team')}>Meet the team</button>
        </div>
      </header>

      {members.length > 1 && (
        <section className="pb-card sh-ask" aria-label="Find the right pro">
          <div className="sh-ask-row">
            <Icons.Search size={15}/>
            <input className="pb-input" type="search" value={ask} onChange={(e) => setAsk(e.target.value.slice(0, 120))}
              placeholder="Who does fades on Saturdays?" aria-label="Search the team by service and day"/>
          </div>
          <div className="sh-days" role="group" aria-label="Day of the week">
            <button type="button" className={`sh-day-chip${askDay == null ? ' on' : ''}`} onClick={() => setAskDay(null)}>Any day</button>
            {WEEKDAYS.map((d, i) => (
              <button key={d} type="button" className={`sh-day-chip${askDay === i ? ' on' : ''}`} onClick={() => setAskDay(askDay === i ? null : i)}>{d.slice(0, 3)}</button>
            ))}
          </div>
          {search && (
            <div className="sh-ask-result" aria-live="polite">
              {search.matches.length === 0
                ? <>No one on the team matches that{search.weekday != null ? ` on ${WEEKDAYS[search.weekday]}s` : ''}. Try another word or day.</>
                : <>{search.matches.length === 1 ? 'One pro' : `${search.matches.length} pros`} match{search.weekday != null ? ` on ${WEEKDAYS[search.weekday]}s` : ''}: {search.matches.map((x) => `${x.member.firstName || x.member.businessName} (${x.services.map((s) => s.name).join(', ')})`).join('; ')}.</>}
            </div>
          )}
        </section>
      )}

      <section id="team" className="pb-card" aria-labelledby="sh-team-h" style={{ scrollMarginTop: 12 }}>
        <h2 className="pb-h2" id="sh-team-h">The team</h2>
        {members.length === 0 ? (
          <div className="pb-empty-day">No one is listed on this page yet.</div>
        ) : (
          <div className="sh-team">
            {shownMembers.map((m) => <ProCard key={m.id} m={m} shop={shop} next={nextByMember.get(m.id)} now={now} showPrices={settings.showPrices !== false}/>)}
          </div>
        )}
      </section>

      <section id="book" className="pb-card" aria-labelledby="sh-book-h" style={{ scrollMarginTop: 12 }}>
        <h2 className="pb-h2" id="sh-book-h">Book a service</h2>
        {groups.length === 0 ? (
          <div className="pb-empty-day">Nothing to book online yet. {shop.phone ? `Call ${shop.phone}.` : ''}</div>
        ) : sections.map((sec) => (
          <div key={sec.title || 'all'}>
            {sec.title && <div className="sh-section-title">{sec.title}</div>}
            <div className="sh-svc-list">
              {sec.groups.map((g) => {
                const selected = g.key === groupKey;
                return (
                  <React.Fragment key={g.key}>
                    <button type="button" className={`sh-svc${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={() => pickGroup(g)}>
                      <span className="sh-svc-name">{g.name}</span>
                      <span className="sh-svc-meta">
                        {settings.showPrices !== false && !g.hidePrice && <b>{g.fromPrice === g.maxPrice ? fmtPrice(g.fromPrice) : `from ${fmtPrice(g.fromPrice)}`}</b>}
                        {g.members.length === 1 ? g.members[0].firstName : `${g.members.length} pros`} · {fmtDuration(g.minDuration)}
                      </span>
                    </button>
                    {selected && (
                      <div className="sh-pick">
                        <div className="sh-pick-title">Who with?</div>
                        <div className="sh-who" role="group" aria-label="Choose a pro">
                          {settings.firstAvailable !== false && g.members.length > 1 && (
                            <button type="button" className={`sh-who-chip${who === 'any' ? ' on' : ''}`} onClick={() => setWho('any')}>
                              <Icons.Spark size={13} sw={2}/> First available
                            </button>
                          )}
                          {g.entries.map((e) => {
                            const m = members.find((x) => x.id === e.memberId);
                            if (!m) return null;
                            const on = who === m.id || (who === 'any' && (settings.firstAvailable === false || g.members.length === 1));
                            return (
                              <button key={m.id} type="button" className={`sh-who-chip${on ? ' on' : ''}`}
                                onClick={() => setWho(m.id)}>
                                {m.firstName || m.businessName}
                                {settings.showPrices !== false && e.price != null && g.fromPrice !== g.maxPrice && <small>{fmtPrice(e.price)}</small>}
                              </button>
                            );
                          })}
                        </div>
                        {soonest ? (
                          <div className="sh-soonest">
                            <div className="sh-soonest-text">
                              <b>{who === 'any' && g.members.length > 1 ? 'Soonest: ' : 'Next: '}{soonest.member.firstName || soonest.member.businessName} · {relativeDay(soonest.dateISO, shop.timezone, now)} {minToHM(soonest.slot.start)}</b>
                              <span>
                                {soonest.service.name} · {fmtDuration(soonest.service.durationMinutes)}
                                {settings.showPrices !== false && !soonest.service.hidePrice && ` · ${fmtPrice(soonest.service.price)}`}
                                {' '}with {soonest.member.businessName}
                              </span>
                            </div>
                            <button type="button" className="pb-btn primary" onClick={() => go(soonest)}>
                              Continue with {soonest.member.firstName || soonest.member.businessName}
                            </button>
                          </div>
                        ) : (
                          <div className="pb-empty-day" style={{ marginTop: 12 }}>
                            No open times for this right now. You can still open a pro's own page and join their waitlist.
                          </div>
                        )}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                          <button type="button" className="pb-link-btn" onClick={() => setWeek((w) => !w)} aria-expanded={week}>
                            {week ? 'Hide times' : (who === 'any' ? 'Any pro, any time this week' : 'All times this week')}
                          </button>
                          {who !== 'any' && (() => {
                            const m = members.find((x) => x.id === who);
                            const entry = g.entries.find((e) => e.memberId === who);
                            return m ? <Link className="pb-link-btn" to={bookHref(shop, m, m.services.find((s) => s.id === entry?.serviceId))}>Open {m.firstName || m.businessName}'s page</Link> : null;
                          })()}
                        </div>
                        {week && (
                          weekList.length === 0 ? (
                            <div className="pb-empty-day" style={{ marginTop: 12 }}>Nothing open in the next 7 days.</div>
                          ) : (
                            <div className="sh-week">
                              {weekList.map((s) => (
                                <button key={`${s.member.id}-${s.dateISO}-${s.start}`} type="button" className="sh-week-slot" onClick={() => go(s)}>
                                  <b>{minToHM(s.start)}</b>
                                  <span>{relativeDay(s.dateISO, shop.timezone, now)}</span>
                                  <small>{s.member.firstName || s.member.businessName}</small>
                                </button>
                              ))}
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        ))}
        {settings.bookingRulesNote && <p className="sh-note">{settings.bookingRulesNote}</p>}
        <p className="sh-note">You book directly with the pro you choose, at their prices and under their policies. You will see who it is before anything is confirmed.</p>
      </section>

      {shop.description && (
        <section className="pb-card" aria-labelledby="sh-about-h">
          <h2 className="pb-h2" id="sh-about-h">About {shop.name}</h2>
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: 'var(--fg-2)', whiteSpace: 'pre-line' }}>{shop.description}</p>
        </section>
      )}

      {settings.showReviews !== false && allReviews.length > 0 && (
        <section id="reviews" className="pb-card" aria-labelledby="sh-reviews-h" style={{ scrollMarginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <h2 className="pb-h2" id="sh-reviews-h" style={{ margin: 0 }}>Reviews</h2>
            {rating.avg && (
              <>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 22 }}>{rating.avg.toFixed(1)}</span>
                <Stars rating={rating.avg} size={14}/>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rating.count} review{rating.count === 1 ? '' : 's'}</span>
              </>
            )}
          </div>
          <p className="sh-note" style={{ marginTop: 0 }}>Reviews come from clients of each pro. The shop rating is the average of every review, weighted by count.</p>
          <div className="sh-reviews">
            {allReviews.map((r) => (
              <div key={r.id} className="sh-review">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Stars rating={r.rating} size={11}/>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span>
                </div>
                {r.text && <p>"{r.text}"</p>}
                <div className="sh-review-who">{r.reviewerName} · about <b>{r.who}</b></div>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="sh-foot">
        Each pro on this page runs their own business on Ivy. Your booking, your details and your payment go to the pro you choose, never to the shop.
        <br/><a href="https://www.joinivy.ai">Run your business on Ivy</a>
      </footer>
    </>
  );
}

function ProCard({ m, shop, next, now, showPrices }) {
  const letter = (m.proName || m.businessName || '?').trim()[0]?.toUpperCase() || '?';
  const from = m.services.length ? Math.min(...m.services.map((s) => Number(s.price || 0))) : null;
  const avg = m.reviews?.count > 0 && m.reviews?.avg ? Number(m.reviews.avg) : null;
  return (
    <article className={`sh-pro${m.featured ? ' featured' : ''}`} aria-label={m.proName || m.businessName}>
      {m.featured && <span className="sh-featured-tag">Featured</span>}
      <div className="sh-pro-top">
        {m.photoUrl ? <img className="sh-avatar" src={m.photoUrl} alt="" width="56" height="56" loading="lazy"/> : <div className="sh-avatar-letter" aria-hidden="true">{letter}</div>}
        <div style={{ minWidth: 0 }}>
          <div className="sh-pro-name">{m.proName || m.businessName}</div>
          {m.title && <div className="sh-pro-title">{m.title}</div>}
          {m.businessName && m.businessName !== m.proName && <div className="sh-pro-biz">{m.businessName}</div>}
        </div>
      </div>
      {m.bio && <p className="sh-pro-bio">{m.bio}</p>}
      <div className="sh-pro-facts">
        {avg != null && <span><span className="pb-stars" aria-hidden="true">★</span> <b>{avg.toFixed(1)}</b> ({m.reviews.count})</span>}
        {showPrices && from != null && !m.services.some((s) => s.hidePrice) && <span>from <b>{fmtPrice(from)}</b></span>}
        <span>{m.services.length} service{m.services.length === 1 ? '' : 's'}</span>
      </div>
      <div className={`sh-next${next ? '' : ' none'}`}><Icons.Clock size={13} sw={2}/> {nextLabel(next, shop.timezone, now)}</div>
      <Link className="pb-btn primary" to={bookHref(shop, m)}>Book with {m.firstName || m.businessName}</Link>
    </article>
  );
}

function Stars({ rating, size = 12 }) {
  const full = Math.round(rating);
  return (
    <span aria-label={`${rating} out of 5`} style={{ display: 'inline-flex', gap: 1.5 }}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} style={{ fontSize: size, lineHeight: 1, color: i <= full ? 'var(--accent)' : 'var(--border-strong)' }}>★</span>)}
    </span>
  );
}
