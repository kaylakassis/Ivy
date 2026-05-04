// /me/bookings — every appointment across all the user's businesses,
// grouped Upcoming / Past / Cancelled with a tab picker.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';

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
  // Bookings the user can review — fetched server-side so we know which
  // past rows haven't been reviewed yet without a per-row probe.
  const [pendingReviewIds, setPendingReviewIds] = useState(new Set());
  const [reviewing, setReviewing]   = useState(null); // booking pending review

  const [reloadKey, setReloadKey] = useState(0);

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
      await api.del('/me/bookings/' + confirming.id);
      // Refetch so upcoming/past/cancelled buckets are correct.
      const fresh = await api.get('/me/bookings');
      setData(fresh);
      setConfirming(null);
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
      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface-2)', borderRadius: 10, alignSelf: 'flex-start' }}>
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
              reviewable={tab === 'past' && pendingReviewIds.has(b.id)}
              onCancel={() => { setCancelErr(null); setConfirming(b); }}
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
    </div>
  );
}

function BookingRow({ booking, first, cancellable, reviewable, onCancel, onReview }) {
  const d = new Date(booking.date + 'T00:00:00');
  return (
    <div style={{
      padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
      borderTop: first ? 'none' : '1px solid var(--border)',
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
        {booking.notes && (
          <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 4 }}>{booking.notes}</div>
        )}
      </div>
      {booking.cancelledAt && (
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Cancelled
        </div>
      )}
      {reviewable && (
        <button onClick={onReview} className="btn btn-outline"
          style={{ fontSize: 12, padding: '6px 12px' }}
          title="Leave a review of this session">
          <Icons.Check size={12} sw={2}/> Leave review
        </button>
      )}
      {cancellable && (
        <button onClick={onCancel} className="btn btn-ghost"
          style={{ fontSize: 12, padding: '6px 10px', color: 'var(--muted)' }}
          title="Cancel this booking">
          Cancel
        </button>
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
