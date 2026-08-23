// useEmbedResize - posts the document height to the parent window
// whenever the embed body's content changes. The host site's embed.js
// listens for { type: 'ivy:resize', height, slug } and resizes the
// iframe to match. Without this, the iframe would either need a fixed
// height (looks bad) or scrolling (also looks bad).
import { useEffect } from 'react';

export function useEmbedResize(slug) {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.parent === window) return; // not in an iframe

    const post = () => {
      // documentElement.scrollHeight is the most reliable cross-browser
      // measure of "how tall is the rendered content right now."
      const h = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0,
      );
      window.parent.postMessage({ type: 'ivy:resize', slug, height: h }, '*');
    };

    // Initial paint + a debounce for fast-changing layouts (mounting
    // steps, fetching reviews, etc.). ResizeObserver fires on every
    // mutation that changes layout - perfect for our case.
    post();
    let timer = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(post, 80);
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);

    // Some browsers don't fire ResizeObserver on font-load layout shifts.
    // Fallback: re-post on load.
    window.addEventListener('load', schedule);

    return () => {
      ro.disconnect();
      window.removeEventListener('load', schedule);
      if (timer) clearTimeout(timer);
    };
  }, [slug]);
}
