// Exit animations for drawers, modals and sheets. Opening is 220ms with a
// soft overshoot; closing is 140ms and must fade out BEFORE unmount, so
// something has to keep the element mounted for those 140ms and flag it
// with `.is-closing` (global.css turns that into the exit keyframes).
//
// Two shapes, one idea:
//
//   useExitAnimation(open)
//     For a parent that owns the boolean (IvyDock's panel, AppShell's
//     mobile drawer, NativePushPrompt's `show`). Returns { mounted, closing }:
//     render while `mounted`, add 'is-closing' while `closing`.
//
//   useAnimatedClose(onClose)
//     For a surface its parent unmounts via onClose (ClientDrawer,
//     InvoiceEditor, AddClientModal, ReportModal...). Returns
//     { closing, close }: call `close` instead of onClose; it flags
//     `.is-closing`, waits the exit duration, then calls onClose.
//
// Both honour prefers-reduced-motion by shortening to the 100ms crossfade.
import { useCallback, useEffect, useRef, useState } from 'react';
import { exitMs } from './motion.js';

export function useExitAnimation(open, duration) {
  const [mounted, setMounted] = useState(!!open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return undefined;
    }
    if (!mounted) return undefined;
    setClosing(true);
    const t = setTimeout(() => { setMounted(false); setClosing(false); }, duration ?? exitMs());
    return () => clearTimeout(t);
  // `mounted` is intentionally read, not tracked: the effect only needs to
  // react to `open` flipping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, duration]);
  return { mounted, closing, className: closing ? 'is-closing' : '' };
}

export function useAnimatedClose(onClose, duration) {
  const [closing, setClosing] = useState(false);
  const timer = useRef(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const close = useCallback((...args) => {
    if (timer.current) return; // already on the way out
    setClosing(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current?.(...args);
    }, duration ?? exitMs());
  }, [duration]);
  return { closing, close, className: closing ? 'is-closing' : '' };
}

export default useExitAnimation;
