// /connected - where the phone's payment-processor connection ends up.
//
// The owner tapped Connect in the iOS app, finished Stripe / Square /
// PayPal in Safari, and the processor sent them back to our callback.
// Safari has no Ivy session, so instead of /finance (which would bounce to
// sign-in) the callback lands here: a public page that says what happened
// and hands them back to the app. The Finance tab refreshes itself when
// the app comes back to the front.
import React from 'react';
import { useTweaks } from '../../lib/tweaks.js';
import { Icons } from '../../components/Icons.jsx';

const NAMES = { stripe: 'Stripe', square: 'Square', paypal: 'PayPal' };

export default function ConnectedPage() {
  const [tweaks] = useTweaks();
  const params = new URLSearchParams(window.location.search);
  const provider = ['stripe', 'square', 'paypal'].find((k) => params.get(k)) || 'stripe';
  const status = params.get(provider) || 'error';
  const msg = params.get('msg') || params.get('detail') || '';
  const name = NAMES[provider];
  const good = status === 'connected';
  const pending = status === 'pending' || status === 'incomplete';

  const title = good ? `${name} is connected.`
    : pending ? `${name} needs one more step.`
    : `${name} didn't connect.`;
  const body = good
    ? `Payments through ${name} are ready. Head back to the Ivy app; your Finance tab will show ${name} as connected.`
    : pending
      ? (status === 'incomplete'
        ? `The ${name} form wasn't finished. Back in the Ivy app, tap Connect again to pick up where you left off.`
        : `${name} is still verifying your details. Ivy will show it as connected as soon as ${name} finishes; nothing else to do.`)
      : `Something went wrong on ${name}'s side${msg ? `: ${msg}` : ''}. Back in the Ivy app, tap Connect to try again.`;

  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', padding: '48px 24px', background: 'var(--page)', color: 'var(--fg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div className="card" style={{ maxWidth: 440, width: '100%', padding: 32, textAlign: 'center' }}>
        <div style={{
          width: 56, height: 56, borderRadius: 99, margin: '0 auto 16px',
          background: good ? 'var(--ok)' : pending ? 'var(--warn)' : 'var(--danger)', color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>{good ? <Icons.Check size={26} sw={2.4}/> : <Icons.Clock size={24} sw={2}/>}</div>
        <h1 className="page-title" style={{ margin: 0, fontSize: 24 }}>{title}</h1>
        <p style={{ color: 'var(--muted)', marginTop: 10, fontSize: 14, lineHeight: 1.55 }}>{body}</p>
        {/* Registered in the app's Info.plist (CFBundleURLTypes). On a phone with
            Ivy installed this brings the app to the front; elsewhere it does
            nothing, and the note below covers that. */}
        <a href="ivy://finance" className="btn btn-primary"
          style={{ marginTop: 22, display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
          Open Ivy <Icons.Arrow size={12} sw={2}/>
        </a>
        <p style={{ color: 'var(--muted-2)', marginTop: 16, fontSize: 12 }}>
          Or just switch back to the Ivy app. You can close this tab.
        </p>
      </div>
    </div>
  );
}
