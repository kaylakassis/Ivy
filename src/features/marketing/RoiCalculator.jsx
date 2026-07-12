// Interactive ROI calculator for the pricing page. Two sliders
// (clients/month + admin hours/week) drive four always-positive
// outputs: fixed tool savings (stack price minus Ivy), admin
// hours reclaimed, no-shows prevented, and the total monthly upside.
//
// Pure client-side math, no API. The dollar figures for each tool are
// editable here in one place - if a competitor changes their price,
// update the TOOL_STACK constants and the savings number updates
// everywhere the calculator is embedded.
import React, { useMemo, useState } from 'react';
// Pricing constants live in one shared module so the paywall + pricing
// page + this calculator can't drift. Re-exported below to preserve the
// existing `import { TOOL_STACK, STACK_TOTAL, IVY_PRICE } from
// './RoiCalculator.jsx'` call sites.
import { TOOL_STACK, STACK_TOTAL, IVY_PRICE, TRIAL_DAYS } from '../../lib/pricing.js';

// Tunable assumptions, all deliberately conservative + cited in the
// footnote so the calculator never feels like fantasy math.
const BILLABLE_RATE = 75;     // $/hr - average solo service rate
const ADMIN_AUTOMATED = 0.6;  // share of admin time Ivy automates
const NO_SHOW_RATE = 0.08;    // typical no-show rate without reminders

export default function RoiCalculator() {
  const [clients, setClients] = useState(40);
  const [hours,   setHours]   = useState(8);

  const calc = useMemo(() => {
    // 1. Tool savings - a FIXED, always-positive number: Ivy
    //    replaces the whole stack (STACK_TOTAL, ~$153) for one price
    //    ($8.99). The old calculator let you drag your current spend
    //    BELOW Ivy's price, which showed "$0 savings vs the stack"
    //    - a contradiction. This is the honest, appealing framing.
    const toolSavings = Math.max(0, STACK_TOTAL - IVY_PRICE);

    // 2. Admin hours reclaimed - the HOURS slider drives this.
    const reclaimedHours = Math.round(hours * 4.33 * ADMIN_AUTOMATED);
    const hoursRevenue = reclaimedHours * BILLABLE_RATE;

    // 3. No-shows prevented - the CLIENTS slider drives this. Card-on-
    //    file + automatic reminders recover most no-shows; each one is
    //    a session you'd otherwise lose.
    const noShowsPrevented = Math.round(clients * NO_SHOW_RATE);
    const noShowRevenue = noShowsPrevented * BILLABLE_RATE;

    const extraRevenue = hoursRevenue + noShowRevenue;
    return {
      toolSavings,
      reclaimedHours,
      noShowsPrevented,
      extraRevenue,
      totalUpside: toolSavings + extraRevenue,
    };
  }, [hours, clients]);

  return (
    <div style={{
      padding: '32px 28px',
      borderRadius: 16,
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 22,
    }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          ROI calculator
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, marginTop: 6 }}>
          See what Ivy puts back in your pocket
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          Move the two sliders. Numbers update live. No signup needed.
        </div>
      </div>

      <Slider label="Clients you serve per month" value={clients} min={5} max={200} step={5} suffix=" clients" onChange={setClients}/>
      <Slider label="Hours a week you spend on admin (billing, scheduling, follow-ups)" value={hours} min={1} max={30} step={1} suffix=" hrs/wk" onChange={setHours}/>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14,
        padding: 18,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }}>
        <Stat label="Tool savings" value={`$${calc.toolSavings}/mo`} sub={`replaces $${STACK_TOTAL} of separate tools`}/>
        <Stat label="Admin hours back" value={`${calc.reclaimedHours} hrs/mo`} sub="billing + reminders, automated"/>
        <Stat label="No-shows prevented" value={`${calc.noShowsPrevented}/mo`} sub="card on file + auto reminders"/>
        <Stat label="Total monthly upside" value={`$${calc.totalUpside.toLocaleString()}/mo`} sub="savings + recovered revenue" emphasis/>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        Ivy is <strong>${IVY_PRICE}/week</strong>, and you start with a {TRIAL_DAYS}-day free trial ($0 today). The
        math is deliberately conservative: a $75/hr billable rate, Ivy automating
        60% of your admin time, and an 8% no-show rate that reminders + card-on-file
        recover. Your real numbers are usually higher.
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, suffix = '', prefix = '', onChange }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)', flex: 1 }}>{label}</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
          {prefix}{value}{suffix}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--accent)' }}
      />
    </div>
  );
}

function Stat({ label, value, sub, emphasis }) {
  return (
    <div>
      <div style={{
        fontSize: 11.5, fontWeight: 600, color: 'var(--muted)',
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>{label}</div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: emphasis ? 28 : 22,
        fontWeight: 600,
        color: emphasis ? 'var(--accent)' : 'var(--fg)',
        lineHeight: 1.1, marginTop: 6,
        letterSpacing: '-0.02em',
      }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>
    </div>
  );
}

export { TOOL_STACK, STACK_TOTAL, IVY_PRICE };
