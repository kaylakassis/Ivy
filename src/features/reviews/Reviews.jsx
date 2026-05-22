// Owner Reviews tab. Lists every review on the workspace grouped by state:
//   • Pending  — submitted by clients, NOT yet public. Publish or hide.
//   • Published — live on the booking page / Discover / profile. Hide or respond.
//   • Hidden    — taken down. Re-publish anytime.
// Backed by GET /api/reviews (list + summary) and PATCH /api/reviews/:id
// (status: visible|hidden, ownerResponse).
import React, { useEffect, useState, useCallback } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

function Stars({ rating }) {
  const r = Math.max(0, Math.min(5, Number(rating) || 0));
  return (
    <span aria-label={`${r} out of 5 stars`} style={{ color: '#E0B645', fontSize: 14, letterSpacing: 1 }}>
      {'★'.repeat(r)}<span style={{ color: 'var(--border-strong)' }}>{'★'.repeat(5 - r)}</span>
    </span>
  );
}

const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; } };

export default function Reviews() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [respondId, setRespondId] = useState(null);
  const [respondText, setRespondText] = useState('');

  const load = useCallback(async () => {
    try { const r = await api.get('/reviews'); setData(r); setError(null); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const patch = async (id, body) => {
    setBusyId(id);
    try { await api.patch(`/reviews/${id}`, body); await load(); }
    catch (e) { setError(e); }
    finally { setBusyId(null); }
  };

  const submitResponse = async (id) => {
    const text = respondText.trim();
    await patch(id, { ownerResponse: text || null });
    setRespondId(null); setRespondText('');
  };

  if (loading) return <div className="page-pad" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;

  const reviews = data?.reviews || [];
  const summary = data?.summary || {};
  const pending = reviews.filter((r) => r.status === 'pending');
  const visible = reviews.filter((r) => r.status === 'visible');
  const hidden  = reviews.filter((r) => r.status === 'hidden');

  const Card = ({ r }) => (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Stars rating={r.rating} />
        <span style={{ fontWeight: 600, fontSize: 14 }}>{r.reviewerName}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>· {fmtDate(r.createdAt)}</span>
        {r.rating <= 2 && r.status === 'pending' && (
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 12%, transparent)', padding: '2px 8px', borderRadius: 99 }}>
            Low rating
          </span>
        )}
      </div>
      {r.text && <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>{r.text}</div>}

      {r.ownerResponse && (
        <div style={{ fontSize: 12.5, color: 'var(--fg-2)', borderLeft: '2px solid var(--accent)', paddingLeft: 10 }}>
          <span style={{ fontWeight: 600 }}>Your response:</span> {r.ownerResponse}
        </div>
      )}

      {respondId === r.id ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea value={respondText} onChange={(e) => setRespondText(e.target.value)}
            placeholder="Write a public response…" rows={3}
            style={{ width: '100%', resize: 'vertical', padding: 10, borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={busyId === r.id} onClick={() => submitResponse(r.id)} style={{ fontSize: 12.5 }}>Save response</button>
            <button className="btn btn-ghost" onClick={() => { setRespondId(null); setRespondText(''); }} style={{ fontSize: 12.5 }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {r.status !== 'visible' && (
            <button className="btn btn-primary" disabled={busyId === r.id} onClick={() => patch(r.id, { status: 'visible' })} style={{ fontSize: 12.5 }}>
              <Icons.Eye size={13}/> Publish
            </button>
          )}
          {r.status !== 'hidden' && (
            <button className="btn btn-ghost" disabled={busyId === r.id} onClick={() => patch(r.id, { status: 'hidden' })} style={{ fontSize: 12.5 }}>
              <Icons.EyeOff size={13}/> Hide
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => { setRespondId(r.id); setRespondText(r.ownerResponse || ''); }} style={{ fontSize: 12.5 }}>
            <Icons.Chat size={13}/> {r.ownerResponse ? 'Edit response' : 'Respond'}
          </button>
        </div>
      )}
    </div>
  );

  const Section = ({ title, hint, items }) => items.length === 0 ? null : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title} <span style={{ color: 'var(--muted)' }}>({items.length})</span></div>
        {hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{hint}</div>}
      </div>
      {items.map((r) => <Card key={r.id} r={r} />)}
    </div>
  );

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 22 }}>Reviews</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--fg-2)' }}>
          New reviews are held here for you to publish — nothing goes public until you say so.
        </p>
      </div>

      {/* Summary tiles */}
      <div className="grid-auto" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        <Tile label="Average" value={summary.avg != null ? `${summary.avg.toFixed(1)} ★` : '—'} />
        <Tile label="Awaiting review" value={summary.pendingCount || 0} tone={summary.pendingCount ? 'var(--accent)' : undefined} />
        <Tile label="Published" value={summary.visibleCount || 0} />
        <Tile label="Hidden" value={summary.hiddenCount || 0} />
      </div>

      {error && (
        <div className="card" style={{ padding: 14, color: 'var(--danger)', fontSize: 13 }}>
          Couldn’t load reviews — {error.message}
        </div>
      )}

      {reviews.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Heart" title="No reviews yet"
            hint="After a completed appointment, THRYVE automatically asks clients for a review. They'll land here for you to publish." />
        </div>
      ) : (
        <>
          <Section title="Awaiting your review" hint="Not visible to anyone yet. Publish the ones you'd like on your booking page." items={pending} />
          <Section title="Published" hint="Live on your booking page, Discover listing, and profile." items={visible} />
          <Section title="Hidden" items={hidden} />
        </>
      )}
    </div>
  );
}

function Tile({ label, value, tone }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: tone || 'var(--fg)' }}>{value}</div>
    </div>
  );
}
