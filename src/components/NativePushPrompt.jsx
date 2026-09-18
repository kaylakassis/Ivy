// iOS app: the "turn on notifications" sheet, shown once the owner is past
// the paywall and onboarding. iOS only ever shows its own permission
// dialog once per install, so we ask in our own words first and only
// trigger the system prompt when they tap "Turn on". "Not now" snoozes
// for a week. Renders nothing on the web (the dashboard card handles
// that) and nothing once permission is decided either way.
import React, { useEffect, useState } from 'react';
import { Icons } from './Icons.jsx';
import { isNative } from '../lib/platform.js';
import { permissionState, getSubscription, subscribePush } from '../lib/push.js';
import { useTutorial } from '../lib/tutorialState.jsx';

// Same key the web card uses, so the two never ask back to back.
const SNOOZE_KEY = 'ivy_notify_prompt_snooze';
const SNOOZE_NOT_NOW_MS = 7 * 24 * 60 * 60 * 1000;
const SNOOZE_DENIED_MS = 30 * 24 * 60 * 60 * 1000;

function snoozed() {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return !!until && Date.now() < until;
  } catch { return false; }
}
function snooze(ms) {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + ms)); } catch { /* private mode */ }
}

export default function NativePushPrompt({ active }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  // Never stack on top of a tab tutorial; wait until it closes.
  const { activeTabId } = useTutorial();
  const tutorialOpen = !!activeTabId;

  useEffect(() => {
    if (!isNative() || !active || tutorialOpen || snoozed()) return undefined;
    let live = true;
    // getSubscription() refreshes the cached native permission; only ask
    // while the OS still says "undecided".
    const t = setTimeout(() => {
      getSubscription()
        .then((sub) => { if (live && !sub && permissionState() === 'default') setShow(true); })
        .catch(() => {});
    }, 700);
    return () => { live = false; clearTimeout(t); };
  }, [active, tutorialOpen]);

  if (!show) return null;

  const notNow = () => { snooze(SNOOZE_NOT_NOW_MS); setShow(false); };
  const turnOn = async () => {
    setBusy(true);
    try { await subscribePush(); setShow(false); }
    catch { snooze(SNOOZE_DENIED_MS); setShow(false); }
    finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="push-prompt-title" style={{
      position: 'fixed', inset: 0, zIndex: 900,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div style={{
        width: '100%', maxWidth: 520,
        background: 'var(--surface)', color: 'var(--fg)',
        borderRadius: '20px 20px 0 0',
        padding: '22px 22px calc(env(safe-area-inset-bottom, 0px) + 22px)',
        boxShadow: '0 -8px 30px rgba(0,0,0,0.25)',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, marginBottom: 14,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Bell size={24} sw={1.8}/>
        </div>
        <div id="push-prompt-title" style={{ fontSize: 19, fontWeight: 700, marginBottom: 6 }}>Turn on notifications</div>
        <div style={{ fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.45, marginBottom: 18 }}>
          Get a ping the moment a client books, pays or messages you, even when Ivy is closed. You can change this any time in Account.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button type="button" className="btn btn-primary" onClick={turnOn} disabled={busy}
            style={{ width: '100%', padding: '13px 16px', fontSize: 15.5 }}>
            {busy ? 'Turning on…' : 'Turn on'}
          </button>
          <button type="button" className="btn btn-outline" onClick={notNow} disabled={busy}
            style={{ width: '100%', padding: '12px 16px', fontSize: 15 }}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
