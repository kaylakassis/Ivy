// /tools/cancellation-policy-generator: pick a few options, get a clear
// cancellation policy in plain language, copy it or download it. All in
// the browser (see policyGenerator.js for the wording rules).
import React, { useMemo, useState } from 'react';
import { usePageMeta, siteUrl } from '../../../lib/pageMeta.js';
import { TOOL_BY_SLUG } from './toolsData.js';
import {
  BUSINESS_TYPES, NOTICE_OPTIONS, FEE_ACTIONS, RESCHEDULE_OPTIONS, TONES, VOICES,
  DEFAULT_POLICY_OPTIONS, generatePolicy,
} from './policyGenerator.js';
import { ToolFrame, ToolHead, CopyDownload, IvyNote, MoreTools, FinalCta, toolJsonLd, FREE_APP } from './toolsUi.jsx';

const TOOL = TOOL_BY_SLUG['cancellation-policy-generator'];

const META = {
  title: TOOL.title,
  description: TOOL.description,
  canonical: siteUrl(TOOL.path),
  jsonLd: toolJsonLd(TOOL, {
    '@type': 'WebApplication',
    name: 'Cancellation policy generator',
    description: TOOL.description,
    ...FREE_APP,
  }),
};

function Seg({ name, legend, hint, options, value, onChange, disabled = () => false }) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className="seg">
        {options.map((o) => (
          <label key={o.value}>
            <input type="radio" name={name} value={o.value} checked={String(value) === String(o.value)}
              disabled={disabled(o)} onChange={() => onChange(o.value)}/>
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}
    </fieldset>
  );
}

function FeeChoice({ id, legend, action, amount, takesDeposit, onAction, onAmount }) {
  const needsAmount = action === 'flat' || action === 'percent';
  return (
    <>
      <Seg name={`${id}-action`} legend={legend} options={FEE_ACTIONS} value={action}
        onChange={onAction} disabled={(o) => o.needsDeposit && !takesDeposit}
        hint={!takesDeposit ? 'Turn on "I take a deposit" above to use "Keep the deposit".' : null}/>
      {needsAmount && (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-amount`}>
            {action === 'flat' ? 'Fee amount' : 'Percent of the price'}
          </label>
          <div className={`affix${action === 'percent' ? ' suffix' : ' has-pre'}`}>
            {action === 'flat' && <span className="pre" aria-hidden="true">$</span>}
            <input id={`${id}-amount`} className="input" inputMode="decimal" autoComplete="off"
              placeholder={action === 'flat' ? 'For example 40' : 'For example 50'}
              value={amount} onChange={(e) => onAmount(e.target.value.slice(0, 9))}/>
            {action === 'percent' && <span className="suf" aria-hidden="true">%</span>}
          </div>
        </div>
      )}
    </>
  );
}

// The policy as the visitor reads it: same text as Copy / Download, with
// the title and section headings set in bold.
function PolicyPreview({ text }) {
  const lines = text.split('\n');
  return (
    <div className="out policy-out" aria-live="polite" aria-label="Generated cancellation policy" tabIndex={0}>
      {lines.map((line, i) => {
        if (!line) return <div key={i} className="gap" aria-hidden="true"/>;
        if (i === 0) return <div key={i} className="ttl">{line}</div>;
        const heading = !line.startsWith('\u2022 ') && (lines[i + 1] || '').startsWith('\u2022 ');
        return <div key={i} className={heading ? 'hd' : line.startsWith('\u2022 ') ? 'li' : undefined}>{line}</div>;
      })}
    </div>
  );
}

const PAGE_CSS = `
.site-root .policy-out .ttl{font-family:var(--head);font-size:18px;font-weight:600}
.site-root .policy-out .hd{font-weight:700;color:var(--lime);margin-bottom:2px}
.site-root .policy-out .li{padding-left:14px;text-indent:-14px;margin-bottom:3px}
.site-root .policy-out .gap{height:12px}
`;

export default function CancellationPolicyTool() {
  usePageMeta(META);
  const [o, setO] = useState(() => ({ ...DEFAULT_POLICY_OPTIONS }));
  const set = (patch) => setO((cur) => ({ ...cur, ...patch }));
  const policy = useMemo(() => generatePolicy(o), [o]);

  const setDeposit = (on) => set({
    takesDeposit: on,
    ...(on ? {} : {
      lateAction: o.lateAction === 'deposit' ? 'flat' : o.lateAction,
      noShowAction: o.noShowAction === 'deposit' ? 'flat' : o.noShowAction,
    }),
  });

  return (
    <ToolFrame css={PAGE_CSS}>
      <ToolHead
        name={TOOL.name}
        h1={TOOL.h1}
        lede="Choose your notice window, what happens when someone cancels late or does not show, and how you want it to sound. Your policy writes itself as you go, ready to copy or download."
      />

      <section style={{ paddingTop: 8 }}>
        <div className="container tool-grid">
          <form className="panel" onSubmit={(e) => e.preventDefault()} aria-label="Policy options">
            <div className="panel-title">Your options</div>
            <p className="panel-sub">Everything stays in your browser. Nothing is sent or saved.</p>

            <div className="field">
              <label className="field-label" htmlFor="cp-name">Business name <small>(optional)</small></label>
              <input id="cp-name" className="input" autoComplete="organization" maxLength={80}
                placeholder="For example: Willow Massage Studio" value={o.businessName}
                onChange={(e) => set({ businessName: e.target.value })}/>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="cp-type">Type of business</label>
              <select id="cp-type" className="input" value={o.businessType}
                onChange={(e) => set({ businessType: e.target.value })}>
                {BUSINESS_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            <Seg name="cp-voice" legend="Write it as" options={VOICES} value={o.voice} onChange={(v) => set({ voice: v })}/>
            <Seg name="cp-notice" legend="Notice you need to cancel or reschedule" options={NOTICE_OPTIONS}
              value={o.noticeHours} onChange={(v) => set({ noticeHours: Number(v) })}/>

            <div className="divider"/>

            <div className="field">
              <label className="check">
                <input type="checkbox" checked={o.takesDeposit} onChange={(e) => setDeposit(e.target.checked)}/>
                <span><b>I take a deposit when clients book</b><br/>Refunded when they cancel in time.</span>
              </label>
            </div>

            <FeeChoice id="cp-late" legend="When someone cancels late" action={o.lateAction} amount={o.lateAmount}
              takesDeposit={o.takesDeposit} onAction={(v) => set({ lateAction: v })} onAmount={(v) => set({ lateAmount: v })}/>
            <FeeChoice id="cp-noshow" legend="When someone does not show up" action={o.noShowAction} amount={o.noShowAmount}
              takesDeposit={o.takesDeposit} onAction={(v) => set({ noShowAction: v })} onAmount={(v) => set({ noShowAmount: v })}/>

            <div className="field">
              <label className="field-label" htmlFor="cp-resched">Rescheduling</label>
              <select id="cp-resched" className="input" value={o.reschedule} onChange={(e) => set({ reschedule: e.target.value })}>
                {RESCHEDULE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>

            <div className="divider"/>

            <fieldset className="field">
              <legend>Also include</legend>
              <div className="checks-list">
                <label className="check">
                  <input type="checkbox" checked={o.emergencies} onChange={(e) => set({ emergencies: e.target.checked })}/>
                  <span><b>Emergencies</b>: illness, family emergencies and unsafe weather get understanding</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={o.graceFirst} onChange={(e) => set({ graceFirst: e.target.checked })}/>
                  <span><b>First one is forgiven</b>: no charge for a client's first late cancel</span>
                </label>
                {o.businessType !== 'cleaning' && (
                  <label className="check">
                    <input type="checkbox" checked={o.runningLate} onChange={(e) => set({ runningLate: e.target.checked })}/>
                    <span><b>Running late</b>: the booking still ends on time</span>
                  </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={o.packages} onChange={(e) => set({ packages: e.target.checked })}/>
                  <span><b>Packages</b>: a late cancel or no-show uses a prepaid session instead of a fee</span>
                </label>
              </div>
            </fieldset>

            <Seg name="cp-tone" legend="Tone" options={TONES} value={o.tone} onChange={(v) => set({ tone: v })}
              hint={o.tone === 'gentle' ? 'Warm and understanding. Fees say "may charge", which leaves you room.'
                : o.tone === 'firm' ? 'Clear and direct. Booking means agreeing to the policy.'
                  : 'Friendly and clear. A good fit for most businesses.'}/>
          </form>

          <div className="sticky-col">
            <div className="panel">
              <div className="panel-title">Your cancellation policy</div>
              <p className="panel-sub">Updates as you choose. Edit the wording freely after you copy it.</p>
              <PolicyPreview text={policy}/>
              <CopyDownload text={policy} filename="cancellation-policy.txt" what="policy"/>
              <p className="disclaimer"><b>This is a template, not legal advice.</b> Rules on fees, deposits and refunds differ by place and by industry. Check local rules before you use it.</p>
              <IvyNote>
                <p><b>Ivy can show this policy when clients book.</b> Paste it into Ivy and it appears on your booking page, each client ticks to agree before they book, and Ivy keeps a dated record of every acceptance in case a charge is ever questioned.</p>
              </IvyNote>
            </div>
          </div>
        </div>
      </section>

      <section className="alt center">
        <div className="container">
          <span className="eyebrow">Make it work</span>
          <h2>A policy only helps if clients see it.</h2>
          <div className="tips">
            <div className="tip"><h3>Show it before they book</h3><p>Put it on your booking page and in your confirmation message, not only on your website. Clients should agree to it, not discover it.</p></div>
            <div className="tip"><h3>Say the same thing everywhere</h3><p>Use the same notice window and the same fees in your policy, your booking page and your invoices, so there is never a question about what applies.</p></div>
            <div className="tip"><h3>Apply it kindly and evenly</h3><p>Treat every client the same way, and keep a little room for real emergencies. Consistency is what makes a policy feel fair.</p></div>
          </div>
        </div>
      </section>

      <MoreTools current="cancellation-policy-generator"/>

      <FinalCta
        title="Let Ivy hold the line for you."
        sub="Deposits at booking, a policy clients agree to, fees charged to the card on file, and reminders before every appointment. One plan, 14 days free."
      />
    </ToolFrame>
  );
}
