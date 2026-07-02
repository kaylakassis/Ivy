// "Invite a fellow coach" — surfaces the existing free-month referral loop
// (api/referrals) that was otherwise buried in Settings, to drive beta
// participation. Renders NOTHING when the endpoint is unavailable (the referral
// program is under the active-subscription paywall), so it degrades quietly
// for trial accounts instead of erroring.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function InviteCoachCard() {
  const [state, setState] = useState(undefined); // undefined=loading · null=unavailable · {code,link}
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.get('/referrals')
      .then((r) => { if (live) setState(r); })
      .catch(() => { if (live) setState(null); }); // paywalled / not active → hide the card
    return () => { live = false; };
  }, []);

  if (state === undefined || state === null) return null;

  const copy = async () => {
    if (!state.link) return;
    try {
      await navigator.clipboard.writeText(state.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked */ }
  };

  const mint = async () => {
    setBusy(true);
    try {
      const code = `COACH${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const r = await api.put('/referrals', { code });
      setState(r);
    } catch { /* leave state; the user can set a code in Settings → Referrals */ }
    finally { setBusy(false); }
  };

  const pretty = state.link ? state.link.replace(/^https?:\/\//, '') : '';

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Gift size={17} sw={1.8}/>
        </div>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>Invite a fellow coach</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>You both get a free month when they subscribe.</div>
        </div>
      </div>

      {state.link ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{
            flex: '1 1 200px', display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm, 10px)', fontSize: 13, overflow: 'hidden',
          }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pretty}</span>
          </div>
          <button type="button" onClick={copy} className="btn btn-primary" style={{ gap: 8 }}>
            <Icons.Copy size={14} sw={1.9}/> {copied ? 'Copied!' : 'Copy invite'}
          </button>
        </div>
      ) : (
        <button type="button" onClick={mint} disabled={busy} className="btn btn-outline" style={{ alignSelf: 'flex-start' }}>
          {busy ? 'Creating…' : 'Get my invite link'}
        </button>
      )}
    </div>
  );
}
