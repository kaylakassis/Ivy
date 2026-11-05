// Finance > Services: the business's own cancellation policy.
//
// The owner writes the words (plain text, every save keeps the old
// version), flips "Require clients to accept my cancellation policy when
// they book", and chooses where it shows. The money numbers (deposit,
// late-cancel fee and window, no-show fee) come from each service and are
// summarised here so the words and the numbers can be checked together.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const STARTER = `Please give at least 24 hours notice if you need to cancel or move your appointment.

Cancellations with less than 24 hours notice may be charged the late-cancellation fee shown when you book. Missed appointments may be charged the no-show fee.

If you paid a deposit and cancel in time, it is refunded. If you cancel late, the deposit is kept and counts toward the fee.`;

function money(n, currency = 'USD') {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n || 0)); } catch { return `$${Number(n || 0).toFixed(2)}`; }
}
function hoursLabel(h) {
  const n = Number(h);
  if (!(n > 0)) return 'no window';
  return n % 24 === 0 ? `${n / 24} day${n === 24 ? '' : 's'}` : `${n} hour${n === 1 ? '' : 's'}`;
}
function depositLabel(s, currency) {
  if (s.depositType === 'full') return 'paid in full';
  if (s.depositType === 'percent' && s.depositAmount > 0) return `${s.depositAmount}% deposit`;
  if (s.depositType === 'fixed' && s.depositAmount > 0) return `${money(Math.min(s.depositAmount, s.price || s.depositAmount), currency)} deposit`;
  return 'no deposit';
}

export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} aria-label={label}
      onClick={() => !disabled && onChange(!checked)} disabled={disabled}
      style={{
        width: 42, height: 24, borderRadius: 999, position: 'relative', flexShrink: 0,
        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background .15s',
        background: checked ? 'var(--accent)' : 'var(--border-strong)', opacity: disabled ? 0.55 : 1,
      }}>
      <span style={{
        position: 'absolute', top: 3, left: checked ? 21 : 3, width: 18, height: 18, borderRadius: 999,
        background: '#fff', transition: 'left .15s',
      }}/>
    </button>
  );
}

function SwitchRow({ title, sub, checked, onChange, disabled }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        {sub && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={title}/>
    </div>
  );
}

export default function CancellationPolicyCard() {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showVersions, setShowVersions] = useState(false);
  const [open, setOpen] = useState(false);

  const load = () => api.get('/cancellation-policy').then((s) => {
    setState(s);
    setDraft(s.policy?.text || '');
    setOpen((o) => o || !!s.policy);
  }).catch((e) => setMsg({ kind: 'error', text: e.message || 'Could not load your policy' }));
  useEffect(() => { load(); }, []);

  const save = async (patch, okText) => {
    setBusy(true); setMsg(null);
    try {
      const s = await api.put('/cancellation-policy', patch);
      setState(s);
      if (patch.text !== undefined) setDraft(s.policy?.text || '');
      setMsg({ kind: 'ok', text: s.createdVersion ? `Saved as version ${s.createdVersion}.` : okText || 'Saved.' });
    } catch (e) {
      setMsg({ kind: 'error', text: e.message || 'Could not save' });
    } finally { setBusy(false); }
  };

  if (!state) {
    return (
      <div className="card" style={{ padding: 16, marginBottom: 16, fontSize: 13, color: 'var(--muted)' }}>
        {msg?.text || 'Loading your cancellation policy…'}
      </div>
    );
  }

  const { policy, settings, versions = [], services = [], currency, cardPayments, maxChars } = state;
  const dirty = draft.trim() !== (policy?.text || '').trim();
  const withFees = services.filter((s) => s.lateCancelFee > 0 || s.noShowFee > 0 || s.depositType !== 'none');

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }} data-testid="cancellation-policy-card">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit' }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icons.Lock size={16} sw={1.8}/>
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 650 }}>Cancellation policy</span>
          <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            {policy
              ? `Version ${policy.version}${settings.requireAcceptance ? ' · clients must accept it to book' : ' · acceptance not required'}`
              : 'Write your policy so clients see it, and turn on acceptance when they book.'}
          </span>
        </span>
        <Icons.ArrowDown size={14} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s', color: 'var(--muted)' }}/>
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          <label htmlFor="cpolicy-text" style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Your policy, in your words</label>
          <textarea id="cpolicy-text" value={draft} onChange={(e) => setDraft(e.target.value.slice(0, maxChars))}
            rows={7} maxLength={maxChars} className="input"
            placeholder="For example: Please give at least 24 hours notice to cancel or move your appointment…"
            style={{ width: '100%', fontSize: 14, lineHeight: 1.55, resize: 'vertical', fontFamily: 'inherit' }}/>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1, minWidth: 140 }}>
              {draft.length}/{maxChars} · Each save keeps the old version, so you can always show what a client agreed to.
            </span>
            {!policy && !draft.trim() && (
              <button type="button" className="btn btn-outline" onClick={() => setDraft(STARTER)} style={{ fontSize: 12.5 }}>
                Start from an example
              </button>
            )}
            <button type="button" className="btn btn-primary" disabled={busy || !dirty || draft.trim().length < 20}
              style={{ opacity: busy || !dirty || draft.trim().length < 20 ? 0.5 : 1 }}
              onClick={() => save({ text: draft })}>
              {busy ? 'Saving…' : policy ? 'Save new version' : 'Save policy'}
            </button>
          </div>

          <div style={{ marginTop: 14 }}>
            <SwitchRow
              title="Require clients to accept my cancellation policy when they book"
              sub={policy
                ? 'Clients see your policy and must tick "I have read and agree" before the booking is confirmed. Each acceptance is saved on the client\'s profile with the exact words, time and device, in case a charge is ever disputed.'
                : 'Save your policy first, then you can turn this on.'}
              checked={settings.requireAcceptance} disabled={busy || !policy}
              onChange={(v) => save({ requireAcceptance: v }, v ? 'Clients now accept your policy when they book.' : 'Acceptance turned off.')}/>
            <SwitchRow title="Show it on my booking page"
              sub="A short summary and a link to the full policy, even when acceptance is off."
              checked={settings.showOnBookingPage} disabled={busy || !policy}
              onChange={(v) => save({ showOnBookingPage: v })}/>
            <SwitchRow title='Show a "Cancellation policy" link in my website footer'
              sub='You can also add a "Cancellation policy" section to any page of your website. It always shows the latest version.'
              checked={settings.showInSiteFooter} disabled={busy || !policy}
              onChange={(v) => save({ showInSiteFooter: v })}/>
            <SwitchRow title="Deposits are refundable when clients cancel in time"
              sub="When a client cancels before the service's cancellation window, you get a one-tap Refund or Keep deposit request. Nothing is refunded until you tap Refund. Late cancellations keep the deposit, and it counts toward the late fee."
              checked={settings.refundDepositOutsideWindow} disabled={busy}
              onChange={(v) => save({ refundDepositOutsideWindow: v })}/>
          </div>

          {msg && (
            <div role="status" style={{ marginTop: 10, fontSize: 13, color: msg.kind === 'error' ? 'var(--danger)' : 'var(--ok)' }}>{msg.text}</div>
          )}

          <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Fees from your services</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 8 }}>
              The amounts clients agree to come from each service below (edit a service to change them).
              {!cardPayments && ' Card payments are not connected, so late-cancel and no-show fees become a draft invoice for you to send instead of an automatic charge.'}
            </div>
            {withFees.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>None of your services has a deposit or a cancellation fee yet.</div>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {withFees.map((s) => (
                  <li key={s.id} style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                    <b style={{ color: 'var(--fg)' }}>{s.name}</b>: {depositLabel(s, currency)}
                    {s.lateCancelFee > 0 ? ` · ${money(s.lateCancelFee, currency)} if cancelled within ${hoursLabel(s.windowHours)}` : ''}
                    {s.noShowFee > 0 ? ` · ${money(s.noShowFee, currency)} no-show fee` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {versions.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setShowVersions((v) => !v)} style={{ fontSize: 12.5, padding: '6px 8px' }}>
                {showVersions ? 'Hide earlier versions' : `See all versions (${versions.length})`}
              </button>
              {showVersions && (
                <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {versions.map((v) => (
                    <li key={v.id}>
                      <details>
                        <summary style={{ cursor: 'pointer', fontSize: 12.5 }}>
                          Version {v.version} · saved {new Date(v.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                        </summary>
                        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12.5, color: 'var(--fg-2)', padding: '8px 10px', marginTop: 6, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                          {v.text}
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
