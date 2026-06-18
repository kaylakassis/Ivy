// Trial banner + paywall modal for the Business view.
// Billing: $39 every 28 days after a 28-day free trial.

const TRIAL_START_KEY = 'Ivy OS:trial-start';
const TRIAL_PAID_KEY  = 'Ivy OS:trial-paid';

function getTrialStart() {
  let s = localStorage.getItem(TRIAL_START_KEY);
  if (!s) {
    s = new Date().toISOString();
    localStorage.setItem(TRIAL_START_KEY, s);
  }
  return new Date(s);
}

function computeTrial(trialState) {
  // trialState (from Tweaks): 'fresh' | 'warning' | 'expired' | 'paid' | 'real'
  const now = new Date();
  if (trialState === 'paid' || localStorage.getItem(TRIAL_PAID_KEY) === '1') {
    return { paid: true, daysLeft: null, expired: false };
  }
  if (trialState === 'fresh')   return { paid: false, daysLeft: 27, expired: false };
  if (trialState === 'warning') return { paid: false, daysLeft: 3,  expired: false };
  if (trialState === 'expired') return { paid: false, daysLeft: 0,  expired: true };
  // 'real' -> compute from trial start
  const start = getTrialStart();
  const elapsed = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const left = 28 - elapsed;
  return { paid: false, daysLeft: Math.max(left, 0), expired: left <= 0 };
}

function TrialBanner({ trialState, onUpgrade }) {
  const t = computeTrial(trialState);
  if (t.paid) return null;
  const urgent = t.daysLeft <= 5 || t.expired;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '10px 32px',
      background: urgent ? 'var(--accent)' : 'var(--surface-2)',
      color: urgent ? 'var(--accent-ink)' : 'var(--fg-2)',
      borderBottom: '1px solid var(--border)',
      fontSize: 13,
    }}>
      <div style={{
        width: 22, height: 22, borderRadius: 99,
        background: urgent ? 'rgba(0,0,0,0.12)' : 'var(--accent-soft)',
        color: urgent ? 'var(--accent-ink)' : 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 700,
      }}>
        {t.expired ? '!' : t.daysLeft}
      </div>
      <div style={{ flex: 1 }}>
        {t.expired ? (
          <><b>Your free trial has ended.</b> Subscribe to $39 every 28 days to keep clients, invoices, and your schedule.</>
        ) : (
          <>
            <b>{t.daysLeft} {t.daysLeft === 1 ? 'day' : 'days'} left</b> in your free trial.
            {' '}After that, Ivy OS is <b>$39 every 28 days</b>. Cancel anytime.
          </>
        )}
      </div>
      <button className="btn"
        onClick={onUpgrade}
        style={{
          background: urgent ? 'var(--fg)' : 'var(--accent)',
          color:      urgent ? 'var(--page)' : 'var(--accent-ink)',
        }}>
        {t.expired ? 'Subscribe now' : 'Upgrade early'}
      </button>
    </div>
  );
}

function Paywall({ open, onClose, onSubscribe, expired }) {
  if (!open) return null;
  const perks = [
    'Unlimited clients, appointments, and invoices',
    'Ivy Pro - AI insights surfaced every morning',
    'Accept card payments (2.9% + 30¢, standard)',
    'Documents, e-signatures, and client portal',
    'Your public booking page on ivy.co/yourname',
    'Email + SMS reminders sent automatically',
  ];
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10, 12, 8, 0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      padding: 20, backdropFilter: 'blur(4px)',
    }} onClick={expired ? undefined : onClose}>
      <div className="card" style={{
        width: '100%', maxWidth: 720, padding: 0, overflow: 'hidden',
        display: 'grid', gridTemplateColumns: '1fr 1fr', maxHeight: '92vh',
      }} onClick={e => e.stopPropagation()}>

        {/* Left - price */}
        <div style={{
          padding: '40px 32px',
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600, opacity: 0.7 }}>
              Ivy OS · Business
            </div>
            <div style={{ marginTop: 30 }}>
              <div style={{
                fontFamily: 'var(--font-display)', fontWeight: 500,
                fontSize: 64, letterSpacing: '-0.04em', lineHeight: 1,
              }}>
                $39
              </div>
              <div style={{ fontSize: 14, marginTop: 8, opacity: 0.8 }}>
                every 28 days · cancel anytime
              </div>
            </div>
            <div style={{ marginTop: 24, fontSize: 13, lineHeight: 1.6, opacity: 0.85 }}>
              Thirteen billing cycles a year, priced so it fits a busy week - not a flat 30 that skips February.
            </div>
          </div>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 40, lineHeight: 1.5 }}>
            Payment handled by Stripe. No hidden fees. Your client data is always exportable.
          </div>
        </div>

        {/* Right - content */}
        <div style={{ padding: '40px 32px', display: 'flex', flexDirection: 'column' }}>
          <h3 style={{
            fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 22,
            letterSpacing: '-0.02em', margin: '0 0 4px',
          }}>
            {expired ? "Welcome back, let's pick up where you left off." : "Keep the momentum going."}
          </h3>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.5 }}>
            Your workspace and all data stay exactly as you left them.
          </p>

          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
            {perks.map(p => (
              <li key={p} style={{ display: 'flex', gap: 10, fontSize: 13, color: 'var(--fg-2)', alignItems: 'flex-start' }}>
                <div style={{
                  width: 18, height: 18, borderRadius: 99, background: 'var(--accent-soft)',
                  color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, marginTop: 1, fontSize: 11, fontWeight: 700,
                }}>✓</div>
                <span>{p}</span>
              </li>
            ))}
          </ul>

          <div style={{ flex: 1, minHeight: 18 }} />

          <button className="btn btn-primary" style={{
            justifyContent: 'center', padding: '12px 16px', fontSize: 14, fontWeight: 600,
          }} onClick={onSubscribe}>
            Subscribe - $39 / 28 days
          </button>
          {!expired && (
            <button className="btn btn-ghost" onClick={onClose} style={{
              justifyContent: 'center', marginTop: 8, fontSize: 13, color: 'var(--muted)',
            }}>
              Not yet, keep exploring
            </button>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 14, textAlign: 'center' }}>
            Next charge in 28 days · renews automatically · cancel in Settings
          </div>
        </div>
      </div>
    </div>
  );
}

window.TrialBanner = TrialBanner;
window.Paywall = Paywall;
window.computeTrial = computeTrial;
