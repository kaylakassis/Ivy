// "Help me write it" on the Cancellation policy card: pick a few rules and
// the words write themselves (policyGenerator.js), starting from what Ivy
// already knows about the business (its name, its kind of work, each
// service's deposit, window and fees, the refund switch, packages). "Use
// this policy" hands the text to the card's textarea; nothing is saved
// until the owner presses Save there, which keeps a version as usual.
//
// A centered dialog on wide screens, a full-height sheet on phones.
import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../components/Icons.jsx';
import { useEscapeKey } from '../../lib/useEscapeKey.js';
import {
  BUSINESS_TYPES, NOTICE_OPTIONS, RESCHEDULE_OPTIONS, TONES, VOICES,
  generatePolicy, noticeLabel, policyOptionsFromIvy,
} from './policyGenerator.js';

// Ivy charges fixed dollar fees, so the app offers only these three.
const FEE_CHOICES = [
  { value: 'deposit', label: 'Keep the deposit', needsDeposit: true },
  { value: 'flat', label: 'A set fee ($)' },
  { value: 'none', label: 'No charge' },
];

const CSS = `
.cph-overlay{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.cph-sheet{width:100%;max-width:960px;max-height:min(92vh,880px);display:flex;flex-direction:column;padding:0;overflow:hidden}
.cph-head{display:flex;align-items:flex-start;gap:10px;padding:16px 18px 12px;border-bottom:1px solid var(--border)}
.cph-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:18px;padding:16px 18px}
.cph-preview-col{position:sticky;top:0;align-self:start}
.cph-foot{border-top:1px solid var(--border);padding:12px 18px calc(12px + env(safe-area-inset-bottom,0px));display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.cph-field{margin-bottom:14px}
.cph-label{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--fg)}
.cph-hint{font-size:12px;color:var(--muted);line-height:1.45;margin-top:5px}
.cph-warn{color:var(--warn)}
.cph-seg{display:flex;flex-wrap:wrap;gap:4px;padding:3px;background:var(--surface-2);border:1px solid var(--border);border-radius:10px}
.cph-seg button{flex:1 1 auto;min-width:0;padding:7px 10px;border:0;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;background:transparent;color:var(--muted);white-space:nowrap}
.cph-seg button[aria-checked="true"]{background:var(--surface);color:var(--fg);box-shadow:var(--shadow-sm)}
.cph-seg button:disabled{opacity:.45;cursor:not-allowed}
.cph-check{display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:1.45;cursor:pointer;padding:5px 0}
.cph-check input{margin-top:2px;width:16px;height:16px;flex-shrink:0;accent-color:var(--accent)}
.cph-money{display:flex;align-items:center;gap:6px;margin-top:8px}
.cph-preview{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:var(--fg-2);background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;max-height:calc(min(92vh,880px) - 220px);overflow-y:auto}
.cph-preview .ttl{font-weight:700;color:var(--fg);font-size:14px}
.cph-preview .hd{font-weight:700;color:var(--fg);margin-bottom:2px}
.cph-preview .li{padding-left:14px;text-indent:-14px;margin-bottom:3px}
.cph-preview .gap{height:10px}
.cph-divider{height:1px;background:var(--border);margin:4px 0 14px}
@media (max-width:760px){
  .cph-overlay{padding:0;align-items:stretch}
  .cph-sheet{max-width:none;max-height:none;height:100%;border-radius:0;border:0}
  .cph-head{padding-top:calc(14px + env(safe-area-inset-top,0px))}
  .cph-body{grid-template-columns:1fr;padding:14px 16px}
  .cph-preview-col{position:static}
  .cph-preview{max-height:none}
  .cph-foot{padding-left:16px;padding-right:16px}
}
`;

function Seg({ label, options, value, onChange, disabled = () => false, hint }) {
  return (
    <div className="cph-field" role="radiogroup" aria-label={label}>
      <span className="cph-label">{label}</span>
      <div className="cph-seg">
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" className="seg-btn"
            aria-checked={String(value) === String(o.value)} disabled={disabled(o)}
            onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
      {hint && <div className="cph-hint">{hint}</div>}
    </div>
  );
}

function Check({ checked, onChange, title, sub }) {
  return (
    <label className="cph-check">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)}/>
      <span><b>{title}</b>{sub ? <>: {sub}</> : null}</span>
    </label>
  );
}

function FeeChoice({ id, label, action, amount, takesDeposit, onAction, onAmount }) {
  return (
    <>
      <Seg label={label} options={FEE_CHOICES} value={action} onChange={onAction}
        disabled={(o) => o.needsDeposit && !takesDeposit}/>
      {action === 'flat' && (
        <div className="cph-field" style={{ marginTop: -6 }}>
          <label className="cph-money" htmlFor={id}>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>$</span>
            <input id={id} className="input" inputMode="decimal" autoComplete="off" value={amount}
              placeholder="Leave empty to use each service's fee"
              onChange={(e) => onAmount(e.target.value.replace(/[^0-9.,]/g, '').slice(0, 9))}
              style={{ flex: 1, minWidth: 0, fontSize: 14 }}/>
          </label>
        </div>
      )}
    </>
  );
}

// The policy as the owner reads it: same text as "Use this policy", with
// the title and section headings in bold. Plain text, never HTML.
function Preview({ text }) {
  const lines = text.split('\n');
  return (
    <div className="cph-preview" aria-live="polite" aria-label="Your policy, written from your choices" tabIndex={0} data-testid="policy-preview">
      {lines.map((line, i) => {
        if (!line) return <div key={i} className="gap" aria-hidden="true"/>;
        if (i === 0) return <div key={i} className="ttl">{line}</div>;
        const heading = !line.startsWith('• ') && (lines[i + 1] || '').startsWith('• ');
        return <div key={i} className={heading ? 'hd' : line.startsWith('• ') ? 'li' : undefined}>{line}</div>;
      })}
    </div>
  );
}

// Everything inside the sheet. `initial` are the starting options,
// `notes` say what came from the business's settings, `current` is the
// text in the card's box now (asks before replacing it), `refundSwitch`
// is the real "Deposits are refundable" switch.
export function HelperBody({ initial, notes = {}, current = '', refundSwitch = null, onUse, onClose }) {
  const [o, setO] = useState(() => ({ ...initial }));
  const [confirming, setConfirming] = useState(false);
  const set = (patch) => { setConfirming(false); setO((cur) => ({ ...cur, ...patch })); };
  const text = useMemo(() => generatePolicy(o), [o]);

  const notice = useMemo(() => {
    const list = [...NOTICE_OPTIONS];
    if (!list.some((n) => n.value === o.noticeHours)) {
      list.push({ value: o.noticeHours, label: noticeLabel(o.noticeHours) });
      list.sort((a, b) => a.value - b.value);
    }
    return list;
  }, [o.noticeHours]);

  const setDeposit = (on) => set({
    takesDeposit: on,
    ...(on ? {} : {
      lateAction: o.lateAction === 'deposit' ? 'none' : o.lateAction,
      noShowAction: o.noShowAction === 'deposit' ? 'none' : o.noShowAction,
    }),
  });

  const use = () => {
    const cur = String(current || '').trim();
    if (cur && cur !== text.trim() && !confirming) { setConfirming(true); return; }
    onUse(text);
  };

  const refundMismatch = o.takesDeposit && refundSwitch !== null && o.depositRefundable !== refundSwitch;

  return (
    <>
      <div className="cph-body">
        <div>
          {notes.fromServices && (
            <div className="cph-hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Filled in from your services and settings. Change anything you like.
            </div>
          )}
          <div className="cph-field">
            <label className="cph-label" htmlFor="cph-name">Business name</label>
            <input id="cph-name" className="input" maxLength={80} value={o.businessName}
              onChange={(e) => set({ businessName: e.target.value })} style={{ width: '100%', fontSize: 14 }}/>
          </div>
          <div className="cph-field">
            <label className="cph-label" htmlFor="cph-type">Type of business</label>
            <select id="cph-type" className="input" value={o.businessType}
              onChange={(e) => set({ businessType: e.target.value })} style={{ width: '100%', fontSize: 14 }}>
              {BUSINESS_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <Seg label="Write it as" options={VOICES} value={o.voice} onChange={(v) => set({ voice: v })}/>
          <Seg label="Notice to cancel or reschedule" options={notice} value={o.noticeHours}
            onChange={(v) => set({ noticeHours: Number(v) })}
            hint={notes.mixedWindows ? 'Your services use different cancellation windows. This starts from the most common one.' : null}/>

          <div className="cph-divider"/>

          <div className="cph-field">
            <Check checked={o.takesDeposit} onChange={setDeposit} title="I take a deposit when clients book"/>
            {o.takesDeposit && (
              <Check checked={o.depositRefundable} onChange={(v) => set({ depositRefundable: v })}
                title="Deposits are refunded when clients cancel in time"/>
            )}
            {refundMismatch && (
              <div className="cph-hint cph-warn">
                This does not match your switch &quot;Deposits are refundable when clients cancel in time&quot;. Change one of them so they agree.
              </div>
            )}
          </div>

          <FeeChoice id="cph-late" label="When someone cancels late" action={o.lateAction} amount={o.lateAmount}
            takesDeposit={o.takesDeposit} onAction={(v) => set({ lateAction: v })} onAmount={(v) => set({ lateAmount: v })}/>
          <FeeChoice id="cph-noshow" label="When someone does not show up" action={o.noShowAction} amount={o.noShowAmount}
            takesDeposit={o.takesDeposit} onAction={(v) => set({ noShowAction: v })} onAmount={(v) => set({ noShowAmount: v })}/>
          {(o.lateAction === 'flat' || o.noShowAction === 'flat') && (
            <div className="cph-hint" style={{ marginTop: -6, marginBottom: 14 }}>
              Ivy charges the fee set on each service, so keep these amounts the same as your services.
            </div>
          )}

          <div className="cph-field">
            <label className="cph-label" htmlFor="cph-resched">Rescheduling</label>
            <select id="cph-resched" className="input" value={o.reschedule}
              onChange={(e) => set({ reschedule: e.target.value })} style={{ width: '100%', fontSize: 14 }}>
              {RESCHEDULE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            {o.reschedule === 'once' && (
              <div className="cph-hint">Clients can still move a booking online before your window closes. You apply the one free move yourself.</div>
            )}
          </div>

          <div className="cph-field">
            <span className="cph-label">Also include</span>
            <Check checked={o.emergencies} onChange={(v) => set({ emergencies: v })} title="Emergencies" sub="illness, family emergencies and unsafe weather get understanding"/>
            <Check checked={o.graceFirst} onChange={(v) => set({ graceFirst: v })} title="First one is forgiven" sub="no charge for a client's first late cancel"/>
            {o.businessType !== 'cleaning' && (
              <Check checked={o.runningLate} onChange={(v) => set({ runningLate: v })} title="Running late" sub="the booking still ends on time"/>
            )}
            <Check checked={o.packages} onChange={(v) => set({ packages: v })} title="Packages"
              sub={o.packageUse === 'completion' ? 'how package sessions work when someone cancels or misses' : 'a late cancel or no-show uses a prepaid session instead of a fee'}/>
          </div>

          <Seg label="Tone" options={TONES} value={o.tone} onChange={(v) => set({ tone: v })}
            hint={o.tone === 'gentle' ? 'Warm and understanding. Fees say "may charge", which leaves you room.'
              : o.tone === 'firm' ? 'Clear and direct. Booking means agreeing to the policy.'
                : 'Friendly and clear. A good fit for most businesses.'}/>
        </div>

        <div className="cph-preview-col">
          <span className="cph-label">Your policy</span>
          <Preview text={text}/>
          <div className="cph-hint">You can change any of the words after you use it.</div>
        </div>
      </div>

      <div className="cph-foot">
        <div style={{ flex: '1 1 220px', minWidth: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
          {confirming
            ? <b style={{ color: 'var(--fg)' }} role="alert">Replace your current policy text?</b>
            : 'This is a template, not legal advice. Check local rules.'}
        </div>
        <button type="button" className="btn btn-outline" onClick={confirming ? () => setConfirming(false) : onClose}>
          {confirming ? 'Keep my text' : 'Cancel'}
        </button>
        <button type="button" className="btn btn-primary" onClick={use}>
          {confirming ? 'Replace it' : 'Use this policy'}
        </button>
      </div>
    </>
  );
}

export default function CancellationPolicyHelper({ state, current, onUse, onClose }) {
  useEscapeKey(onClose);
  const { options, notes } = useMemo(() => policyOptionsFromIvy({
    businessName: state?.businessName || '',
    category: state?.businessCategory || null,
    services: state?.services || [],
    settings: state?.settings || {},
    packages: state?.packages || {},
    cardPayments: state?.cardPayments !== false,
  }), [state]);
  return createPortal(
    <div className="cph-overlay" onClick={onClose}>
      <style>{CSS}</style>
      <div className="card cph-sheet" role="dialog" aria-modal="true" aria-labelledby="cph-title"
        onClick={(e) => e.stopPropagation()} data-testid="policy-helper">
        <div className="cph-head">
          <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icons.Edit size={15} sw={1.8}/>
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 id="cph-title" style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Help me write my policy</h3>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
              Pick your rules and the words write themselves. Nothing is saved until you press Save.
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>
        <HelperBody initial={options} notes={notes} current={current}
          refundSwitch={state?.settings ? state.settings.refundDepositOutsideWindow !== false : null}
          onUse={onUse} onClose={onClose}/>
      </div>
    </div>,
    document.body,
  );
}
