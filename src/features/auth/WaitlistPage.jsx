// Pre-launch waitlist screen. Shown by EarlyAccessGate on "/signin" and
// "/signup" (and the public "/waitlist" route) when launch_mode ===
// 'waitlist' and the visitor hasn't entered the beta bypass. The marketing
// home stays public; this only appears when a visitor clicks "Start free
// trial" / "Sign up". Split-hero: brand + headline + tagline + inline email
// capture on the left, a product visual on the right.
//
// Themed like the rest of the app: it self-wraps in `app-root dir-${dir}`
// so the design tokens (--accent, --page, --surface, --fg, --font-display…)
// resolve and the shared .btn/.input/.card primitives render correctly —
// without this wrapper the tokens are undefined and the page renders
// unstyled (no button fill, borderless input).
//
// Two actions:
//   • Join the waitlist  → POST /api/waitlist/join (honeypot + rate-limited)
//   • Beta access code    → POST /api/waitlist/verify; on success the
//     ea_pass cookie is set and we go to /signup, dropping the visitor into
//     the normal signup/app flow (onboarding etc. unchanged).
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useTweaks } from '../../lib/tweaks.js';

export default function WaitlistPage({ hasBetaPassword = false }) {
  const [tweaks] = useTweaks();
  const [email, setEmail] = useState('');
  const [hp, setHp] = useState(''); // honeypot - real users never fill this
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [err, setErr] = useState(null);

  // Beta bypass panel.
  const [showBeta, setShowBeta] = useState(false);
  const [betaPw, setBetaPw] = useState('');
  const [betaBusy, setBetaBusy] = useState(false);
  const [betaErr, setBetaErr] = useState(null);

  useEffect(() => { document.title = 'THRYVE - join the waitlist'; }, []);

  const join = async (e) => {
    e.preventDefault();
    setErr(null);
    if (!email.trim()) { setErr('Enter your email'); return; }
    setBusy(true);
    try {
      await api.post('/waitlist/join', { email: email.trim(), hp, source: 'waitlist-landing' });
      setJoined(true);
    } catch (e2) {
      setErr(e2.message || 'Something went wrong - try again');
    } finally {
      setBusy(false);
    }
  };

  const submitBeta = async (e) => {
    e.preventDefault();
    setBetaErr(null);
    if (!betaPw) { setBetaErr('Enter your access code'); return; }
    setBetaBusy(true);
    try {
      const r = await api.post('/waitlist/verify', { password: betaPw });
      // Cookie is set server-side; go to /signup so the gate re-checks
      // status, sees `bypassed: true`, and renders the normal signup flow.
      if (r.unlocked) window.location.assign('/signup');
    } catch (e2) {
      setBetaErr(e2.message || 'Wrong code');
      setBetaBusy(false);
    }
  };

  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', background: 'var(--page)', color: 'var(--fg)' }}>
      <div style={{
        maxWidth: 1180, margin: '0 auto', padding: '28px clamp(20px, 5vw, 64px)',
        display: 'flex', flexDirection: 'column', minHeight: '100vh',
      }}>
        {/* Brand */}
        <Link to="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
          <div style={{
            width: 34, height: 34, borderRadius: 'var(--radius-sm, 9px)',
            background: 'var(--accent)', color: 'var(--accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icons.Logo size={21} color="currentColor"/>
          </div>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 20, letterSpacing: '-0.015em' }}>
            THRYVE
          </span>
        </Link>

        {/* Split hero */}
        <div style={{
          flex: 1, display: 'grid', gap: 'clamp(32px, 6vw, 72px)',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          alignItems: 'center', padding: '40px 0',
        }}>
          {/* Left: copy + capture */}
          <div style={{ maxWidth: 520 }}>
            <span style={{
              display: 'inline-block', fontSize: 12.5, fontWeight: 600, letterSpacing: '0.04em',
              textTransform: 'uppercase', color: 'var(--accent)', background: 'var(--accent-soft)',
              padding: '5px 11px', borderRadius: 999, marginBottom: 20,
            }}>
              Private beta · launching soon
            </span>

            <h1 className="page-title" style={{
              fontFamily: 'var(--font-display)', fontSize: 'clamp(38px, 6vw, 60px)',
              lineHeight: 1.04, letterSpacing: '-0.02em', margin: '0 0 20px', fontWeight: 600,
            }}>
              The all-in-one home for your business.
            </h1>

            <p style={{ margin: '0 0 28px', color: 'var(--muted)', fontSize: 17, lineHeight: 1.55 }}>
              Booking, payments, clients, and an AI copilot — in one place.
              Join the waitlist and lock in <b style={{ color: 'var(--fg)' }}>20% off your first 12 months</b> 👀
            </p>

            {joined ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                padding: '16px 18px', borderRadius: 'var(--radius, 12px)', fontSize: 15, fontWeight: 500,
              }}>
                <Icons.Check size={18} sw={2}/>
                You're on the list — we'll email you the moment we launch 🎉
              </div>
            ) : (
              <form onSubmit={join} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {/* Honeypot - visually hidden, off the tab order. */}
                <input
                  type="text" name="hp" value={hp} onChange={(e) => setHp(e.target.value)}
                  tabIndex={-1} autoComplete="off" aria-hidden="true"
                  style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
                />
                <input
                  type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email" autoComplete="email" autoFocus
                  className="input"
                  style={{ flex: '1 1 240px', padding: '13px 15px', fontSize: 15 }}
                />
                <button
                  type="submit" className="btn btn-primary" disabled={busy}
                  style={{ padding: '13px 22px', fontSize: 15, whiteSpace: 'nowrap' }}
                >
                  {busy ? 'Joining…' : 'Join waitlist'}
                </button>
              </form>
            )}
            {err && <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>{err}</div>}

            {/* Beta access bypass (only shown when a password is configured). */}
            {hasBetaPassword && !joined && (
              <div style={{ marginTop: 22 }}>
                {!showBeta ? (
                  <button
                    type="button" onClick={() => setShowBeta(true)}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: 'var(--muted)', fontSize: 13, textDecoration: 'underline',
                    }}
                  >
                    Have a beta access code?
                  </button>
                ) : (
                  <form onSubmit={submitBeta} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      type="password" value={betaPw} onChange={(e) => setBetaPw(e.target.value)}
                      placeholder="Beta access code" autoComplete="off" autoFocus
                      className="input"
                      style={{ flex: '1 1 200px', padding: '11px 13px', fontSize: 14 }}
                    />
                    <button type="submit" className="btn btn-outline" disabled={betaBusy} style={{ padding: '11px 16px', fontSize: 14 }}>
                      {betaBusy ? 'Checking…' : 'Enter'}
                    </button>
                    {betaErr && <div style={{ color: 'var(--danger)', fontSize: 12.5, flexBasis: '100%' }}>{betaErr}</div>}
                  </form>
                )}
              </div>
            )}
          </div>

          {/* Right: product visual (CSS mock so it needs no image asset). */}
          <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'center' }}>
            <div style={{
              width: '100%', maxWidth: 420, aspectRatio: '4 / 5', borderRadius: 'var(--radius-lg, 22px)',
              background: 'linear-gradient(160deg, var(--accent-soft), var(--surface))',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 28,
            }}>
              <div className="card" style={{
                width: '100%', borderRadius: 'var(--radius, 14px)', background: 'var(--surface)',
                border: '1px solid var(--border)', overflow: 'hidden', padding: 0,
                boxShadow: 'var(--shadow-sm)',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent)', color: 'var(--accent-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icons.Spark size={14} sw={2}/>
                  </div>
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}>Ivy</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>Today</span>
                </div>
                {[
                  { c: 'Calendar', t: '3 bookings today · next at 2:00pm' },
                  { c: 'Dollar',   t: 'Invoice #1042 paid · $180' },
                  { c: 'Chat',     t: '“Reply to Maya about Friday?”' },
                  { c: 'Check',    t: 'Follow-up sent to 4 clients' },
                ].map((row, i) => {
                  const Ico = Icons[row.c] || Icons.Check;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                      <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Ico size={15} sw={1.8}/>
                      </div>
                      <span style={{ fontSize: 13, color: 'var(--fg)' }}>{row.t}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <footer style={{ paddingTop: 18, color: 'var(--muted)', fontSize: 12.5 }}>
          © {new Date().getFullYear()} THRYVE · <Link to="/privacy" style={{ color: 'inherit' }}>Privacy</Link> · <Link to="/terms" style={{ color: 'inherit' }}>Terms</Link>
        </footer>
      </div>
    </div>
  );
}
