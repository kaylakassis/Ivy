// Marketing: one tab for everything that brings clients back.
//   Campaigns  - newsletters and announcements
//   Workflows  - automations that run on their own
//   Rewards    - the client loyalty program
// Each section is its own page underneath; this hub just picks one via
// ?tab= so old links (/campaigns, /workflows, /rewards) keep working.
import React, { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';

const Campaigns = lazy(() => import('../campaigns/Campaigns.jsx'));
const Workflows = lazy(() => import('../workflows/Workflows.jsx'));
const Rewards   = lazy(() => import('../rewards/Rewards.jsx'));

export const MARKETING_TABS = [
  { id: 'campaigns', label: 'Campaigns', icon: 'Mail',  hint: 'Newsletters and announcements' },
  { id: 'workflows', label: 'Workflows', icon: 'Spark', hint: 'Follow-ups that run on their own' },
  { id: 'rewards',   label: 'Rewards',   icon: 'Gift',  hint: 'Loyalty for your clients' },
];

export default function Marketing() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const tab = MARKETING_TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'campaigns';
  const pick = (id) => {
    const p = new URLSearchParams(location.search);
    p.set('tab', id);
    navigate({ pathname: location.pathname, search: p.toString() }, { replace: true });
  };
  const Body = tab === 'workflows' ? Workflows : tab === 'rewards' ? Rewards : Campaigns;

  return (
    <div>
      <div className="page-pad" style={{ paddingBottom: 0 }}>
        <div role="tablist" aria-label="Marketing sections" className="tab-row" style={{ display: 'inline-flex', flexWrap: 'wrap' }}>
          {MARKETING_TABS.map((t) => {
            const Icon = Icons[t.icon] || Icons.Spark;
            const on = tab === t.id;
            return (
              <button key={t.id} role="tab" aria-selected={on} onClick={() => pick(t.id)} title={t.hint} style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', borderRadius: 8, border: 0,
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                background: on ? 'var(--surface)' : 'transparent',
                color: on ? 'var(--fg)' : 'var(--muted)',
                boxShadow: on ? 'var(--shadow-sm)' : 'none',
              }}>
                <Icon size={14} sw={1.9}/> {t.label}
              </button>
            );
          })}
        </div>
      </div>
      <Suspense fallback={<div className="page-pad" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}>
        <Body key={tab}/>
      </Suspense>
    </div>
  );
}
