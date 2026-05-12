// Persistent "Finish setting up" card on the dashboard. Surfaces the
// owner's skipped onboarding steps + any post-onboarding gaps detected
// at runtime (no Stripe connected, no services, no website launched,
// etc.). Each item routes to the right place to fix it, and is
// individually dismissible — dismissed items go into
// users.onboarding_state.dismissedChecklistItems so they don't nag
// after the owner waves them off.
//
// The card collapses to a single line when there's nothing left to do,
// then fades out entirely after a delay.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

// Static catalog of checklist items. Each defines:
//   id          — stable identifier (used in dismissedChecklistItems)
//   label       — what the owner sees
//   hint        — small subtitle
//   check       — fn(setup, state) → true if NEEDS ATTENTION
//   actionLabel — CTA text
//   to          — route to navigate on click
//   icon        — Icons key
//
// Order matters — items render top-to-bottom.
const ITEMS = [
  { id: 'business_name', label: 'Set your business name + booking handle',
    hint: 'Clients see this on your booking page.',
    icon: 'Edit',
    check: (s) => !s.calendar?.bizName || !s.calendar?.slug || s.calendar.bizName === 'My business',
    actionLabel: 'Set it up', to: '/calendar?drawer=share',
  },
  { id: 'services', label: 'Add at least one service',
    hint: 'No services = no booking page activity.',
    icon: 'Dollar',
    check: (s) => (s.serviceCount || 0) === 0,
    actionLabel: 'Add services', to: '/calendar?drawer=services',
  },
  { id: 'availability', label: 'Set your weekly availability',
    hint: 'Clients can only book inside your working hours.',
    icon: 'Calendar',
    check: (s) => !s.calendar?.availability || Object.keys(s.calendar.availability).length === 0,
    actionLabel: 'Set hours', to: '/calendar?drawer=availability',
  },
  { id: 'stripe', label: 'Connect Stripe to take card payments',
    hint: 'Without this, you can\'t auto-charge deposits, fees, or tips.',
    icon: 'Spark',
    check: (s) => !s.stripeConnected,
    actionLabel: 'Connect Stripe', to: '/finance',
  },
  { id: 'first_client', label: 'Add your first client',
    hint: 'Brings the rest of the platform to life.',
    icon: 'Users',
    check: (s) => (s.clientCount || 0) === 0,
    actionLabel: 'Add client', to: '/clients',
  },
  { id: 'website', label: 'Publish your website',
    hint: 'Optional but gives clients a real landing page.',
    icon: 'Globe',
    check: (s) => !s.websiteLive,
    actionLabel: 'Build website', to: '/website',
  },
  { id: 'logo', label: 'Add your logo + accent color',
    hint: 'Branded emails, invoices, and booking page.',
    icon: 'Edit',
    check: (s) => !s.calendar?.brandLogoUrl,
    actionLabel: 'Add branding', to: '/account',
  },
];

export default function SetupChecklist() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState(null);
  const [state, setState] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get('/me/setup-status').catch(() => null),
      api.get('/onboarding/state').catch(() => ({ state: null })),
    ]).then(([s, st]) => {
      if (!live) return;
      setSetup(s);
      setState(st?.state || { dismissedChecklistItems: [] });
    });
    return () => { live = false; };
  }, []);

  const dismissed = new Set(state?.dismissedChecklistItems || []);
  const items = useMemo(() => {
    if (!setup) return [];
    return ITEMS.filter((it) => !dismissed.has(it.id) && it.check(setup));
  }, [setup, dismissed]);

  const dismissItem = async (id) => {
    const next = Array.from(new Set([...(state?.dismissedChecklistItems || []), id]));
    setState((p) => ({ ...p, dismissedChecklistItems: next }));
    try {
      await api.patch('/onboarding/state', { dismissedChecklistItems: next });
    } catch { /* swallow — local state already updated */ }
  };

  // Nothing to show: either still loading, or every item is done /
  // dismissed.
  if (!setup) return null;
  if (items.length === 0) return null;

  if (collapsed) {
    return (
      <button onClick={() => setCollapsed(false)}
        className="card" style={{
          padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', textAlign: 'left', cursor: 'pointer',
        }}>
        <Icons.Check size={14} stroke="var(--accent)" sw={2}/>
        <span style={{ fontSize: 13, fontWeight: 550, flex: 1 }}>
          {items.length} more thing{items.length === 1 ? '' : 's'} to finish setting up
        </span>
        <Icons.Arrow size={12} sw={1.7} stroke="var(--muted)"/>
      </button>
    );
  }

  return (
    <div className="card" style={{
      padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
      border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
      background: 'color-mix(in srgb, var(--accent-soft) 50%, transparent)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Spark size={14} sw={1.7}/>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Finish setting up</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {items.length} thing{items.length === 1 ? '' : 's'} left — knock them out when you're ready.
          </div>
        </div>
        <button onClick={() => setCollapsed(true)} className="btn btn-ghost"
          style={{ padding: 6, color: 'var(--muted)' }} title="Collapse">
          <Icons.X size={13}/>
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((it) => {
          const Icon = Icons[it.icon] || Icons.Check;
          return (
            <div key={it.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 12px', borderRadius: 10,
              background: 'var(--surface)', border: '1px solid var(--border)',
            }}>
              <Icon size={15} sw={1.7} stroke="var(--accent)"/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 550 }}>{it.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{it.hint}</div>
              </div>
              <button onClick={() => navigate(it.to)} className="btn btn-primary"
                style={{ padding: '5px 11px', fontSize: 12 }}>
                {it.actionLabel}
              </button>
              <button onClick={() => dismissItem(it.id)} className="btn btn-ghost"
                style={{ padding: 4, color: 'var(--muted)' }} title="Dismiss">
                <Icons.X size={11}/>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
