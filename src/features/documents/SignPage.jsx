// /sign/:token  (public, no login required)
// Renders the sent document, lets the recipient fill each field, and submits.
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import SignaturePad from './SignaturePad.jsx';

export default function SignPage() {
  const { token } = useParams();
  const [tweaks] = useTweaks();
  const [doc, setDoc]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const [values, setValues]   = useState({}); // fieldId → string
  const [signerInfo, setSignerInfo] = useState(null); // { position, total, name, email }
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone]       = useState(false);
  const [nextSignerName, setNextSignerName] = useState(null);
  const [submitErr, setSubmitErr] = useState(null);
  // Decline flow state.
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declining, setDeclining] = useState(false);
  const [declined, setDeclined]   = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/sign/' + encodeURIComponent(token), { credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status });
        }
        return res.json();
      })
      .then((r) => {
        if (!live) return;
        setDoc(r.document);
        if (r.signer) setSignerInfo(r.signer);
        // Pre-fill date fields with today.
        const todayISO = new Date().toISOString().slice(0, 10);
        const initial = {};
        for (const f of (r.document.fields || [])) {
          if (f.type === 'date' && !f.value) initial[f.id] = todayISO;
        }
        setValues(initial);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [token]);

  const setVal = (id, v) => setValues((m) => ({ ...m, [id]: v }));

  const submit = async () => {
    if (!doc) return;
    // Validate required fields
    for (const f of doc.fields || []) {
      const required = f.required !== false;
      if (required && !((values[f.id] ?? f.value ?? '').toString().trim())) {
        setSubmitErr(`Please fill in "${f.label || f.type}"`);
        return;
      }
    }
    setSubmitting(true); setSubmitErr(null);
    try {
      const res = await fetch('/api/sign/' + encodeURIComponent(token), {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: (doc.fields || []).map((f) => ({
            id: f.id, type: f.type,
            value: (values[f.id] ?? f.value ?? '').toString(),
          })),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const j = await res.json().catch(() => ({}));
      // Multi-signer: server tells us who's next so we can show the
      // honest "you're done — passing it on to X" message instead of
      // pretending the whole doc is finalized.
      if (j.nextSigner?.name) setNextSignerName(j.nextSigner.name);
      setDone(true);
    } catch (e) {
      setSubmitErr(e.message || 'Could not submit');
    } finally {
      setSubmitting(false);
    }
  };

  const decline = async () => {
    setDeclining(true); setSubmitErr(null);
    try {
      const res = await fetch('/api/sign/' + encodeURIComponent(token), {
        method: 'DELETE',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: declineReason.trim() || null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setDeclined(true);
    } catch (e) {
      setSubmitErr(e.message || 'Could not record decline');
    } finally {
      setDeclining(false);
    }
  };

  if (loading) {
    return <PageWrap tweaks={tweaks}><div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div></PageWrap>;
  }

  if (error) {
    return (
      <PageWrap tweaks={tweaks}>
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Doc"
            title="This signing link isn't active"
            hint={error.message || 'It may have expired, been voided, or already been signed.'}/>
        </div>
      </PageWrap>
    );
  }

  if (declined) {
    return (
      <PageWrap tweaks={tweaks}>
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 99,
            background: 'var(--surface-2)', color: 'var(--fg-2)',
            border: '1px solid var(--border-strong)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
          }}><Icons.X size={26} sw={2}/></div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 26 }}>Recorded.</h1>
          <p style={{ color: 'var(--muted)', marginTop: 10, fontSize: 14, lineHeight: 1.55, maxWidth: 460, marginInline: 'auto' }}>
            We've let the sender know that you declined to sign{' '}
            <b style={{ color: 'var(--fg-2)' }}>{doc.name}</b>. They'll
            follow up if they want to revise and re-send.
          </p>
        </div>
      </PageWrap>
    );
  }

  if (done) {
    const handedOff = !!nextSignerName;
    return (
      <PageWrap tweaks={tweaks}>
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 99, background: 'var(--ok)', color: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
          }}><Icons.Check size={28} sw={2.4}/></div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 28 }}>You're signed.</h1>
          <p style={{ color: 'var(--muted)', marginTop: 10, fontSize: 14, lineHeight: 1.55, maxWidth: 460, marginInline: 'auto' }}>
            {handedOff ? (
              <>Thanks — your part of <b style={{ color: 'var(--fg-2)' }}>{doc.name}</b> is in.
              We've passed it to <b style={{ color: 'var(--fg-2)' }}>{nextSignerName}</b> to sign next.</>
            ) : (
              <>Thanks — <b style={{ color: 'var(--fg-2)' }}>{doc.name}</b> is complete and the sender has been notified.</>
            )}
          </p>
        </div>
      </PageWrap>
    );
  }

  return (
    <PageWrap tweaks={tweaks}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10, background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Doc size={18}/></div>
        <div>
          <div className="metric-label">Action needed</div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 22 }}>{doc.name}</h1>
        </div>
      </div>

      {/* Multi-signer position banner — only shows when we have signer
          context, which only happens for documents sent through the
          new multi-signer flow. */}
      {signerInfo && signerInfo.total > 1 && (
        <div style={{
          padding: '10px 14px', borderRadius: 10, marginBottom: 18,
          background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--surface))',
          border: '1px solid var(--accent)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5,
        }}>
          <Icons.Users size={14} sw={1.7} stroke="var(--accent)"/>
          <span style={{ color: 'var(--fg-2)' }}>
            You're signer <strong style={{ color: 'var(--fg)' }}>{signerInfo.position}</strong>{' '}
            of <strong style={{ color: 'var(--fg)' }}>{signerInfo.total}</strong>.
            {signerInfo.position < signerInfo.total
              ? ' The next signer will get their link after you finish.'
              : " You're the last signer — the document finalizes when you submit."}
          </span>
        </div>
      )}

      <div className="card" style={{ padding: 32, marginBottom: 18 }}>
        <div
          style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--fg)', whiteSpace: 'pre-wrap' }}
          dangerouslySetInnerHTML={{ __html: sanitize(doc.contentHtml || '') }}
        />
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div className="metric-label" style={{ marginBottom: 16 }}>Please complete the following</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(doc.fields || []).map((f) => (
            <FieldInput key={f.id} field={f}
              value={values[f.id] ?? f.value ?? ''}
              onChange={(v) => setVal(f.id, v)}/>
          ))}
        </div>

        {submitErr && (
          <div style={{
            marginTop: 16, padding: '10px 14px', borderRadius: 10,
            background: 'rgba(155,44,44,0.10)', border: '1px solid rgba(155,44,44,0.30)',
            color: 'var(--danger)', fontSize: 13,
          }}>{submitErr}</div>
        )}

        <div style={{
          marginTop: 24, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <button onClick={() => setDeclineOpen(true)} disabled={submitting || declining}
            className="btn btn-ghost"
            style={{ color: 'var(--danger)', padding: '10px 14px' }}>
            <Icons.X size={13} sw={2}/> Decline to sign
          </button>
          <div style={{ flex: 1 }}/>
          <button className="btn btn-primary" onClick={submit} disabled={submitting || declining}
            style={{ padding: '12px 22px', opacity: submitting ? 0.6 : 1 }}>
            {submitting ? 'Submitting…' : 'Sign and submit'}
            {!submitting && <Icons.Check size={14} sw={2.4}/>}
          </button>
        </div>
      </div>

      {declineOpen && (
        <div role="dialog" onClick={() => !declining && setDeclineOpen(false)} style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={(e) => e.stopPropagation()} className="card"
            style={{ width: '100%', maxWidth: 460, padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{
                width: 34, height: 34, borderRadius: 10,
                background: 'rgba(155,44,44,0.12)', color: 'var(--danger)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><Icons.X size={16}/></div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>Decline to sign?</h3>
            </div>
            <p style={{ margin: '4px 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              The sender will be notified that you declined. You can include
              a brief reason — it'll go in the audit log so they understand
              why.
            </p>
            <textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)}
              rows={3} maxLength={500}
              placeholder="Optional reason (e.g., need to revise term 4)"
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 10,
                background: 'var(--surface)', border: '1px solid var(--border-strong)',
                color: 'var(--fg)', fontSize: 13.5, outline: 'none',
                fontFamily: 'inherit', resize: 'vertical', marginBottom: 14,
              }}/>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeclineOpen(false)} className="btn btn-outline"
                disabled={declining}>Keep signing</button>
              <button onClick={decline} disabled={declining} className="btn btn-primary"
                style={{
                  background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff',
                  opacity: declining ? 0.6 : 1,
                }}>
                {declining ? 'Recording…' : 'Decline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageWrap>
  );
}

function FieldInput({ field, value, onChange }) {
  const label = field.label || field.type;
  const required = field.required !== false;
  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 550, color: 'var(--fg-2)', marginBottom: 8 }}>
        {label}{required && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>}
      </div>
      {field.type === 'signature' && (
        <SignaturePad value={value} onChange={onChange} height={110}/>
      )}
      {field.type === 'initial' && (
        <input value={value} maxLength={4} onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder="AB" style={{ ...inputS, width: 120, textTransform: 'uppercase', letterSpacing: '0.1em', textAlign: 'center', fontWeight: 600 }}/>
      )}
      {field.type === 'date' && (
        <input type="date" value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputS, width: 220 }}/>
      )}
      {field.type === 'text' && (
        <input value={value} onChange={(e) => onChange(e.target.value)} style={inputS}/>
      )}
    </div>
  );
}

function PageWrap({ tweaks, children }) {
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', padding: '40px 24px 80px', background: 'var(--page)',
    }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

// Allow only a tight set of tags (h1/h2/h3, p, br, strong, em, ul/ol/li).
// Strip everything else. This is a safety net — content_html came from the
// owner of the document, but we still don't want script tags in there.
function sanitize(html) {
  if (typeof html !== 'string') return '';
  // Remove any HTML tags we don't whitelist, then any attributes from the
  // ones we keep.
  return html
    .replace(/<\/?(?!\/?(?:h[1-3]|p|br|strong|em|ul|ol|li)\b)[^>]+>/gi, '')
    .replace(/<(\/?)(h[1-3]|p|br|strong|em|ul|ol|li)\b[^>]*>/gi, '<$1$2>');
}

const inputS = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};
