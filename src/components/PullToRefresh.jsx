// Pull down at the top of a page to reload it, like every iPhone app.
// Listens on the window (the app scrolls the page, not an inner box) and
// ignores pulls that start inside something scrolled, inside an open
// dialog, or on the full-screen Ivy chat. Runs the page's registered
// reloaders (usePullRefresh) plus the account refresh the shell passes in.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { runPullRefresh, hasPullHandlers } from '../lib/pullRefresh.js';
import { haptic } from '../lib/celebrate.js';

const THRESHOLD = 70;   // px of (damped) pull that triggers a refresh
const MAX = 96;

function blockedTarget(t) {
  if (!t || !t.closest) return false;
  if (t.closest('[role="dialog"], [aria-modal="true"], .motion-sheet, .mobile-drawer, input, textarea, select')) return true;
  if (document.body.classList.contains('ivy-fill') || document.body.classList.contains('keyboard-open')) return true;
  // Something between the finger and the page that is itself scrolled down.
  for (let el = t; el && el !== document.body; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollTop > 0) return true;
  }
  return false;
}

export default function PullToRefresh({ onRefresh, fallbackReload = false }) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const st = useRef({ y0: null, armed: false, pull: 0, busy: false });

  useEffect(() => {
    if (!('ontouchstart' in window)) return undefined;
    const onStart = (e) => {
      if (st.current.busy || window.scrollY > 0 || e.touches.length !== 1 || blockedTarget(e.target)) { st.current.y0 = null; return; }
      st.current.y0 = e.touches[0].clientY; st.current.armed = false; st.current.pull = 0;
    };
    const onMove = (e) => {
      if (st.current.y0 == null) return;
      const dy = e.touches[0].clientY - st.current.y0;
      if (dy <= 0 || window.scrollY > 0) { if (st.current.pull) { st.current.pull = 0; setPull(0); } return; }
      const p = Math.min(MAX, dy * 0.5);
      st.current.pull = p; setPull(p);
      if (!st.current.armed && p >= THRESHOLD) { st.current.armed = true; haptic(); }
      if (st.current.armed && p < THRESHOLD) st.current.armed = false;
    };
    const onEnd = async () => {
      if (st.current.y0 == null) return;
      st.current.y0 = null;
      if (!st.current.armed) { st.current.pull = 0; setPull(0); return; }
      st.current.busy = true; setBusy(true); setPull(THRESHOLD);
      try {
        if (!hasPullHandlers() && fallbackReload) { window.location.reload(); return; }
        await Promise.allSettled([runPullRefresh(), Promise.resolve().then(() => onRefresh?.())]);
        await new Promise((r) => setTimeout(r, 300));
      } finally {
        st.current.busy = false; st.current.armed = false; st.current.pull = 0;
        setBusy(false); setPull(0);
      }
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [onRefresh, fallbackReload]);

  if (!pull && !busy) return null;
  const ready = pull >= THRESHOLD;
  // Portal to <body> so page layout rules (e.g. the tab bar's bottom
  // padding on direct children of the app frame) can never reshape it.
  return createPortal((
    <div aria-live="polite" aria-label={busy ? 'Refreshing' : (ready ? 'Release to refresh' : 'Pull to refresh')}
      className="ptr" style={{ transform: `translate(-50%, ${Math.round(pull * 0.6)}px)`, opacity: Math.min(1, pull / THRESHOLD) }}>
      <span className={busy ? 'ptr-spin' : ''} style={{ transform: busy ? undefined : `rotate(${Math.round((pull / THRESHOLD) * 270)}deg)` }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>
        </svg>
      </span>
    </div>
  ), document.body);
}
