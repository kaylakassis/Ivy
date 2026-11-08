// Building blocks for the public booking page (PublicBooking.jsx): header,
// progress, service list, date strip + times, sticky bar, "More from"
// sections and the loading skeleton. Pure presentation; state lives in the
// page. Styles: publicBooking.css (.pb-*).
import React, { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { minToHM, WEEKDAYS_SHORT } from './utils.js';
import {
  groupSlotsByPeriod, shortDate, longDate, nextAvailableLabel, fmtDuration, fmtPrice,
  filterServices, mapsUrl, telHref, policyLines, dualTimeLabel,
} from './publicBookingHelpers.js';

export function PinIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"/>
      <circle cx="12" cy="9.5" r="2.5"/>
    </svg>
  );
}
export function Chevron({ size = 16, className = 'pb-chev', dir = 'right' }) {
  const rot = { right: 0, left: 180, down: 90, up: -90 }[dir] || 0;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" style={rot ? { transform: `rotate(${rot}deg)` } : undefined}>
      <path d="m9 6 6 6-6 6"/>
    </svg>
  );
}

// ── Header ─────────────────────────────────────────────────────────────
export function BizHeader({ settings, reviews, phone, showAddress, onMessage }) {
  const bizName = settings.bizName || 'Your business';
  const avg = reviews?.count > 0 && reviews?.avg ? Number(reviews.avg) : null;
  const addr = showAddress ? (settings.addressLabel || '').trim() : '';
  const mapHref = addr ? mapsUrl(addr) : null;
  const tel = telHref(phone);
  return (
    <header className="pb-head">
      {settings.brandLogoUrl ? (
        <img className="pb-logo" src={settings.brandLogoUrl} alt="" width="56" height="56"/>
      ) : (
        <div className="pb-logo-letter" aria-hidden="true">{bizName[0].toUpperCase()}</div>
      )}
      <div className="pb-head-text">
        <h1 className="pb-name">{bizName}</h1>
        {settings.tagline && <p className="pb-tagline">{settings.tagline}</p>}
        <div className="pb-meta">
          {avg != null && (
            <a className="pb-meta-item" href="#reviews"
              aria-label={`Rated ${avg.toFixed(1)} out of 5 from ${reviews.count} review${reviews.count === 1 ? '' : 's'}. Read reviews`}>
              <span className="pb-stars" aria-hidden="true">★</span>
              <span><b>{avg.toFixed(1)}</b> ({reviews.count} review{reviews.count === 1 ? '' : 's'})</span>
            </a>
          )}
          {mapHref && (
            <a className="pb-meta-item" href={mapHref} target="_blank" rel="noopener noreferrer"
              aria-label={`${addr}. Open in maps`}>
              <PinIcon/><span>{addr}</span>
            </a>
          )}
          {tel && (
            <a className="pb-meta-item" href={tel} aria-label={`Call ${phone}`}>
              <Icons.Phone size={13} sw={1.8}/><span>{phone}</span>
            </a>
          )}
          {onMessage && (
            <button type="button" className="pb-msg-btn" onClick={onMessage}>
              <Icons.Chat size={13} sw={1.8}/> Message us
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

// ── Progress ───────────────────────────────────────────────────────────
const STEP_LABELS = ['Service', 'Time', 'Details', 'Done'];
export function Progress({ current }) {
  return (
    <ol className="pb-steps" aria-label="Booking steps">
      {STEP_LABELS.map((label, i) => (
        <li key={label}
          className={i < current ? 'done' : i === current ? 'current' : ''}
          aria-current={i === current ? 'step' : undefined}>
          {label}
          {i < current && <span className="pb-sr"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}

// ── Services ───────────────────────────────────────────────────────────
export function ServiceList({ services, selectedId, onSelect }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const shown = services.length > 8 ? filterServices(services, query) : services;
  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <>
      {services.length > 8 && (
        <div className="pb-search">
          <Icons.Search size={15}/>
          <input className="pb-input" type="search" value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 80))}
            placeholder="Search services" aria-label="Search services"/>
        </div>
      )}
      {shown.length === 0 && (
        <div className="pb-empty-day">No services match "{query}".</div>
      )}
      <div className="pb-services">
        {shown.map((s) => {
          const selected = s.id === selectedId;
          const open = expanded.has(s.id);
          const longDesc = (s.description || '').length > 90 || (s.description || '').includes('\n');
          const hasDeposit = s.depositType && s.depositType !== 'none'
            && (s.depositType === 'full' || Number(s.depositAmount) > 0);
          return (
            <div key={s.id} className={`pb-svc${selected ? ' selected' : ''}`}
              onClick={() => onSelect(s)}>
              <button type="button" className="pb-svc-main" aria-pressed={selected}
                onClick={(e) => { e.stopPropagation(); onSelect(s); }}>
                {s.photoUrl && (
                  <img className="pb-svc-photo" src={s.photoUrl} alt="" width="64" height="64" loading="lazy"/>
                )}
                <span className="pb-svc-body">
                  <span className="pb-svc-name" style={{ display: 'block' }}>{s.name}</span>
                  <span className="pb-svc-meta" style={{ display: 'block' }}>
                    {fmtDuration(s.durationMinutes)} · <b>{fmtPrice(s.price)}</b>
                  </span>
                  {(s.capacity > 1 || (s.locationType && s.locationType !== 'in_person') || hasDeposit) && (
                    <span className="pb-chips">
                      {s.capacity > 1 && <span className="pb-chip accent">Group · up to {s.capacity}</span>}
                      {s.locationType === 'mobile' && <span className="pb-chip accent">Comes to you</span>}
                      {s.locationType === 'virtual' && <span className="pb-chip accent">Online</span>}
                      {hasDeposit && (
                        <span className="pb-chip"><Icons.Lock size={9} sw={1.8}/>
                          {s.depositType === 'full' ? 'Pay when booking'
                            : `Deposit ${s.depositType === 'percent' ? `${Number(s.depositAmount)}%` : fmtPrice(s.depositAmount)}`}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </button>
              <span className="pb-svc-check" aria-hidden="true">
                {selected && <Icons.Check size={13} sw={3}/>}
              </span>
              {s.description && (
                <div className="pb-svc-desc">
                  <p className={open ? '' : 'clamped'}>{s.description}</p>
                  {longDesc && (
                    <button type="button" className="pb-link-btn" aria-expanded={open}
                      onClick={(e) => { e.stopPropagation(); toggle(s.id); }}>
                      {open ? 'Less' : 'More'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Date strip + times ─────────────────────────────────────────────────
const DAY_MARK = { open: 'has openings', full: 'fully booked', closed: 'closed', none: 'no times left' };

export function DateTimePicker({
  days, selectedDateISO, onSelectDate, slot, onSelectTime, nextAvail, onNextAvail,
  canLoadMore, onLoadMore, onWaitlist, bizTz, viewerTz, bizName,
}) {
  const stripRef = useRef(null);
  const btnRefs = useRef(new Map());
  const selectedIdx = Math.max(0, days.findIndex((d) => d.dateISO === selectedDateISO));
  const selected = days[selectedIdx] || null;
  const [announce, setAnnounce] = useState('');

  // Keep the chosen date in view inside the strip (never scrolls the page).
  useEffect(() => {
    const el = btnRefs.current.get(selectedDateISO);
    const strip = stripRef.current;
    if (!el || !strip) return;
    const left = el.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + el.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo({ left: Math.max(0, left - 8), behavior: 'smooth' });
    }
  }, [selectedDateISO]);

  useEffect(() => {
    if (!selected) return;
    const n = selected.slots.length;
    setAnnounce(selected.status === 'open'
      ? `${n} time${n === 1 ? '' : 's'} open on ${longDate(selected.date)}`
      : `${longDate(selected.date)}: ${DAY_MARK[selected.status]}`);
  }, [selected]);

  const onStripScroll = () => {
    const s = stripRef.current;
    if (s && canLoadMore && s.scrollLeft + s.clientWidth > s.scrollWidth - 140) onLoadMore();
  };
  const page = (dir) => {
    const s = stripRef.current;
    if (s) s.scrollBy({ left: dir * Math.max(200, s.clientWidth - 80), behavior: 'smooth' });
  };
  const onKey = (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1
      : e.key === 'Home' ? -selectedIdx : e.key === 'End' ? days.length - 1 - selectedIdx : 0;
    if (!step) return;
    e.preventDefault();
    const next = days[Math.min(days.length - 1, Math.max(0, selectedIdx + step))];
    if (!next) return;
    onSelectDate(next.dateISO);
    requestAnimationFrame(() => btnRefs.current.get(next.dateISO)?.focus());
  };

  const monthLabel = selected
    ? selected.date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : '';
  const groups = selected ? groupSlotsByPeriod(selected.slots) : [];
  const nextIsSelected = nextAvail && slot && slot.dateISO === nextAvail.dateISO && slot.start === nextAvail.slot.start;

  return (
    <>
      {nextAvail && (
        <button type="button" className={`pb-next${nextIsSelected ? ' on' : ''}`} onClick={onNextAvail}
          aria-pressed={!!nextIsSelected}>
          <Icons.Clock size={16} stroke="var(--accent)"/>
          <span style={{ flex: 1 }}>Next available: <b>{nextAvailableLabel(nextAvail)}</b></span>
          {nextIsSelected ? <Icons.Check size={16} sw={2.4} stroke="var(--accent)"/> : <Chevron/>}
        </button>
      )}

      <div className="pb-strip-head">
        <div className="pb-month" aria-hidden="true">{monthLabel}</div>
        <button type="button" className="pb-arrow" onClick={() => page(-1)} aria-label="Earlier dates">
          <Chevron dir="left" className=""/>
        </button>
        <button type="button" className="pb-arrow" onClick={() => page(1)} aria-label="Later dates">
          <Chevron className=""/>
        </button>
      </div>
      <div className="pb-strip" ref={stripRef} role="radiogroup" aria-label="Choose a date"
        onScroll={onStripScroll} onKeyDown={onKey}>
        {days.map((d, i) => {
          const isSel = i === selectedIdx;
          const first = i === 0 || d.date.getDate() === 1;
          return (
            <button key={d.dateISO} type="button" role="radio" aria-checked={isSel}
              tabIndex={isSel ? 0 : -1}
              ref={(el) => { if (el) btnRefs.current.set(d.dateISO, el); else btnRefs.current.delete(d.dateISO); }}
              className={`pb-day ${d.status}${isSel ? ' selected' : ''}`}
              aria-label={`${longDate(d.date)}, ${d.status === 'open' ? `${d.slots.length} time${d.slots.length === 1 ? '' : 's'} open` : DAY_MARK[d.status]}`}
              onClick={() => onSelectDate(d.dateISO)}>
              <span className="pb-day-wd">
                {first && i !== 0 ? d.date.toLocaleDateString('en-US', { month: 'short' }) : WEEKDAYS_SHORT[d.date.getDay()]}
              </span>
              <span className="pb-day-num">{d.date.getDate()}</span>
              <span className="pb-day-mark">
                {d.status === 'open' && <span className="pb-day-dot"/>}
                {d.status === 'full' && 'Full'}
                {d.status === 'closed' && 'Closed'}
              </span>
            </button>
          );
        })}
        {canLoadMore && (
          <button type="button" className="pb-day-more" onClick={onLoadMore}>More dates</button>
        )}
      </div>
      <div className="pb-legend" aria-hidden="true">
        <span><span className="pb-day-dot"/> Openings</span>
        <span style={{ color: 'var(--warn)', fontWeight: 650 }}>Full</span>
        <span>Closed</span>
      </div>
      <div className="pb-sr" aria-live="polite">{announce}</div>

      {selected && (
        <div>
          <h3 className="pb-day-title">{longDate(selected.date)}</h3>
          {selected.status === 'open' ? (
            groups.map((g) => (
              <div key={g.key} className="pb-period" role="group" aria-labelledby={`pb-p-${g.key}`}>
                <div className="pb-period-label" id={`pb-p-${g.key}`}>{g.label}</div>
                <div className="pb-times">
                  {g.slots.map((s) => {
                    const isSel = slot && slot.dateISO === selected.dateISO && slot.start === s.start;
                    const label = dualTimeLabel({ dateISO: selected.dateISO, startMin: s.start, bizTz, viewerTz, bizName });
                    return (
                      <button key={s.start} type="button"
                        className={`pb-time${isSel ? ' selected' : ''}`}
                        aria-pressed={!!isSel}
                        aria-label={`${label}, ${longDate(selected.date)}${s.seatsLeft != null ? `, ${s.seatsLeft} spots left` : ''}`}
                        onClick={() => onSelectTime(selected, s)}>
                        {minToHM(s.start)}
                        {s.seatsLeft != null && (
                          <small className={s.seatsLeft <= 2 ? 'low' : ''}>{s.seatsLeft} left</small>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          ) : selected.status === 'full' ? (
            <div className="pb-empty-day">
              {onWaitlist
                ? <>Every time on {shortDate(selected.date)} is taken. Join the waitlist and we'll send you a link the moment a spot opens.</>
                : <>Every time on {shortDate(selected.date)} is taken.</>}
              <div className="pb-actions">
                {onWaitlist && (
                  <button type="button" className="pb-btn warn" onClick={() => onWaitlist(selected)}>
                    <Icons.Clock size={14}/> Join the waitlist
                  </button>
                )}
                {nextAvail && (
                  <button type="button" className="pb-btn outline" onClick={onNextAvail}>
                    Next available: {nextAvailableLabel(nextAvail)}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="pb-empty-day">
              {selected.status === 'closed'
                ? `${bizName || 'This business'} isn't taking bookings on ${shortDate(selected.date)}.`
                : `There are no times left to book on ${shortDate(selected.date)}.`}
              {nextAvail && (
                <div className="pb-actions">
                  <button type="button" className="pb-btn outline" onClick={onNextAvail}>
                    Next available: {nextAvailableLabel(nextAvail)}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function PolicyNote({ svc, total }) {
  const lines = policyLines(svc, total);
  if (!lines.length) return null;
  return (
    <div className="pb-policy">
      <div className="pb-policy-title"><Icons.Lock size={12} sw={1.8}/> Booking policy</div>
      <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  );
}

// Phones: fixed bar once a time is picked.
export function StickyBar({ svc, slot, dateObj, extra = null, onContinue }) {
  // 1.0.6: a service that needs the owner's OK says so on the button.
  const cta = svc?.requireApproval ? 'Request this time' : 'Continue';
  if (!svc || !slot || !dateObj) return null;
  return (
    <div className="pb-sticky" role="region" aria-label="Your selection">
      <div className="pb-sticky-text">
        <b>{svc.name} · {fmtPrice(svc.price)}</b>
        <span>{shortDate(dateObj)}, {minToHM(slot.start)}</span>
        {extra && <small>{extra}</small>}
      </div>
      <button type="button" className="pb-btn primary" onClick={onContinue}>
        {cta} <Icons.Arrow size={14}/>
      </button>
    </div>
  );
}

// ── More from <business> ───────────────────────────────────────────────
function Accordion({ icon, title, summary, defaultOpen, children, id }) {
  const [open, setOpen] = useState(!!defaultOpen);
  useEffect(() => { setOpen(!!defaultOpen); }, [defaultOpen]);
  const Icon = Icons[icon] || Icons.Gift;
  return (
    <section className="pb-acc" data-open={open}>
      <button type="button" className="pb-acc-head" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((o) => !o)}>
        <span className="pb-acc-icon"><Icon size={16} sw={1.8}/></span>
        <span className="pb-acc-text"><b>{title}</b><span>{summary}</span></span>
        <Chevron/>
      </button>
      {open && <div className="pb-acc-body" id={id}>{children}</div>}
    </section>
  );
}

const money0 = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fromPrice = (vals) => {
  const v = vals.filter((x) => Number(x) > 0);
  if (!v.length) return '';
  return `from ${money0(Math.min(...v))}`;
};
const countLabel = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmtProgramPrice = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 }).format((cents || 0) / 100);
const programBilling = (b) => b === 'month' ? '/ month' : b === 'year' ? '/ year' : 'one-time';

export function MoreFrom({
  cal, embedded, defaultOpen, heading, onBuyPackage, onJoinMembership, onBuyProgram, onGiftCard,
}) {
  const showMemberships = !embedded && cal.memberships?.length > 0;
  const showPackages = !embedded && cal.packages?.length > 0;
  const showPrograms = !embedded && cal.programs?.length > 0;
  const showGift = cal.giftCardsAvailable !== false;
  if (!showMemberships && !showPackages && !showPrograms && !showGift) return null;
  const nameById = new Map((cal.services || []).map((s) => [s.id, s.name]));
  return (
    <div>
      {heading && <h2 className="pb-more-title">{heading}</h2>}
      {showPackages && (
        <Accordion id="pb-acc-packages" icon="Gift" defaultOpen={defaultOpen} title="Packages"
          summary={[countLabel(cal.packages.length, 'package', 'packages'), fromPrice(cal.packages.map((p) => p.price))].filter(Boolean).join(' · ')}>
          {cal.packages.map((p) => {
            const scoped = (p.serviceIds || []).map((id) => nameById.get(id)).filter(Boolean);
            const scope = scoped.length === 0 ? 'Any service'
              : scoped.length <= 2 ? scoped.join(' or ') : `${scoped.slice(0, 2).join(', ')} +${scoped.length - 2} more`;
            const per = p.price > 0 && p.sessionCount > 1 ? p.price / p.sessionCount : null;
            return (
              <div key={p.id} className="pb-item">
                <div className="pb-item-name">{p.name}</div>
                <div className="pb-item-price">
                  <b>{money0(p.price)}</b> <span>· {countLabel(p.sessionCount, 'session', 'sessions')}{per ? ` (${money0(per)} each)` : ''}</span>
                </div>
                {p.description && <p className="pb-item-desc">{p.description}</p>}
                <div className="pb-item-sub">
                  Good for: {scope}{p.expiryDays ? ` · Use within ${p.expiryDays} day${p.expiryDays === 1 ? '' : 's'}` : ''}
                </div>
                <div className="pb-item-actions">
                  <button type="button" className="pb-btn primary" onClick={() => onBuyPackage(p)}>Buy</button>
                </div>
              </div>
            );
          })}
        </Accordion>
      )}
      {showMemberships && (
        <Accordion id="pb-acc-memberships" icon="Heart" defaultOpen={defaultOpen} title="Memberships"
          summary={[countLabel(cal.memberships.length, 'membership', 'memberships'), fromPrice(cal.memberships.map((m) => m.priceCents / 100))].filter(Boolean).join(' · ')}>
          {cal.memberships.map((m) => (
            <div key={m.id} className="pb-item">
              <div className="pb-item-name">{m.name}</div>
              <div className="pb-item-price">
                <b>{money0(Number(m.priceCents) / 100)}</b> <span>/ {m.interval === 'quarter' ? '3 months' : m.interval}</span>
              </div>
              {m.description && <p className="pb-item-desc">{m.description}</p>}
              {Array.isArray(m.perks) && m.perks.length > 0 && (
                <div className="pb-item-sub">{m.perks.slice(0, 3).join(' · ')}</div>
              )}
              <div className="pb-item-actions">
                <button type="button" className="pb-btn primary" onClick={() => onJoinMembership(m)}>Join</button>
              </div>
            </div>
          ))}
        </Accordion>
      )}
      {showPrograms && (
        <Accordion id="pb-acc-programs" icon="Doc" defaultOpen={defaultOpen} title="Programs"
          summary={[countLabel(cal.programs.length, 'program', 'programs'),
            cal.programs.some((p) => !p.priceCents) ? 'some free' : fromPrice(cal.programs.map((p) => p.priceCents / 100))].filter(Boolean).join(' · ')}>
          {cal.programs.map((p) => (
            <div key={p.id} className="pb-item">
              <div className="pb-item-name">{p.title}</div>
              <div className="pb-item-price">
                <b>{p.priceCents ? fmtProgramPrice(p.priceCents) : 'Free'}</b>
                {p.priceCents ? <span> {programBilling(p.billing)}</span> : null}
              </div>
              {p.description && <p className="pb-item-desc">{p.description}</p>}
              <div className="pb-item-sub">
                {countLabel(p.items, 'item', 'items')}{p.communityEnabled ? ' · private community' : ''}
                {p.billing === 'one_time' && p.accessDays ? ` · ${p.accessDays} days of access` : ''}
              </div>
              <div className="pb-item-actions">
                <a className="pb-btn outline" href={`/p/${p.id}`}>Details</a>
                {p.priceCents > 0 && (
                  <button type="button" className="pb-btn primary" onClick={() => onBuyProgram(p)}>
                    {p.billing === 'one_time' ? 'Buy' : 'Subscribe'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </Accordion>
      )}
      {showGift && (
        <section className="pb-acc">
          <button type="button" className="pb-acc-head" onClick={onGiftCard}>
            <span className="pb-acc-icon"><Icons.Gift size={16} sw={1.8}/></span>
            <span className="pb-acc-text">
              <b>Gift cards</b>
              <span>Send one to a friend. They get it by email right away.</span>
            </span>
            <Chevron/>
          </button>
        </section>
      )}
    </div>
  );
}

// ── Loading skeleton (same shapes as the page, so nothing jumps) ─────────
export function BookingSkeleton({ embedded }) {
  const bar = (w, h, extra = {}) => <div className="pb-skel" style={{ width: w, height: h, ...extra }}/>;
  return (
    <div aria-busy="true" aria-label="Loading booking page">
      {!embedded && (
        <div className="pb-head">
          {bar(56, 56, { borderRadius: 14, flexShrink: 0 })}
          <div style={{ flex: 1 }}>
            {bar('55%', 26)}
            {bar('80%', 14, { marginTop: 10 })}
            {bar('40%', 14, { marginTop: 14 })}
          </div>
        </div>
      )}
      {bar('100%', 26, { marginBottom: 16, borderRadius: 6 })}
      <div className="pb-card">
        {bar(160, 18, { marginBottom: 16 })}
        <div className="pb-services">
          {[0, 1, 2, 3].map((i) => <div key={i} className="pb-skel" style={{ height: 88, borderRadius: 12 }}/>)}
        </div>
      </div>
      <div className="pb-card">
        {bar(180, 18, { marginBottom: 16 })}
        <div style={{ display: 'flex', gap: 8, overflow: 'hidden' }}>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="pb-skel" style={{ width: 60, height: 78, borderRadius: 12, flexShrink: 0 }}/>)}
        </div>
      </div>
    </div>
  );
}

// "Use your package" on the details step, for a signed-in client of this
// business. `packages` are the client's packages that cover the chosen
// service (from /api/me/packages?include=recent). Usable ones are offered
// as a choice, preselected; when none is usable but one is used up or
// expired, the repurchase prompt shows instead.
export function PackageChoice({ packages, value, onChange, onBuyAgain, onSeeAll, buyable }) {
  const usable = packages.filter((p) => (p.state || 'active') === 'active' && p.creditsRemaining > 0);
  const spent = packages.filter((p) => p.state === 'used_up' || p.state === 'expired');
  if (usable.length === 0 && spent.length === 0) return null;
  if (usable.length === 0) {
    const p = spent[0];
    const canBuy = buyable(p);
    return (
      <div className="pb-pkg-prompt" role="status">
        <div className="pb-pkg-title">
          <Icons.Gift size={15} sw={1.8}/> {p.name}: {p.state === 'expired' ? 'Expired' : '0 sessions left'}
        </div>
        <p>
          {p.state === 'expired'
            ? 'This package has expired. Buy it again or see other services.'
            : "You've used all your sessions. Buy this package again or see other services."}
          {' '}You can still book this time and pay as usual.
        </p>
        <div className="pb-pkg-actions">
          {canBuy && <button type="button" className="pb-btn primary" onClick={() => onBuyAgain(p)}>Buy again</button>}
          <button type="button" className="pb-btn outline" onClick={onSeeAll}>See all services</button>
        </div>
      </div>
    );
  }
  const option = (id, title, sub) => {
    const on = value === id;
    return (
      <label key={id || 'none'} className="pb-check pb-pkg-option" data-on={on ? '1' : undefined}>
        <input type="radio" name="pb-pkg" checked={on} onChange={() => onChange(id)}/>
        <span style={{ flex: 1, minWidth: 0 }}>
          <b>{title}</b>
          {sub && <small>{sub}</small>}
        </span>
      </label>
    );
  };
  return (
    <div className="pb-field" role="radiogroup" aria-label="How to pay">
      <div className="pb-label">Use your package?</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {usable.map((p) => option(p.id, `Use 1 session from ${p.name}`,
          p.creditsRemaining === 1
            ? '1 session left. This is your last one.'
            : `${p.creditsRemaining} sessions left${p.sessionsBooked > 0 ? ` · ${p.sessionsBooked} booked` : ''}`))}
        {option('', 'Pay as usual', null)}
      </div>
    </div>
  );
}
