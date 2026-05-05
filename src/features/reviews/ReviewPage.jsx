// /review/:token  (public, no auth)
//
// Lands here from the daily review-request email. Renders booking
// context (business name + service + date), captures a star rating
// + optional text, posts back to /api/review/:token. Single-use —
// the server invalidates the token on submit.
//
// Branding from the booking's workspace tints the page so the page
// feels owner-branded, matching the email the visitor just clicked.
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useTweaks } from '../../lib/tweaks.js';

export default function ReviewPage() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [tweaks] = useTweaks();
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  // Pre-rate when the email's "tap to rate" link carries ?rating=N.
  const initialRating = (() => {
    const r = parseInt(params.get('rating') || '', 10);
    return Number.isInteger(r) && r >= 1 && r <= 5 ? r : 0;
  })();
  const [rating, setRating] = useState(initialRating);
  const [text, setText]     = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/review/' + encodeURIComponent(token), { credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status });
        }
        return res.json();
      })
      .then((r) => live && setBooking(r.booking))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [token]);

  const submit = async (e) => {
    e?.preventDefault();
    if (!rating) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/review/' + encodeURIComponent(token), {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, text: text.trim() || null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setSubmitted(true);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <Wrap tweaks={tweaks}><div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div></Wrap>;
  }
  if (error && !submitted) {
    return (
      <Wrap tweaks={tweaks}>
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Heart"
            title="This review link isn't active"
            hint={error.message || "It may have already been submitted, or it's expired."}/>
        </div>
      </Wrap>
    );
  }
  if (submitted) {
    return (
      <Wrap tweaks={tweaks} accent={booking?.accentColor}>
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 99,
            background: booking?.accentColor || 'var(--ok)', color: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
          }}><Icons.Check size={28} sw={2.4}/></div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 26 }}>Thank you!</h1>
          <p style={{ color: 'var(--muted)', marginTop: 10, fontSize: 14, lineHeight: 1.55, maxWidth: 460, marginInline: 'auto' }}>
            Your review for <b style={{ color: 'var(--fg-2)' }}>{booking?.businessName}</b> is in.
            They'll see it instantly and can reply through their portal.
          </p>
        </div>
      </Wrap>
    );
  }

  const accent = booking?.accentColor || 'var(--accent)';

  return (
    <Wrap tweaks={tweaks} accent={booking?.accentColor}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
        {booking?.logoUrl ? (
          <img src={booking.logoUrl} alt="" style={{
            height: 48, maxWidth: 120, objectFit: 'contain',
          }}/>
        ) : (
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: accent, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Heart size={20}/></div>
        )}
        <div>
          <div className="metric-label">How was it?</div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 22 }}>
            Review your {booking?.serviceName} with {booking?.businessName}
          </h1>
        </div>
      </div>

      <form onSubmit={submit} className="card" style={{ padding: 28 }}>
        <div className="metric-label" style={{ marginBottom: 14, textAlign: 'center' }}>
          How would you rate this experience?
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 8, marginBottom: 24,
        }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" onClick={() => setRating(n)}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              style={{
                background: 'transparent', border: 0, cursor: 'pointer',
                fontSize: 38, lineHeight: 1,
                color: rating >= n ? '#E0B645' : '#D7D2C4',
                transition: 'transform .1s, color .1s',
                padding: '0 4px',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.15)')}
              onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
            >★</button>
          ))}
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500, display: 'block' }}>
            Want to add anything? (optional)
          </label>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            rows={5} maxLength={2000}
            placeholder={`What did you love? Anything that could be even better?`}
            style={{
              width: '100%', padding: '12px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
              color: 'var(--fg)', fontSize: 14, outline: 'none',
              fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.55,
            }}/>
        </div>

        <button type="submit" disabled={!rating || submitting}
          style={{
            width: '100%', padding: '14px', borderRadius: 10,
            background: rating ? accent : 'var(--surface-2)',
            color: rating ? '#fff' : 'var(--muted)',
            border: 0, fontSize: 14, fontWeight: 600,
            cursor: rating && !submitting ? 'pointer' : 'not-allowed',
          }}>
          {submitting ? 'Submitting…' : (rating ? 'Submit review' : 'Pick a rating to continue')}
        </button>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, textAlign: 'center' }}>
          One-time link — once submitted, it can't be used again.
        </div>
      </form>
    </Wrap>
  );
}

function Wrap({ tweaks, accent, children }) {
  // CSS var override so accent-keyed children inherit the workspace's color.
  const styleVars = accent ? { '--accent': accent } : {};
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', padding: '40px 24px 80px', background: 'var(--page)',
      ...styleVars,
    }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>{children}</div>
    </div>
  );
}
