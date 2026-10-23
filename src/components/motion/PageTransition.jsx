// PageTransition - the routed page fades in while rising 8px whenever the
// pathname changes (180ms, ease-out). Query-string-only changes (Finance
// ?section=, Marketing ?tab=) do NOT remount: those pages crossfade their
// own panel with .panel-enter instead.
//
// Phone tab bar: when both the old and the new path are top-level tabs and
// the viewport is mobile, the new page slides in from the right going
// forward in tab order (src/lib/nav.js) and from the left going back - a
// browser back / back arrow (navigationType === 'POP') always reads as
// back. Desktop keeps the fade + rise.
//
// Deliberately enter-only: a keyed wrapper that animates on mount. An exit
// animation would keep the outgoing page mounted for a frame and double
// render pages that fetch on mount. The animation class is dropped on
// animationend so no transform lingers (a transform on this wrapper would
// become the containing block for position:fixed drawers inside the page).
import React, { useRef, useState, useEffect } from 'react';
import { useNavigationType } from 'react-router-dom';
import { NAV } from '../../lib/nav.js';

const TAB_INDEX = new Map(NAV.map((n, i) => [n.to, i]));
// Not in NAV but reachable from the tab bar / header; treat as "after".
TAB_INDEX.set('/more', NAV.length);
TAB_INDEX.set('/account', NAV.length + 1);

export function directionFor(prevPath, nextPath, navigationType, mobile) {
  if (!mobile || !prevPath || prevPath === nextPath) return 'rise';
  const from = TAB_INDEX.get(prevPath);
  const to = TAB_INDEX.get(nextPath);
  if (from == null || to == null) return 'rise';
  if (navigationType === 'POP') return 'back';
  if (to > from) return 'forward';
  if (to < from) return 'back';
  return 'rise';
}

export default function PageTransition({ pathname, mobile = false, children }) {
  const navigationType = useNavigationType();
  const prevRef = useRef(null);
  const dirRef = useRef('rise');
  if (prevRef.current !== pathname) {
    dirRef.current = directionFor(prevRef.current, pathname, navigationType, mobile);
    prevRef.current = pathname;
  }
  return (
    <Enter key={pathname} dir={dirRef.current}>
      {children}
    </Enter>
  );
}

function Enter({ dir, children }) {
  const [animating, setAnimating] = useState(true);
  // Safety net for browsers that never fire animationend (e.g. the element
  // was display:none during the animation): drop the class after 300ms.
  useEffect(() => {
    const t = setTimeout(() => setAnimating(false), 300);
    return () => clearTimeout(t);
  }, []);
  const cls = dir === 'forward' ? 'page-enter-forward' : dir === 'back' ? 'page-enter-back' : 'page-enter';
  return (
    <div
      className={animating ? `page-frame ${cls}` : 'page-frame'}
      data-page-dir={dir}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) setAnimating(false); }}>
      {children}
    </div>
  );
}
