// /me/notifications — per-workspace email preferences for the
// authenticated user's client memberships. A user who's a client of
// three businesses sees three independent toggle blocks.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const EMAIL_LABELS = {
  bookings:  { label: 'Bookings',     hint: 'Confirmations, reminders, cancellations, reschedules.' },
  invoices:  { label: 'Invoices',     hint: 'Invoices sent to you, plus paid receipts.' },
  documents: { label: 'Documents',    hint: 'Signature requests + reminders.' },
  messages:  { label: 'Messages',     hint: 'When this business sends you a chat message.' },
  marketing: { label: 'Other emails', hint: 'Review prompts and occasional updates from the business.' },
  billing:   { label: 'Billing',      hint: 'Subscription billing emails (rarely relevant to clients).' },
};

export default function ClientNotifications() {
  const [memberships, setMemberships] = useState(null);
  const [emailTypes, setEmailTypes] = useState([]);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [prefs, setPrefs] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/me/notifications-clients')
      .then((r) => {
        if (!live) return;
        setMemberships(r.memberships || []);
        setEmailTypes(r.emailTypes || []);
      })
      .catch((e) => { if (live) setErr(e.message || 'Failed to load'); });
    api.get('/me/notification-prefs')
      .then((r) => { if (live) setPrefs(r.prefs); })
      .catch(() => { /* silent — defaults */ });
    return () => { live = false; };
  }, []);

  const toggleDigest = async () => {
    const next = !(prefs?.digestGroupsDaily !== false);
    setPrefs((p) => ({ ...(p || {}), digestGroupsDaily: next }));
    try {
      const r = await api.patch('/me/notification-prefs', { digestGroupsDaily: next });
      setPrefs(r.prefs);
    } catch (e) {
      setPrefs((p) => ({ ...(p || {}), digestGroupsDaily: !next }));
      setErr(e.message || 'Could not update');
    }
  };

  const toggle = async (clientId, type) => {
    setMemberships((list) => list.map((m) => m.clientId === clientId
      ? { ...m, prefs: { ...m.prefs, [type]: !m.prefs[type] } } : m));
    const busyKey = `${clientId}:${type}`;
    setBusy(busyKey); setErr(null);
    try {
      const current = memberships.find((m) => m.clientId === clientId);
      const r = await api.patch('/me/notifications-clients', {
        clientId,
        prefs: { [type]: !current.prefs[type] },
      });
      setMemberships((list) => list.map((m) => m.clientId === clientId
        ? { ...m, prefs: r.prefs } : m));
    } catch (e) {
      // Revert on failure
      setMemberships((list) => list.map((m) => m.clientId === clientId
        ? { ...m, prefs: { ...m.prefs, [type]: !m.prefs[type] } } : m));
      setErr(e.message || 'Could not update');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="container" style={{ maxWidth: 760, padding: '28px 18px 64px' }}>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, letterSpacing: '-0.02em', margin: 0 }}>
          Email preferences
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.55 }}>
          Choose which emails you want to receive from each business you're a client of.
          Account-critical emails (verification, password reset) always send.
        </p>
      </header>

      {err && (
        <div className="card" style={{
          padding: '12px 14px', marginBottom: 14, fontSize: 13,
          background: 'rgba(155,44,44,0.08)', color: 'var(--danger)',
          border: '1px solid rgba(155,44,44,0.25)',
        }}>{err}</div>
      )}

      <section className="card" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Group chat</div>
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, padding: '8px 0',
          cursor: 'pointer',
        }}>
          <input type="checkbox"
            checked={prefs?.digestGroupsDaily !== false}
            onChange={toggleDigest}
            style={{ marginTop: 2 }}/>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Daily digest email</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
              One email each morning summarizing every unread group message across the businesses
              you're a member of. Turn off if you want push only.
            </div>
          </div>
        </label>
      </section>

      {memberships === null && !err && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
          Loading…
        </div>
      )}

      {memberships && memberships.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <Icons.Mail size={28} sw={1.4} style={{ color: 'var(--muted)' }}/>
          <h3 style={{ margin: '12px 0 4px', fontSize: 16 }}>No client memberships yet</h3>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            Once a business adds you as their client, you'll be able to manage which emails they send you here.
          </p>
        </div>
      )}

      {memberships && memberships.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {memberships.map((m) => (
            <section key={m.clientId} className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 14 }}>
                {m.businessName}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {emailTypes.map((t) => {
                  const meta = EMAIL_LABELS[t] || { label: t, hint: '' };
                  const on = m.prefs[t] !== false;
                  const busyKey = `${m.clientId}:${t}`;
                  return (
                    <label key={t} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                      padding: '10px 12px', borderRadius: 10,
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      cursor: busy === busyKey ? 'wait' : 'pointer',
                    }}>
                      <Switch checked={on} disabled={busy === busyKey} onChange={() => toggle(m.clientId, t)}/>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{meta.label}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
                          {meta.hint}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Switch({ checked, disabled, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={checked}
      onClick={onChange} disabled={disabled}
      style={{
        flexShrink: 0, marginTop: 1,
        width: 36, height: 22, borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--border-strong)',
        border: 0, padding: 2,
        cursor: disabled ? 'wait' : 'pointer',
        transition: 'background 0.15s ease',
        opacity: disabled ? 0.6 : 1,
      }}>
      <span style={{
        display: 'block',
        width: 18, height: 18, borderRadius: 999,
        background: '#fff',
        transform: checked ? 'translateX(14px)' : 'translateX(0)',
        transition: 'transform 0.15s ease',
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }}/>
    </button>
  );
}
