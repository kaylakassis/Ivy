// /me/profile - lets a client update the name on their account plus
// the phone / address / photo they share with the businesses they're
// connected to.
//
// Email is read-only - changing it is auth-critical (it's the login
// identity + the workspace-link key) and would need its own verify-
// new-address flow. Documented as a TODO on the surface so users
// aren't left guessing why the field doesn't accept edits.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { BlockedCard, ReportsCard, clientModeration } from '../../components/Moderation.jsx';

export default function ClientProfile() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Local form state - initialized from the loaded profile so the
  // user can type freely without re-fetching on every keystroke.
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');

  useEffect(() => {
    let live = true;
    api.get('/me/profile')
      .then((r) => {
        if (!live) return;
        setProfile(r.profile);
        setName(r.profile.name || '');
        setPhone(r.profile.phone || '');
        setAddress(r.profile.address || '');
        setPhotoUrl(r.profile.photoUrl || '');
      })
      .catch((e) => { if (live) setErr(e.message || 'Failed to load profile'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const dirty =
    name !== (profile?.name || '') ||
    phone !== (profile?.phone || '') ||
    address !== (profile?.address || '') ||
    photoUrl !== (profile?.photoUrl || '');

  const save = async (e) => {
    e?.preventDefault();
    setBusy(true); setErr(null); setSaved(false);
    try {
      const r = await api.patch('/me/profile', {
        name, phone, address, photoUrl,
      });
      setProfile(r.profile);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e2) {
      setErr(e2.message || 'Could not save profile');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="container" style={{ maxWidth: 640, padding: '28px 18px 64px' }}>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }

  return (
    <div className="container" style={{ maxWidth: 640, padding: '28px 18px 64px' }}>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>
          Your profile
        </h1>
        <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
          Update what the businesses you work with see when they look you up.
          Changes apply to every account you're linked to.
        </p>
      </header>

      <form onSubmit={save} className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Name" hint="The name your businesses see in their CRM.">
          <input
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your full name"
            maxLength={120}
            required
            style={inputStyle}/>
        </Field>

        <Field label="Email" hint="Read-only - used to sign in + link you to businesses. Contact support to change it.">
          <input
            type="email"
            className="input"
            value={profile?.email || ''}
            disabled
            style={{ ...inputStyle, opacity: 0.6, cursor: 'not-allowed' }}/>
        </Field>

        <Field label="Phone" hint="Saved with each business so they can reach you. SMS reminders also need consent - turn them on under Notifications.">
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 555 1234"
            style={inputStyle}/>
        </Field>

        <Field label="Address" hint="Used by businesses that travel to you (mobile services).">
          <textarea
            className="input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street, city, postal code"
            rows={2}
            maxLength={500}
            style={{ ...inputStyle, resize: 'vertical', minHeight: 56 }}/>
        </Field>

        <Field label="Photo URL" hint="Optional. Paste a public link to a profile picture.">
          <input
            type="url"
            className="input"
            value={photoUrl}
            onChange={(e) => setPhotoUrl(e.target.value)}
            placeholder="https://…"
            maxLength={1000}
            style={inputStyle}/>
        </Field>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!dirty || busy}
            style={{ padding: '10px 16px', fontSize: 13 }}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {saved && (
            <span style={{ fontSize: 12.5, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icons.Check size={13}/> Saved
            </span>
          )}
        </div>
      </form>

      {/* Saved cards, one per business. Removing one detaches it from the
          business's payment processor as well as from Ivy. */}
      <div style={{ marginTop: 16 }}>
        <PaymentMethodsCard/>
      </div>

      {/* Messaging moderation: businesses you've blocked, what you've reported. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
        <BlockedCard id="blocked"
          hint="Blocked businesses cannot message you and you cannot message them. You can unblock any time."
          load={clientModeration.loadBlocks}
          labelOf={(b) => b.businessName || 'Business'}
          unblock={(b) => clientModeration.unblock(b.workspaceId)}/>
        <ReportsCard id="reports" load={clientModeration.loadReports} subjectOf={(r) => r.businessName}/>
      </div>
    </div>
  );
}

// Profile → Payment methods. Cards a client saved while paying an invoice
// (or from Billing) are kept per business on that business's payment
// processor; Ivy only knows the brand and last four digits. Removing a card
// detaches it there too, so the business can no longer charge it.
export function PaymentMethodsCard() {
  const [cards, setCards] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () => api.get('/me/payment-methods')
    .then((r) => setCards((r.cards || []).filter((c) => c.hasCard)))
    .catch((e) => setErr(e.message || 'Could not load payment methods'));

  useEffect(() => { load(); }, []);

  const remove = async (c) => {
    if (!window.confirm(`Remove the ${capitalize(c.brand) || 'card'} ending in ${c.last4} saved with ${c.businessName}?`)) return;
    setBusy(c.clientId); setErr(null);
    try {
      await api.del('/me/payment-methods/' + encodeURIComponent(c.clientId));
      await load();
    } catch (e) {
      setErr(e.message || 'Could not remove the card');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div id="payment-methods" className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Payment methods
        </div>
        <Link to="/me/billing" style={{ fontSize: 12, color: 'var(--accent)' }}>Billing</Link>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
        Cards you chose to save while paying an invoice. Each one is kept with that business only and can be removed here at any time.
      </p>
      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 10,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}
      {cards === null ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
      ) : cards.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No saved cards. When you pay an invoice by card you can choose to save it for next time.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {cards.map((c, i) => (
            <div key={c.clientId} style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><Icons.Lock size={14} sw={1.7}/></div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.businessName}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {capitalize(c.brand) || 'Card'} ending in {c.last4}
                  {c.expMonth ? ` · expires ${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}` : ''}
                </div>
              </div>
              <button type="button" className="btn btn-ghost" disabled={busy === c.clientId} onClick={() => remove(c)}
                style={{ fontSize: 12, padding: '6px 12px', color: 'var(--danger)' }}>
                {busy === c.clientId ? 'Removing…' : 'Remove saved card'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function capitalize(s) {
  if (!s) return s;
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{
        fontSize: 11.5, fontWeight: 600, color: 'var(--muted)',
        letterSpacing: '0.04em', textTransform: 'uppercase',
      }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>{hint}</span>}
    </label>
  );
}

const inputStyle = { padding: '10px 12px', fontSize: 14, width: '100%' };
