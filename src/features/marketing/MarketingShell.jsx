// Shared marketing-page shell. Wraps content in the themed root
// (`app-root dir-<direction>`) so the brand CSS variables — --page,
// --accent, --fg, --surface, … — actually resolve.
//
// Those variables are ONLY defined under `.dir-calm` / `.dir-bold`
// (see styles/tokens.css). A marketing page that forgets the wrapper
// renders with undefined variables → plain white background + black
// text, visibly off-brand from the home page. Several pages
// (Mobile, Pricing, Security, Blog, Compare, Integrations, Roadmap)
// hit exactly that bug. Routing them all through this shell keeps
// every marketing tab matching the home page, and matching whatever
// direction the visitor has (defaults to 'bold').
import React from 'react';
import { useTweaks } from '../../lib/tweaks.js';

export default function MarketingShell({ children, style }) {
  const [tweaks] = useTweaks();
  return (
    <div
      className={`app-root dir-${tweaks.direction}`}
      style={{ minHeight: '100vh', background: 'var(--page)', color: 'var(--fg)', ...style }}
    >
      {children}
    </div>
  );
}
