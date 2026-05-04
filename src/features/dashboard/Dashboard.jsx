import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

const METRICS = [
  { k: 'mrr',     label: 'Monthly revenue' },
  { k: 'clients', label: 'Active clients' },
  { k: 'booked',  label: 'Booked this month' },
  { k: 'hours',   label: 'Coaching hours' },
];

function MetricCard({ label }) {
  return (
    <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 128 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="metric-label">{label}</span>
        <Icons.More size={16} stroke="var(--muted)" sw={1.8} />
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="metric-value" style={{ fontSize: 38, color: 'var(--muted-2)' }}>—</span>
      </div>
      <div style={{ height: 32, borderTop: '1px dashed var(--border)' }} />
    </div>
  );
}

// Owner setup checklist. Hides itself the moment every required step is
// done so the dashboard isn't permanently noisy. Optional steps stay
// visible while there are still incomplete required steps; once those
// are all green, the entire card disappears (we don't nag about
// optional things forever).
function SetupChecklist() {
  const [data, setData] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await api.get('/me/setup-status');
        if (!cancelled) setData(r);
      } catch { /* hide silently if we can't load */ }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  if (!data || data.complete || !data.items || data.items.length === 0) return null;

  const required = data.items.filter((i) => i.required);
  const optional = data.items.filter((i) => !i.required);
  const doneRequired = required.filter((i) => i.done).length;
  const totalRequired = required.length;
  const pct = Math.round((doneRequired / Math.max(1, totalRequired)) * 100);
  const nextItem = required.find((i) => !i.done);

  return (
    <div className="card" style={{
      padding: 22,
      borderColor: 'var(--accent)',
      background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--surface))',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Check size={18} sw={2.4}/>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Finish setting up your business</h3>
            <span style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
              padding: '2px 8px', borderRadius: 99,
              background: 'var(--accent)', color: 'var(--accent-ink)',
            }}>{doneRequired}/{totalRequired}</span>
          </div>
          <p style={{ margin: '6px 0 12px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            A few quick steps and you're ready to take real bookings.
            {nextItem && <> Up next — <strong>{nextItem.label.toLowerCase()}</strong>.</>}
          </p>
          {/* Progress bar */}
          <div style={{
            height: 6, borderRadius: 99, background: 'var(--border)',
            overflow: 'hidden', marginBottom: 16,
          }}>
            <div style={{
              height: '100%', width: `${pct}%`,
              background: 'var(--accent)', transition: 'width 0.25s ease',
            }}/>
          </div>

          {!collapsed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...required, ...optional].map((item) => (
                <ChecklistRow key={item.id} item={item}/>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
            {nextItem && (
              <Link to={nextItem.href} className="btn btn-primary" style={{ padding: '7px 14px', fontSize: 12.5 }}>
                {nextItem.label} <Icons.Arrow size={11} sw={2}/>
              </Link>
            )}
            <button onClick={() => setCollapsed((c) => !c)} className="btn btn-ghost"
              style={{ padding: '7px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
              {collapsed ? 'Show all steps' : 'Hide details'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChecklistRow({ item }) {
  return (
    <Link to={item.href} style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 10px', borderRadius: 8,
      background: item.done ? 'transparent' : 'var(--surface)',
      border: '1px solid',
      borderColor: item.done ? 'var(--border)' : 'var(--border-strong)',
      textDecoration: 'none', color: 'inherit',
      opacity: item.done ? 0.65 : 1,
    }}>
      <div style={{
        width: 18, height: 18, borderRadius: 99, flexShrink: 0, marginTop: 1,
        background: item.done ? 'var(--accent)' : 'var(--surface-2)',
        color: item.done ? 'var(--accent-ink)' : 'var(--muted)',
        border: item.done ? 'none' : '1px solid var(--border-strong)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {item.done && <Icons.Check size={11} sw={2.6}/>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 550,
          textDecoration: item.done ? 'line-through' : 'none',
          color: item.done ? 'var(--muted)' : 'var(--fg)',
        }}>
          {item.label}
        </div>
        {!item.done && item.why && (
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
            {item.why}
          </div>
        )}
      </div>
      {!item.done && <Icons.Arrow size={12} stroke="var(--muted)" sw={1.8} style={{ alignSelf: 'center', flexShrink: 0 }}/>}
    </Link>
  );
}

function HeroBand() {
  const hour = new Date().getHours();
  const nav = useNavigate();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  return (
    <div className="hero-band" style={{
      display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
      padding: '24px 32px',
      background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, letterSpacing: '0.04em' }}>{dateStr}</div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 36 }}>{greet}.</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--fg-2)', maxWidth: 560 }}>
          Welcome to THRYVE. Add a client or open Ivy — she'll walk you through setup.
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button className="btn btn-outline" onClick={() => nav('/calendar')}>
          <Icons.Calendar size={14}/>Open calendar
        </button>
        <button className="btn btn-primary" onClick={() => nav('/clients?add=1')}>
          <Icons.Plus size={14}/>Add client
        </button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  return (
    <div>
      <HeroBand />
      <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <SetupChecklist/>
        <div className="grid-auto">
          {METRICS.map(m => <MetricCard key={m.k} label={m.label} />)}
        </div>
        <div className="split-2">
          <div className="card" style={{ padding: 24 }}>
            <div className="metric-label" style={{ marginBottom: 14 }}>Revenue vs expenses</div>
            <EmptyNote icon="Trending" title="No revenue recorded yet"
              hint="Connect an invoice or payment source and your numbers will populate here." />
          </div>
          <div className="card" style={{ padding: 20 }}>
            <div className="metric-label" style={{ marginBottom: 10 }}>Today</div>
            <EmptyNote icon="Calendar" title="No appointments" hint="Share a booking link or add one manually." />
          </div>
        </div>
        <div className="split-2">
          <div className="card" style={{ padding: 20 }}>
            <div className="metric-label" style={{ marginBottom: 10 }}>Activity</div>
            <EmptyNote icon="Clock" title="Nothing yet"
              hint="Payments, messages, and bookings will appear here in real time." />
          </div>
          <div className="card" style={{ padding: 20 }}>
            <div className="metric-label" style={{ marginBottom: 10 }}>Your list</div>
            <EmptyNote icon="Check" title="No tasks" hint="Add one, or ask Ivy to draft your week." />
          </div>
        </div>
      </div>
    </div>
  );
}
