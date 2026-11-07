// /tools/deposit-calculator: what no-shows cost today, what a deposit
// would keep, and a suggested deposit range, from the visitor's own
// numbers. All math in depositMath.js, all of it in the browser.
import React, { useMemo, useState } from 'react';
import { usePageMeta, siteUrl } from '../../../lib/pageMeta.js';
import { TOOL_BY_SLUG } from './toolsData.js';
import { DEFAULT_DEPOSIT_INPUTS, computeDeposit, fmtMoney, fmtNum, WEEKS_PER_MONTH } from './depositMath.js';
import { ToolFrame, ToolHead, IvyNote, MoreTools, FinalCta, toolJsonLd, FREE_APP } from './toolsUi.jsx';

const TOOL = TOOL_BY_SLUG['deposit-calculator'];

const META = {
  title: TOOL.title,
  description: TOOL.description,
  canonical: siteUrl(TOOL.path),
  jsonLd: toolJsonLd(TOOL, {
    '@type': 'WebApplication',
    name: 'Booking deposit calculator',
    description: TOOL.description,
    ...FREE_APP,
  }),
};

const PAGE_CSS = `
.site-root .example{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;color:var(--muted);background:var(--bg);border:1px dashed var(--border2);border-radius:10px;padding:12px 14px;margin-bottom:22px}
.site-root .example b{color:var(--text)}
.site-root .example button{margin-left:auto;background:none;border:none;color:var(--lime);font:inherit;font-weight:600;cursor:pointer;white-space:nowrap;padding:0 0 0 6px;min-height:24px}
.site-root .res-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.site-root .res{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:16px 18px;min-width:0}
.site-root .res .k{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.site-root .res .v{font-family:var(--head);font-size:clamp(22px,2.6vw,28px);font-weight:600;margin-top:4px;line-height:1.2}
.site-root .res .v.lime{color:var(--lime)}
.site-root .res .v.warn{color:#F2B8A2}
.site-root .res .d{font-size:12.5px;color:var(--dim);margin-top:3px}
.site-root .res.wide{grid-column:1/-1}
.site-root .mathlist{margin-top:18px;border:1px solid var(--border);border-radius:12px;overflow:hidden}
.site-root .mathlist .mrow{display:flex;justify-content:space-between;gap:14px;padding:12px 16px;border-bottom:1px solid var(--border);font-size:13.5px;align-items:baseline}
.site-root .mathlist .mrow:last-child{border-bottom:none}
.site-root .mathlist .mrow .t{color:var(--muted)}
.site-root .mathlist .mrow .t small{display:block;color:var(--dim);font-size:12.5px;margin-top:2px}
.site-root .mathlist .mrow .r{color:var(--text);font-weight:600;white-space:nowrap}
.site-root .suggest{margin-top:18px;background:var(--panel);border:1px solid var(--border2);border-radius:14px;padding:20px 22px}
.site-root .suggest .big{font-family:var(--head);font-size:26px;font-weight:600;color:var(--lime);margin:4px 0 10px}
.site-root .suggest ul{list-style:none;display:grid;gap:9px}
.site-root .suggest li{font-size:14px;color:var(--muted);display:flex;gap:10px}
.site-root .suggest li::before{content:'✓';color:var(--lime);font-weight:700;flex-shrink:0}
.site-root .empty{font-size:14.5px;color:var(--muted);background:var(--bg);border:1px dashed var(--border2);border-radius:12px;padding:22px}
@media(max-width:640px){.site-root .mathlist .mrow{flex-direction:column;gap:4px}.site-root .mathlist .mrow .r{white-space:normal}}
`;

function NumberField({ id, label, hint, prefix, suffix, value, onChange, placeholder }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className={`affix${prefix ? ' has-pre' : ''}${suffix ? ' suffix' : ''}`}>
        {prefix && <span className="pre" aria-hidden="true">{prefix}</span>}
        <input id={id} className="input" inputMode="decimal" autoComplete="off" placeholder={placeholder}
          value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, '').slice(0, 10))}
          aria-describedby={hint ? `${id}-hint` : undefined}/>
        {suffix && <span className="suf" aria-hidden="true">{suffix}</span>}
      </div>
      {hint && <p className="hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

const pct = (n) => `${fmtNum(n, 1)}%`;

export default function DepositCalculatorTool() {
  usePageMeta(META);
  const [v, setV] = useState(() => ({ ...DEFAULT_DEPOSIT_INPUTS }));
  const [edited, setEdited] = useState(false);
  const set = (patch) => { setEdited(true); setV((cur) => ({ ...cur, ...patch })); };
  const r = useMemo(() => computeDeposit(v), [v]);
  const clearAll = () => { setEdited(true); setV({ price: '', perWeek: '', rate: '', depositMode: v.depositMode, deposit: '' }); };

  return (
    <ToolFrame css={PAGE_CSS}>
      <ToolHead
        name={TOOL.name}
        h1={TOOL.h1}
        lede="See what missed bookings cost you today and how much a deposit would keep, using your own numbers. Every step of the math is shown below the results."
      />

      <section style={{ paddingTop: 8 }}>
        <div className="container tool-grid">
          <form className="panel" onSubmit={(e) => e.preventDefault()} aria-label="Your numbers">
            <div className="panel-title">Your numbers</div>
            <p className="panel-sub">Everything stays in your browser. Nothing is sent or saved.</p>

            {!edited && (
              <div className="example">
                <span><b>Example numbers.</b> Replace them with your own.</span>
                <button type="button" onClick={clearAll}>Clear all</button>
              </div>
            )}

            <NumberField id="dc-price" label="Price of a typical booking" prefix="$" placeholder="For example 80"
              value={v.price} onChange={(x) => set({ price: x })}/>
            <NumberField id="dc-week" label="Bookings in a typical week" placeholder="For example 20"
              value={v.perWeek} onChange={(x) => set({ perWeek: x })}/>
            <NumberField id="dc-rate" label="Your no-show and late-cancel rate (your estimate)" suffix="%" placeholder="Your estimate"
              hint={r.ok
                ? `Out of every 100 bookings, about how many cancel too late to fill or do not show? At ${pct(r.rate)}, that is about ${fmtNum(r.missedPerMonth)} missed bookings a month.`
                : 'Out of every 100 bookings, about how many cancel too late to fill or do not show? Your calendar from the last month or two is the best guide.'}
              value={v.rate} onChange={(x) => set({ rate: x })}/>

            <div className="divider"/>

            <fieldset className="field">
              <legend>Deposit you would take</legend>
              <div className="seg" style={{ marginBottom: 12 }}>
                {[['percent', '% of the price'], ['flat', 'Set amount ($)']].map(([val, lab]) => (
                  <label key={val}>
                    <input type="radio" name="dc-mode" value={val} checked={v.depositMode === val} onChange={() => set({ depositMode: val })}/>
                    <span>{lab}</span>
                  </label>
                ))}
              </div>
              <NumberField id="dc-deposit" label={v.depositMode === 'percent' ? 'Deposit as a percent of the price' : 'Deposit amount'}
                prefix={v.depositMode === 'flat' ? '$' : null} suffix={v.depositMode === 'percent' ? '%' : null}
                placeholder={v.depositMode === 'percent' ? 'For example 25' : 'For example 20'}
                hint={r.ok && r.depositCapped ? `A deposit can't be more than the price, so this uses ${fmtMoney(r.price)}.` : null}
                value={v.deposit} onChange={(x) => set({ deposit: x })}/>
            </fieldset>
          </form>

          <div className="sticky-col">
            <div className="panel" aria-live="polite">
              <div className="panel-title">Your results</div>
              <p className="panel-sub">Estimates from the numbers you entered.</p>
              {!r.ok ? (
                <p className="empty">Add your price, your bookings in a typical week and your own no-show estimate to see your numbers.</p>
              ) : (
                <Results r={r}/>
              )}
              <IvyNote>
                <p><b>Ivy can take the deposit for you.</b> Set a deposit (a set amount or a percent) on any service and clients pay it when they book online. When they cancel in time you refund it with one tap; when they cancel late or do not show, it is kept toward your fee.</p>
              </IvyNote>
            </div>
          </div>
        </div>
      </section>

      <section className="alt center">
        <div className="container">
          <span className="eyebrow">Choosing a deposit</span>
          <h2>Fair to clients, fair to you.</h2>
          <div className="tips">
            <div className="tip"><h3>Say it up front</h3><p>Show the deposit and what happens to it on your booking page, so it is part of the deal and never a surprise.</p></div>
            <div className="tip"><h3>Refund it when they give notice</h3><p>A deposit that comes back with enough notice protects your time without feeling like a penalty. Write the rule into your <a href="/tools/cancellation-policy-generator" className="lime">cancellation policy</a>.</p></div>
            <div className="tip"><h3>Check your numbers again later</h3><p>Count your missed bookings over the next couple of months and run this again. Your real rate beats any guess.</p></div>
          </div>
        </div>
      </section>

      <MoreTools current="deposit-calculator"/>

      <FinalCta
        title="Deposits, reminders and fees, handled."
        sub="Ivy takes deposits at booking, sends reminders before every appointment, and charges late-cancel and no-show fees to the card on file. One plan, 14 days free."
      />
    </ToolFrame>
  );
}

function Results({ r }) {
  const depositLabel = r.mode === 'percent' && r.depositInput != null
    ? `${pct(r.depositInput)} of ${fmtMoney(r.price)} = ${fmtMoney(r.depositAmount)}`
    : fmtMoney(r.depositAmount);
  return (
    <>
      <div className="res-grid">
        <div className="res"><div className="k">Lost to no-shows</div><div className="v warn">{fmtMoney(r.lostPerMonth)}</div><div className="d">a month</div></div>
        <div className="res"><div className="k">Lost to no-shows</div><div className="v warn">{fmtMoney(r.lostPerYear)}</div><div className="d">a year</div></div>
        <div className="res"><div className="k">Kept with deposits</div><div className="v lime">{fmtMoney(r.keptPerMonth)}</div><div className="d">a month</div></div>
        <div className="res"><div className="k">Kept with deposits</div><div className="v lime">{fmtMoney(r.keptPerYear)}</div><div className="d">a year</div></div>
        <div className="res wide">
          <div className="k">Still unpaid after deposits</div>
          <div className="v">{fmtMoney(r.stillLostPerYear)} <span style={{ fontSize: 15, color: 'var(--dim)', fontWeight: 400 }}>a year</span></div>
          <div className="d">Your deposit keeps {pct(r.share * 100)} of what missed bookings cost you today. A late-cancel or no-show fee can cover more.</div>
        </div>
      </div>

      <div className="mathlist" aria-label="How these numbers are worked out">
        <div className="mrow"><span className="t">Bookings a month<small>52 weeks ÷ 12 months = {fmtNum(WEEKS_PER_MONTH, 2)} weeks a month</small></span><span className="r">{fmtNum(r.perWeek)} × {fmtNum(WEEKS_PER_MONTH, 2)} = {fmtNum(r.bookingsPerMonth)}</span></div>
        <div className="mrow"><span className="t">Missed bookings a month</span><span className="r">{fmtNum(r.bookingsPerMonth)} × {pct(r.rate)} = {fmtNum(r.missedPerMonth)}</span></div>
        <div className="mrow"><span className="t">Lost a month</span><span className="r">{fmtNum(r.missedPerMonth)} × {fmtMoney(r.price)} = {fmtMoney(r.lostPerMonth)}</span></div>
        <div className="mrow"><span className="t">Lost a year<small>{fmtNum(r.perWeek)} a week × 52 weeks × {pct(r.rate)} × {fmtMoney(r.price)}</small></span><span className="r">{fmtMoney(r.lostPerYear)}</span></div>
        <div className="mrow"><span className="t">Your deposit</span><span className="r">{depositLabel}</span></div>
        <div className="mrow"><span className="t">Kept a month<small>missed bookings × deposit</small></span><span className="r">{fmtNum(r.missedPerMonth)} × {fmtMoney(r.depositAmount)} = {fmtMoney(r.keptPerMonth)}</span></div>
        <div className="mrow"><span className="t">Kept a year</span><span className="r">{fmtNum(r.missedPerYear)} × {fmtMoney(r.depositAmount)} = {fmtMoney(r.keptPerYear)}</span></div>
      </div>
      <p className="disclaimer">Figures are rounded for display; the totals use the unrounded numbers. They assume your no-show rate stays the same. A deposit may also make missed bookings less likely, which this calculator does not count.</p>

      <div className="suggest">
        <div className="k-label" style={{ marginBottom: 0 }}>Suggested deposit</div>
        <div className="big">{fmtMoney(r.suggestedLow)} to {fmtMoney(r.suggestedHigh)}</div>
        <ul>
          <li>That is a quarter to a half of your {fmtMoney(r.price)} price: enough that a booking feels like a commitment and a missed slot does not cost you the whole fee, while booking still feels easy.</li>
          <li>Lean higher if missed bookings happen often for you, if you buy supplies or travel for each booking, or if a slot is hard to fill at short notice.</li>
          <li>Lean lower if most of your clients are regulars who rarely miss.</li>
          <li>You can also ask new clients to prepay in full and take a smaller deposit from regulars.</li>
        </ul>
      </div>
    </>
  );
}
