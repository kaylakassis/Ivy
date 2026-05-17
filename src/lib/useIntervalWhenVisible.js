// useIntervalWhenVisible — like setInterval but pauses when the tab
// is backgrounded. At scale (many open tabs across many users) this
// is the difference between baseline RPS being "actual users hitting
// the site" and "every stale tab anyone forgot to close."
//
// Behavior:
//   - Ticks when document.visibilityState === 'visible'.
//   - Stops ticking when the tab is hidden; restarts on visibility
//     change (and fires once immediately on re-show so the user sees
//     fresh data when they switch back).
//   - Pass `enabled = false` to suspend (e.g. a polling panel that's
//     collapsed).
//   - Caller passes a stable `fn` (memoize with useCallback if it
//     depends on state).
import { useEffect } from 'react';

export function useIntervalWhenVisible(fn, ms, enabled = true) {
  useEffect(() => {
    if (!enabled || !ms) return undefined;

    let timerId = null;
    const start = () => {
      if (timerId != null) return;
      timerId = setInterval(fn, ms);
    };
    const stop = () => {
      if (timerId == null) return;
      clearInterval(timerId);
      timerId = null;
    };

    const onVis = () => {
      if (document.visibilityState === 'visible') {
        // Re-show: kick a fresh fetch so the UI isn't stale, then resume.
        try { fn(); } catch { /* caller's fn shouldn't throw, but be defensive */ }
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, [fn, ms, enabled]);
}
