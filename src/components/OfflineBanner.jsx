// A small bar while the phone or computer has no connection, so spinners
// never just hang. On reconnect it says so briefly and reloads the page's
// data (the same reloaders pull-to-refresh uses).
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { runPullRefresh } from '../lib/pullRefresh.js';

export default function OfflineBanner() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const [back, setBack] = useState(false);

  useEffect(() => {
    let t = null;
    const off = () => { setOffline(true); setBack(false); };
    const on = () => {
      setOffline(false); setBack(true);
      runPullRefresh().catch(() => {});
      clearTimeout(t); t = setTimeout(() => setBack(false), 2500);
    };
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); clearTimeout(t); };
  }, []);

  if (!offline && !back) return null;
  return createPortal((
    <div role="status" className={`offline-bar${back ? ' is-back' : ''}`}>
      {offline
        ? "You're offline. Ivy will catch up as soon as you're back online."
        : 'Back online.'}
    </div>
  ), document.body);
}
