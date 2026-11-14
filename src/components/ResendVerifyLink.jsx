// "Send the link again" for the email-confirmation message, used where a
// step needs a confirmed email first (connecting Stripe).
import React, { useState } from 'react';
import { api } from '../lib/api.js';

export default function ResendVerifyLink() {
  const [state, setState] = useState('idle'); // idle | sending | sent | error
  const [msg, setMsg] = useState('');
  const send = async () => {
    setState('sending');
    try {
      await api.post('/auth/resend-verification');
      setState('sent');
    } catch (e) {
      setMsg(e?.message || 'Could not send it. Please try again in a minute.');
      setState('error');
    }
  };
  if (state === 'sent') return <div role="status" style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ok)' }}>Sent. Check your inbox (and your spam folder).</div>;
  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" className="btn btn-outline" onClick={send} disabled={state === 'sending'} style={{ fontSize: 12.5, minHeight: 40 }}>
        {state === 'sending' ? 'Sending…' : 'Send the link again'}
      </button>
      {state === 'error' && <div role="alert" style={{ marginTop: 6, fontSize: 12, color: 'var(--danger)' }}>{msg}</div>}
    </div>
  );
}
