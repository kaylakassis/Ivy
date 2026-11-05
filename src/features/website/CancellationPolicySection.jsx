// Website "Cancellation policy" section + the optional footer link.
//
// The text is never stored in the section: it always shows the owner's
// latest saved policy (Finance > Services > Cancellation policy). On the
// public site it comes with the site payload (SiteLinkContext); in the
// editor it is fetched by website handle. Plain text, rendered as React
// text (escaped), line breaks kept with pre-wrap.
import React, { useContext, useEffect, useState } from 'react';
import { SiteLinkContext } from './SectionRenderer.jsx';

const container = {
  padding: 'clamp(48px, 9vw, 80px) clamp(20px, 6vw, 64px)',
  maxWidth: 780,
  margin: '0 auto',
};

function usePolicy(handle) {
  const ctx = useContext(SiteLinkContext);
  const fromSite = ctx && Object.prototype.hasOwnProperty.call(ctx, 'cancellationPolicy') ? ctx.cancellationPolicy : undefined;
  const [fetched, setFetched] = useState(undefined);
  useEffect(() => {
    if (fromSite !== undefined || !handle) return undefined;
    let alive = true;
    fetch(`/api/cancellation-policy/public?site=${encodeURIComponent(handle)}`, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setFetched(j?.policy || null); })
      .catch(() => { if (alive) setFetched(null); });
    return () => { alive = false; };
  }, [fromSite, handle]);
  return fromSite !== undefined ? fromSite : fetched;
}

export default function CancellationPolicySection({ data = {}, handle, editable = false }) {
  const policy = usePolicy(handle);
  const headline = data.headline || 'Cancellation policy';
  if (!policy?.text) {
    // Public visitors see nothing until the owner writes a policy; the
    // editor shows where to write it.
    if (!editable) return null;
    return (
      <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
        <div style={{ ...container, textAlign: 'center', color: 'var(--site-muted)', fontSize: 14 }}>
          {policy === undefined ? 'Loading your cancellation policy…'
            : 'Your cancellation policy shows here. Write it in Finance, Services, Cancellation policy.'}
        </div>
      </section>
    );
  }
  return (
    <section style={{ background: 'var(--site-bg)', color: 'var(--site-fg)' }}>
      <div style={container}>
        <h2 style={{
          margin: 0, fontFamily: 'var(--site-font-display)', fontSize: 'clamp(26px, 3.2vw, 36px)',
          fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.15,
        }}>{headline}</h2>
        {data.sub && <p style={{ margin: '10px 0 0', color: 'var(--site-fg-2)', fontSize: 15, lineHeight: 1.55 }}>{data.sub}</p>}
        <div style={{
          marginTop: 22, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 15, lineHeight: 1.65,
          color: 'var(--site-fg-2)', padding: '18px 20px', borderRadius: 'var(--site-radius)',
          border: '1px solid var(--site-border)', background: 'var(--site-surface)',
        }}>{policy.text}</div>
      </div>
    </section>
  );
}

// "Cancellation policy" link for the footer, shown only when the owner
// turned on "Show a link in my website footer".
export function PolicyFooterLink() {
  const ctx = useContext(SiteLinkContext);
  const pol = ctx?.cancellationPolicy;
  if (!pol?.showInSiteFooter || !pol.policyUrl || !/^\/book\/[a-z0-9-]+\/policy$/.test(pol.policyUrl)) return null;
  return (
    <a href={pol.policyUrl} style={{ fontSize: 12, color: 'var(--site-muted)', textDecoration: 'underline' }}>
      Cancellation policy
    </a>
  );
}

// Inspector panel for the section: only the heading words are editable
// here; the policy itself lives with the booking settings.
export function CancellationPolicyEditor({ data = {}, update }) {
  const input = {
    width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
    border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--fg)',
  };
  return (
    <>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
        Headline
        <input value={data.headline || ''} maxLength={120} onChange={(e) => update({ headline: e.target.value })} style={input}/>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
        Short intro (optional)
        <textarea rows={2} value={data.sub || ''} maxLength={300} onChange={(e) => update({ sub: e.target.value })}
          style={{ ...input, resize: 'vertical', lineHeight: 1.5 }}/>
      </label>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        The policy text updates on its own whenever you save a new version in Finance, Services, Cancellation policy.
      </div>
    </>
  );
}
