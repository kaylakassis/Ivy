// /book/:slug/policy - a business's cancellation policy, public.
// With ?t=<token> (the link an owner emails for a booking they made), the
// client can also tick "I have read and agree" and the acceptance is
// recorded for that booking. The owner's text is rendered as React text.
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';

function fmtAppt(a) {
  if (!a?.date) return null;
  const d = new Date(`${a.date}T00:00:00Z`);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  if (a.startMin == null) return day;
  const h = Math.floor(a.startMin / 60), m = a.startMin % 60;
  return `${day} at ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export default function PublicPolicyPage() {
  const { slug } = useParams();
  const [tweaks] = useTweaks();
  const [params] = useSearchParams();
  const token = params.get('t');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [submitErr, setSubmitErr] = useState(null);

  useEffect(() => {
    const q = token ? `token=${encodeURIComponent(token)}` : `slug=${encodeURIComponent(slug || '')}`;
    api.get(`/cancellation-policy/public?${q}`)
      .then((r) => { setData(r); if (r.request?.accepted) setDone(true); })
      .catch((e) => setErr(e.message || 'This page is not available.'));
  }, [slug, token]);

  const agree = async (e) => {
    e.preventDefault();
    if (!checked || busy) return;
    setBusy(true); setSubmitErr(null);
    try {
      await api.post(`/cancellation-policy/public?token=${encodeURIComponent(token)}`, {
        policyAccepted: true, policyVersionId: data.policy.versionId,
      });
      setDone(true);
    } catch (ex) {
      if (ex.details?.policy) { setData((d) => ({ ...d, policy: ex.details.policy })); setChecked(false); }
      setSubmitErr(ex.message || 'Could not save. Try again.');
    } finally { setBusy(false); }
  };

  const wrap = (children) => (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', background: 'var(--page)', color: 'var(--fg)', padding: '32px 16px 64px' }}>
      <main style={{ maxWidth: 680, margin: '0 auto' }}>{children}</main>
    </div>
  );

  if (err) return wrap(<div className="card" style={{ padding: 20, fontSize: 14 }}>{err}</div>);
  if (!data) return wrap(<div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</div>);
  const p = data.policy;
  const appt = fmtAppt(data.request?.appointment);

  return wrap(
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icons.Lock size={16} sw={1.8}/>
        </span>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650 }}>Cancellation policy</h1>
          {data.businessName && <div style={{ fontSize: 13, color: 'var(--muted)' }}>{data.businessName}</div>}
        </div>
      </div>
      {token && appt && (
        <p style={{ fontSize: 14, color: 'var(--fg-2)', margin: '12px 0 0' }}>
          {data.request?.clientFirstName ? `Hi ${data.request.clientFirstName}, ` : ''}this is for your appointment on {appt}.
        </p>
      )}
      {!p ? (
        <p style={{ fontSize: 14, color: 'var(--muted)' }}>This business has not published a cancellation policy.</p>
      ) : (
        <>
          <div style={{
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14.5, lineHeight: 1.65, marginTop: 14,
            padding: '14px 16px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>{p.text}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            Version {p.version} · updated {new Date(p.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        </>
      )}
      {token && p && (
        done ? (
          <div role="status" style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', color: 'var(--ok)', fontWeight: 600, fontSize: 14 }}>
            <Icons.Check size={16} sw={2.4}/> Thanks, your acceptance is saved.
          </div>
        ) : (
          <form onSubmit={agree} style={{ marginTop: 16 }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, fontWeight: 550, cursor: 'pointer', minHeight: 44 }}>
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} required
                style={{ marginTop: 3, width: 18, height: 18, accentColor: 'var(--accent)' }}/>
              <span>I have read and agree to the cancellation policy</span>
            </label>
            {submitErr && <div role="alert" style={{ color: 'var(--danger)', fontSize: 13, marginTop: 6 }}>{submitErr}</div>}
            <button type="submit" className="btn btn-primary" disabled={!checked || busy} style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}>
              {busy ? 'Saving…' : 'Agree'}
            </button>
          </form>
        )
      )}
      {data.bookingSlug && !token && (
        <div style={{ marginTop: 18 }}>
          <Link to={`/book/${data.bookingSlug}`} className="btn btn-outline">
            <Icons.Calendar size={14}/> Book an appointment
          </Link>
        </div>
      )}
    </div>,
  );
}
