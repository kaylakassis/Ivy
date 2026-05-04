// Skippable in-app walkthrough that introduces THRYVE's surface to a
// signed-in owner. Auto-launches on first AppShell render after signup
// + onboarding complete (gated on user.walkthroughCompletedAt being
// null), or manually from the Account page's "Replay walkthrough" button.
//
// Each step has a copy block and a CTA — either "Take me there" (which
// navigates and dismisses the tour) or "Next" / "Finish". Skip closes
// the tour and stamps walkthrough_completed_at so the user isn't
// nagged again — a deliberate choice over highlighting DOM elements,
// which would break every time we touch the layout.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const STEPS = [
  {
    icon: 'Trending',
    title: 'Welcome to THRYVE',
    body: "This is your business OS — every booking, client, invoice, and document in one place. The tour takes about a minute. You can replay it any time from your Account page.",
    cta: { kind: 'next', label: 'Show me around' },
  },
  {
    icon: 'Calendar',
    title: 'Calendar — bookings + availability',
    body: "Define your services, set your weekly availability, and share your booking link. Public bookings auto-create clients, send confirmations, and (if you've turned them on) trigger SMS reminders + Google Cal sync.",
    cta: { kind: 'go', label: 'Open Calendar', to: '/calendar' },
  },
  {
    icon: 'Users',
    title: 'Clients — your CRM',
    body: "Tag clients, take notes, track lifetime value, sell packages, manage SMS consent. Bulk-import from CSV or let them onboard themselves through your booking link.",
    cta: { kind: 'go', label: 'Open Clients', to: '/clients' },
  },
  {
    icon: 'Dollar',
    title: 'Finance — invoices + Stripe',
    body: "Send invoices, accept card payments through your own Stripe account, refund (full or partial), and bundle multi-session packages. Connect Stripe in the Stripe section to flip card collection on.",
    cta: { kind: 'go', label: 'Open Finance', to: '/finance' },
  },
  {
    icon: 'Doc',
    title: 'Documents + intake forms',
    body: "Build reusable form templates (waivers, intakes), then attach them to a service so they auto-send when that service is booked. Clients sign in their portal — you get the completed PDF.",
    cta: { kind: 'go', label: 'Open Documents', to: '/documents' },
  },
  {
    icon: 'Chat',
    title: 'Messages — chat with clients',
    body: "Native two-way chat per client. Booking confirmations, intake forms, and cancellations all surface as system notes in the thread, so context never goes missing.",
    cta: { kind: 'go', label: 'Open Messages', to: '/messages' },
  },
  {
    icon: 'Globe',
    title: 'Discover — show up to new clients',
    body: "Opt in to the THRYVE directory in Calendar → Share. Set a category, address, and price band so clients filtering by service / distance / price find you.",
    cta: { kind: 'go', label: 'Open Calendar', to: '/calendar' },
  },
  {
    icon: 'Check',
    title: "You're set",
    body: "That's the lap. Anything missing or broken — there's an admin panel on your Account page, and you can replay this walkthrough any time from there.",
    cta: { kind: 'finish', label: 'Finish' },
  },
];

export default function Walkthrough({ onClose }) {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();

  const dismiss = async ({ markCompleted = true } = {}) => {
    if (markCompleted) {
      try { await api.post('/me/walkthrough', { completed: true }); }
      catch { /* if the API hiccups the user can dismiss again */ }
    }
    onClose?.();
  };

  const s = STEPS[step];
  const Icon = Icons[s.icon] || Icons.Check;
  const isLast = step === STEPS.length - 1;

  const onCta = () => {
    if (s.cta.kind === 'next') setStep((i) => i + 1);
    else if (s.cta.kind === 'finish') dismiss();
    else if (s.cta.kind === 'go') {
      dismiss();
      navigate(s.cta.to);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="walkthrough-title" style={{
      position: 'fixed', inset: 0, zIndex: 220,
      background: 'rgba(10, 12, 8, 0.55)',
      backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div className="card" style={{
        width: '100%', maxWidth: 480, padding: 28,
        display: 'flex', flexDirection: 'column', gap: 16,
        boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
      }}>
        {/* Step pills */}
        <div style={{ display: 'flex', gap: 4 }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              flex: 1, height: 3, borderRadius: 99,
              background: i <= step ? 'var(--accent)' : 'var(--border)',
              transition: 'background 0.15s ease',
            }}/>
          ))}
        </div>

        <div style={{
          width: 44, height: 44, borderRadius: 12, alignSelf: 'flex-start',
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icon size={20}/></div>

        <div>
          <h2 id="walkthrough-title" style={{
            margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500,
            fontSize: 22, letterSpacing: '-0.02em',
          }}>{s.title}</h2>
          <p style={{ margin: '8px 0 0', color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.55 }}>
            {s.body}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
          {!isLast && (
            <button onClick={() => dismiss()} className="btn btn-ghost"
              style={{ color: 'var(--muted)', fontSize: 13 }}>
              Skip
            </button>
          )}
          <div style={{ flex: 1 }}/>
          {step > 0 && !isLast && (
            <button onClick={() => setStep((i) => i - 1)} className="btn btn-outline">
              Back
            </button>
          )}
          <button onClick={onCta}
            className="btn btn-primary"
            style={{ padding: '10px 16px' }}>
            {s.cta.label}
            {s.cta.kind === 'next' && <Icons.Arrow size={13} sw={2.2}/>}
            {s.cta.kind === 'go' && <Icons.Arrow size={13} sw={2.2}/>}
            {s.cta.kind === 'finish' && <Icons.Check size={13} sw={2.4}/>}
          </button>
        </div>

        <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 4 }}>
          Step {step + 1} of {STEPS.length}
        </div>
      </div>
    </div>
  );
}
