// Owner Reviews tab. Reviews AUTO-PUBLISH the moment a client leaves them.
// Owners can respond publicly to any review, or appeal one for removal —
// appeals go to the Ivy OS support team, who approve (remove) or deny. Owners
// can't hide reviews themselves.
// Backed by GET /api/reviews (list + summary) and PATCH /api/reviews/:id
// ({ ownerResponse } or { appealReason }).
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

const badge = (text, color) => (
  <span style={{ fontSize: 11, fontWeight: 600, color, background: `color-mix(in srgb, ${color} 12%, transparent)`, padding: '2px 8px', borderRadius: 99 }}>
    {text}
  </span>
);

export default function Reviews() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [respondId, setRespondId] = useState(null);
  const [respondText, setRespondText] = useState('');
  const [appealId, setAppealId] = useState(null);
  const [appealText, setAppealText] = useState('');

  const load = useCallback(async () => {
    try { const r = await api.get('/reviews'); setData(r); setError(null); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const patch = async (id, body) => {
    setBusyId(id);
    try { await api.patch(`/reviews/${id}`, body); await load(); return true; }
    catch (e) { setError(e); return false; }
    finally { setBusyId(null); }
  };

  const submitResponse = async (id) => {
    await patch(id, { ownerResponse: respondText.trim() || null });
    setRespondId(null); setRespondText('');
  };
  const submitAppeal = async (id) => {
    const reason = appealText.trim();
    if (!reason) return;
    const okp = await patch(id, { appealReason: reason });
    if (okp) { setAppealId(null); setAppealText(''); }
  };

  if (loading) return <div className="page-pad" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;

  const reviews = data?.reviews || [];
  const summary = data?.summary || {};
  const visible = reviews.filter((r) => r.status === 'visible');
  const removed = reviews.filter((r) => r.status === 'hidden');

  const Card = ({ r }) => (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Stars rating={r.rating} />
        <span style={{ fontWeight: 600, fontSize: 14 }}>{r.reviewerName}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>· {fmtDate(r.createdAt)}</span>
        {r.appealStatus === 'requested' && badge('Appeal under review', 'var(--accent)')}
        {r.appealStatus === 'denied' && badge('Appeal denied', 'var(--muted)')}
        {r.status === 'hidden' && badge('Removed by support', 'var(--danger)')}
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
      ) : appealId === r.id ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Tell our support team why this review should be removed (e.g. fake, not a real client, abusive, violates policy). It stays public while we review.
          </div>
          <textarea value={appealText} onChange={(e) => setAppealText(e.target.value)}
            placeholder="Reason for the appeal…" rows={3}
            style={{ width: '100%', resize: 'vertical', padding: 10, borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={busyId === r.id || !appealText.trim()} onClick={() => submitAppeal(r.id)} style={{ fontSize: 12.5 }}>Submit appeal</button>
            <button className="btn btn-ghost" onClick={() => { setAppealId(null); setAppealText(''); }} style={{ fontSize: 12.5 }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={() => { setRespondId(r.id); setRespondText(r.ownerResponse || ''); }} style={{ fontSize: 12.5 }}>
            <Icons.Chat size={13}/> {r.ownerResponse ? 'Edit response' : 'Respond'}
          </button>
          {r.status === 'visible' && r.appealStatus !== 'requested' && (
            <button className="btn btn-ghost" disabled={busyId === r.id} onClick={() => { setAppealId(r.id); setAppealText(''); }} style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              Appeal for removal
            </button>
          )}
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
          Reviews publish automatically. Respond to any review, or appeal one for removal — our support team reviews every appeal.
        </p>
      </div>

      {/* Summary tiles */}
      <div className="grid-auto" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        <Tile label="Average" value={summary.avg != null ? `${summary.avg.toFixed(1)} ★` : '—'} />
        <Tile label="Published" value={summary.visibleCount || 0} />
        <Tile label="Removed" value={summary.hiddenCount || 0} />
      </div>

      {error && (
        <div className="card" style={{ padding: 14, color: 'var(--danger)', fontSize: 13 }}>
          Couldn’t complete that — {error.message}
        </div>
      )}

      {reviews.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Heart" title="No reviews yet"
            hint="After a completed appointment, Ivy OS automatically asks clients for a review. New reviews publish here right away — you can respond to any of them." />
        </div>
      ) : (
        <>
          <Section title="Published" hint="Live on your booking page, Discover listing, and profile." items={visible} />
          <Section title="Removed" hint="Taken down by our support team after an approved appeal." items={removed} />
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
