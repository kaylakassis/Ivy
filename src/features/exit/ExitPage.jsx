// /exit/:token - the page the "tell us why" link in a cancellation email
// opens. No sign-in: the link itself says which business is answering
// (api/exit-interview.js). It can only add that business's answer.
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import ExitInterviewForm, { EXIT_REASONS } from '../../components/ExitInterviewForm.jsx';

export default function ExitPage() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [state, setState] = useState('loading'); // loading | form | thanks | closed | invalid
  const [answer, setAnswer] = useState({ reasons: [], comment: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const q = `/exit-interview?token=${encodeURIComponent(token || '')}`;

  useEffect(() => {
    let live = true;
    api.get(q)
      .then((r) => { if (!live) return; setInfo(r); setState(r.answered ? 'thanks' : r.open ? 'form' : 'closed'); })
      .catch(() => { if (live) setState('invalid'); });
    return () => { live = false; };
  }, [q]);

  const send = async () => {
    setBusy(true); setErr(null);
    try { await api.post(q, { reasons: answer.reasons, comment: answer.comment }); setState('thanks'); }
    catch (e) { setErr(e.message || 'Could not send that. Please try again.'); }
    finally { setBusy(false); }
  };
  const canSend = answer.reasons.length > 0 || answer.comment.trim().length > 0;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--page)', color: 'var(--fg)', display: 'flex', justifyContent: 'center', padding: '40px 16px' }}>
      <main className="card" data-exit-page={state} style={{ width: '100%', maxWidth: 520, padding: 24, alignSelf: 'flex-start' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, marginBottom: 14 }}>Ivy</div>
        {state === 'loading' && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
        {state === 'invalid' && (
          <>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>This link is not valid any more</h1>
            <p style={{ fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5 }}>It may have expired. You can always reply to any email from Ivy and it will be read.</p>
          </>
        )}
        {state === 'closed' && (
          <>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Good news: there is nothing to answer</h1>
            <p style={{ fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5 }}>Your plan is active, so this question no longer applies. Thank you.</p>
          </>
        )}
        {state === 'thanks' && (
          <>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Thank you</h1>
            <p style={{ fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              Your answer goes straight to the people building Ivy, and it helps the next person running a business on their own.
            </p>
          </>
        )}
        {state === 'form' && (
          <>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>What made you cancel?</h1>
            <p style={{ margin: '6px 0 14px', fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              {info?.business ? `For ${info.business}. ` : ''}Pick anything that fits. It takes a few seconds and it shapes what gets built next.
            </p>
            <ExitInterviewForm reasons={answer.reasons} comment={answer.comment} onChange={setAnswer}
              options={Array.isArray(info?.reasons) && info.reasons.length ? info.reasons : EXIT_REASONS}/>
            {err && <div role="alert" style={{ marginTop: 10, fontSize: 13, color: 'var(--danger)' }}>{err}</div>}
            <button type="button" className="btn btn-primary" disabled={busy || !canSend} onClick={send} style={{ marginTop: 16 }}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </>
        )}
      </main>
    </div>
  );
}
