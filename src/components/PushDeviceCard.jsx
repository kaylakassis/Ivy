// "Notifications on this device" for the client portal and the helper
// shell (owners have the fuller card in Account). One button turns push on
// or off for THIS phone or browser (iPhone app: iOS permission + APNs
// token; browser: web push), then a switch per kind of notification. The
// switches are the account's push preferences (/api/me/notifications), so
// they follow the person to every device.
//
// The permission prompt only ever runs from the button tap (browsers and
// iOS require a user gesture, and iOS shows its dialog once per install).
import React, { useEffect, useState } from 'react';
import { Icons } from './Icons.jsx';
import { api } from '../lib/api.js';
import { isNative } from '../lib/platform.js';
import {
  pushSupported, permissionState, getSubscription, subscribePush, unsubscribePush,
} from '../lib/push.js';

const LABELS = {
  client: {
    messages:  { label: 'Messages', hint: 'When a business you book with messages you, including group chats.' },
    bookings:  { label: 'Appointments', hint: 'Bookings made for you, moved or cancelled, spots that open up, and reminders.' },
    payments:  { label: 'Invoices and payments', hint: 'New invoices, due and overdue reminders, and payment receipts.' },
    documents: { label: 'Documents', hint: 'Documents to sign, and your copy once everyone has signed.' },
    engagement: { label: 'Programs', hint: 'New lessons and live sessions in programs you are part of.' },
  },
  helper: {
    bookings:  { label: 'Your schedule', hint: 'Sessions added to your day, moved or cancelled, and reminders before each one.' },
    messages:  { label: 'Messages', hint: 'When a client you work with sends a message.' },
  },
};

const SWITCH_TRACK = (on) => ({
  width: 38, height: 22, borderRadius: 99, flexShrink: 0, position: 'relative',
  background: on ? 'var(--accent)' : 'var(--border-strong)', transition: 'background 120ms',
  border: 0, padding: 0, cursor: 'pointer',
});
const SWITCH_KNOB = (on) => ({
  position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: 99,
  background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left 120ms',
});

export default function PushDeviceCard({ audience = 'client' }) {
  const labels = LABELS[audience] || LABELS.client;
  const [supported, setSupported] = useState(true);
  const [perm, setPerm] = useState('default');
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [savingKey, setSavingKey] = useState(null);

  const refresh = async () => {
    if (!pushSupported()) { setSupported(false); return; }
    try {
      const sub = await getSubscription();
      setPerm(permissionState());
      setOn(!!sub);
    } catch {
      setOn(false);
    }
  };

  useEffect(() => {
    refresh();
    let live = true;
    api.get('/me/notifications')
      .then((r) => { if (live) setPrefs(r.pushPrefs || r.prefs || {}); })
      .catch(() => { if (live) setPrefs({}); });
    return () => { live = false; };
  }, []);

  const turnOn = async () => {
    setBusy(true); setErr(null);
    try { await subscribePush(); await refresh(); }
    catch (e) { setErr(e.message || 'Could not turn on notifications'); await refresh(); }
    finally { setBusy(false); }
  };
  const turnOff = async () => {
    setBusy(true); setErr(null);
    try { await unsubscribePush(); await refresh(); }
    catch (e) { setErr(e.message || 'Could not turn off notifications'); }
    finally { setBusy(false); }
  };

  const toggleType = async (key) => {
    const next = !(prefs?.[key] !== false);
    setPrefs((p) => ({ ...(p || {}), [key]: next }));
    setSavingKey(key);
    try {
      const r = await api.patch('/me/notifications', { pushPrefs: { [key]: next } });
      if (r?.pushPrefs) setPrefs(r.pushPrefs);
    } catch (e) {
      setPrefs((p) => ({ ...(p || {}), [key]: !next }));
      setErr(e.message || 'Could not save');
    } finally {
      setSavingKey(null);
    }
  };

  const blockedHint = isNative()
    ? 'Notifications are off for Ivy in your iPhone settings. Open Settings, then Notifications, then Ivy, and allow notifications.'
    : "Notifications are blocked for this site. Open your browser's site settings, allow notifications for Ivy, and reload this page.";

  return (
    <section className="card" data-testid="push-device-card" style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{
          width: 30, height: 30, borderRadius: 9, flexShrink: 0,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Bell size={15} sw={1.8}/></span>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Notifications on this device</div>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
        {audience === 'helper'
          ? 'A ping on this phone or computer when your schedule changes or a client messages.'
          : 'A ping on this phone or computer, even when Ivy is closed. Never used for ads.'}
      </p>

      {err && (
        <div style={{ fontSize: 12.5, color: 'var(--danger)', marginBottom: 10 }}>{err}</div>
      )}

      {!supported ? (
        <div style={{ fontSize: 12.5, color: 'var(--fg-2)', padding: '8px 12px', borderRadius: 8, background: 'var(--surface-2)' }}>
          This browser can't show notifications. On iPhone, use the Ivy app or add Ivy to your Home Screen.
        </div>
      ) : perm === 'denied' ? (
        <div style={{ fontSize: 12.5, color: 'var(--fg-2)', padding: '8px 12px', borderRadius: 8, background: 'var(--surface-2)', lineHeight: 1.5 }}>
          {blockedHint}
        </div>
      ) : on ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 12.5, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Icons.Check size={12} sw={2.4}/> On for this device
          </span>
          <button type="button" className="btn btn-outline" onClick={turnOff} disabled={busy}
            style={{ padding: '6px 12px', fontSize: 12 }}>
            {busy ? 'Turning off…' : 'Turn off here'}
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-primary" onClick={turnOn} disabled={busy}
          style={{ marginBottom: 4 }}>
          {busy ? 'Turning on…' : 'Turn on notifications'}
        </button>
      )}

      {on && prefs && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          {Object.entries(labels).map(([key, l]) => {
            const enabled = prefs[key] !== false;
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '6px 0' }}>
                <button type="button" role="switch" aria-checked={enabled} aria-label={l.label}
                  disabled={savingKey === key} onClick={() => toggleType(key)} style={SWITCH_TRACK(enabled)}>
                  <span style={SWITCH_KNOB(enabled)}/>
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{l.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1, lineHeight: 1.45 }}>{l.hint}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
