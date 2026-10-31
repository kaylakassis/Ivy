// Pull-to-refresh registry. A page registers how to reload its data with
// usePullRefresh(fn); the shell's <PullToRefresh/> runs every registered
// reloader when someone pulls down at the top of the page.
import { useEffect, useRef } from 'react';

const handlers = new Set();

export function usePullRefresh(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current?.();
    handlers.add(h);
    return () => { handlers.delete(h); };
  }, []);
}

export function hasPullHandlers() { return handlers.size > 0; }

export async function runPullRefresh() {
  await Promise.allSettled([...handlers].map((h) => Promise.resolve().then(h)));
}
