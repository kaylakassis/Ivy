// Shared constants for the motion system. The CSS side lives in
// global.css (tokens on :root, keyframes + utility classes under
// "Motion system"); these mirror the durations JS needs to know about.
//
// Honouring the OS "reduce motion" setting: movement is replaced by a
// 100ms opacity crossfade in CSS; here we expose the same decision so hooks
// can shorten their timers and CountUp can skip the count.

// Closing surfaces is faster than opening them (140ms vs 220ms).
export const EXIT_MS = 140;
export const REDUCED_EXIT_MS = 100;

export function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}

export function exitMs() {
  return prefersReducedMotion() ? REDUCED_EXIT_MS : EXIT_MS;
}
