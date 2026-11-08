// iPhone app only, mounted once by the app shell:
//   • scopes the saved copy to the signed-in owner's workspace (a change
//     of workspace wipes it);
//   • while offline, probes /api/health every few seconds so the bar drops
//     the moment signal returns;
//   • when signal returns (or at launch), sends the changes queued offline
//     and says what happened: one toast for what synced, one gentle toast
//     per change the server kept its own version of.
import React, { useEffect, useRef, useState } from 'react';
import SuccessToast from '../SuccessToast.jsx';
import { api } from '../../lib/api.js';
import { isNative } from '../../lib/platform.js';
import { useUserContext } from '../../lib/userContext.jsx';
import { setSnapshotWorkspace, primeSnapshot } from '../../lib/snapshot.js';
import { flushOfflineQueue, primeOfflineQueue, listOfflineQueue } from '../../lib/offlineQueue.js';
import { useOffline } from '../../lib/useOffline.js';

const PROBE_MS = 8000;

export function syncToasts(result) {
  const out = [];
  if (!result) return out;
  if (result.synced > 0) {
    out.push({ icon: 'Check', tone: 'ok', text: result.synced === 1 ? 'Synced 1 change from when you were offline.' : `Synced ${result.synced} changes from when you were offline.` });
  }
  for (const c of result.conflicts || []) {
    const who = c.clientName ? `${c.clientName}'s` : 'An';
    const what = c.kind === 'note' ? 'offline note' : 'offline Complete';
    out.push({ icon: 'Clock', tone: 'neutral', text: `${who} booking changed while you were offline, so Ivy kept the newer version and skipped your ${what}.` });
  }
  return out;
}

export default function OfflineSync() {
  const native = isNative();
  const { ctx } = useUserContext();
  const workspaceId = ctx?.owns?.id || null;
  const offline = useOffline();
  const [toasts, setToasts] = useState([]);
  const wasOffline = useRef(false);

  useEffect(() => { if (native) { primeSnapshot(); primeOfflineQueue(); } }, [native]);
  useEffect(() => { if (native && workspaceId) setSnapshotWorkspace(workspaceId); }, [native, workspaceId]);

  // Probe while offline.
  useEffect(() => {
    if (!native || !offline) return undefined;
    const iv = setInterval(() => {
      api.get('/health', { retry: false, timeoutMs: 6000 }).catch(() => {});
    }, PROBE_MS);
    return () => clearInterval(iv);
  }, [native, offline]);

  // Flush at launch (online) and on every return to online.
  useEffect(() => {
    if (!native) return undefined;
    if (offline) { wasOffline.current = true; return undefined; }
    let live = true;
    (async () => {
      await primeOfflineQueue();
      if (!listOfflineQueue().length) { wasOffline.current = false; return; }
      const r = await flushOfflineQueue(api).catch(() => null);
      wasOffline.current = false;
      if (live && r) setToasts((t) => [...t, ...syncToasts(r)]);
    })();
    return () => { live = false; };
  }, [native, offline]);

  if (!native || !toasts.length) return null;
  const t = toasts[0];
  return <SuccessToast text={t.text} icon={t.icon} tone={t.tone} duration={t.tone === 'ok' ? 3200 : 6000} onDone={() => setToasts((all) => all.slice(1))}/>;
}
