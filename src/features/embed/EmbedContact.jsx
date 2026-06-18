// /embed/contact/:slug - lean lead-capture form embedded on a host
// site via the script in /embed.js. Posts to the existing public
// contact endpoint (no new API surface) and shows a "thanks, we got
// it" confirmation in place when submitted.
//
// Visual chrome is intentionally minimal: transparent background, no
// page header, tight padding. The host site's container styles control
// width + outer margin.
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useEmbedResize } from '../../lib/embedResize.js';

export default function EmbedContact() {
  const { slug } = useParams();
  useEmbedResize(slug);

  const [name, setName]       = useState('');
  const [email, setEmail]     = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState(null);
  const [done, setDone]       = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    if (!name.trim()) { setErr('Please share your name.'); return; }
    if (!email.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setErr('A valid email is required.'); return;
    }
    if (!message.trim()) { setErr('Please write a message.'); return; }
    setBusy(true);
    try {
      // Direct fetch (no api.js helper - that prefixes /api and includes
      // session-auth cookies we don't want flying around on a 3rd-party
      // site). Same-origin since this iframe is served from our domain.
      const r = await fetch('/api/calendar/public/contact?slug=' + encodeURIComponent(slug || ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Something went wrong. Please try again.');
      }
      setDone(true);
    } catch (e2) {
      setErr(e2.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      padding: 18, background: 'transparent',
      fontFamily: 'var(--font-sans), system-ui, sans-serif',
      color: 'var(--fg, #2A2924)',
    }}>
      {done ? (
        <div style={{
          padding: 24, borderRadius: 12,
          background: 'var(--surface, #fff)', border: '1px solid var(--border, #E6E1D7)',
          textAlign: 'center',
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 999,
            background: 'var(--accent-soft, #F2EDE2)', color: 'var(--accent, #8E826A)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, fontWeight: 600, marginBottom: 12,
          }}>✓</div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Got it.</h2>
          <p style={{ margin: '8px 0 0', fontSize: 13.5, color: 'var(--muted, #807C73)', lineHeight: 1.5 }}>
            Thanks {name.split(/\s+/)[0]} - we'll get back to you shortly at <strong>{email}</strong>.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Your name" autoFocus disabled={busy}/>
          </Field>
          <Field>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" disabled={busy}/>
          </Field>
          <Field>
            <Label>Message</Label>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder="What would you like to know?"
              disabled={busy}
              rows={4}
              style={{
                padding: '10px 12px', borderRadius: 8, fontSize: 14,
                border: '1px solid var(--border, #E6E1D7)',
                background: 'var(--surface, #fff)', color: 'inherit',
                resize: 'vertical', minHeight: 96, width: '100%',
                fontFamily: 'inherit', outline: 'none',
              }}/>
          </Field>
          {err && (
            <div style={{ fontSize: 12.5, color: 'var(--danger, #9B2C2C)', padding: '4px 2px' }}>
              {err}
            </div>
          )}
          <button type="submit" disabled={busy}
            style={{
              padding: '11px 16px', borderRadius: 8, fontSize: 14, fontWeight: 600,
              background: 'var(--accent, #8E826A)', color: 'var(--accent-ink, #fff)',
              border: 0, cursor: busy ? 'wait' : 'pointer',
              transition: 'opacity 0.12s', opacity: busy ? 0.65 : 1,
            }}>
            {busy ? 'Sending…' : 'Send message'}
          </button>
        </form>
      )}
    </div>
  );
}

function Field({ children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>;
}
function Label({ children }) {
  return (
    <label style={{
      fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em',
      textTransform: 'uppercase', color: 'var(--muted, #807C73)',
    }}>{children}</label>
  );
}
function Input(props) {
  return (
    <input {...props}
      style={{
        padding: '10px 12px', borderRadius: 8, fontSize: 14,
        border: '1px solid var(--border, #E6E1D7)',
        background: 'var(--surface, #fff)', color: 'inherit',
        outline: 'none', width: '100%', fontFamily: 'inherit',
        ...(props.style || {}),
      }}
    />
  );
}
