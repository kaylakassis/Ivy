// /me/bookings - every appointment across all the user's businesses,
// grouped Upcoming / Past / Cancelled with a tab picker.
//
// Each booking is its own card: date badge + what / who / when / price on
// stacked lines, then a row of actions underneath that wraps cleanly on a
// 390px phone. Upcoming: Join (video), Add to calendar (one menu),
// Reschedule, Cancel. Past: Book again, Leave a review, Session notes.
//
// Deep links: ?tab=past|cancelled, ?reschedule=<id>, ?cancel=<id> (Home's
// next-appointment card uses the last two).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { safeHref } from '../../lib/safeHref.js';
import { useSearchParams, Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { usePullRefresh } from '../../lib/pullRefresh.js';
import { slotsForDate } from '../calendar/utils.js';
import {
  fmtDay, fmtDate, fmtTime, fmtTimeRange, fmtMoney, bookHref,
  AddToCalendarMenu, Sheet, ErrorNote, SkelCards, EmptyCard, actionBtn, actionRow,
} from './portalUi.jsx';

const TABS = [
  { id: 'upcoming',  label: 'Upcoming' },
  { id: 'past',      label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
];
const VALID_TAB_PARAMS = new Set(['upcoming', 'past', 'cancelled']);

// Kept for older imports: the two-link version of "add to calendar".
export function AddToCalendar({ links }) {
  return <AddToCalendarMenu links={links}/>;
}

export default function ClientBookings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData]       = useState({ upcoming: [], past: [], cancelled: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab] = useState(() => {
    const t = searchParams.get('tab');
    return t && VALID_TAB_PARAMS.has(t) ? t : 'upcoming';
  });
  const [confirming, setConfirming] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr]   = useState(null);
  const [rescheduling, setRescheduling] = useState(null);
  const [pendingReviewIds, setPendingReviewIds] = useState(new Set());
  const [reviewing, setReviewing]   = useState(null);
  const [notice, setNotice] = useState(null); // { tone, text }

  const load = useCallback(async () => {
    const [b, p] = await Promise.all([
      api.get('/me/bookings'),
      api.get('/me/pending-reviews').catch(() => ({ bookings: [] })),
    ]);
    setData({ upcoming: b.upcoming || [], past: b.past || [], cancelled: b.cancelled || [] });
    setPendingReviewIds(new Set((p.bookings || []).map((x) => x.id)));
    return b;
  }, []);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    load()
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [reloadKey, load]);
  usePullRefresh(() => load().catch(() => {}));

  // One-shot deep links (?tab, ?reschedule, ?cancel), consumed once the
  // bookings are in so a refresh does not reopen a dialog.
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current || loading) return;
    const r = searchParams.get('reschedule');
    const c = searchParams.get('cancel');
    if (!searchParams.get('tab') && !r && !c) return;
    consumed.current = true;
    const find = (id) => data.upcoming.find((b) => b.id === id);
    if (r && find(r)) setRescheduling(find(r));
    if (c && find(c)) { setCancelErr(null); setConfirming(find(c)); }
    const next = new URLSearchParams(searchParams);
    next.delete('tab'); next.delete('reschedule'); next.delete('cancel');
    setSearchParams(next, { replace: true });
  }, [loading, data, searchParams, setSearchParams]);

  async function doCancel() {
    if (!confirming) return;
    setCancelBusy(true);
    setCancelErr(null);
    try {
      const r = await api.del('/me/bookings/' + confirming.id);
      await load();
      setConfirming(null);
      if (r && r.policyMessage) {
        setNotice({ tone: Number(r.feeCharged) > 0 || Number(r.depositKept) > 0 ? 'warn' : 'ok', text: `Your booking is cancelled. ${r.policyMessage}` });
      } else if (r && Number(r.feeCharged) > 0) {
        setNotice({ tone: 'warn', text: `Your booking is cancelled. A ${fmtMoney(r.feeCharged)} late-cancellation fee was charged to your saved card.` });
      } else {
        setNotice({ tone: 'ok', text: 'Your booking is cancelled. The business has been told.' });
      }
    } catch (e) {
      setCancelErr(e.message || 'Could not cancel');
    } finally {
      setCancelBusy(false);
    }
  }

  if (loading) return (
    <div className="page-pad"><div className="portal-page">
      <div style={{ height: 40 }}/>
      <SkelCards rows={3}/>
    </div></div>
  );
  if (error) return (
    <div className="page-pad"><div className="portal-page">
      <EmptyCard icon="Calendar" title="We couldn't load your bookings"
        hint="Check your connection and try again."
        action={<button className="btn btn-primary" onClick={() => setReloadKey((n) => n + 1)}>Try again</button>}/>
    </div></div>
  );

  const rows = data[tab] || [];
  const counts = { upcoming: data.upcoming.length, past: data.past.length, cancelled: data.cancelled.length };
  // Most recent business to suggest in the empty state.
  const lastPast = data.past.find((b) => b.bizSlug && !b.archived);

  return (
    <div className="page-pad"><div className="portal-page" style={{ gap: 16 }}>
      {notice && (
        <div role="status" style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '12px 14px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.5,
          background: `color-mix(in srgb, var(--${notice.tone === 'warn' ? 'warn' : 'ok'}) 12%, var(--surface))`,
          border: `1px solid color-mix(in srgb, var(--${notice.tone === 'warn' ? 'warn' : 'ok'}) 35%, var(--border))`,
        }}>
          <span style={{ flex: 1 }}>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="btn btn-ghost"
            style={{ padding: 4, color: 'var(--muted)' }} aria-label="Dismiss"><Icons.X size={14}/></button>
        </div>
      )}

      <div className="tab-row" role="tablist">
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button key={t.id} role="tab" aria-selected={on} onClick={() => setTab(t.id)} style={{
              padding: '8px 14px', borderRadius: 8, border: 0, fontSize: 13, fontWeight: 550, cursor: 'pointer',
              background: on ? 'var(--surface)' : 'transparent',
              color: on ? 'var(--fg)' : 'var(--muted)',
              boxShadow: on ? 'var(--shadow-sm)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              {t.label}
              {counts[t.id] > 0 && (
                <span style={{
                  fontSize: 11, padding: '1px 7px', borderRadius: 99,
                  background: on ? 'var(--surface-2)' : 'var(--surface)',
                  color: 'var(--muted)', fontWeight: 600,
                }}>{counts[t.id]}</span>
              )}
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        tab === 'upcoming' ? (
          <EmptyCard icon="Calendar" title="Nothing booked right now"
            hint={lastPast ? `Ready for your next visit with ${lastPast.businessName}?` : 'When you book a session, it will show up here.'}
            action={lastPast
              ? <Link className="btn btn-primary" to={bookHref(lastPast.bizSlug, lastPast.serviceId)} style={actionBtn}>Book again</Link>
              : <Link className="btn btn-primary" to="/me/discover" style={actionBtn}>Find a business</Link>}/>
        ) : tab === 'past' ? (
          <EmptyCard icon="Clock" title="No past visits yet" hint="Once you have been to an appointment, it will be listed here."
            action={<button className="btn btn-outline" onClick={() => setTab('upcoming')} style={actionBtn}>See upcoming</button>}/>
        ) : (
          <EmptyCard icon="Check" title="Nothing cancelled" hint="Bookings you or the business cancel will show here."/>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((b) => (
            <BookingCard key={b.id} booking={b} tab={tab}
              reviewable={tab === 'past' && pendingReviewIds.has(b.id) && !b.archived}
              onCancel={() => { setCancelErr(null); setConfirming(b); }}
              onReschedule={() => setRescheduling(b)}
              onReview={() => setReviewing(b)}/>
          ))}
        </div>
      )}

      {confirming && (
        <CancelConfirmDialog booking={confirming} busy={cancelBusy} error={cancelErr}
          onClose={() => !cancelBusy && setConfirming(null)} onConfirm={doCancel}/>
      )}

      {reviewing && (
        <ReviewDialog booking={reviewing} onClose={() => setReviewing(null)}
          onSubmitted={() => {
            setPendingReviewIds((prev) => { const next = new Set(prev); next.delete(reviewing.id); return next; });
            setReviewing(null);
            setNotice({ tone: 'ok', text: `Thank you! Your review of ${reviewing.businessName} is posted.` });
          }}/>
      )}

      {rescheduling && (
        <RescheduleDialog booking={rescheduling} onClose={() => setRescheduling(null)}
          onRescheduled={async () => {
            await load().catch(() => {});
            setRescheduling(null);
            setNotice({ tone: 'ok', text: 'Your booking has a new time. The business has been told.' });
          }}/>
      )}
    </div></div>
  );
}

function canReschedule(b) {
  return !b.cancelledAt && !!b.bizSlug && !!b.serviceId && !b.recurrenceRule && !b.archived;
}

function paymentLine(p) {
  if (!p) return null;
  if (p.fullyPaid) return { text: `Paid in full, ${fmtMoney(p.total)}`, color: 'var(--ok)' };
  if (!(p.balanceDue > 0)) return null;
  const bits = [`${fmtMoney(p.balanceDue)} left to pay`];
  if (p.depositPaid > 0) bits.push(`${fmtMoney(p.depositPaid)} deposit paid`);
  if (p.giftCardCredit > 0) bits.push(`${fmtMoney(p.giftCardCredit)} gift card used`);
  return { text: bits.join(' · '), color: 'var(--accent)' };
}

export function whereLine(b) {
  if (b.serviceLocationType === 'virtual' || b.videoRoomUrl) return 'Video call';
  if (b.serviceLocationType === 'mobile') return b.locationAddress ? `At ${b.locationAddress}` : 'At your place';
  return b.locationLabel || b.businessAddress || null;
}

function BookingCard({ booking: b, tab, reviewable, onCancel, onReschedule, onReview }) {
  const d = new Date(b.date + 'T00:00:00');
  const [showNotes, setShowNotes] = useState(false);
  const hasCompletion = !!b.completionNotes
    || (Array.isArray(b.completionAttachments) && b.completionAttachments.length > 0);
  const cancelled = !!b.cancelledAt;
  const pay = !cancelled ? paymentLine(b.payment) : null;
  const where = !cancelled ? whereLine(b) : null;
  const upcoming = tab === 'upcoming' && !cancelled;
  const again = !upcoming && b.bizSlug && !b.archived ? bookHref(b.bizSlug, b.serviceId) : null;

  const actions = [];
  if (upcoming && b.videoRoomUrl) {
    actions.push(
      <a key="join" href={safeHref(b.videoRoomUrl)} target="_blank" rel="noopener noreferrer"
        className="btn btn-primary" style={actionBtn}>
        <Icons.Globe size={14} sw={1.8}/> Join video call
      </a>,
    );
  }
  if (upcoming && b.calendar) actions.push(<AddToCalendarMenu key="cal" links={b.calendar}/>);
  if (upcoming && canReschedule(b)) {
    actions.push(
      <button key="move" onClick={onReschedule} className="btn btn-outline" style={actionBtn}>
        <Icons.Clock size={14} sw={1.8}/> Reschedule
      </button>,
    );
  }
  if (upcoming) {
    actions.push(
      <button key="cancel" onClick={onCancel} className="btn btn-ghost"
        style={{ ...actionBtn, color: 'var(--danger)' }}>
        Cancel
      </button>,
    );
  }
  if (again) {
    actions.push(
      <Link key="again" to={again} className="btn btn-primary" style={actionBtn}>
        <Icons.Repeat size={14} sw={1.8}/> Book again
      </Link>,
    );
  }
  if (reviewable) {
    actions.push(
      <button key="review" onClick={onReview} className="btn btn-outline" style={actionBtn}>
        <Icons.Star size={14} sw={1.8}/> Leave a review
      </button>,
    );
  }
  if (hasCompletion) {
    actions.push(
      <button key="notes" onClick={() => setShowNotes((x) => !x)} className="btn btn-outline" style={actionBtn}
        aria-expanded={showNotes}>
        <Icons.Doc size={14} sw={1.8}/> {showNotes ? 'Hide session notes' : 'Session notes'}
      </button>,
    );
  }

  return (
    <article className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <div style={{
          width: 52, minHeight: 56, borderRadius: 12, flexShrink: 0,
          background: cancelled ? 'var(--surface-2)' : 'var(--accent-soft)',
          color: cancelled ? 'var(--muted)' : 'var(--accent)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          lineHeight: 1.1, fontWeight: 600, padding: '6px 0',
        }} aria-hidden="true">
          <span style={{ fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {d.toLocaleDateString('en-US', { month: 'short' })}
          </span>
          <span style={{ fontSize: 21, fontFamily: 'var(--font-display)' }}>{d.getDate()}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontSize: 15.5, fontWeight: 650, lineHeight: 1.3, overflowWrap: 'anywhere' }}>
            {b.serviceName || 'Appointment'}
            {cancelled && (
              <span style={{
                marginLeft: 8, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                color: 'var(--muted)', verticalAlign: 'middle',
              }}>Cancelled</span>
            )}
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{b.businessName}</div>
          <div style={{ fontSize: 13.5, color: 'var(--fg-2)' }}>
            {fmtDay(b.date)} · {fmtTimeRange(b.startMin, b.endMin)}
          </div>
          {where && (
            <div style={{ fontSize: 13, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{where}</div>
          )}
          {b.price != null && !pay && !cancelled && Number(b.price) > 0 && (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{fmtMoney(b.price)}</div>
          )}
          {pay && (
            <div style={{ fontSize: 13, fontWeight: 600, color: pay.color }}>{pay.text}</div>
          )}
          {cancelled && b.depositRefundStatus === 'pending' && (
            <div style={{ fontSize: 13, color: 'var(--fg-2)' }}>Your deposit refund is being reviewed by {b.businessName}.</div>
          )}
          {cancelled && b.depositRefundStatus === 'approved' && (
            <div style={{ fontSize: 13, color: 'var(--ok)' }}>Your deposit was refunded.</div>
          )}
          {b.fromPackage && !cancelled && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Uses a session from your package</div>
          )}
          {b.recurrenceRule && !cancelled && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Repeats</div>
          )}
          {b.notes && (
            <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 2, overflowWrap: 'anywhere' }}>
              <span style={{ color: 'var(--muted)' }}>Note: </span>{b.notes}
            </div>
          )}
        </div>
      </div>

      {actions.length > 0 && <div style={actionRow}>{actions}</div>}

      {hasCompletion && showNotes && <CompletionNotes booking={b}/>}
    </article>
  );
}

function CompletionNotes({ booking }) {
  return (
    <div style={{
      marginTop: 12, padding: 12, borderRadius: 12,
      background: 'color-mix(in srgb, var(--accent-soft) 35%, var(--surface-2))',
      border: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 650, marginBottom: 8 }}>
        Notes from your session
        {booking.completedAt && (
          <span style={{ marginLeft: 6, color: 'var(--muted)', fontWeight: 400 }}>
            · {fmtDate(booking.completedAt)}
          </span>
        )}
      </div>
      {booking.completionNotes && (
        <div style={{ fontSize: 13.5, color: 'var(--fg)', lineHeight: 1.55, whiteSpace: 'pre-wrap', marginBottom: 8, overflowWrap: 'anywhere' }}>
          {booking.completionNotes}
        </div>
      )}
      {Array.isArray(booking.completionAttachments) && booking.completionAttachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {booking.completionAttachments.map((a, i) => {
            const isImage = (a.mimeType || '').startsWith('image/');
            return (
              <a key={(a.url || '') + i} href={safeHref(a.url)} target="_blank" rel="noopener noreferrer"
                style={{ textDecoration: 'none' }}>
                {isImage ? (
                  <img src={safeHref(a.url)} alt={a.filename || ''}
                    style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover', border: '1px solid var(--border)' }}/>
                ) : (
                  <div style={{
                    width: 64, height: 64, borderRadius: 8,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    gap: 4, padding: 4, background: 'var(--surface)', border: '1px solid var(--border)',
                    color: 'var(--muted)', fontSize: 9, textAlign: 'center',
                  }}>
                    <Icons.FileIcon size={18} sw={1.6}/>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 56 }}>
                      {a.filename || ''}
                    </span>
                  </div>
                )}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DialogHead({ icon = 'Calendar', tone = 'accent', title, sub, onClose, busy, id }) {
  const I = Icons[icon] || Icons.Calendar;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, flexShrink: 0,
        background: tone === 'danger' ? 'rgba(155,44,44,0.12)' : 'var(--accent-soft)',
        color: tone === 'danger' ? 'var(--danger)' : 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><I size={18} sw={2}/></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div id={id} style={{ fontSize: 16, fontWeight: 650 }}>{title}</div>
        {sub && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
      </div>
      <button type="button" onClick={() => !busy && onClose()} aria-label="Close"
        className="btn btn-ghost" style={{ padding: 8 }}>
        <Icons.X size={16}/>
      </button>
    </div>
  );
}

// What cancelling means for this booking, from what the business has set
// up: the free-cancellation window, any late fee (and whether it would be
// charged automatically, which needs a saved card at that business), and
// what happens to a deposit, gift card or package session.
export function cancelPolicy(b, now = Date.now()) {
  const fee = Number(b.cancellationFeeAmount || 0);
  const windowH = Number(b.cancellationWindowHours || 0);
  const startMs = Number(b.startEpochMs)
    || (Date.parse(`${b.date}T00:00:00Z`) + (b.startMin || 0) * 60000);
  const late = windowH > 0 && startMs < now + windowH * 3600 * 1000;
  const lines = [];
  let tone = 'calm';
  const p = b.payment || {};
  // A paid deposit is kept when cancelling late and counts toward the fee
  // (api/_lib/bookingFees.js), so only the rest goes on the card.
  const deposit = Number(p.depositPaid || 0);
  const due = Math.max(0, Math.round((fee - deposit) * 100) / 100);
  // Package bookings: a late cancel (under the business's own fee policy)
  // keeps the session used instead of charging the card. Same rule as
  // the server (api/me/bookings/[id].js isLateCancelWithPolicy).
  if (b.fromPackage && b.packageUseMode !== 'completion') {
    const pkg = b.packageName ? `your ${b.packageName} package` : 'your package';
    if (fee > 0 && windowH > 0) {
      lines.push(`${b.businessName} lets you cancel for free up to ${windowH} hours before.`);
      if (late) {
        tone = 'warn';
        lines.push(`This appointment starts in less than ${windowH} hours, so the session from ${pkg} stays used. Your card is not charged.`);
      } else {
        lines.push(`You are cancelling in time, so the session goes back into ${pkg}.`);
      }
    } else {
      lines.push(`The session goes back into ${pkg}.`);
    }
    return { lines, tone, late: late && fee > 0, fee: 0 };
  }
  if (fee > 0 && windowH > 0) {
    lines.push(`${b.businessName} lets you cancel for free up to ${windowH} hours before. After that there is a ${fmtMoney(fee)} late-cancellation fee.`);
    if (late) {
      tone = 'warn';
      if (deposit > 0 && due <= 0) {
        lines.push(`This appointment starts in less than ${windowH} hours, so your ${fmtMoney(deposit)} deposit is kept to cover the fee. Nothing more is charged.`);
      } else {
        const what = deposit > 0 ? `your ${fmtMoney(deposit)} deposit is kept and the other ${fmtMoney(due)}` : fmtMoney(fee);
        lines.push(b.cardOnFile
          ? `This appointment starts in less than ${windowH} hours, so ${what} will be charged to the card you saved with them.`
          : `This appointment starts in less than ${windowH} hours, so ${deposit > 0 ? `your ${fmtMoney(deposit)} deposit is kept and they may ask you to pay the other ${fmtMoney(due)}` : `they may ask you to pay the ${fmtMoney(fee)} fee`}.`);
      }
    } else {
      lines.push('You are cancelling in time, so there is no fee.');
    }
  } else {
    lines.push(`There is no cancellation fee for this appointment.`);
  }
  if (deposit > 0 && !(late && fee > 0)) {
    if (late) lines.push(`You are cancelling less than ${windowH} hours before, so your ${fmtMoney(deposit)} deposit is kept.`);
    else if (b.depositRefundable === false) lines.push(`Your ${fmtMoney(deposit)} deposit is not refundable.`);
    else lines.push(`Your ${fmtMoney(deposit)} deposit can be refunded. ${b.businessName} reviews the refund, and you get a receipt once it goes through.`);
  }
  if (p.giftCardCredit > 0) lines.push(`The ${fmtMoney(p.giftCardCredit)} you used from a gift card goes back on the card.`);
  if (b.fromPackage) {
    // Business counts sessions when you attend: the session was only held.
    lines.push(`The session goes back into ${b.packageName ? `your ${b.packageName} package` : 'your package'}.`);
  }
  return { lines, tone, late, fee };
}

function CancelConfirmDialog({ booking, busy, error, onClose, onConfirm }) {
  const policy = cancelPolicy(booking);
  return (
    <Sheet onClose={onClose} busy={busy} labelledBy="cancel-title" maxWidth={440}>
      <DialogHead id="cancel-title" icon="X" tone="danger" title="Cancel this booking?" onClose={onClose} busy={busy}/>
      <div style={{
        padding: 12, borderRadius: 12, background: 'var(--surface-2)',
        border: '1px solid var(--border)', fontSize: 14, lineHeight: 1.55,
      }}>
        <div style={{ fontWeight: 650 }}>{booking.serviceName || 'Appointment'}</div>
        <div style={{ color: 'var(--fg-2)' }}>{booking.businessName}</div>
        <div style={{ color: 'var(--fg-2)' }}>{fmtDay(booking.date)} · {fmtTimeRange(booking.startMin, booking.endMin)}</div>
      </div>
      <div style={{
        padding: '12px 14px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.55,
        background: policy.tone === 'warn' ? 'color-mix(in srgb, var(--warn) 12%, var(--surface))' : 'var(--surface)',
        border: `1px solid ${policy.tone === 'warn' ? 'color-mix(in srgb, var(--warn) 40%, var(--border))' : 'var(--border)'}`,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ fontWeight: 650, fontSize: 13 }}>Cancellation policy</div>
        {policy.lines.map((l) => <div key={l}>{l}</div>)}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
        We will let {booking.businessName} know. This can't be undone, but you can always book again.
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-outline" onClick={onClose} disabled={busy} style={{ ...actionBtn, flex: '1 1 140px' }}>
          Keep booking
        </button>
        <button className="btn btn-primary" onClick={onConfirm} disabled={busy}
          style={{ ...actionBtn, flex: '1 1 140px', background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}>
          {busy ? 'Cancelling…' : (policy.late && policy.fee > 0 && booking.cardOnFile ? `Cancel and pay ${fmtMoney(policy.fee)}` : 'Cancel booking')}
        </button>
      </div>
    </Sheet>
  );
}

function ReviewDialog({ booking, onClose, onSubmitted }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover]   = useState(0);
  const [text, setText]     = useState('');
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState(null);
  const labels = ['', 'Not good', 'Could be better', 'Good', 'Great', 'Loved it'];

  const submit = async () => {
    if (rating < 1) { setErr('Tap a star to rate your visit'); return; }
    setBusy(true); setErr(null);
    try {
      await api.post('/me/reviews', { bookingId: booking.id, rating, text: text.trim() || null });
      onSubmitted?.();
    } catch (e) {
      setErr(e.message || 'Could not post your review');
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} busy={busy} labelledBy="review-title">
      <DialogHead id="review-title" icon="Star" title="How was your visit?"
        sub={`${booking.serviceName || 'Appointment'} · ${booking.businessName}`} onClose={onClose} busy={busy}/>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button"
            onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)}
            onClick={() => setRating(n)}
            aria-label={`${n} star${n === 1 ? '' : 's'}`} aria-pressed={rating === n}
            style={{
              background: 'transparent', border: 0, padding: 6, cursor: 'pointer',
              color: (hover || rating) >= n ? 'var(--accent)' : 'var(--border-strong)',
            }}>
            <Star filled={(hover || rating) >= n}/>
          </button>
        ))}
        <span style={{ marginLeft: 6, fontSize: 13, color: 'var(--muted)' }}>
          {labels[hover || rating] || 'Tap to rate'}
        </span>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 2000))}
        placeholder="Anything you'd like to share? (optional)"
        rows={4} className="input"
        style={{ width: '100%', resize: 'vertical', padding: '10px 12px', fontSize: 15, lineHeight: 1.5 }}/>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: -8 }}>
        Your review and name can be shown on {booking.businessName}'s booking page.
      </div>
      <ErrorNote>{err}</ErrorNote>
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={() => !busy && onClose()} className="btn btn-outline" style={{ ...actionBtn, flex: 1 }} disabled={busy}>
          Not now
        </button>
        <button onClick={submit} disabled={busy || rating < 1} className="btn btn-primary" style={{ ...actionBtn, flex: 2 }}>
          {busy ? 'Posting…' : 'Post review'}
        </button>
      </div>
    </Sheet>
  );
}

function Star({ filled }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  );
}

// Reschedule: fetches the business's public calendar by slug and shows the
// open times for the booking's service on a picked date. PATCHes
// /api/me/bookings/:id with rescheduleTo; the server re-checks everything.
function RescheduleDialog({ booking, onClose, onRescheduled }) {
  const [cal, setCal]         = useState(null);
  const [calErr, setCalErr]   = useState(null);
  const [date, setDate]       = useState(booking.date);
  const [pick, setPick]       = useState(null);
  const [busy, setBusy]       = useState(false);
  const [submitErr, setSubmitErr] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/calendar/public/' + encodeURIComponent(booking.bizSlug))
      .then((r) => live && setCal(r.calendar))
      .catch((e) => live && setCalErr(e));
    return () => { live = false; };
  }, [booking.bizSlug]);

  const svc = cal?.services?.find((s) => s.id === booking.serviceId)
    || (booking.durationMinutes ? { id: booking.serviceId, durationMinutes: booking.durationMinutes } : null);
  const dateObj = new Date(date + 'T00:00:00');
  let slots = [];
  if (cal && svc && !Number.isNaN(dateObj.getTime())) {
    try { slots = (slotsForDate(cal, dateObj, svc) || []).filter((s) => s.available); } catch { slots = []; }
  }

  const submit = async () => {
    if (!pick) { setSubmitErr('Pick a new time first.'); return; }
    setBusy(true); setSubmitErr(null);
    try {
      await api.patch('/me/bookings/' + booking.id, {
        rescheduleTo: { date, startMin: pick.start, endMin: pick.end },
      });
      onRescheduled?.();
    } catch (e) {
      setSubmitErr(e.message || 'Could not move your booking. Try another time.');
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} busy={busy} labelledBy="move-title" maxWidth={540}>
      <DialogHead id="move-title" icon="Clock" title="Pick a new time"
        sub={`${booking.serviceName || 'Appointment'} · ${booking.businessName}`} onClose={onClose} busy={busy}/>
      <div style={{
        padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--border)',
        fontSize: 13.5, color: 'var(--muted)',
      }}>
        Now: <b style={{ color: 'var(--fg)' }}>{fmtDay(booking.date)} at {fmtTime(booking.startMin)}</b>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13, color: 'var(--fg-2)', fontWeight: 550 }}>Day</span>
        <input type="date" value={date} className="input"
          min={new Date().toISOString().slice(0, 10)}
          onChange={(e) => { setDate(e.target.value); setPick(null); }}
          style={{ padding: '10px 12px', fontSize: 15, maxWidth: 260 }}/>
      </label>
      <div>
        <div style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 8, fontWeight: 550 }}>Open times</div>
        {calErr ? (
          <ErrorNote>We couldn't load open times. Please try again in a moment.</ErrorNote>
        ) : !cal ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading open times…</div>
        ) : slots.length === 0 ? (
          <div style={{
            padding: 16, borderRadius: 12, background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
            color: 'var(--muted)', fontSize: 13.5, textAlign: 'center',
          }}>No open times that day. Try another day.</div>
        ) : (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
            gap: 8, maxHeight: 260, overflowY: 'auto',
          }}>
            {slots.map((s) => {
              const selected = pick?.start === s.start;
              const isCurrent = date === booking.date && s.start === booking.startMin;
              return (
                <button key={s.start} type="button" onClick={() => setPick(s)} aria-pressed={selected}
                  style={{
                    padding: '10px 8px', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                    background: selected ? 'var(--accent)' : 'var(--surface-2)',
                    color: selected ? 'var(--accent-ink)' : 'var(--fg-2)',
                    border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                  }}>
                  {fmtTime(s.start)}
                  {isCurrent && <div style={{ fontSize: 10.5, fontWeight: 600, opacity: 0.8, marginTop: 2 }}>your time now</div>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <ErrorNote>{submitErr}</ErrorNote>
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={() => !busy && onClose()} className="btn btn-outline" style={{ ...actionBtn, flex: 1 }} disabled={busy}>
          Keep current time
        </button>
        <button onClick={submit} disabled={busy || !pick} className="btn btn-primary" style={{ ...actionBtn, flex: 1 }}>
          {busy ? 'Moving…' : 'Move booking'}
        </button>
      </div>
    </Sheet>
  );
}
