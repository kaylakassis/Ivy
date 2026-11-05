// /me/notifications - per-workspace email preferences for the
// authenticated user's client memberships. A user who's a client of
// three businesses sees three independent toggle blocks.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SkelCards } from './portalUi.jsx';
import { api } from '../../lib/api.js';

const EMAIL_LABELS = {
  bookings:  { label: 'Bookings',     hint: 'Confirmations, reminders, cancellations, reschedules.' },
  invoices:  { label: 'Invoice reminders', hint: 'Quotes, due-date and overdue reminders, payment problems. Invoices and receipts always arrive.' },
  documents: { label: 'Documents',    hint: 'Requests to sign, and reminders.' },
  messages:  { label: 'Messages',     hint: 'When this business sends you a chat message.' },
  marketing: { label: 'Other emails', hint: 'Review prompts and occasional updates from the business.' },
  billing:   { label: 'Billing',      hint: 'Subscription billing emails (rarely relevant to clients).' },
  programs:  { label: 'Programs',     hint: 'New lessons and newly opened modules in programs you are part of.' },
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
      .catch(() => { /* silent - defaults */ });
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

  // Ivy's own tips, product news and offers (not any business's emails):
  // the same choice as the optional box at sign-up.
  const toggleMarketing = async () => {
    const next = !prefs?.marketingEmails;
    setPrefs((p) => ({ ...(p || {}), marketingEmails: next }));
    setBusy('ivy-marketing');
    try {
      const r = await api.patch('/me/notification-prefs', { marketingEmails: next });
      setPrefs(r.prefs);
    } catch (e) {
      setPrefs((p) => ({ ...(p || {}), marketingEmails: !next }));
      setErr(e.message || 'Could not update');
    } finally {
      setBusy(null);
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

  const toggleReminders = async (clientId) => {
    const current = memberships.find((m) => m.clientId === clientId);
    const next = current?.reminders === false;
    setMemberships((list) => list.map((m) => m.clientId === clientId ? { ...m, reminders: next } : m));
    setBusy(`${clientId}:reminders`); setErr(null);
    try {
      const r = await api.patch('/me/notifications-clients', { clientId, reminders: next });
      setMemberships((list) => list.map((m) => m.clientId === clientId ? { ...m, reminders: r.reminders } : m));
    } catch (e) {
      setMemberships((list) => list.map((m) => m.clientId === clientId ? { ...m, reminders: !next } : m));
      setErr(e.message || 'Could not update');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-pad"><div className="portal-page" style={{ gap: 0 }}>
      <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
        Choose what each business can email or text you. Sign-in emails, receipts and invoices always arrive.
      </p>

      <TextMessages/>

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

      <section className="card" style={{ padding: 18, marginBottom: 16 }} data-testid="ivy-marketing-pref">
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Emails from Ivy</div>
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          cursor: busy === 'ivy-marketing' ? 'wait' : 'pointer',
        }}>
          <Switch checked={!!prefs?.marketingEmails} disabled={!prefs || busy === 'ivy-marketing'} onChange={toggleMarketing}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Tips, product news and offers from Ivy</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
              Optional. This is about Ivy itself, not the businesses you book with. Emails about your account always arrive.
            </div>
          </div>
        </label>
      </section>

      {memberships === null && !err && (
        <SkelCards rows={2}/>
      )}

      {memberships && memberships.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <Icons.Mail size={28} sw={1.4} style={{ color: 'var(--muted)' }}/>
          <h3 style={{ margin: '12px 0 4px', fontSize: 16 }}>No businesses yet</h3>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            Once a business adds you as a client, you can choose which emails they send you here.
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
                {/* Appointment reminders: one switch for every channel
                    (email, text, app). Off always wins over the business. */}
                <label data-testid="portal-reminders" style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  padding: '10px 12px', borderRadius: 10,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  cursor: busy === `${m.clientId}:reminders` ? 'wait' : 'pointer',
                }}>
                  <Switch checked={m.reminders !== false} disabled={busy === `${m.clientId}:reminders`}
                    onChange={() => toggleReminders(m.clientId)}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Appointment reminders</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
                      A heads up before each appointment, by email, text or app. Booking confirmations still arrive.
                    </div>
                  </div>
                </label>
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
    </div></div>
  );
}

// Text reminders: one phone + consent for the person, applied to every
// business they're a client of (api/me/sms-preferences.js).
function TextMessages() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/me/sms-preferences').then((r) => live && setSt(r)).catch(() => live && setSt({ phone: null, smsConsentAt: null }));
    return () => { live = false; };
  }, []);
  if (!st) return null;
  const on = !!st.smsConsentAt;
  const flip = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/me/sms-preferences', { smsConsent: !on });
      setSt((s) => ({ ...s, smsConsentAt: on ? null : new Date().toISOString() }));
    } catch (e) {
      setErr(e.message || 'Could not update');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Text messages</div>
      {st.phone ? (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
          <Switch checked={on} disabled={busy} onChange={flip}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Text me reminders and updates</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
              To {st.phone}. Reply STOP to any text to stop them. <Link to="/me/profile" style={{ color: 'var(--accent)' }}>Change number</Link>
            </div>
          </div>
        </label>
      ) : (
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          Add your phone number in <Link to="/me/profile" style={{ color: 'var(--accent)', fontWeight: 600 }}>Profile</Link> to get text reminders.
        </div>
      )}
      {err && <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{err}</div>}
    </section>
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
        opacity: disabled ? 0.6 : 1,
      }}>
      <span className="switch-thumb" style={{
        display: 'block',
        width: 18, height: 18, borderRadius: 999,
        background: '#fff',
        transform: checked ? 'translateX(14px)' : 'translateX(0)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }}/>
    </button>
  );
}
