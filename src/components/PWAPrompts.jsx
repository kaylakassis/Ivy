// Two slim bottom banners driven by src/lib/pwa.js:
//   • "Update ready"  — a new service worker is waiting; reload to apply.
//   • "Install"       — the browser offered an install prompt; offer it
//                       once, then snooze a dismissal so we don't nag.
import React, { useEffect, useState } from 'react';
import { applyUpdate, promptInstall, canInstall, isStandalone } from '../lib/pwa.js';

const SNOOZE_KEY = 'thryve_pwa_install_snooze';
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

function installSnoozed() {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return !!until && Date.now() < until;
  } catch { return false; }
}

export default function PWAPrompts() {
  const [updateReg, setUpdateReg] = useState(null);
  const [showInstall, setShowInstall] = useState(false);

  useEffect(() => {
    const onUpdate = (e) => setUpdateReg(e.detail || null);
    const onInstall = () => { if (!isStandalone() && !installSnoozed()) setShowInstall(true); };
    const onInstalled = () => setShowInstall(false);
    window.addEventListener('pwa:update-available', onUpdate);
    window.addEventListener('pwa:install-available', onInstall);
    window.addEventListener('pwa:installed', onInstalled);
    // The prompt may have fired before this component mounted.
    if (canInstall() && !installSnoozed()) setShowInstall(true);
    return () => {
      window.removeEventListener('pwa:update-available', onUpdate);
      window.removeEventListener('pwa:install-available', onInstall);
      window.removeEventListener('pwa:installed', onInstalled);
    };
  }, []);

  const dismissInstall = () => {
    setShowInstall(false);
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* private mode */ }
  };
  const doInstall = async () => {
    const outcome = await promptInstall();
    if (outcome === 'accepted') setShowInstall(false);
    else dismissInstall();
  };

  if (!updateReg && !showInstall) return null;

  return (
    <div style={wrap}>
      {updateReg ? (
        <div className="card" style={banner} role="status">
          <span style={text}>A new version of THRYVE is ready.</span>
          <button className="btn btn-primary" style={btn} onClick={() => applyUpdate(updateReg)}>
            Reload
          </button>
        </div>
      ) : showInstall ? (
        <div className="card" style={banner}>
          <span style={text}>Install THRYVE for a faster, full-screen app.</span>
          <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-outline" style={btn} onClick={dismissInstall}>Not now</button>
            <button className="btn btn-primary" style={btn} onClick={doInstall}>Install</button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

const wrap = {
  position: 'fixed', left: 0, right: 0,
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
  display: 'flex', justifyContent: 'center',
  padding: '0 12px', zIndex: 4000, pointerEvents: 'none',
};
const banner = {
  pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 14,
  maxWidth: 520, width: '100%', padding: '12px 14px',
  boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
};
const text = { fontSize: 13.5, lineHeight: 1.4, flex: 1 };
const btn = { padding: '7px 14px', fontSize: 13, whiteSpace: 'nowrap' };
