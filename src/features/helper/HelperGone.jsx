// The friendly full-screen state a helper sees when they are no longer
// part of a team (the owner revoked them, or they opened a cancelled
// invite link) or when the team's subscription has lapsed. Never names
// the business. Below the explanation: an invitation to try Ivy for
// their own work, unless they already own a business or are a client
// somewhere, in which case we send them there instead.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { clearMeCache, forgetLanding } from '../../lib/landing.js';

export const GONE_COPY = {
  revoked: {
    heading: 'Uh-oh!',
    line: "Looks like you're no longer part of this team on Ivy.",
    detail: 'The owner removed your access. Any sessions you marked complete stay recorded with them.',
  },
  paused: {
    heading: 'Uh-oh!',
    line: 'Looks like this team is paused on Ivy right now.',
    detail: 'The owner’s subscription is not active, so your schedule is on hold until they reactivate it.',
  },
  expired: {
    heading: 'Uh-oh!',
    line: 'This invite link has expired.',
    detail: 'Invite links work once and last 7 days. Ask the owner to send you a fresh one.',
  },
};

export const PITCH = {
  heading: 'Run your own business? Ivy was built for you.',
  intro: 'Ivy is the business platform for businesses of one. It replaces the five or six apps most solo owners juggle, and comes with an AI assistant that actually does the admin.',
  bullets: [
    'Online booking with automatic reminders, so no-shows drop',
    'Invoices your clients pay with cards, Apple Pay, Cash App Pay, bank transfer, Klarna, Affirm or Afterpay, straight into your own Stripe account',
    'Contracts and forms with e-signatures',
    'Client messaging, all in one inbox',
    'A website you can build and publish in minutes',
    'A free portal where your clients book, pay, sign and message you',
    'Ivy, the AI assistant: ask it to send an invoice, write a follow-up or build your website, and approve before anything goes out',
  ],
  closing: 'Free for 14 days, then $8.99 a week. Cancel anytime.',
  cta: 'Start your 14-day free trial',
};

// `kind`: 'revoked' | 'paused' | 'expired'
// `ctx`: the /api/me context when signed in (isOwner / isClient decide the
//        buttons); null when signed out (cancelled link opened cold).
export default function HelperGone({ kind = 'revoked', ctx = null }) {
  const copy = GONE_COPY[kind] || GONE_COPY.revoked;
  const nav = useNavigate();
  const { user, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const signedIn = !!user;

  const startTrial = async () => {
    if (!signedIn) { nav('/signup'); return; }
    // Signed in already (a revoked or paused helper): /signup would refuse
    // their existing email, so we mint their own business on this account
    // and open the same onboarding flow a fresh signup lands in.
    setBusy(true); setErr(null);
    try {
      await api.post('/helper/start-business');
      clearMeCache(); forgetLanding();
      nav('/onboarding', { replace: true });
    } catch (e) {
      setErr(e.message || 'Could not start your trial. Please try again.');
      setBusy(false);
    }
  };
  const logOut = async () => { await signOut(); nav('/signin', { replace: true }); };

  return (
    <div className="card" style={{ padding: 'clamp(20px, 4vw, 30px)', maxWidth: 560, margin: '16px auto', width: '100%' }}>
      <div style={{
        width: 44, height: 44, borderRadius: 13, marginBottom: 14,
        background: 'color-mix(in srgb, var(--warn) 14%, transparent)', color: 'var(--warn)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Clock size={20}/></div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em', margin: '0 0 6px' }}>
        {copy.heading}
      </h1>
      <div style={{ fontSize: 16, fontWeight: 550, lineHeight: 1.4 }}>{copy.line}</div>
      <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: '8px 0 0' }}>{copy.detail}</p>

      <div style={{ height: 1, background: 'var(--border)', margin: '20px 0' }}/>

      {ctx?.isOwner || ctx?.isClient ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ctx.isOwner && (
            <button className="btn btn-primary" style={{ justifyContent: 'center' }} onClick={() => { forgetLanding(); nav('/dashboard'); }}>
              Go to your business <Icons.Arrow size={14}/>
            </button>
          )}
          {ctx.isClient && (
            <button className={'btn ' + (ctx.isOwner ? 'btn-outline' : 'btn-primary')} style={{ justifyContent: 'center' }} onClick={() => { forgetLanding(); nav('/me'); }}>
              Go to your client portal <Icons.Arrow size={14}/>
            </button>
          )}
          <button className="btn btn-ghost" style={{ justifyContent: 'center' }} onClick={logOut}>Log out</button>
        </div>
      ) : (
        <>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.015em', lineHeight: 1.25 }}>
            {PITCH.heading}
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55, margin: '8px 0 0' }}>{PITCH.intro}</p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '14px 0 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {PITCH.bullets.map((b) => (
              <li key={b} style={{ display: 'flex', gap: 10, fontSize: 13.5, lineHeight: 1.5 }}>
                <span style={{ flex: 'none', marginTop: 3, width: 16, height: 16, borderRadius: 99, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icons.Check size={10} sw={2.6}/>
                </span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '14px 0 0' }}>{PITCH.closing}</p>
          {err && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 10 }}>{err}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
            <button className="btn btn-primary" disabled={busy} style={{ justifyContent: 'center' }} onClick={startTrial}>
              {busy ? 'Setting things up…' : PITCH.cta} {!busy && <Icons.Arrow size={14}/>}
            </button>
            {signedIn
              ? <button className="btn btn-ghost" style={{ justifyContent: 'center' }} onClick={logOut}>Log out</button>
              : <button className="btn btn-ghost" style={{ justifyContent: 'center' }} onClick={() => nav('/signin')}>Sign in</button>}
          </div>
        </>
      )}
    </div>
  );
}
