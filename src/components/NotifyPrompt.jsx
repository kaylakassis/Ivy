// Proactive "turn on notifications" card for owners. Push permission used to be
// buried in Account → Notifications, so almost no owner opted in and every
// server push (booking, payment, dunning, re-engagement, Ivy nudge) silently
// degraded to a bell row only. This surfaces the ask where owners live (the
// dashboard), one tap to enable, with a 14-day snooze on dismiss.
//
// Renders nothing unless: push is supported, permission is still 'default'
// (undecided), the device isn't already subscribed, and it isn't snoozed.
import React, { useEffect, useState } from 'react';
import { Icons } from './Icons.jsx';
import { pushSupported, permissionState, getSubscription, subscribePush } from '../lib/push.js';

const SNOOZE_KEY = 'ivy_notify_prompt_snooze';
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

function snoozed() {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return !!until && Date.now() < until;
  } catch { return false; }
}

export default function NotifyPrompt() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    if (!pushSupported() || permissionState() !== 'default' || snoozed()) return undefined;
    // Don't prompt if this device already has a subscription.
    getSubscription().then((s) => { if (live && !s) setShow(true); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const dismiss = () => {
    setShow(false);
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* private mode */ }
  };
  const enable = async () => {
    setBusy(true);
    try { await subscribePush(); setShow(false); }
    catch { dismiss(); } // denied / not configured → snooze so we don't re-ask right away
    finally { setBusy(false); }
  };

  if (!show) return null;
  return (
    <div className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{
        width: 32, height: 32, borderRadius: 9, flexShrink: 0,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Bell size={17} sw={1.8}/>
      </div>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>Turn on notifications</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          Get a ping the moment a client books or pays, even when the app is closed.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button type="button" onClick={dismiss} disabled={busy} className="btn btn-outline" style={{ fontSize: 13 }}>Not now</button>
        <button type="button" onClick={enable} disabled={busy} className="btn btn-primary" style={{ fontSize: 13 }}>
          {busy ? 'Enabling…' : 'Enable'}
        </button>
      </div>
    </div>
  );
}
