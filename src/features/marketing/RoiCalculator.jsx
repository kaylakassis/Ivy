// Interactive ROI calculator for the pricing page. Three sliders compute:
//   1. monthly savings vs the typical solo-business tool stack
//   2. hours-of-admin saved per week
//   3. extra billable revenue those hours unlock
//
// Pure client-side math, no API. The dollar figures for each tool are
// editable here in one place — if a competitor changes their price,
// update the TOOL_STACK constants and the savings number updates
// everywhere the calculator is embedded.
import React, { useMemo, useState } from 'react';

// Typical replaceable monthly spend across the SaaS stack a solo
// business otherwise has to assemble. Numbers are taken from publicly
// listed entry-tier prices (May 2026) — kept conservative so the
// calculator never over-promises.
const TOOL_STACK = [
  { name: 'HoneyBook',  monthly: 39, replaces: 'clients + invoices + contracts' },
  { name: 'Calendly',   monthly: 12, replaces: 'booking pages + reminders' },
  { name: 'QuickBooks Self-Employed', monthly: 20, replaces: 'invoices + expenses + taxes' },
  { name: 'Mailchimp',  monthly: 13, replaces: 'newsletter + email blasts' },
  { name: 'Squarespace', monthly: 23, replaces: 'website + custom domain' },
  { name: 'Loom',       monthly: 15, replaces: 'product walkthroughs' },
];
const STACK_TOTAL = TOOL_STACK.reduce((sum, t) => sum + t.monthly, 0);

const THRYVE_PRICE = 19;

export default function RoiCalculator() {
  const [clients,  setClients]  = useState(40);
  const [hours,    setHours]    = useState(8);
  const [spend,    setSpend]    = useState(STACK_TOTAL);

  const calc = useMemo(() => {
    const savedDollars = Math.max(0, spend - THRYVE_PRICE);
    // Conservative billable-rate proxy: average solo service rate ~$75/hr.
    // 50% of saved admin hours converted to billable (the rest is
    // breathing room).
    const billableRate = 75;
    const savedHoursMo = hours * 4.33;
    const billableHoursMo = Math.round(savedHoursMo * 0.5);
    const extraRevenue = billableHoursMo * billableRate;
    return {
      savedDollars,
      savedHoursMo: Math.round(savedHoursMo),
      billableHoursMo,
      extraRevenue,
      totalUpside: savedDollars + extraRevenue,
    };
  }, [hours, spend]);

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
          See what THRYVE saves you every month
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          Move the sliders. Numbers update live. No signup needed.
        </div>
      </div>

      <Slider label="Clients you serve per month" value={clients} min={5} max={200} step={5} suffix=" clients" onChange={setClients}/>
      <Slider label="Hours/week you spend on admin (billing, scheduling, follow-ups)" value={hours} min={1} max={30} step={1} suffix=" hrs/wk" onChange={setHours}/>
      <Slider label="What you currently pay for SaaS tools combined" value={spend} min={0} max={500} step={5} suffix=" /mo" prefix="$" onChange={setSpend}/>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14,
        padding: 18,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }}>
        <Stat label="SaaS savings" value={`$${calc.savedDollars}/mo`} sub={`vs the $${STACK_TOTAL} stack`}/>
        <Stat label="Admin hours back" value={`${calc.savedHoursMo} hrs/mo`} sub="time you reclaim"/>
        <Stat label="Extra billable revenue" value={`$${calc.extraRevenue}/mo`} sub={`${calc.billableHoursMo} more sessions`}/>
        <Stat label="Total upside" value={`$${calc.totalUpside}/mo`} sub="savings + revenue" emphasis/>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        THRYVE is <strong>${THRYVE_PRICE}/mo</strong> when out of beta — free during beta. Math uses a
        conservative $75/hr billable rate and converts 50% of saved admin hours
        into client time (the rest is breathing room).
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

export { TOOL_STACK, STACK_TOTAL, THRYVE_PRICE };
