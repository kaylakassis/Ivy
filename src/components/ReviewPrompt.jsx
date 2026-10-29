// "Loving Ivy?" card. Opened by the weekly check-in push, which deep-links
// to any page with ?ivy_feedback=1. Three steps, and every one of them can
// be closed with the X, the secondary button, a tap outside, or Escape:
//
//   ask  → "Do you love Ivy?"   Yes, I love it / Not really
//   yes  → "Leave a 5-star review"  opens Apple's own rating window, with an
//          App Store link as a fallback (Apple may decline to show its
//          window, at most 3 times a year)
//   no   → "We can help"  Talk to support, plus a quiet "or leave a review"
//          link so nobody is kept from the App Store (no review gating)
//
// Answers are recorded server-side (api/_lib/reviewPrompt.js) to set when
// we ask next. Nothing here blocks the app underneath.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icons } from './Icons.jsx';
import { api } from '../lib/api.js';
import { isNative } from '../lib/platform.js';
import { useExitAnimation } from './motion/useExitAnimation.js';

export const APP_STORE_REVIEW_URL = 'https://apps.apple.com/app/id6808542331?action=write-review';

const record = (body) => api.post('/me/review-prompt', body).catch(() => {});

async function openAppleRating() {
  // Apple's built-in rating window (SKStoreReviewController). Falls back to
  // the App Store's write-a-review page off-device or if the plugin is missing.
  if (isNative()) {
    try {
      const { InAppReview } = await import('@capacitor-community/in-app-review');
      await InAppReview.requestReview();
      return 'native';
    } catch { /* fall through to the link */ }
  }
  openAppStore();
  return 'link';
}
function openAppStore() {
  if (isNative()) window.location.href = APP_STORE_REVIEW_URL;
  else window.open(APP_STORE_REVIEW_URL, '_blank', 'noopener');
}

export default function ReviewPrompt() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [step, setStep] = useState(null); // null | 'ask' | 'yes' | 'thanks' | 'no'
  const exit = useExitAnimation(step != null);

  // Open on ?ivy_feedback=1, then strip it so a refresh doesn't reopen.
  useEffect(() => {
    if (params.get('ivy_feedback') !== '1') return;
    setStep('ask');
    const next = new URLSearchParams(params);
    next.delete('ivy_feedback');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const close = useCallback((answered) => {
    // Closing the first question without choosing counts as "not now".
    if (!answered && step === 'ask') record({ answer: 'dismissed' });
    else record({ action: 'closed' });
    setStep(null);
  }, [step]);

  useEffect(() => {
    if (step == null) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, close]);

  if (!exit.mounted) return null;

  const yes = () => { record({ answer: 'yes' }); setStep('yes'); };
  const no = () => { record({ answer: 'no' }); setStep('no'); };
  const leaveReview = async () => {
    record({ action: 'review_requested' });
    await openAppleRating();
    setStep('thanks');
  };
  const appStoreFallback = () => { record({ action: 'app_store_opened' }); openAppStore(); };
  const support = () => { record({ action: 'support_opened' }); setStep(null); navigate('/account?support=1'); };

  const content = {
    ask: {
      icon: <Icons.Heart size={24} sw={1.8}/>,
      title: 'Do you love Ivy?',
      body: 'Be honest. Your answer helps us make Ivy better for you.',
      primary: ['Yes, I love it', yes],
      secondary: ['Not really', no],
    },
    yes: {
      icon: <Icons.Star size={24} sw={1.8}/>,
      title: 'That made our day.',
      body: 'Would you leave Ivy a 5-star review on the App Store? It takes ten seconds and helps other solo business owners find us.',
      primary: ['Leave a 5-star review', leaveReview],
      secondary: ['Maybe later', () => close(true)],
    },
    thanks: {
      icon: <Icons.Heart size={24} sw={1.8}/>,
      title: 'Thank you!',
      body: 'Every review helps another business of one find Ivy.',
      primary: ['Done', () => close(true)],
      link: ["Didn't see the rating window? Open the App Store", appStoreFallback],
    },
    no: {
      icon: <Icons.Heart size={24} sw={1.8}/>,
      title: "We're sorry Ivy isn't there yet.",
      body: "If something isn't working the way it should, our team can help. Tell us what's going on and we'll get back to you.",
      primary: ['Talk to support', support],
      secondary: ['No thanks', () => close(true)],
      link: ['Or leave a review on the App Store', appStoreFallback],
    },
  }[step || 'ask'];

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="review-prompt-title"
      className={`motion-backdrop${exit.closing ? ' is-closing' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) close(false); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 900,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}>
      <div className="motion-sheet" style={{
        position: 'relative', width: '100%', maxWidth: 520,
        background: 'var(--surface)', color: 'var(--fg)',
        borderRadius: '20px 20px 0 0',
        padding: '22px 22px calc(env(safe-area-inset-bottom, 0px) + 22px)',
        boxShadow: '0 -8px 30px rgba(0,0,0,0.25)',
      }}>
        <button type="button" aria-label="Close" onClick={() => close(false)} className="btn btn-ghost"
          style={{ position: 'absolute', top: 12, right: 12, width: 36, height: 36, padding: 0, borderRadius: 18,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
          <Icons.X size={18} sw={2}/>
        </button>
        <div style={{
          width: 48, height: 48, borderRadius: 14, marginBottom: 14,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{content.icon}</div>
        <div id="review-prompt-title" style={{ fontSize: 19, fontWeight: 700, marginBottom: 6, paddingRight: 36 }}>{content.title}</div>
        <div style={{ fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.45, marginBottom: 18 }}>{content.body}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button type="button" className="btn btn-primary" onClick={content.primary[1]}
            style={{ width: '100%', padding: '13px 16px', fontSize: 15.5 }}>
            {content.primary[0]}
          </button>
          {content.secondary && (
            <button type="button" className="btn btn-outline" onClick={content.secondary[1]}
              style={{ width: '100%', padding: '12px 16px', fontSize: 15 }}>
              {content.secondary[0]}
            </button>
          )}
          {content.link && (
            <button type="button" onClick={content.link[1]}
              style={{ background: 'none', border: 0, padding: '6px 0 0', color: 'var(--muted)',
                fontSize: 13, textDecoration: 'underline', cursor: 'pointer' }}>
              {content.link[0]}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
