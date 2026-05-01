// Reactive viewport classifier. Re-renders consumers when the window crosses
// a breakpoint so layouts can branch on `isMobile` / `isTablet` / `isDesktop`.
//
//   < 720px      → mobile  (phone portrait + small landscape)
//   720-1024px   → tablet  (iPad portrait)
//   ≥ 1024px     → desktop
//
// SSR-safe: defaults to desktop on first render so the server-rendered shell
// matches the dominant case; the client effect updates on mount.
import { useState, useEffect } from 'react';

const MOBILE_MAX = 720;
const TABLET_MAX = 1024;

function read() {
  if (typeof window === 'undefined') return 1280;
  return window.innerWidth;
}

export function useViewport() {
  const [width, setWidth] = useState(read);

  useEffect(() => {
    let raf = 0;
    const handle = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWidth(window.innerWidth));
    };
    window.addEventListener('resize', handle);
    window.addEventListener('orientationchange', handle);
    // Sync once on mount in case SSR / first render guessed wrong
    handle();
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('orientationchange', handle);
      cancelAnimationFrame(raf);
    };
  }, []);

  return {
    width,
    isMobile:  width <= MOBILE_MAX,
    isTablet:  width >  MOBILE_MAX && width <= TABLET_MAX,
    isDesktop: width >  TABLET_MAX,
  };
}
