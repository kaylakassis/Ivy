// Calendar Sync drawer — outbound iCal feed setup + Google Calendar
// OAuth connect (richer two-way push integration).
//
// Both options keep Ivy OS as the source of truth: edits / cancels /
// reschedules happen in the Ivy OS app, then propagate out. The Google
// option additionally creates a dedicated "Ivy OS Bookings" calendar
// in the owner's Google account so events live in their own colour-
// coded layer rather than mixing with personal events.
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import Drawer from './Drawer.jsx';
import { api } from '../../lib/api.js';

export default function SyncDrawer({ onClose }) {
  const [status, setStatus]     = useState(null); // null = loading
  const [busy, setBusy]         = useState(null); // 'gen' | 'revoke' | null
  const [err, setErr]           = useState(null);
  // The freshly-issued URL only lives client-side, while the user is on
  // this drawer. Refresh the page → URL gone, must regenerate.
  const [freshUrl, setFreshUrl]       = useState(null);
  const [freshWebcal, setFreshWebcal] = useState(null);
  const [confirmRoll, setConfirmRoll] = useState(false);
  const [copied, setCopied]     = useState(null);

  const load = async () => {
    try {
      const r = await api.get('/calendar/feed-token');
      setStatus(r);
    } catch (e) {
      setErr(e.message || 'Could not load sync settings.');
    }
  };
  useEffect(() => { load(); }, []);

  const generate = async () => {
    setBusy('gen'); setErr(null);
    try {
      const r = await api.post('/calendar/feed-token', {});
      setStatus({ enabled: true, createdAt: r.createdAt });
      setFreshUrl(r.url);
      setFreshWebcal(r.webcalUrl);
      setConfirmRoll(false);
    } catch (e) {
      setErr(e.message || 'Could not generate feed.');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setBusy('revoke'); setErr(null);
    try {
      await api.del('/calendar/feed-token');
      setStatus({ enabled: false, createdAt: null });
      setFreshUrl(null);
      setFreshWebcal(null);
    } catch (e) {
      setErr(e.message || 'Could not revoke feed.');
    } finally {
      setBusy(null);
    }
  };

  const copy = async (label, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1800);
    } catch { /* noop */ }
  };

  return (
    <Drawer title="Calendar sync"
      subtitle="Mirror your Ivy OS bookings into your personal calendar."
      onClose={onClose}>

      <GoogleSection/>

      <Divider label="or use a public iCal URL"/>

      <div style={{
        padding: '10px 12px', borderRadius: 10, marginBottom: 14,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.55,
      }}>
        Works with any calendar app that supports subscriptions. One-way
        only — edits, reschedules, and cancellations all happen here in
        Ivy OS, then sync out within a few minutes.
      </div>

      {status === null ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading…</div>
      ) : !status.enabled ? (
        <NotConnected busy={busy === 'gen'} onGenerate={generate} err={err}/>
      ) : (
        <Connected
          status={status}
          freshUrl={freshUrl}
          freshWebcal={freshWebcal}
          confirmRoll={confirmRoll}
          setConfirmRoll={setConfirmRoll}
          copied={copied}
          copy={copy}
          generate={generate}
          revoke={revoke}
          busy={busy}
          err={err}
        />
      )}
    </Drawer>
  );
}

function Divider({ label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '20px 0 14px' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
      <span style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
    </div>
  );
}

// Google Calendar OAuth panel. Reads /api/calendar/google/status, kicks
// off OAuth via /connect (we redirect on the client), reflects connection
// state, supports disconnect. Surfaces ?google=... query params left by
// the callback flow so the user sees a clear success / error banner.
function GoogleSection() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [busy, setBusy]     = useState(null);
  const [err, setErr]       = useState(null);

  const load = async () => {
    try {
      const r = await api.get('/calendar/google/status');
      setStatus(r);
    } catch (e) {
      setStatus({ configured: false, connected: false });
      setErr(e.message || null);
    }
  };
  useEffect(() => { load(); }, []);

  // After the OAuth round-trip, the callback bounces us back here with
  // ?google=... — surface it as a banner, then strip from the URL.
  const callbackFlag = params.get('google');
  useEffect(() => {
    if (!callbackFlag) return;
    if (callbackFlag === 'connected') load();
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      next.delete('google');
      setParams(next, { replace: true });
    }, 6000);
    return () => clearTimeout(t);
  }, [callbackFlag]);

  const connect = async () => {
    setBusy('connect'); setErr(null);
    try {
      const r = await api.get('/calendar/google/connect');
      if (!r.url) throw new Error('Could not start Google connect');
      window.location.href = r.url;
    } catch (e) {
      setErr(e.message || 'Could not start Google connect');
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('disconnect'); setErr(null);
    try {
      await api.post('/calendar/google/disconnect', {});
      await load();
    } catch (e) {
      setErr(e.message || 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  };

  if (!status) {
    return <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading Google…</div>;
  }

  if (!status.configured) {
    return (
      <div style={{
        padding: '10px 12px', borderRadius: 10, marginBottom: 14,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        fontSize: 12, color: 'var(--muted)', lineHeight: 1.5,
      }}>
        Google Calendar sync isn't configured on this deployment. Ask an
        admin to set <code>GOOGLE_OAUTH_CLIENT_ID</code> and{' '}
        <code>GOOGLE_OAUTH_CLIENT_SECRET</code> in Vercel env.
      </div>
    );
  }

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
          <Icons.Globe size={13} sw={1.7}/> Google Calendar
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          Two-way push: bookings appear in a dedicated "Ivy OS Bookings"
          calendar in your Google account, updated within seconds when
          you edit them in Ivy OS.
        </div>
      </div>

      {callbackFlag && <CallbackBanner flag={callbackFlag}/>}

      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, margin: '10px 0',
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      {status.connected ? (
        <>
          <div style={{
            marginTop: 10, padding: '10px 12px', borderRadius: 10,
            background: 'color-mix(in srgb, var(--ok) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--ok) 35%, transparent)',
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}>
            <Icons.Check size={14} sw={2.2} stroke="var(--ok)"/>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ok)' }}>Connected</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-2)', marginTop: 2 }}>
                {status.email || 'Google account'}
                {status.connectedAt && (
                  <> · since {new Date(status.connectedAt).toLocaleDateString([], { dateStyle: 'medium' })}</>
                )}
              </div>
            </div>
            <button onClick={disconnect} disabled={busy != null}
              className="btn btn-ghost"
              style={{ color: 'var(--danger)', fontSize: 12.5 }}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
          <InboundToggle/>
        </>
      ) : (
        <button onClick={connect} disabled={busy != null}
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', padding: '10px 14px', marginTop: 10 }}>
          {busy === 'connect' ? 'Redirecting…' : 'Connect Google Calendar'}
          {busy !== 'connect' && <Icons.Arrow size={13} sw={2.2}/>}
        </button>
      )}
    </>
  );
}

// Inbound busy-block sync toggle. Lives under the "Connected" card in
// the Google section. When enabled, the cron pulls busy windows from
// the owner's primary Google calendar every hour; the slot-conflict
// check on the public booking page consults them so personal events
// auto-block client booking attempts.
function InboundToggle() {
  const [state, setState] = useState(null); // { connected, enabled, lastSyncAt, lastError }
  const [busy, setBusy]   = useState(null); // 'toggle' | 'sync'
  const [err, setErr]     = useState(null);

  const load = async () => {
    try { setState(await api.get('/calendar/google/inbound')); }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const toggle = async () => {
    if (!state) return;
    setBusy('toggle'); setErr(null);
    try {
      const r = await api.post('/calendar/google/inbound', { enabled: !state.enabled });
      setState((s) => ({ ...s, enabled: r.enabled }));
      // Wait a beat then refetch so lastSyncAt updates after the
      // server's fire-and-forget pull.
      setTimeout(load, 1500);
    } catch (e) { setErr(e.message || 'Could not toggle'); }
    finally { setBusy(null); }
  };

  const syncNow = async () => {
    setBusy('sync'); setErr(null);
    try {
      await api.patch('/calendar/google/inbound', {});
      await load();
    } catch (e) { setErr(e.message || 'Sync failed'); }
    finally { setBusy(null); }
  };

  if (!state) return null;
  const lastSync = state.lastSyncAt ? new Date(state.lastSyncAt) : null;

  return (
    <div style={{
      marginTop: 10, padding: '12px 14px', borderRadius: 10,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!state.enabled}
          onChange={toggle} disabled={busy != null}
          style={{ marginTop: 3 }}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            Block Ivy OS slots from external events
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
            We'll pull busy windows from your primary Google calendar every
            hour and block matching slots on your public booking page —
            so a dentist appointment on your personal calendar auto-blocks
            client bookings. Event titles never leave your account.
          </div>
        </div>
      </label>

      {state.enabled && (
        <div style={{
          marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          fontSize: 11.5, color: 'var(--muted)',
        }}>
          {lastSync ? (
            <span>Last synced {lastSync.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
          ) : <span>Not synced yet — running on the next hourly cron tick.</span>}
          <button onClick={syncNow} disabled={busy != null}
            className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 10px', color: 'var(--accent)' }}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      )}

      {(err || state.lastError) && (
        <div style={{
          marginTop: 8, padding: '6px 10px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 11.5,
        }}>{err || `Last sync: ${state.lastError}`}</div>
      )}
    </div>
  );
}

function CallbackBanner({ flag }) {
  const map = {
    connected:        { tone: 'ok',    text: "You're connected. Bookings will start syncing now." },
    denied:           { tone: 'muted', text: 'Connection cancelled — you can reconnect any time.' },
    'state-mismatch': { tone: 'warn',  text: 'Authorization mismatch (try again from this tab).' },
    'no-refresh':     { tone: 'warn',  text: 'Google did not return a refresh token. Reconnect from your Google account settings to retry.' },
    invalid:          { tone: 'warn',  text: 'Invalid OAuth response.' },
    unconfigured:     { tone: 'warn',  text: 'Google integration not configured on this deployment.' },
    error:            { tone: 'warn',  text: 'Something went wrong. Try again.' },
  };
  const m = map[flag] || { tone: 'muted', text: flag };
  const bg     = m.tone === 'ok' ? 'color-mix(in srgb, var(--ok) 10%, transparent)'
              : m.tone === 'warn' ? 'rgba(155,44,44,0.08)'
              : 'var(--surface-2)';
  const border = m.tone === 'ok' ? 'color-mix(in srgb, var(--ok) 35%, transparent)'
              : m.tone === 'warn' ? 'rgba(155,44,44,0.25)'
              : 'var(--border)';
  const fg     = m.tone === 'ok' ? 'var(--ok)'
              : m.tone === 'warn' ? 'var(--danger)'
              : 'var(--fg-2)';
  return (
    <div style={{
      marginTop: 10, padding: '8px 12px', borderRadius: 8,
      background: bg, border: `1px solid ${border}`,
      color: fg, fontSize: 12.5,
    }}>{m.text}</div>
  );
}

function NotConnected({ busy, onGenerate, err }) {
  return (
    <>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Generate a private feed URL. You'll paste it into your calendar
        app once; from then on your Ivy OS bookings show up automatically.
      </p>

      {err && <ErrorRow message={err}/>}

      <button onClick={onGenerate} disabled={busy}
        className="btn btn-primary"
        style={{ width: '100%', justifyContent: 'center', padding: '11px 14px' }}>
        {busy ? 'Generating…' : 'Generate feed URL'}
        {!busy && <Icons.Arrow size={13} sw={2.2}/>}
      </button>
    </>
  );
}

function Connected({
  status, freshUrl, freshWebcal, confirmRoll, setConfirmRoll,
  copied, copy, generate, revoke, busy, err,
}) {
  const since = status.createdAt
    ? new Date(status.createdAt).toLocaleDateString([], { dateStyle: 'medium' })
    : null;
  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
        padding: '10px 12px', borderRadius: 10,
        background: 'color-mix(in srgb, var(--ok) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--ok) 35%, transparent)',
        fontSize: 12.5, color: 'var(--ok)',
      }}>
        <Icons.Check size={14} sw={2.2}/>
        <span><strong>Sync is active.</strong>{since && <> · Generated {since}</>}</span>
      </div>

      {freshUrl ? (
        <>
          <UrlField
            label="Subscription URL (Google Cal, Outlook)"
            url={freshUrl}
            copyKey="https"
            copied={copied}
            onCopy={() => copy('https', freshUrl)}
          />
          <UrlField
            label="Webcal URL (Apple Cal, iOS)"
            hint="Tap on iPhone / Mac to open the Calendar app's subscribe sheet."
            url={freshWebcal}
            copyKey="webcal"
            copied={copied}
            onCopy={() => copy('webcal', freshWebcal)}
          />

          <div style={{
            padding: '10px 12px', borderRadius: 10, marginBottom: 14,
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent-tint, var(--accent))',
            fontSize: 11.5, color: 'var(--accent-ink, var(--accent))',
            lineHeight: 1.5,
          }}>
            <strong>Save this URL now</strong> — once you close this drawer,
            we won't show it again. Lost it? Regenerate and your old URL
            stops working.
          </div>

          <SetupSteps/>
        </>
      ) : (
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Your sync URL is already in use by your calendar app. We don't
          show old URLs (they're hashed for safety). To re-add the feed
          on a new device, regenerate below — it'll invalidate the old
          URL and give you a fresh one.
        </p>
      )}

      {err && <ErrorRow message={err}/>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
        {confirmRoll ? (
          <div style={{
            padding: 12, borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 10, lineHeight: 1.5 }}>
              Regenerating creates a new URL and immediately invalidates the
              old one. Anyone subscribed to the old URL will need the new
              one to keep getting updates.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setConfirmRoll(false)}
                className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }}>
                Cancel
              </button>
              <button onClick={generate} disabled={busy != null}
                className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}>
                {busy === 'gen' ? 'Regenerating…' : 'Yes, regenerate'}
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirmRoll(true)} disabled={busy != null}
            className="btn btn-outline"
            style={{ width: '100%', justifyContent: 'center', padding: '10px 14px' }}>
            <Icons.Arrow size={12} sw={2}/>{' '}Regenerate URL
          </button>
        )}
        <button onClick={revoke} disabled={busy != null}
          className="btn btn-ghost"
          style={{ width: '100%', justifyContent: 'center', color: 'var(--danger)', fontSize: 13 }}>
          {busy === 'revoke' ? 'Revoking…' : 'Disable sync'}
        </button>
      </div>
    </>
  );
}

function UrlField({ label, hint, url, copyKey, copied, onCopy }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <code style={{
          flex: 1, padding: '8px 10px', borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 11.5, overflow: 'auto', whiteSpace: 'nowrap',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        }}>{url}</code>
        <button onClick={onCopy} className="btn btn-outline"
          style={{ padding: '0 12px', fontSize: 12 }}>
          {copied === copyKey ? 'Copied' : 'Copy'}
        </button>
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>
      )}
    </div>
  );
}

function SetupSteps() {
  return (
    <details style={{
      padding: 10, borderRadius: 8,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      marginBottom: 14, fontSize: 12.5,
    }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>How to subscribe</summary>
      <ol style={{ margin: '10px 0 0', paddingLeft: 18, color: 'var(--fg-2)', lineHeight: 1.6 }}>
        <li>
          <strong>Google Cal:</strong> Settings → Add calendar → From URL → paste
          the HTTPS URL → Add. Updates every ~12–24h on Google's side.
        </li>
        <li style={{ marginTop: 6 }}>
          <strong>Apple Cal (Mac):</strong> File → New Calendar Subscription → paste
          the Webcal URL → set Auto-refresh to Every 15 minutes.
        </li>
        <li style={{ marginTop: 6 }}>
          <strong>iPhone / iPad:</strong> Tap the Webcal URL on your device → choose
          Subscribe in the prompt.
        </li>
        <li style={{ marginTop: 6 }}>
          <strong>Outlook:</strong> Calendar → Add calendar → Subscribe from web →
          paste the HTTPS URL.
        </li>
      </ol>
    </details>
  );
}

function ErrorRow({ message }) {
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 8, marginBottom: 12,
      background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
      color: 'var(--danger)', fontSize: 12.5,
    }}>{message}</div>
  );
}
