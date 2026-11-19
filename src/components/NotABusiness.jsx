// "I'm a client, not a business." Shown where someone who created a
// business account by mistake ends up: business set-up and the paywall.
// One tap (with a confirmation) removes the unused business and opens the
// client portal. The server only allows it for a business that never had
// a plan and holds no records (api/account/become-client.js); otherwise
// its plain refusal is shown.
import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { confirmAction, showNotice } from '../lib/confirm.js';
import { rememberLanding } from '../lib/landing.js';

export async function switchToClientAccount() {
  const yes = await confirmAction({
    title: 'Switch to a client account?',
    body: 'Choose this if a business you use asked you to join Ivy and you do not run a business yourself. The empty business set-up on this account is removed and Ivy opens your client view, where you see your bookings, invoices and messages. It is free. You can still start a business later.',
    confirmLabel: 'Switch to client account',
  });
  if (!yes) return false;
  try {
    await api.post('/account/become-client', { confirm: true });
  } catch (e) {
    await showNotice({ title: 'This account could not be switched', body: e?.message || 'Please try again, or contact support@joinivy.ai.' });
    return false;
  }
  rememberLanding('client');
  // A full load, so nothing from the business screens is left in memory.
  window.location.assign('/me');
  return true;
}

// The other direction: a client account that wants its own business. One
// explicit step (api/helper/start-business.js); nothing creates a business
// for a client account by accident any more.
export async function startBusinessFromClientAccount() {
  const yes = await confirmAction({
    title: 'Start your own business on Ivy?',
    body: 'This sets up a business account on this login, for taking bookings, sending invoices and managing your own clients. You keep your client view too. Nothing is charged until you choose a plan.',
    confirmLabel: 'Set up my business',
  });
  if (!yes) return false;
  try {
    await api.post('/helper/start-business');
  } catch (e) {
    await showNotice({ title: 'That did not go through', body: e?.message || 'Please try again.' });
    return false;
  }
  rememberLanding(null);
  window.location.assign('/');
  return true;
}

export default function NotABusiness({ variant = 'card', style }) {
  const [busy, setBusy] = useState(false);
  const go = async () => { if (busy) return; setBusy(true); try { await switchToClientAccount(); } finally { setBusy(false); } };
  if (variant === 'link') {
    return (
      <button type="button" data-not-a-business onClick={go} disabled={busy}
        className="btn btn-ghost"
        style={{ alignSelf: 'center', fontSize: 13, color: 'var(--fg-2)', textDecoration: 'underline', ...style }}>
        {busy ? 'Switching…' : 'I’m a client, not a business'}
      </button>
    );
  }
  return (
    <div data-not-a-business style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '12px 14px', borderRadius: 12,
      background: 'var(--surface-2)', border: '1px solid var(--border)', ...style,
    }}>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Here as a client?</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--fg-2)', marginTop: 2 }}>
          This set-up is for people who run a business. If a business you use asked you to join, switch to a client account instead.
        </div>
      </div>
      <button type="button" onClick={go} disabled={busy} className="btn btn-outline" style={{ flexShrink: 0 }}>
        {busy ? 'Switching…' : 'I’m a client'}
      </button>
    </div>
  );
}
