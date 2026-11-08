// A small bar while the phone or computer has no connection, so spinners
// never just hang. On reconnect it says so briefly and reloads the page's
// data (the same reloaders pull-to-refresh uses).
//
// iPhone app: offline is detected from failed requests too (src/lib/offline.js),
// and while a screen is showing the copy saved on the phone the bar reads
// "Offline. Showing what Ivy saved at 9:41 AM." (useSnapshotBar).
// Web: the bar follows navigator.onLine as before, plus a short toast when
// a request fails for lack of signal.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { runPullRefresh } from '../lib/pullRefresh.js';
import { OFFLINE_MESSAGE, subscribeOfflineRequests, attachBrowserEvents } from '../lib/offline.js';
import { useOffline, useCurrentSnapshotBar } from '../lib/useOffline.js';
import { fmtSavedAt } from '../lib/snapshot.js';
import { isNative } from '../lib/platform.js';

export default function OfflineBanner() {
  const native = isNative();
  const detected = useOffline();
  const savedAt = useCurrentSnapshotBar();
  const [browserOffline, setBrowserOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const [back, setBack] = useState(false);
  const [toast, setToast] = useState(false);

  useEffect(() => attachBrowserEvents(), []);
  useEffect(() => {
    let t = null;
    const off = () => { setBrowserOffline(true); setBack(false); };
    const on = () => {
      setBrowserOffline(false); setBack(true);
      runPullRefresh().catch(() => {});
      clearTimeout(t); t = setTimeout(() => setBack(false), 2500);
    };
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); clearTimeout(t); };
  }, []);

  // Native: a failed request also counts; coming back (any answered
  // request, or the health probe) reloads the open screen.
  const wasOffline = React.useRef(false);
  useEffect(() => {
    if (!native) return undefined;
    if (detected) { wasOffline.current = true; return undefined; }
    if (!wasOffline.current) return undefined;
    wasOffline.current = false;
    setBack(true);
    runPullRefresh().catch(() => {});
    const t = setTimeout(() => setBack(false), 2500);
    return () => clearTimeout(t);
  }, [detected, native]);

  // Web toast: one short line when a request fails for lack of signal.
  useEffect(() => {
    let t = null;
    const un = subscribeOfflineRequests(() => {
      setToast(true);
      clearTimeout(t); t = setTimeout(() => setToast(false), 4000);
    });
    return () => { un(); clearTimeout(t); };
  }, []);

  const offline = native ? (detected || browserOffline) : browserOffline;
  if (!offline && !back && !toast) return null;
  let text;
  if (offline && native && savedAt) text = `Offline. Showing what Ivy saved at ${fmtSavedAt(savedAt)}.`;
  else if (offline) text = native ? OFFLINE_MESSAGE : "You're offline. Ivy will catch up as soon as you're back online.";
  else if (back) text = 'Back online.';
  else text = OFFLINE_MESSAGE;
  return createPortal((
    <div role="status" className={`offline-bar${!offline && back ? ' is-back' : ''}`} data-offline-bar={offline ? 'offline' : back ? 'back' : 'toast'}>
      {text}
    </div>
  ), document.body);
}
