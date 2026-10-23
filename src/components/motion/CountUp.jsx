// CountUp - a number that counts from 0 to its value over 400ms (ease-out)
// the FIRST time it has a value, then updates instantly on later changes.
// `format` renders the intermediate values with the existing money/number
// formatters so the digits never change shape mid-count. requestAnimationFrame
// only; no layout work. Honours prefers-reduced-motion by skipping the count.
import React, { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './motion.js';

const DURATION = 400;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export default function CountUp({ value, format = (n) => String(n), duration = DURATION, className, style }) {
  const num = (value == null || value === '') ? null : Number(value);
  const numeric = num != null && Number.isFinite(num);
  // Count only once: the first time a finite value shows up (loading
  // states hand us null first, and that first real number is what the
  // owner sees land).
  const started = useRef(false);
  const [shown, setShown] = useState(() => (numeric ? 0 : num));

  useEffect(() => {
    if (!numeric) { setShown(num); return undefined; }
    if (started.current || num === 0 || prefersReducedMotion()) {
      started.current = true;
      setShown(num);
      return undefined;
    }
    started.current = true;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      setShown(num * easeOut(p));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [num, numeric, duration]);

  let text;
  if (!numeric) text = format(value);
  else {
    // Keep integers integral while counting so "12 clients" never reads 7.3.
    const v = Number.isInteger(num) ? Math.round(shown) : shown;
    text = format(v);
  }
  return <span className={className} style={style}>{text}</span>;
}
