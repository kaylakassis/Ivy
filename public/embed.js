/**
 * Ivy embeddable widget loader.
 *
 * Owners drop this <script> on their website to embed a booking widget
 * or contact (lead-capture) form. The script reads the data-* attrs,
 * injects an iframe pointing at /embed/<kind>/<slug>, and auto-sizes
 * the iframe height to its content via postMessage from the inner page.
 *
 * Usage:
 *
 *   <!-- Booking widget -->
 *   <script async src="https://joinivy.ai/embed.js"
 *     data-ivy="book"
 *     data-slug="your-handle"
 *     data-accent="#C7BFA8"></script>
 *
 *   <!-- Lead-capture / contact form -->
 *   <script async src="https://joinivy.ai/embed.js"
 *     data-ivy="contact"
 *     data-slug="your-handle"></script>
 *
 * The iframe inserts inline at the script tag's location. Owners can
 * wrap it in their own <div> to control max-width.
 *
 * No external dependencies. No tracking. Loads in < 1KB gzip.
 */
(function () {
  'use strict';

  // currentScript is the running <script> tag - that's the anchor point
  // we insert the iframe next to. Falls back to last <script> for old
  // browsers that don't expose currentScript.
  var script = document.currentScript;
  if (!script) {
    var ss = document.getElementsByTagName('script');
    script = ss[ss.length - 1];
  }
  if (!script) return;

  var kind = (script.getAttribute('data-ivy') || script.getAttribute('data-thryve') || 'book').toLowerCase();
  var slug = (script.getAttribute('data-slug') || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  var accent = script.getAttribute('data-accent') || '';

  if (!slug) {
    // Don't litter the page with a broken iframe - log and bail.
    if (window.console) console.warn('[Ivy] embed missing data-slug');
    return;
  }
  if (kind !== 'book' && kind !== 'contact') {
    if (window.console) console.warn('[Ivy] embed data-ivy must be "book" or "contact"');
    return;
  }

  // The src points at the embed page on whatever origin this script is
  // served from. That keeps things working in dev (localhost) without
  // having to bake the production hostname into the script.
  var origin = (function () {
    try { return new URL(script.src).origin; }
    catch (e) { return ''; }
  })();
  var src = origin + '/embed/' + kind + '/' + encodeURIComponent(slug);
  if (accent) src += '?accent=' + encodeURIComponent(accent);

  var iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = kind === 'book' ? 'Book an appointment' : 'Get in touch';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('scrolling', 'no');
  iframe.style.cssText = [
    'width: 100%',
    'max-width: 720px',
    // 480 is a reasonable initial paint height before the auto-size
    // message arrives. The inner page sends a postMessage with its
    // scrollHeight on load + on every mutation.
    'height: 480px',
    'border: 0',
    'display: block',
    'margin: 0 auto',
    'background: transparent',
  ].join(';');

  // Auto-resize listener. The inner /embed/* page posts
  // { type: 'ivy:resize', height: <px>, slug: <slug> } whenever its
  // body height changes. We only honor messages whose origin matches
  // the iframe's src origin to avoid sites postMessage-DDoSing the
  // host page.
  function onMessage(ev) {
    if (origin && ev.origin !== origin) return;
    var d = ev.data;
    if (!d || d.type !== 'ivy:resize') return;
    if (typeof d.height !== 'number') return;
    if (d.slug && d.slug !== slug) return;
    iframe.style.height = Math.max(220, Math.min(4000, d.height)) + 'px';
  }
  window.addEventListener('message', onMessage, false);

  // Insert the iframe right after the script tag. Owners can wrap the
  // script in any layout container they like and the iframe inherits
  // the wrapper's width.
  if (script.parentNode) {
    script.parentNode.insertBefore(iframe, script.nextSibling);
  } else {
    document.body.appendChild(iframe);
  }
})();
