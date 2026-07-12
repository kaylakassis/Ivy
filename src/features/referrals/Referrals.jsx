// Referral portal — the full "refer a friend, you both get a free week"
// surface. Expands the small Account referral card into a dedicated page:
// shareable link + custom code, how-it-works, earnings summary, and a
// per-referral history table. Backed by GET /api/referrals (see
// api/referrals/index.js + api/_lib/referrals.js). Owner-only; the endpoint
// gates eligibility (trial/active/past_due) and returns 400 otherwise, which
// we render as a gentle "start your trial" note rather than an error.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

function money(cents) {
  const n = Number(cents || 0) / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return '—'; }
}

const STATUS = {
  invited:    { label: 'Invited',    bg: 'var(--surface-2)', fg: 'var(--muted)' },
  subscribed: { label: 'Subscribed', bg: 'var(--accent-soft)', fg: 'var(--accent)' },
  rewarded:   { label: 'Reward earned', bg: 'rgba(34,197,94,0.14)', fg: 'rgb(21,128,61)' },
};

export default function Referrals() {
  const [data, setData]   = useState(undefined); // undefined=loading · null=ineligible · {…}
  const [draft, setDraft] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let live = true;
    api.get('/referrals')
      .then((r) => { if (live) { setData(r); setDraft(r.code || ''); } })
      .catch((e) => { if (live) setData(e?.status === 400 ? null : { error: true, message: e.message }); });
    return () => { live = false; };
  }, []);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.put('/referrals', { code: draft });
      setData((prev) => ({ ...prev, ...r }));
      setDraft(r.code);
    } catch (e) {
      setErr(e.message || 'Could not save code');
    } finally { setBusy(false); }
  };

  const copy = async (text, which) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(''), 2000);
    } catch { /* clipboard blocked */ }
  };

  const share = async () => {
    if (!data?.link || !navigator.share) return;
    try {
      await navigator.share({
        title: 'Ivy',
        text: 'Run your whole business in one place. Use my link — we both get a free week.',
        url: data.link,
      });
    } catch { /* dismissed */ }
  };

  if (data === undefined) {
    return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading referrals…</div>;
  }
  if (data === null) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Gift" title="Referrals unlock with your trial"
            hint="Start your Ivy trial or subscribe and you can invite friends — you'll both get a free week." />
        </div>
      </div>
    );
  }
  if (data.error) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Gift" title="Couldn't load referrals" hint={data.message || 'Try refreshing.'} />
        </div>
      </div>
    );
  }

  const stats = data.stats || {};
  const weeks = data.weeksEarned ?? stats.rewarded ?? 0;
  const list = data.referrals || [];

  return (
    <div style={{ padding: '24px 24px 48px', maxWidth: 860, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* Hero */}
      <div className="card" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 11, flexShrink: 0,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icons.Gift size={20} sw={1.8} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.2 }}>Refer a friend — you both get a free week</div>
            <div style={{ fontSize: 13, color: 'var(--fg-2)' }}>
              When someone subscribes with your link, {money(data.rewardCents)} comes off both your next invoices. It stacks.
            </div>
          </div>
        </div>

        {/* Code editor */}
        <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', margin: '14px 0 6px' }}>
          Your referral code
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            placeholder="e.g. SARAH-HAIR"
            maxLength={40}
            style={{
              flex: 1, minWidth: 180, padding: '10px 12px', borderRadius: 10,
              border: '1px solid var(--border-strong)', background: 'var(--surface)',
              outline: 'none', fontSize: 14, color: 'var(--fg)', textTransform: 'uppercase',
            }} />
          <button className="btn btn-primary" onClick={save}
            disabled={busy || !draft.trim() || draft.trim() === (data.code || '')}
            style={{ padding: '9px 16px', fontSize: 13 }}>
            {busy ? 'Saving…' : (data.code ? 'Update' : 'Set code')}
          </button>
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 10 }}>{err}</div>}

        {/* Link + share */}
        {data.link && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <code style={{
              flex: 1, minWidth: 200, padding: '10px 12px', borderRadius: 8,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 12.5, color: 'var(--fg-2)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{data.link}</code>
            <button className="btn btn-primary" onClick={() => copy(data.link, 'link')} style={{ gap: 8 }}>
              <Icons.Copy size={14} sw={1.9} /> {copied === 'link' ? 'Copied!' : 'Copy link'}
            </button>
            {typeof navigator !== 'undefined' && navigator.share && (
              <button className="btn btn-outline" onClick={share} style={{ padding: '9px 14px', fontSize: 13 }}>Share</button>
            )}
          </div>
        )}
      </div>

      {/* Earnings summary */}
      <div className="card" style={{ padding: 22 }}>
        <div className="metric-label" style={{ marginBottom: 14 }}>Your earnings</div>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <Stat label="Friends referred" value={stats.referred ?? 0} />
          <Stat label="Subscribed"       value={stats.converted ?? 0} />
          <Stat label="Free weeks earned" value={weeks} />
          <Stat label="Credit earned"     value={money(stats.rewarded_cents)} />
        </div>
      </div>

      {/* How it works */}
      <div className="card" style={{ padding: 22 }}>
        <div className="metric-label" style={{ marginBottom: 14 }}>How it works</div>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          <li>Share your link or code with another business owner.</li>
          <li>They start their free trial and subscribe.</li>
          <li><strong>You both get a free week</strong> — automatically credited to your next invoice. Refer more, earn more.</li>
        </ol>
      </div>

      {/* History */}
      <div className="card" style={{ padding: 22 }}>
        <div className="metric-label" style={{ marginBottom: 14 }}>Referral history</div>
        {list.length === 0 ? (
          <EmptyNote icon="Users" title="No referrals yet"
            hint="Share your link above — when a friend subscribes, they'll show up here." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11.5 }}>
                  <th style={{ padding: '6px 8px', fontWeight: 500 }}>Friend</th>
                  <th style={{ padding: '6px 8px', fontWeight: 500 }}>Joined</th>
                  <th style={{ padding: '6px 8px', fontWeight: 500 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r, i) => {
                  const s = STATUS[r.status] || STATUS.invited;
                  return (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 8px', fontWeight: 500 }}>{r.name}</td>
                      <td style={{ padding: '10px 8px', color: 'var(--fg-2)' }}>{fmtDate(r.signedUpAt)}</td>
                      <td style={{ padding: '10px 8px' }}>
                        <span style={{
                          display: 'inline-block', padding: '3px 10px', borderRadius: 999,
                          background: s.bg, color: s.fg, fontSize: 11.5, fontWeight: 600,
                        }}>{s.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>{label}</div>
    </div>
  );
}
