// Calendar Sync drawer — outbound iCal feed setup.
//
// Owners enable a per-workspace token and paste the resulting URL into
// Google Cal / Apple Cal / Outlook. Their THRYVE bookings then appear in
// their personal calendar app, read-only. Every edit / cancel still
// happens in THRYVE — that's the point.
//
// We never echo a previously-issued URL back to the UI. The token's
// hashed at write time and the raw value only exists in memory long
// enough to return it on the regenerate response. Lost the URL?
// Regenerate (which also revokes the old one).
import React, { useEffect, useState } from 'react';
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
      subtitle="Mirror your THRYVE bookings into Google Cal, Apple Cal, or Outlook."
      onClose={onClose}>

      <div style={{
        padding: '10px 12px', borderRadius: 10, marginBottom: 14,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.55,
      }}>
        Bookings flow <strong>out</strong> of THRYVE into your personal
        calendar — reads only. Edits, reschedules, and cancellations all
        happen here in THRYVE, then sync to your calendar app within a few
        minutes (Google Cal can take up to 24h on its end).
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

function NotConnected({ busy, onGenerate, err }) {
  return (
    <>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Generate a private feed URL. You'll paste it into your calendar
        app once; from then on your THRYVE bookings show up automatically.
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
