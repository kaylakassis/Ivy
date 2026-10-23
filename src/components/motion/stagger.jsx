// List motion helpers.
//
//   stagger(i)   - inline style for the i-th child of a `.stagger` (or
//                  `.stagger-chat`) container: sets `--i` so global.css can
//                  delay its rise by i * 25ms (40ms for chat). Capped: index
//                  10 and beyond get no delay, so a long list never waits.
//
//   useFreshKeys(keys, { ready, resetKey })
//                - which keys appeared AFTER the list first rendered with
//                  data. Used to grow in a client row that was just created
//                  or a message that was just sent, without animating the
//                  rows that were there on load (those get the stagger).
//
//   <GrowIn fresh>  - wraps a new row: height 0 → auto (grid-template-rows
//                  0fr → 1fr) plus fade, 220ms. Drops its class after the
//                  animation so nothing stays clipped. With fresh=false it
//                  renders the children bare.
import React, { useRef, useState } from 'react';

export const STAGGER_CAP = 10;

export function stagger(i) {
  return (Number.isFinite(i) && i >= 0 && i < STAGGER_CAP) ? { '--i': i } : undefined;
}

export function useFreshKeys(keys, { ready = true, resetKey } = {}) {
  const base = useRef(null);
  const resetRef = useRef(resetKey);
  if (resetRef.current !== resetKey) { resetRef.current = resetKey; base.current = null; }
  if (base.current === null && ready) base.current = new Set(keys);
  if (base.current === null) return EMPTY;
  // Items added after the baseline stay "fresh" for their lifetime; GrowIn
  // only animates on mount anyway, so a re-render never replays it.
  let fresh = null;
  for (const k of keys) {
    if (!base.current.has(k)) { (fresh ||= new Set()).add(k); }
  }
  return fresh || EMPTY;
}
const EMPTY = new Set();

export function GrowIn({ fresh = true, children, style }) {
  const [done, setDone] = useState(false);
  if (!fresh) return children;
  // The wrapper pair stays in the tree after the animation (only the class
  // goes) so the child is never re-parented, which would remount it and
  // replay its own enter animation.
  return (
    <div className={done ? undefined : 'row-new'} style={style}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) setDone(true); }}>
      <div className="row-new-inner">{children}</div>
    </div>
  );
}
