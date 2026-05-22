// In-app walkthrough — spotlight overlay edition.
//
// Each step optionally targets a CSS selector and an app route. When a
// step's route differs from the current location we navigate first, then
// poll for the target to mount before painting the spotlight. The
// spotlight is a fixed-position SVG mask: a full-page dimmed rect with
// a rounded-rect cutout around the target, plus a pulsing ring + a
// floating tooltip card with the step copy.
//
// Survives navigation by living at the AppShell level (the modal isn't
// dismissed when the user moves to another page). Old design dismissed
// on "Take me there" — that's why the walkthrough cut off at the
// calendar step.
//
// Final step is the Ivy hello: a friendly "I'm Ivy, ask me anything"
// panel with an inline chat composer that POSTs to /api/ivy and shows
// the reply in-place. After Ivy's first reply, the user can keep
// chatting or click "Done — let me explore" to dismiss.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

// Each step:
//   selector?  — query string. If absent, step renders as a centered card.
//   route?     — navigate here before painting (only if not already there).
//   placement? — 'right' | 'bottom' | 'top' | 'left' | 'auto' (default auto).
const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to THRYVE',
    body: "This is your business OS — every booking, client, invoice, and document in one place. The tour takes about a minute. You can replay it any time from your Account page.",
  },
  {
    id: 'dashboard',
    title: 'Dashboard',
    body: "This is your at-a-glance home: revenue, upcoming bookings, who's gone quiet, what needs your attention today. Everything important on one screen.",
    route: '/dashboard',
    selector: '[data-tour="nav-dashboard"]',
    placement: 'right',
  },
  {
    id: 'calendar',
    title: 'Calendar',
    body: "Define your services, set weekly availability, and share your booking link. Public bookings auto-create clients, send confirmations, and trigger SMS reminders.",
    route: '/calendar',
    selector: '[data-tour="nav-calendar"]',
    placement: 'right',
  },
  {
    id: 'calendar-packages',
    title: 'Sell session packages',
    body: "Bundle multiple sessions into one upfront purchase — '5-pack of massage', 'monthly retainer'. Sell to a client from their drawer; credits get consumed as they book.",
    route: '/calendar',
    selector: '[data-tour="calendar-packages"]',
    placement: 'bottom',
  },
  {
    id: 'calendar-share',
    title: 'Your booking link',
    body: "Drop this in your Instagram bio, your email signature, anywhere a client might see it. They book in two taps; you don't trade texts to find a slot.",
    route: '/calendar',
    selector: '[data-tour="calendar-share"]',
    placement: 'bottom',
  },
  {
    id: 'clients',
    title: 'Clients — your CRM',
    body: "Tag clients, take notes, track lifetime value, sell packages, manage SMS consent. Bulk-import from CSV or let them onboard themselves through your booking link.",
    route: '/clients',
    selector: '[data-tour="nav-clients"]',
    placement: 'right',
  },
  {
    id: 'finance',
    title: 'Finance — invoices + Stripe',
    body: "Send invoices, accept card payments through your own Stripe account, refund (full or partial), track expenses, and export Schedule C-ready CSVs at tax time.",
    route: '/finance',
    selector: '[data-tour="nav-finance"]',
    placement: 'right',
  },
  {
    id: 'docs',
    title: 'Documents + intake forms',
    body: "Build reusable form templates (waivers, intakes), then attach them to a service so they auto-send when that service is booked. Clients sign in their portal — you get the completed PDF.",
    route: '/documents',
    selector: '[data-tour="nav-docs"]',
    placement: 'right',
  },
  {
    id: 'comms',
    title: 'Messages — chat with clients',
    body: "Native two-way chat per client. Booking confirmations, intake forms, paid invoices, and cancellations all surface as system notes in the thread, so context never goes missing.",
    route: '/messages',
    selector: '[data-tour="nav-comms"]',
    placement: 'right',
  },
  {
    id: 'rewards',
    title: 'Rewards & referrals',
    body: "Loyalty points, referral codes, and birthday perks — stand up programs that bring repeat clients back and give them a reason to bring friends.",
    route: '/rewards',
    selector: '[data-tour="nav-rewards"]',
    placement: 'right',
  },
  {
    id: 'website',
    title: 'Your public website',
    body: "A polished, hosted site you can spin up in minutes — services, pricing, gallery, contact. Linked to your booking flow so visitors can book without leaving.",
    route: '/website',
    selector: '[data-tour="nav-website"]',
    placement: 'right',
  },
  // Final step: Ivy hello with inline chat.
  { id: 'ivy-hello', kind: 'ivy' },
];

// Wait up to this long for a target element to mount after a route change.
const FIND_TIMEOUT_MS = 4000;
const FIND_POLL_MS    = 80;

export default function Walkthrough({ onClose }) {
  const [stepIdx, setStepIdx] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const [target, setTarget] = useState(null);     // resolved DOM node
  const [resolving, setResolving] = useState(false);

  const step = STEPS[stepIdx];
  const isLast = stepIdx === STEPS.length - 1;

  const dismiss = async () => {
    try { await api.post('/me/walkthrough', { completed: true }); }
    catch { /* user can dismiss again */ }
    onClose?.();
  };

  // Resolve the target: optionally navigate, then poll for the element.
  // Re-run on step change.
  useEffect(() => {
    let cancelled = false;
    setTarget(null);

    if (step.kind === 'ivy' || !step.selector) {
      // Centered card, no spotlight needed.
      return () => { cancelled = true; };
    }

    const run = async () => {
      // Step 1: navigate to the target route if we're not already there.
      if (step.route && location.pathname !== step.route) {
        navigate(step.route);
      }

      // Step 2: poll for the element. Cap at FIND_TIMEOUT_MS so a renamed
      // selector or a slow page can't leave the user stuck on a blank
      // spotlight.
      setResolving(true);
      const deadline = Date.now() + FIND_TIMEOUT_MS;
      while (!cancelled && Date.now() < deadline) {
        const el = document.querySelector(step.selector);
        if (el) {
          if (cancelled) return;
          // Scroll into view if necessary, then resolve.
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
          // Give the smooth scroll one frame to settle so the spotlight
          // doesn't paint at the pre-scroll position.
          await new Promise((r) => setTimeout(r, 220));
          if (cancelled) return;
          setTarget(el);
          setResolving(false);
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, FIND_POLL_MS));
      }
      if (!cancelled) setResolving(false);
    };
    run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIdx]);

  // Keyboard: Esc skips, Enter advances.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') dismiss();
      else if (e.key === 'Enter' && !isLast) setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLast]);

  const goNext = () => setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
  const goBack = () => setStepIdx((i) => Math.max(i - 1, 0));

  const showSpotlight = !!target && step.kind !== 'ivy' && step.selector;

  return (
    <>
      {/* Dimmed backdrop with optional cutout. Always present so step
          changes don't flash an undimmed page mid-transition. */}
      <BackdropMask target={showSpotlight ? target : null}/>

      {/* Spotlight ring (purely decorative — sits over the cutout). */}
      {showSpotlight && <SpotlightRing target={target}/>}

      {/* Step UI: either a tooltip pinned near the target, an Ivy card,
          or a centered card (welcome / fallback when target not found). */}
      {step.kind === 'ivy' ? (
        <IvyHello onDismiss={dismiss}
          onBack={goBack}/>
      ) : showSpotlight ? (
        <Tooltip target={target} placement={step.placement}>
          <StepCard step={step} stepIdx={stepIdx}
            isLast={false}
            onSkip={dismiss} onBack={stepIdx > 0 ? goBack : null} onNext={goNext}/>
        </Tooltip>
      ) : (
        <CenteredCard>
          {resolving && step.selector ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
              Loading the next part of the tour…
            </div>
          ) : null}
          <StepCard step={step} stepIdx={stepIdx}
            isLast={false}
            onSkip={dismiss} onBack={stepIdx > 0 ? goBack : null} onNext={goNext}
            embedded/>
        </CenteredCard>
      )}
    </>
  );
}

// SVG-based mask: full-viewport dim with an optional rounded-rect hole
// where the spotlight target sits. We re-measure on scroll/resize via
// useLayoutEffect so the cutout tracks the element if the page reflows.
function BackdropMask({ target }) {
  const [box, setBox] = useState(null);
  const [vw, setVw] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      setVw({ w: window.innerWidth, h: window.innerHeight });
      if (!target) { setBox(null); return; }
      const r = target.getBoundingClientRect();
      const pad = 8;
      setBox({
        x: r.left - pad, y: r.top - pad,
        w: r.width + pad * 2, h: r.height + pad * 2,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const id = setInterval(measure, 200);  // catch layout shifts
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      clearInterval(id);
    };
  }, [target]);

  return (
    <svg aria-hidden style={{
      position: 'fixed', inset: 0, width: '100%', height: '100%',
      zIndex: 218, pointerEvents: 'none',
    }}>
      <defs>
        <mask id="thryve-tour-mask">
          <rect width="100%" height="100%" fill="white"/>
          {box && (
            <rect x={box.x} y={box.y} width={box.w} height={box.h}
              rx="14" ry="14" fill="black"/>
          )}
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgba(10,12,8,0.62)"
        mask="url(#thryve-tour-mask)"
        style={{ transition: 'opacity 0.2s ease' }}/>
    </svg>
  );
}

// Pulsing ring around the spotlight target. Drawn as a fixed-position div
// so we can use CSS box-shadow + transform; SVG is reserved for the mask.
function SpotlightRing({ target }) {
  const [rect, setRect] = useState(null);

  useLayoutEffect(() => {
    if (!target) return;
    const measure = () => {
      const r = target.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const id = setInterval(measure, 200);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      clearInterval(id);
    };
  }, [target]);

  if (!rect) return null;
  return (
    <div aria-hidden style={{
      position: 'fixed', zIndex: 219, pointerEvents: 'none',
      left: rect.left - 8, top: rect.top - 8,
      width: rect.width + 16, height: rect.height + 16,
      borderRadius: 14,
      border: '2px solid var(--accent)',
      boxShadow: '0 0 0 0 var(--accent), 0 12px 40px rgba(0,0,0,0.25)',
      animation: 'thryve-tour-pulse 2.2s ease-out infinite',
    }}/>
  );
}

// Tooltip pinned next to a target. Auto-flips placement if there's no
// room on the requested side. Always falls back to centered if the
// target is somehow off-screen.
function Tooltip({ target, placement = 'auto', children }) {
  const cardRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!target) return;
    const measure = () => {
      const card = cardRef.current;
      const r = target.getBoundingClientRect();
      const margin = 14;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const cw = card?.offsetWidth || 360;
      const ch = card?.offsetHeight || 220;

      // Decide placement: try requested first; else pick the side with
      // the most space.
      const trySides = (() => {
        const want = placement === 'auto' ? null : placement;
        if (want) return [want, 'bottom', 'top', 'right', 'left'];
        const space = {
          right:  W - r.right,
          left:   r.left,
          bottom: H - r.bottom,
          top:    r.top,
        };
        return Object.entries(space).sort((a, b) => b[1] - a[1]).map(([k]) => k);
      })();

      let chosen = trySides[0];
      for (const s of trySides) {
        if (s === 'right'  && r.right + margin + cw <= W) { chosen = s; break; }
        if (s === 'left'   && r.left  - margin - cw >= 0) { chosen = s; break; }
        if (s === 'bottom' && r.bottom + margin + ch <= H) { chosen = s; break; }
        if (s === 'top'    && r.top    - margin - ch >= 0) { chosen = s; break; }
      }

      let left = 0, top = 0;
      if (chosen === 'right') { left = r.right + margin;        top = r.top + r.height/2 - ch/2; }
      if (chosen === 'left')  { left = r.left - margin - cw;     top = r.top + r.height/2 - ch/2; }
      if (chosen === 'bottom'){ top  = r.bottom + margin;        left = r.left + r.width/2 - cw/2; }
      if (chosen === 'top')   { top  = r.top - margin - ch;      left = r.left + r.width/2 - cw/2; }

      // Clamp to viewport so the card never leaks off-screen.
      left = Math.max(12, Math.min(left, W - cw - 12));
      top  = Math.max(12, Math.min(top,  H - ch - 12));
      setPos({ left, top });
    };

    measure();
    const id = setTimeout(measure, 30);   // re-measure once layout settles
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      clearTimeout(id);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [target, placement]);

  return (
    <div ref={cardRef} style={{
      position: 'fixed', zIndex: 222,
      left: pos?.left ?? -9999, top: pos?.top ?? -9999,
      width: 360, maxWidth: 'calc(100vw - 24px)',
      transition: 'left 0.18s ease, top 0.18s ease',
    }}>
      {children}
    </div>
  );
}

function CenteredCard({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 222,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, pointerEvents: 'none',
    }}>
      <div style={{ pointerEvents: 'auto', width: '100%', maxWidth: 460 }}>
        {children}
      </div>
    </div>
  );
}

function StepCard({ step, stepIdx, isLast, onSkip, onBack, onNext, embedded }) {
  return (
    <div className="card" style={{
      padding: 22,
      display: 'flex', flexDirection: 'column', gap: 14,
      boxShadow: '0 24px 60px rgba(0,0,0,0.32)',
      border: '1px solid var(--border-strong)',
      background: 'var(--surface)',
    }}>
      {/* Step pills */}
      <div style={{ display: 'flex', gap: 4 }}>
        {STEPS.map((_, i) => (
          <div key={i} style={{
            flex: 1, height: 3, borderRadius: 99,
            background: i <= stepIdx ? 'var(--accent)' : 'var(--border)',
            transition: 'background 0.15s ease',
          }}/>
        ))}
      </div>

      <div>
        <h2 style={{
          margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500,
          fontSize: 19, letterSpacing: '-0.02em',
        }}>{step.title}</h2>
        <p style={{ margin: '8px 0 0', color: 'var(--fg-2)', fontSize: 13.5, lineHeight: 1.55 }}>
          {step.body}
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
        <button onClick={onSkip} className="btn btn-ghost"
          style={{ color: 'var(--muted)', fontSize: 12.5 }}>
          Skip
        </button>
        <div style={{ flex: 1 }}/>
        {onBack && (
          <button onClick={onBack} className="btn btn-outline"
            style={{ padding: '7px 12px', fontSize: 12.5 }}>
            Back
          </button>
        )}
        <button onClick={onNext} className="btn btn-primary"
          style={{ padding: '7px 14px', fontSize: 12.5 }}>
          Next <Icons.Arrow size={11} sw={2.2}/>
        </button>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', textAlign: 'center', marginTop: -2 }}>
        Step {stepIdx + 1} of {STEPS.length}
      </div>
    </div>
  );
}

// Final step. Friendly Ivy intro + inline chat: one round-trip is enough
// to feel real; the user can keep going or dismiss whenever.
function IvyHello({ onDismiss, onBack }) {
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages]   = useState([
    { role: 'ivy', text: "Welcome to THRYVE! I'm Ivy, your AI business coach. I'll be here in the app to help you understand your numbers, spot patterns, and figure out what to focus on next. Is there anything you'd like to ask before you dive in?" },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState(null);
  const navigate = useNavigate();

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setErr(null);
    setMessages((m) => [...m, { role: 'me', text }]);
    setInput('');
    try {
      const r = await api.post('/ivy', { text, sessionId });
      setSessionId(r.session?.id || sessionId);
      const ivyReply = r.messages?.find((m) => m.role === 'ivy');
      if (ivyReply) setMessages((m) => [...m, { role: 'ivy', text: ivyReply.text }]);
    } catch (e) {
      setErr(e.message || 'Could not reach Ivy');
    } finally {
      setBusy(false);
    }
  };

  const finishAndOpenIvy = async () => {
    try { await api.post('/me/walkthrough', { completed: true }); }
    catch { /* user can dismiss again */ }
    onDismiss?.();
    navigate('/ivy');
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 222,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, pointerEvents: 'none',
    }}>
      <div className="card" style={{
        pointerEvents: 'auto',
        width: '100%', maxWidth: 520, padding: 24,
        display: 'flex', flexDirection: 'column', gap: 14,
        boxShadow: '0 30px 80px rgba(0,0,0,0.36)',
        border: '1px solid var(--border-strong)',
        background: 'var(--surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}><Icons.Spark size={22}/></div>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 18, letterSpacing: '-0.02em' }}>
              Hi, I'm Ivy
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              Your AI business coach
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex', flexDirection: 'column', gap: 10,
          maxHeight: 280, overflowY: 'auto',
          padding: '4px 2px',
        }}>
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} text={m.text}/>
          ))}
          {busy && <Bubble role="ivy" text="…"/>}
          {err && (
            <div style={{
              padding: '6px 10px', borderRadius: 8, fontSize: 12,
              background: 'rgba(155,44,44,0.08)', color: 'var(--danger)',
              border: '1px solid rgba(155,44,44,0.25)',
            }}>{err}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
            placeholder="Ask me anything…" disabled={busy}
            style={{
              flex: 1, padding: '10px 12px', borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'var(--surface-2)', color: 'var(--fg)',
              fontSize: 13.5, outline: 'none',
            }}/>
          <button onClick={send} disabled={busy || !input.trim()}
            className="btn btn-primary"
            style={{ padding: '8px 14px' }}>
            <Icons.Arrow size={13} sw={2}/>
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          {onBack && (
            <button onClick={onBack} className="btn btn-ghost"
              style={{ color: 'var(--muted)', fontSize: 12.5 }}>
              Back
            </button>
          )}
          <div style={{ flex: 1 }}/>
          <button onClick={finishAndOpenIvy} className="btn btn-outline"
            style={{ padding: '7px 12px', fontSize: 12.5 }}>
            Open Ivy <Icons.Arrow size={11} sw={2}/>
          </button>
          <button onClick={onDismiss} className="btn btn-primary"
            style={{ padding: '7px 14px', fontSize: 12.5 }}>
            <Icons.Check size={11} sw={2.4}/> Done — let me explore
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, text }) {
  const isMe = role === 'me';
  return (
    <div style={{
      display: 'flex', justifyContent: isMe ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        maxWidth: '86%',
        padding: '8px 12px',
        borderRadius: 14,
        fontSize: 13.5, lineHeight: 1.5,
        background: isMe ? 'var(--accent)' : 'var(--surface-2)',
        color: isMe ? 'var(--accent-ink)' : 'var(--fg)',
        whiteSpace: 'pre-wrap',
      }}>{text}</div>
    </div>
  );
}
