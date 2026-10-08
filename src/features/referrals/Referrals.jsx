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

export default function Referrals({ embedded = false }) {
  const [data, setData]   = useState(undefined); // undefined=loading · null=ineligible · {…}
  const [draft, setDraft] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState(null);
  const [copied, setCopied] = useState('');
  // "Were you referred?" box: attach a friend's code after signup.
  const [attachDraft, setAttachDraft] = useState('');
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachErr, setAttachErr] = useState(null);
  const [attachedCode, setAttachedCode] = useState(null);

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

  const attach = async () => {
    const code = attachDraft.trim();
    if (!code) return;
    setAttachBusy(true); setAttachErr(null);
    try {
      const r = await api.post('/referrals/attach', { code });
      setAttachedCode(r.code || code.toUpperCase());
      setData((prev) => (prev ? { ...prev, canAttachCode: false } : prev));
    } catch (e) {
      setAttachErr(e.message || 'That code could not be added.');
    } finally { setAttachBusy(false); }
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
    return <div style={{ padding: embedded ? 12 : 48, color: 'var(--muted)', fontSize: 13 }}>Loading referrals…</div>;
  }
  if (data === null) {
    return (
      <div style={{ padding: embedded ? 0 : 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Gift" title="Referrals unlock with your trial"
            hint="Start your Ivy trial or subscribe and you can invite friends — you'll both get a free week." />
        </div>
      </div>
    );
  }
  if (data.error) {
    return (
      <div style={{ padding: embedded ? 0 : 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Gift" title="Couldn't load referrals" hint={data.message || 'Try refreshing.'} />
        </div>
      </div>
    );
  }

  const stats = data.stats || {};
  const weeks = data.weeksEarned ?? stats.rewarded ?? 0;
  const list = data.referrals || [];
  const rewards = data.rewards || [];
  const isApple = data.platform === 'apple';
  const bankedWeeks = data.bankedWeeks || 0;
  const howDelivered = isApple
    ? '7 days added to your Apple subscription'
    : 'credited to your next invoice';
  const heroLine = isApple
    ? `When someone subscribes with your link, you both get 7 days added to your subscriptions. It stacks.`
    : `When someone subscribes with your link, ${money(data.rewardCents)} comes off both your next invoices. It stacks.`;

  return (
    <div style={embedded ? { display: 'flex', flexDirection: 'column', gap: 18 } : { padding: '24px 24px 48px', maxWidth: 860, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

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
              {heroLine}
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

      {/* Were you referred? (only while a code can still be attached) */}
      {(data.canAttachCode || attachedCode) && (
        <div className="card" style={{ padding: 20 }}>
          {attachedCode ? (
            <div style={{ fontSize: 13.5, color: 'var(--fg-2)' }}>
              Code <strong>{attachedCode}</strong> is on your account. When you subscribe, you and your friend each get a free week.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 4 }}>Were you referred? Enter a code</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
                If a friend sent you to Ivy, add their code here and you both get a free week once you subscribe.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  value={attachDraft}
                  onChange={(e) => setAttachDraft(e.target.value.toUpperCase())}
                  placeholder="Friend's code"
                  maxLength={40}
                  autoCapitalize="characters" spellCheck={false}
                  style={{
                    flex: 1, minWidth: 160, padding: '10px 12px', borderRadius: 10,
                    border: '1px solid var(--border-strong)', background: 'var(--surface)',
                    outline: 'none', fontSize: 14, color: 'var(--fg)', textTransform: 'uppercase',
                  }} />
                <button className="btn btn-outline" onClick={attach}
                  disabled={attachBusy || !attachDraft.trim()}
                  style={{ padding: '9px 16px', fontSize: 13 }}>
                  {attachBusy ? 'Adding…' : 'Add code'}
                </button>
              </div>
              {attachErr && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>{attachErr}</div>}
            </>
          )}
        </div>
      )}

      {/* Earnings summary */}
      <div className="card" style={{ padding: 22 }}>
        <div className="metric-label" style={{ marginBottom: 14 }}>Your earnings</div>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <Stat label="Friends referred" value={stats.referred ?? 0} />
          <Stat label="Subscribed"       value={stats.converted ?? 0} />
          <Stat label="Free weeks earned" value={weeks} />
          {isApple
            ? <Stat label="Days added" value={(data.appliedWeeks || 0) * 7} />
            : <Stat label="Credit earned" value={money(stats.rewarded_cents)} />}
        </div>
        {isApple && bankedWeeks > 0 && (
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
            background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--fg-2)',
          }}>
            {bankedWeeks === 1 ? '1 more week earned.' : `${bankedWeeks} more weeks earned.`}{' '}
            {data.nextEligibleAt
              ? `Apple allows two renewal extensions a year, so ${bankedWeeks === 1 ? 'it' : 'they'} will be added ${bankedWeeks === 1 ? '' : 'together '}on ${fmtDate(data.nextEligibleAt)}.`
              : `${bankedWeeks === 1 ? 'It' : 'They'} will be added to your Apple subscription shortly.`}
          </div>
        )}
        {rewards.length > 0 && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rewards.map((r) => (
              <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13, color: 'var(--fg-2)' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12, minWidth: 92 }}>{fmtDate(r.earnedAt)}</span>
                <span>
                  {r.side === 'referred' ? 'Welcome week' : 'Referral week'}:{' '}
                  {r.method === 'stripe_credit'
                    ? 'credited to your next invoice'
                    : r.method === 'apple_extension'
                      ? `added ${r.weeks * 7} days to your Apple subscription`
                      : (isApple ? 'waiting for the next Apple extension' : 'pending')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="card" style={{ padding: 22 }}>
        <div className="metric-label" style={{ marginBottom: 14 }}>How it works</div>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          <li>Share your link or code with another business owner.</li>
          <li>They start their free trial and subscribe.</li>
          <li><strong>You both get a free week</strong>, automatically {howDelivered}. Refer more, earn more.</li>
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
