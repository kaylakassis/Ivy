// /me/bookings — every appointment across all the user's businesses,
// grouped Upcoming / Past / Cancelled with a tab picker.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';
import { slotsForDate } from '../calendar/utils.js';

function fmtDay(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

const TABS = [
  { id: 'upcoming',  label: 'Upcoming' },
  { id: 'past',      label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
];

export default function ClientBookings() {
  const [data, setData]       = useState({ upcoming: [], past: [], cancelled: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState('upcoming');
  const [confirming, setConfirming] = useState(null); // booking object pending cancel
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr]   = useState(null);
  const [rescheduling, setRescheduling] = useState(null); // booking pending reschedule
  // Bookings the user can review — fetched server-side so we know which
  // past rows haven't been reviewed yet without a per-row probe.
  const [pendingReviewIds, setPendingReviewIds] = useState(new Set());
  const [reviewing, setReviewing]   = useState(null); // booking pending review

  const [reloadKey, setReloadKey] = useState(0);
  const [feeNotice, setFeeNotice] = useState(null); // late-cancel fee charge confirmation

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    Promise.all([
      api.get('/me/bookings'),
      api.get('/me/pending-reviews').catch(() => ({ bookings: [] })),
    ])
      .then(([b, p]) => {
        if (!live) return;
        setData(b);
        setPendingReviewIds(new Set((p.bookings || []).map((x) => x.id)));
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [reloadKey]);

  async function doCancel() {
    if (!confirming) return;
    setCancelBusy(true);
    setCancelErr(null);
    try {
      const r = await api.del('/me/bookings/' + confirming.id);
      // Refetch so upcoming/past/cancelled buckets are correct.
      const fresh = await api.get('/me/bookings');
      setData(fresh);
      setConfirming(null);
      // Surface a late-cancel fee that was actually charged — the client
      // must know money left their card. (The endpoint returns feeCharged
      // for exactly this; it used to be silently discarded.)
      if (r && Number(r.feeCharged) > 0) {
        setFeeNotice(`Your booking was cancelled. A $${Number(r.feeCharged).toFixed(2)} late-cancellation fee was charged to your card on file.`);
      }
    } catch (e) {
      setCancelErr(e.message || 'Could not cancel');
    } finally {
      setCancelBusy(false);
    }
  }

  if (loading) return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SkelRowList rows={5}/>
    </div>
  );
  if (error) return (
    <div style={{ padding: 48 }}>
      <div className="card" style={{ padding: 40 }}>
        <EmptyNote icon="Calendar" title="Couldn't load bookings"
          hint={error.message || 'Try refreshing.'}
          action={<button className="btn btn-outline" onClick={() => setReloadKey((n) => n + 1)}>Retry</button>}/>
      </div>
    </div>
  );

  const rows = data[tab] || [];
  const counts = { upcoming: data.upcoming.length, past: data.past.length, cancelled: data.cancelled.length };

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {feeNotice && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '12px 14px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
          background: 'color-mix(in srgb, var(--warn) 12%, var(--surface))',
          border: '1px solid color-mix(in srgb, var(--warn) 35%, var(--border))',
        }}>
          <Icons.Receipt size={15} sw={1.8} stroke="var(--warn)"/>
          <span style={{ flex: 1 }}>{feeNotice}</span>
          <button onClick={() => setFeeNotice(null)} className="btn btn-ghost"
            style={{ padding: 2, color: 'var(--muted)' }} title="Dismiss"><Icons.X size={13}/></button>
        </div>
      )}
      <div className="tab-row">
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
              background: on ? 'var(--surface)' : 'transparent',
              color: on ? 'var(--fg)' : 'var(--muted)',
              boxShadow: on ? 'var(--shadow-sm)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              {t.label}
              <span style={{
                fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
                background: on ? 'var(--surface-2)' : 'var(--surface)',
                color: 'var(--muted)', fontWeight: 600,
              }}>{counts[t.id]}</span>
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Calendar"
            title={tab === 'upcoming' ? 'No upcoming bookings' : tab === 'past' ? 'No past bookings yet' : 'Nothing cancelled'}
            hint={tab === 'upcoming' ? 'When you book a session, it\'ll show up here.' : ''}/>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {rows.map((b, i) => (
            <BookingRow key={b.id} booking={b} first={i === 0}
              cancellable={tab === 'upcoming' && !b.cancelledAt}
              reschedulable={tab === 'upcoming' && !b.cancelledAt && !!b.bizSlug && !!b.serviceId}
              reviewable={tab === 'past' && pendingReviewIds.has(b.id)}
              onCancel={() => { setCancelErr(null); setConfirming(b); }}
              onReschedule={() => setRescheduling(b)}
              onReview={() => setReviewing(b)}/>
          ))}
        </div>
      )}

      {confirming && (
        <CancelConfirmDialog
          booking={confirming}
          busy={cancelBusy}
          error={cancelErr}
          onClose={() => !cancelBusy && setConfirming(null)}
          onConfirm={doCancel}/>
      )}

      {reviewing && (
        <ReviewDialog
          booking={reviewing}
          onClose={() => setReviewing(null)}
          onSubmitted={() => {
            setPendingReviewIds((prev) => {
              const next = new Set(prev);
              next.delete(reviewing.id);
              return next;
            });
            setReviewing(null);
          }}
        />
      )}

      {rescheduling && (
        <RescheduleDialog
          booking={rescheduling}
          onClose={() => setRescheduling(null)}
          onRescheduled={async () => {
            const fresh = await api.get('/me/bookings');
            setData(fresh);
            setRescheduling(null);
          }}/>
      )}
    </div>
  );
}

function BookingRow({ booking, first, cancellable, reschedulable, reviewable, onCancel, onReschedule, onReview }) {
  const d = new Date(booking.date + 'T00:00:00');
  const [showCompletion, setShowCompletion] = useState(false);
  const hasCompletion = !!booking.completionNotes
    || (Array.isArray(booking.completionAttachments) && booking.completionAttachments.length > 0);
  return (
    <div style={{
      borderTop: first ? 'none' : '1px solid var(--border)',
    }}>
    <div style={{
      padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
    }}>
      <div style={{
        width: 48, height: 52, borderRadius: 10,
        background: booking.cancelledAt ? 'var(--surface-2)' : 'var(--accent-soft)',
        color: booking.cancelledAt ? 'var(--muted)' : 'var(--accent)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        lineHeight: 1.1, fontWeight: 600, flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {d.toLocaleDateString('en-US', { month: 'short' })}
        </span>
        <span style={{ fontSize: 18, fontFamily: 'var(--font-display)' }}>{d.getDate()}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {booking.serviceName || 'Session'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>·</span>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{booking.businessName}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
          {fmtDay(booking.date)} · {fmtTime(booking.startMin)} – {fmtTime(booking.endMin)}
          {booking.price != null && <> · ${Number(booking.price).toFixed(0)}</>}
        </div>
        {booking.payment && !booking.cancelledAt && (
          <div style={{ fontSize: 12, marginTop: 4, fontWeight: 600,
            color: booking.payment.fullyPaid ? 'var(--ok)' : 'var(--accent)' }}>
            {booking.payment.fullyPaid
              ? `Paid in full · $${booking.payment.total.toFixed(2)}`
              : `$${booking.payment.balanceDue.toFixed(2)} balance due · $${booking.payment.total.toFixed(2)} total${booking.payment.depositPaid > 0 ? ` (deposit $${booking.payment.depositPaid.toFixed(2)} paid)` : ''}`}
          </div>
        )}
        {booking.notes && (
          <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 4 }}>{booking.notes}</div>
        )}
      </div>
      {booking.cancelledAt && (
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Cancelled
        </div>
      )}
      {booking.videoRoomUrl && !booking.cancelledAt && (
        <a href={booking.videoRoomUrl} target="_blank" rel="noopener noreferrer"
          className="btn btn-primary"
          style={{ fontSize: 12, padding: '6px 12px' }}
          title="Join your meeting">
          <Icons.Globe size={12} sw={1.8}/> Join
        </a>
      )}
      {reviewable && (
        <button onClick={onReview} className="btn btn-outline"
          style={{ fontSize: 12, padding: '6px 12px' }}
          title="Leave a review of this session">
          <Icons.Check size={12} sw={2}/> Leave review
        </button>
      )}
      {reschedulable && (
        <button onClick={onReschedule} className="btn btn-outline"
          style={{ fontSize: 12, padding: '6px 12px' }}
          title="Move this booking to a different time">
          <Icons.Calendar size={12} sw={2}/> Reschedule
        </button>
      )}
      {cancellable && (
        <button onClick={onCancel} className="btn btn-ghost"
          style={{ fontSize: 12, padding: '6px 10px', color: 'var(--muted)' }}
          title="Cancel this booking">
          Cancel
        </button>
      )}
      {hasCompletion && (
        <button onClick={() => setShowCompletion((x) => !x)} className="btn btn-outline"
          style={{ fontSize: 12, padding: '6px 12px' }}
          title="View session notes from your provider">
          <Icons.Doc size={12} sw={1.8}/> {showCompletion ? 'Hide notes' : 'Session notes'}
        </button>
      )}
    </div>
    {hasCompletion && showCompletion && (
      <div style={{
        margin: '0 18px 14px 76px', padding: 12, borderRadius: 10,
        background: 'color-mix(in srgb, var(--accent-soft) 35%, var(--surface-2))',
        border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
          Notes from your session
          {booking.completedAt && (
            <span style={{ marginLeft: 8, color: 'var(--muted)', fontWeight: 400,
              letterSpacing: 0, textTransform: 'none' }}>
              · {new Date(booking.completedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        {booking.completionNotes && (
          <div style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.55,
            whiteSpace: 'pre-wrap', marginBottom: 8 }}>
            {booking.completionNotes}
          </div>
        )}
        {Array.isArray(booking.completionAttachments) && booking.completionAttachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {booking.completionAttachments.map((a, i) => {
              const isImage = (a.mimeType || '').startsWith('image/');
              return (
                <a key={a.url + i} href={a.url} target="_blank" rel="noopener noreferrer"
                  style={{ textDecoration: 'none' }}>
                  {isImage ? (
                    <img src={a.url} alt={a.filename || ''}
                      style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover',
                        border: '1px solid var(--border)' }}/>
                  ) : (
                    <div style={{
                      width: 64, height: 64, borderRadius: 8,
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      gap: 4, padding: 4,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      color: 'var(--muted)', fontSize: 9, textAlign: 'center',
                    }}>
                      <Icons.FileIcon size={18} sw={1.6}/>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap', maxWidth: 56 }}>
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
    )}
    </div>
  );
}

function CancelConfirmDialog({ booking, busy, error, onClose, onConfirm }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,14,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: 14, boxShadow: 'var(--shadow-lg, var(--shadow))',
          width: '100%', maxWidth: 420, padding: 22,
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'rgba(155,44,44,0.12)', color: 'var(--danger)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icons.X size={18} sw={2}/>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Cancel this booking?</div>
        </div>
        <div style={{
          padding: 12, borderRadius: 10, background: 'var(--surface-2)',
          border: '1px solid var(--border)', fontSize: 13, lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600 }}>{booking.serviceName || 'Session'}</div>
          <div style={{ color: 'var(--muted)', marginTop: 2 }}>{booking.businessName}</div>
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>
            {fmtDay(booking.date)} · {fmtTime(booking.startMin)} – {fmtTime(booking.endMin)}
          </div>
        </div>
        {(() => {
          const fee = Number(booking.cancellationFeeAmount || 0);
          const windowH = Number(booking.cancellationWindowHours || 0);
          const startMs = Date.parse(`${booking.date}T00:00:00Z`) + (booking.startMin || 0) * 60000;
          const insideWindow = fee > 0 && windowH > 0 && startMs < Date.now() + windowH * 3600 * 1000;
          if (!insideWindow) return null;
          return (
            <div style={{
              padding: '10px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.55,
              background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--warn) 35%, var(--border))',
              color: 'var(--fg-2)',
            }}>
              <strong>Late-cancellation fee:</strong> this is within {windowH}h of your appointment, so a
              ${fee.toFixed(2)} fee may be charged to your card on file.
            </div>
          );
        })()}
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
          The business will be notified through your message thread. This can't be undone — you'd need
          to book again from scratch.
        </div>
        {error && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Keep booking
          </button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={busy}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
            {busy ? 'Cancelling…' : 'Cancel booking'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Star-rating + freeform-text dialog. Posts to /api/me/reviews.
function ReviewDialog({ booking, onClose, onSubmitted }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover]   = useState(0);
  const [text, setText]     = useState('');
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState(null);

  const submit = async () => {
    if (rating < 1) { setErr('Pick a star rating from 1 to 5'); return; }
    setBusy(true); setErr(null);
    try {
      await api.post('/me/reviews', {
        bookingId: booking.id,
        rating,
        text: text.trim() || null,
      });
      onSubmitted?.();
    } catch (e) {
      setErr(e.message || 'Could not post your review');
      setBusy(false);
    }
  };

  return (
    <div onClick={() => !busy && onClose()} style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,14,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: '100%', maxWidth: 460, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Check size={18} sw={2}/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Review your session</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {booking.serviceName || 'Session'} · {booking.businessName}
            </div>
          </div>
          <button type="button" onClick={() => !busy && onClose()}
            className="btn btn-ghost" style={{ padding: 6 }}>
            <Icons.X size={14}/>
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button"
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setRating(n)}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              style={{
                background: 'transparent', border: 0, padding: 4, cursor: 'pointer',
                color: (hover || rating) >= n ? 'var(--accent)' : 'var(--border-strong)',
                transition: 'color 0.1s ease',
              }}>
              <Star filled={(hover || rating) >= n}/>
            </button>
          ))}
          <span style={{ marginLeft: 8, fontSize: 12.5, color: 'var(--muted)' }}>
            {rating ? `${rating} / 5` : 'Tap to rate'}
          </span>
        </div>

        <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 2000))}
          placeholder="Anything you'd like the business — and other clients — to know? (optional)"
          rows={5}
          style={{
            width: '100%', resize: 'vertical', padding: '10px 12px', borderRadius: 10,
            border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
            color: 'var(--fg)', fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5,
            outline: 'none',
          }}/>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: -8, textAlign: 'right' }}>
          {text.length}/2000
        </div>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => !busy && onClose()}
            className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} disabled={busy}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy || rating < 1}
            className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}>
            {busy ? 'Posting…' : 'Post review'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Star({ filled }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  );
}

// Reschedule modal: fetches the workspace's public calendar by slug,
// renders a date picker + computed slot grid for the booking's
// service. Submit PATCHes /api/me/bookings/:id with rescheduleTo.
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

  const svc = cal?.services.find((s) => s.id === booking.serviceId)
    || (booking.durationMinutes ? { id: booking.serviceId, durationMinutes: booking.durationMinutes } : null);

  // slotsForDate is from the calendar utils — same logic the public
  // booking page uses, so the slot grid here matches what a fresh
  // booking would show. Reuses the same conflict / availability rules.
  const dateObj = (() => {
    try { return new Date(date + 'T00:00:00'); }
    catch { return new Date(); }
  })();
  let slots = [];
  if (cal && svc) {
    try {
      slots = slotsForDate(cal, dateObj, svc) || [];
    } catch {
      // Defensive: malformed availability shouldn't crash the modal.
    }
  }

  // Same-slot-as-current is allowed (server self-excludes). Past
  // dates filtered client-side; server will refuse anyway.
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const submit = async () => {
    if (!pick) { setSubmitErr('Pick a new time first.'); return; }
    setBusy(true); setSubmitErr(null);
    try {
      await api.patch('/me/bookings/' + booking.id, {
        rescheduleTo: { date, startMin: pick.start, endMin: pick.end },
      });
      onRescheduled?.();
    } catch (e) {
      setSubmitErr(e.message || 'Could not reschedule. Try a different slot.');
      setBusy(false);
    }
  };

  return (
    <div onClick={() => !busy && onClose()} style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,14,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: '100%', maxWidth: 540, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Calendar size={18} sw={2}/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Reschedule booking</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {booking.serviceName || 'Session'} · {booking.businessName}
            </div>
          </div>
          <button type="button" onClick={() => !busy && onClose()}
            className="btn btn-ghost" style={{ padding: 6 }}>
            <Icons.X size={14}/>
          </button>
        </div>

        <div style={{
          padding: 10, borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 12.5, color: 'var(--muted)',
        }}>
          Currently <b style={{ color: 'var(--fg-2)' }}>
            {fmtDay(booking.date)} at {fmtTime(booking.startMin)}
          </b>
        </div>

        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>
            Pick a new date
          </div>
          <input type="date" value={date}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(e) => { setDate(e.target.value); setPick(null); }}
            style={{
              padding: '10px 12px', borderRadius: 10,
              background: 'var(--surface)', border: '1px solid var(--border-strong)',
              color: 'var(--fg)', fontSize: 14, outline: 'none',
            }}/>
        </div>

        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, fontWeight: 500 }}>
            Available times
          </div>
          {calErr ? (
            <div style={{
              padding: 10, borderRadius: 10,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5,
            }}>Couldn't load availability: {calErr.message}</div>
          ) : !cal ? (
            <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>Loading availability…</div>
          ) : slots.filter((s) => s.available).length === 0 ? (
            <div style={{
              padding: 16, borderRadius: 10,
              background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
              color: 'var(--muted)', fontSize: 12.5, textAlign: 'center',
            }}>
              No openings on that date — try another day.
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
              gap: 6, maxHeight: 260, overflowY: 'auto',
            }}>
              {slots.filter((s) => s.available).map((s) => {
                const selected = pick?.start === s.start;
                const isCurrent = date === booking.date && s.start === booking.startMin;
                return (
                  <button key={s.start} type="button"
                    onClick={() => setPick(s)}
                    style={{
                      padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                      cursor: 'pointer',
                      background: selected ? 'var(--accent)' : 'var(--surface-2)',
                      color: selected ? 'var(--accent-ink)' : 'var(--fg-2)',
                      border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                    }}>
                    {fmtTime(s.start)}
                    {isCurrent && (
                      <div style={{ fontSize: 9.5, fontWeight: 600, color: selected ? 'var(--accent-ink)' : 'var(--muted)', marginTop: 2 }}>
                        current
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {submitErr && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{submitErr}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => !busy && onClose()}
            className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} disabled={busy}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !pick}
            className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}>
            {busy ? 'Moving…' : 'Confirm reschedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
