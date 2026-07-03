// A tiny dependency-free confetti burst for "win" moments — hitting a goal,
// taking a payment, marking an invoice paid. Imperative so any component can
// fire it (`fireConfetti()`) without wiring a provider. Honors
// prefers-reduced-motion (skips entirely) and cleans up after itself, so it's
// safe to call from anywhere including inside a click handler.
//
// Uses the Web Animations API (element.animate) — no canvas, no timers to leak.

const COLORS = ['#7c5cff', '#22c55e', '#f59e0b', '#ec4899', '#38bdf8', '#facc15'];

let lastFire = 0;

// A short haptic tap for confirm/paid/charge moments. Uses the Vibration API
// (Android/Chrome; iOS Safari ignores it, which is a silent no-op — the app is
// a PWA, there's no native Capacitor layer). Honors reduced-motion. `pattern`
// is ms or an array of on/off ms (default a single light 15ms tap).
export function haptic(pattern = 15) {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    if (typeof window !== 'undefined' && window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    navigator.vibrate(pattern);
  } catch { /* unsupported — ignore */ }
}

export function fireConfetti(opts = {}) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  // Respect reduced-motion: no surprise animation for people who opt out.
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch { /* matchMedia unavailable — proceed */ }

  // Debounce: a double-click or two moments firing at once shouldn't stack.
  const now = Date.now();
  if (now - lastFire < 250) return;
  lastFire = now;

  const count = opts.count || 90;
  const originX = opts.x != null ? opts.x : window.innerWidth / 2;
  const originY = opts.y != null ? opts.y : Math.min(window.innerHeight * 0.32, 260);

  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:9999;';
  document.body.appendChild(layer);

  let remaining = count;
  const done = () => { remaining -= 1; if (remaining <= 0 && layer.parentNode) layer.remove(); };

  for (let i = 0; i < count; i += 1) {
    const p = document.createElement('div');
    const size = 6 + Math.random() * 6;
    const color = COLORS[(Math.random() * COLORS.length) | 0];
    const round = Math.random() < 0.4;
    p.style.cssText =
      `position:fixed;left:${originX}px;top:${originY}px;width:${size}px;height:${size * (round ? 1 : 0.5)}px;` +
      `background:${color};border-radius:${round ? '50%' : '1px'};will-change:transform,opacity;`;
    layer.appendChild(p);

    // Spray upward-and-out, then fall under "gravity".
    const angle = (-Math.PI / 2) + (Math.random() - 0.5) * (Math.PI * 0.9);
    const velocity = 140 + Math.random() * 260;
    const dx = Math.cos(angle) * velocity;
    const upY = Math.sin(angle) * velocity;           // negative = up
    const fallY = 320 + Math.random() * 260;
    const rot = (Math.random() - 0.5) * 720;
    const dur = 1100 + Math.random() * 900;

    const anim = p.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx * 0.5}px, ${upY}px) rotate(${rot * 0.5}deg)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${dx}px, ${fallY}px) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: dur, easing: 'cubic-bezier(0.2,0.6,0.4,1)', fill: 'forwards' },
    );
    anim.onfinish = done;
    anim.oncancel = done;
  }

  // Safety net: force-remove after the longest possible run in case an
  // animation event never fires (backgrounded tab, etc.).
  setTimeout(() => { if (layer.parentNode) layer.remove(); }, 2600);
}
