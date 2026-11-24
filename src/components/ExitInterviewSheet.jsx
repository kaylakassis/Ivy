// Asked once, inside the app, after an owner turns renewal off or their
// paid plan ends: "what made you cancel?". Cancelling itself happens on
// Stripe's page or in Apple's settings, so this is the first moment Ivy can
// ask. "Not now" is remembered, so it is not asked again for this
// cancellation (the cancellation email carries the same question as a link).
// The server decides who is due (GET /api/me → exitInterview.due).
import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { Icons } from './Icons.jsx';
import ExitInterviewForm from './ExitInterviewForm.jsx';

export default function ExitInterviewSheet({ due, onDone }) {
  const [answer, setAnswer] = useState({ reasons: [], comment: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [thanks, setThanks] = useState(false);
  const [gone, setGone] = useState(false);
  if (!due || gone) return null;

  const close = () => { setGone(true); onDone?.(); };
  const send = async (skipped) => {
    setBusy(true); setErr(null);
    try {
      await api.post('/me/exit-interview', skipped ? { skipped: true } : { reasons: answer.reasons, comment: answer.comment });
      if (skipped) close(); else setThanks(true);
    } catch (e) {
      // "Not now" must always get them out, even if saving it failed.
      if (skipped) close(); else setErr(e.message || 'Could not send that. Please try again.');
    } finally { setBusy(false); }
  };
  const canSend = answer.reasons.length > 0 || answer.comment.trim().length > 0;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="exit-h" data-exit-interview style={{
      position: 'fixed', inset: 0, zIndex: 260, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', padding: 22 }}>
        {thanks ? (
          <div style={{ textAlign: 'center', padding: '10px 0' }}>
            <div style={{ display: 'inline-flex', width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              <Icons.Check size={20} sw={2.4}/>
            </div>
            <h3 style={{ margin: '12px 0 6px', fontSize: 18, fontWeight: 700 }}>Thank you</h3>
            <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              That goes straight to the people building Ivy, and it helps the next person running a business on their own.
            </p>
            <button type="button" className="btn btn-primary" onClick={close}>Close</button>
          </div>
        ) : (
          <>
            <h3 id="exit-h" style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Before you go, what made you cancel?</h3>
            <p style={{ margin: '6px 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              Pick anything that fits. It takes a few seconds and it shapes what gets built next.
            </p>
            <ExitInterviewForm reasons={answer.reasons} comment={answer.comment} onChange={setAnswer}/>
            {err && <div role="alert" style={{ marginTop: 10, fontSize: 13, color: 'var(--danger)' }}>{err}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => send(true)} style={{ color: 'var(--muted)' }}>Not now</button>
              <div style={{ flex: 1 }}/>
              <button type="button" className="btn btn-primary" disabled={busy || !canSend} onClick={() => send(false)}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
