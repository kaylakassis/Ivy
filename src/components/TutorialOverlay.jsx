// Per-tab tutorial overlay - full-screen modal that walks through the
// tab's content slide-by-slide. Auto-opens on first visit (driven by
// the Topbar effect) and re-opens any time the owner taps the (i)
// button next to the page title.
//
// Keyboard:
//   Esc        → trigger Skip flow (with confirmation modal)
//   ←  / →     → previous / next step
//   Enter      → next (or "Got it" on the last step)
//
// Skip is gated by a short confirmation that names the cost - owners
// can always skip but they get one chance to reconsider.
import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Icons } from './Icons.jsx';
import { useTutorial } from '../lib/tutorialState.jsx';
import { getTutorial } from '../lib/tutorials.js';

export default function TutorialOverlay() {
  const { activeTabId, complete, skip, close } = useTutorial();
  const tutorial = activeTabId ? getTutorial(activeTabId) : null;
  const [stepIdx, setStepIdx] = useState(0);
  const navigate = useNavigate();

  // Reset to step 0 every time a new tab's tutorial opens.
  useEffect(() => {
    if (activeTabId) {
      setStepIdx(0);
    }
  }, [activeTabId]);

  // Lock the page scroll while open. Keyboard nav.
  useEffect(() => {
    if (!activeTabId) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        skip(activeTabId);
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        if (stepIdx < (tutorial?.steps?.length || 1) - 1) setStepIdx((n) => n + 1);
        else complete(activeTabId);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setStepIdx((n) => Math.max(0, n - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [activeTabId, stepIdx, tutorial, complete]);

  const onCtaClick = useCallback((to) => {
    complete(activeTabId);
    navigate(to);
  }, [activeTabId, complete, navigate]);

  if (!activeTabId || !tutorial) return null;

  const total = tutorial.steps.length;
  const step = tutorial.steps[stepIdx];
  const isFirst = stepIdx === 0;
  const isLast  = stepIdx === total - 1;

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(0, 0, 0, 0.62)',
      backdropFilter: 'blur(4px)',
      WebkitBackdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
      animation: 'tutorial-fade-in .18s ease',
    }}>
      <div style={{
        width: '100%', maxWidth: 560,
        background: 'var(--surface)',
        color: 'var(--fg)',
        borderRadius: 18,
        border: '1px solid var(--border)',
        boxShadow: '0 30px 60px rgba(0,0,0,.4)',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Progress bar */}
        <div style={{
          display: 'flex', gap: 4,
          padding: '14px 24px 0',
        }}>
          {tutorial.steps.map((_, i) => (
            <div key={i} style={{
              flex: 1, height: 3, borderRadius: 999,
              background: i <= stepIdx ? 'var(--accent)' : 'var(--border)',
              transition: 'background .2s ease',
            }}/>
          ))}
        </div>

        {/* Header band */}
        <div style={{
          padding: '14px 24px 6px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
            {tutorial.title} · Step {stepIdx + 1} of {total}
          </div>
          <button onClick={() => skip(activeTabId)} aria-label="Close tutorial"
            style={{
              padding: 6, borderRadius: 8,
              background: 'transparent', border: 'none',
              color: 'var(--muted)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <Icons.X size={16}/>
          </button>
        </div>

        {/* Step body */}
        <div style={{ padding: '14px 28px 22px', flex: 1 }}>
          {isFirst && tutorial.intro && (
            <div style={{
              fontSize: 13, color: 'var(--muted)', lineHeight: 1.6,
              marginBottom: 16,
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
            }}>
              {tutorial.intro}
            </div>
          )}
          <h2 style={{
            margin: '0 0 10px',
            fontFamily: 'var(--font-display)',
            fontSize: 22, lineHeight: 1.25,
            letterSpacing: '-0.02em', fontWeight: 600,
            color: 'var(--fg)',
          }}>
            {step.title}
          </h2>
          <p style={{
            margin: 0, fontSize: 14.5, lineHeight: 1.6, color: 'var(--fg-2)',
          }}>
            {step.body}
          </p>
          {step.bullets && step.bullets.length > 0 && (
            <ul style={{ margin: '12px 0 0', paddingLeft: 20, color: 'var(--fg-2)' }}>
              {step.bullets.map((b, i) => (
                <li key={i} style={{ fontSize: 13.5, lineHeight: 1.6, marginBottom: 6 }}>
                  {b}
                </li>
              ))}
            </ul>
          )}
          {step.cta && (
            <button onClick={() => onCtaClick(step.cta.to)}
              className="btn btn-outline"
              style={{ marginTop: 16, fontSize: 12.5 }}>
              {step.cta.label} →
            </button>
          )}
        </div>

        {/* Footer controls */}
        <div style={{
          padding: '14px 24px',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          {/* One tap skips. The old two-step "Skip anyway" confirm with
              guilt-trip copy cost two extra taps on EVERY tab in her
              first week (~14 tabs). Replay lives behind the (i) icon. */}
          <button onClick={() => skip(activeTabId)}
            style={{
              fontSize: 12, fontWeight: 500,
              padding: '6px 10px', borderRadius: 8,
              background: 'transparent', border: 'none',
              color: 'var(--muted)', cursor: 'pointer',
            }}
            title="You can replay this any time from the (i) icon next to the page title">
            Skip tutorial
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {!isFirst && (
              <button onClick={() => setStepIdx((n) => Math.max(0, n - 1))}
                className="btn btn-outline" style={{ fontSize: 12.5, padding: '6px 14px' }}>
                Back
              </button>
            )}
            {isLast ? (
              <button onClick={() => complete(activeTabId)}
                className="btn btn-primary" style={{ fontSize: 12.5, padding: '6px 18px' }}>
                Got it
              </button>
            ) : (
              <button onClick={() => setStepIdx((n) => n + 1)}
                className="btn btn-primary" style={{ fontSize: 12.5, padding: '6px 18px' }}>
                Next →
              </button>
            )}
          </div>
        </div>
      </div>

    </div>,
    document.body,
  );
}

// Two-button confirmation. First option resumes the tutorial (the
// recommended path). Second option is the explicit "skip anyway" with
// the soft warning copy the user asked for.
