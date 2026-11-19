// Native-only launch screen: what a logged-out user sees when the app
// opens. The mark draws itself, the name and line rise, the buttons
// follow; an ambient glow drifts behind. About 1.5s to fully settled,
// any tap skips to the end, and reduced-motion users get the settled
// frame immediately. Signed-in users never see this (RootRouter).
import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import LegalLink from '../../components/LegalLink.jsx';

const CSS = `
@keyframes ivy-w-draw { to { stroke-dashoffset: 0 } }
@keyframes ivy-w-rise { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
@keyframes ivy-w-pop  { 0% { transform: scale(.55); opacity: 0 } 65% { transform: scale(1.06); opacity: 1 } 100% { transform: scale(1) } }
@keyframes ivy-w-glow { 0%,100% { transform: translate(-50%,-50%) scale(1) } 50% { transform: translate(-44%,-56%) scale(1.18) } }
.ivy-w { position: fixed; inset: 0; background: #042b25; color: #F3F3EE; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: calc(env(safe-area-inset-top, 0px) + 24px) 28px calc(env(safe-area-inset-bottom, 0px) + 28px);
  font-family: var(--font-sans, Inter, -apple-system, sans-serif); -webkit-tap-highlight-color: transparent; }
.ivy-w .glow { position: absolute; left: 50%; top: 40%; width: 640px; height: 640px; border-radius: 50%; pointer-events: none; will-change: transform;
  background: radial-gradient(circle, rgba(236,240,241,.14) 0%, rgba(236,240,241,.05) 32%, transparent 62%);
  animation: ivy-w-glow 9s ease-in-out infinite; }
.ivy-w .mark { position: relative; width: 132px; height: 132px; border-radius: 30px; overflow: hidden; background: #042b25;
  box-shadow: 0 24px 60px -20px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08); animation: ivy-w-pop .7s cubic-bezier(.2,.8,.2,1) both; }
.ivy-w .mark img { width: 100%; height: 100%; display: block; }
.ivy-w h1 { font-family: var(--font-display); font-size: 46px; font-weight: 600;
  letter-spacing: -.03em; line-height: 1; margin: 32px 0 0; animation: ivy-w-rise .6s ease-out .9s both; }
.ivy-w p { margin: 12px 0 0; font-size: 16px; line-height: 1.5; color: #C9CAC3; text-align: center; max-width: 28ch;
  animation: ivy-w-rise .6s ease-out 1.05s both; }
.ivy-w .actions { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 360px; margin-top: 44px;
  animation: ivy-w-rise .6s ease-out 1.2s both; }
.ivy-w .primary { background: #ECF0F1; color: #012B24; border: 0; border-radius: 14px; padding: 16px; font: inherit; font-size: 17px; font-weight: 700; }
.ivy-w .secondary { background: transparent; color: #F3F3EE; border: 1.5px solid rgba(255,255,255,.28); border-radius: 14px; padding: 15px; font: inherit; font-size: 16px; font-weight: 600; }
/* The two ways to create an account. Each says who it is for in its own
   words, so a client never ends up with a business account by guessing. */
.ivy-w .new { margin: 10px 0 0; font-size: 13px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #9BB0A9; text-align: center; }
.ivy-w .choice { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; width: 100%;
  background: rgba(255,255,255,.04); color: #F3F3EE; border: 1.5px solid rgba(255,255,255,.28); border-radius: 14px; padding: 13px 16px; font: inherit; }
.ivy-w .choice b { font-size: 16px; font-weight: 650; }
.ivy-w .choice span { font-size: 13.5px; line-height: 1.35; color: #C9CAC3; }
@media (max-height: 760px) {
  .ivy-w .mark { width: 96px; height: 96px; border-radius: 22px; }
  .ivy-w h1 { font-size: 38px; margin-top: 22px; }
  .ivy-w .actions { margin-top: 26px; gap: 10px; }
}
@media (max-height: 620px) {
  .ivy-w .mark { width: 64px; height: 64px; border-radius: 16px; }
  .ivy-w h1 { font-size: 30px; margin-top: 14px; }
  .ivy-w p { font-size: 14.5px; margin-top: 8px; }
  .ivy-w .actions { margin-top: 18px; }
  .ivy-w .legal { position: static; margin-top: 14px; }
}
.ivy-w .legal { position: absolute; bottom: calc(env(safe-area-inset-bottom, 0px) + 16px); font-size: 12px; color: #8A8D85;
  display: flex; gap: 16px; animation: ivy-w-rise .6s ease-out 1.35s both; }
.ivy-w .legal a { color: inherit; text-decoration: none }
.ivy-w.settled .mark, .ivy-w.settled h1, .ivy-w.settled p, .ivy-w.settled .actions, .ivy-w.settled .legal { animation: none; opacity: 1; transform: none }
@media (prefers-reduced-motion: reduce) {
  .ivy-w .glow { animation: none }
  .ivy-w .mark, .ivy-w h1, .ivy-w p, .ivy-w .actions, .ivy-w .legal { animation: none; opacity: 1; transform: none }
  }
`;

function signedIn() {
  try { return localStorage.getItem('ivy_signed_in') === '1'; } catch { return false; }
}

export default function WelcomePage() {
  const navigate = useNavigate();
  const [settled, setSettled] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSettled(true), 1900); return () => clearTimeout(t); }, []);
  if (signedIn()) return <Navigate to="/" replace/>;
  return (
    <div className={'ivy-w' + (settled ? ' settled' : '')} onPointerDown={() => setSettled(true)}>
      <style>{CSS}</style>
      <div className="glow" aria-hidden="true"/>
      <div className="mark" aria-hidden="true">
        <img src="/icon-512.png" alt="" draggable="false"/>
      </div>
      <h1>Ivy</h1>
      <p>Bookings, invoices, clients and an assistant that does the admin. One app.</p>
      <div className="actions">
        <button type="button" className="primary" onClick={() => navigate('/signin')}>Sign in</button>
        <div className="new" id="ivy-w-new">New to Ivy? Create an account</div>
        <button type="button" className="choice" aria-describedby="ivy-w-new" onClick={() => navigate('/signup')}>
          <b>I run a business</b>
          <span>Bookings, invoices and clients.</span>
        </button>
        <button type="button" className="choice" aria-describedby="ivy-w-new" onClick={() => navigate('/signup?mode=client')}>
          <b>I&apos;m a client</b>
          <span>A business I use asked me to join. Free.</span>
        </button>
      </div>
      <div className="legal">
        <LegalLink to="/privacy">Privacy</LegalLink>
        <LegalLink to="/terms">Terms</LegalLink>
      </div>
    </div>
  );
}
