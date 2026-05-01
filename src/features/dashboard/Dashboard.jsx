import React from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';

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

function HeroBand() {
  const hour = new Date().getHours();
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
        <button className="btn btn-outline"><Icons.Calendar size={14}/>Open calendar</button>
        <button className="btn btn-primary"><Icons.Plus size={14}/>Add client</button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  return (
    <div>
      <HeroBand />
      <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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
