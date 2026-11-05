// /sign/:token  (public, no login required)
//
// The signer's side, DocuSign style:
//   • a guided bar at the bottom ("Start", then "Next" jumps to each field
//     you still need to fill, with a running count)
//   • adopt your signature and initials once (draw or type) and they're
//     applied to every signature / initials box with one tap
//   • Date signed and Email fill themselves; Full name starts as your name
//   • required fields are enforced (here and again on the server)
//   • you agree to sign electronically before you finish
// Works the same on a phone and a desktop.
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import SignaturePad, { typedToPng } from './SignaturePad.jsx';
import PdfFieldSigner from './PdfFieldSigner.jsx';
import { fieldLabel, initialsOf } from './fieldTypes.js';

const isFilled = (f, v) => (f.type === 'checkbox' ? v === 'true' : !!String(v ?? '').trim());

export default function SignPage() {
  const { token } = useParams();
  const [tweaks] = useTweaks();
  const [doc, setDoc]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const [values, setValues]   = useState({}); // fieldId → string
  const [signerInfo, setSignerInfo] = useState(null); // { position, total, name, email, isOwner }
  const [businessName, setBusinessName] = useState(null);
  const [signedDate, setSignedDate] = useState('');
  const [adopted, setAdopted] = useState({ signature: '', initial: '' });
  const [modal, setModal]     = useState(null); // { field }
  const [focusId, setFocusId] = useState(null);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone]       = useState(false);
  const [nextSignerName, setNextSignerName] = useState(null);
  const [finalPdfUrl, setFinalPdfUrl] = useState(null);
  const [submitErr, setSubmitErr] = useState(null);
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
        setBusinessName(r.businessName || null);
        const today = r.signedDate || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        setSignedDate(today);
        // Fill what we already know: today's date, their email, their name.
        const myIdx = r.signer?.position ? r.signer.position - 1 : 0;
        const initial = {};
        for (const f of (r.document.fields || [])) {
          if ((f.signerIndex || 0) !== myIdx || f.value) continue;
          if (f.type === 'date') initial[f.id] = today;
          if (f.type === 'email' && r.signer?.email) initial[f.id] = r.signer.email;
          if (f.type === 'name' && r.signer?.name) initial[f.id] = r.signer.name;
        }
        setValues(initial);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [token]);

  const myIdx = signerInfo?.position ? signerInfo.position - 1 : 0;
  // Only this signer's fields are theirs to fill (the server enforces the
  // same rule). Legacy single-signer documents own everything.
  const myFields = useMemo(() => {
    if (!doc) return [];
    const all = doc.fields || [];
    const mine = signerInfo ? all.filter((f) => (f.signerIndex || 0) === myIdx) : all;
    // Reading order: page, then top to bottom, then left to right.
    return mine.slice().sort((a, b) => ((a.page || 0) - (b.page || 0)) || ((a.y ?? 0) - (b.y ?? 0)) || ((a.x ?? 0) - (b.x ?? 0)));
  }, [doc, signerInfo, myIdx]);
  const priorFields = useMemo(() => {
    if (!doc || !signerInfo) return [];
    return (doc.fields || []).filter((f) => (f.signerIndex || 0) < myIdx && f.value);
  }, [doc, signerInfo, myIdx]);
  const valueOf = useCallback((f) => values[f.id] ?? f.value ?? '', [values]);
  const required = myFields.filter((f) => f.required !== false && f.type !== 'date' && f.type !== 'email');
  const requiredDone = required.filter((f) => isFilled(f, valueOf(f))).length;
  const nextField = myFields.find((f) => f.required !== false && !isFilled(f, valueOf(f)))
    || null;

  const backTo = new URLSearchParams(window.location.search).get('back') === 'documents'
    ? `/documents${doc?.id ? `?doc=${encodeURIComponent(doc.id)}` : ''}` : null;
  const isPdf = doc?.kind === 'pdf' && !!doc?.fileUrl;

  const setVal = (id, v) => setValues((m) => ({ ...m, [id]: v }));

  const scrollToField = (id) => {
    setFocusId(id);
    const el = document.querySelector(`[data-sign-field="${CSS.escape(id)}"]`) || document.getElementById(`field-${id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Tap on one of my boxes on the PDF.
  const activate = (f) => {
    setFocusId(f.id);
    if (f.type === 'date' || f.type === 'email') return; // filled in for you
    if (f.type === 'checkbox') { setVal(f.id, valueOf(f) === 'true' ? '' : 'true'); return; }
    if ((f.type === 'signature' || f.type === 'initial') && adopted[f.type] && !valueOf(f)) {
      setVal(f.id, adopted[f.type]);
      return;
    }
    setModal({ field: f });
  };

  const applyAdopted = (kind, value, fieldId) => {
    setAdopted((a) => ({ ...a, [kind]: value }));
    // Re-adopting updates every box of that kind you already signed, so
    // the document never carries two different signatures from you.
    setValues((m) => {
      const next = { ...m, [fieldId]: value };
      for (const f of myFields) if (f.type === kind && m[f.id]) next[f.id] = value;
      return next;
    });
  };

  const submit = async () => {
    if (!doc) return;
    for (const f of myFields) {
      if (f.required !== false && !isFilled(f, valueOf(f))) {
        setSubmitErr(`Please fill in "${fieldLabel(f)}"`);
        scrollToField(f.id);
        return;
      }
    }
    if (!consent) { setSubmitErr('Please tick the box to agree to sign electronically.'); return; }
    setSubmitting(true); setSubmitErr(null);
    try {
      const res = await fetch('/api/sign/' + encodeURIComponent(token), {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consent: true,
          fields: myFields.map((f) => ({ id: f.id, type: f.type, value: String(valueOf(f)) })),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (j.nextSigner?.name) setNextSignerName(j.nextSigner.name);
      if (j.document?.finalPdfUrl) setFinalPdfUrl(j.document.finalPdfUrl);
      setDone(true);
      window.scrollTo?.({ top: 0 });
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
        <div className="card" style={{ padding: 'clamp(24px, 6vw, 40px)', textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 99, background: 'var(--ok)', color: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
          }}><Icons.Check size={28} sw={2.4}/></div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 28 }}>You're signed.</h1>
          <p style={{ color: 'var(--muted)', marginTop: 10, fontSize: 14, lineHeight: 1.55, maxWidth: 460, marginInline: 'auto' }}>
            {handedOff ? (
              <>Thanks, your part of <b style={{ color: 'var(--fg-2)' }}>{doc.name}</b> is in.
              We've passed it to <b style={{ color: 'var(--fg-2)' }}>{nextSignerName}</b> to sign next.
              You'll get the signed copy by email once everyone has signed.</>
            ) : (
              <>Thanks, <b style={{ color: 'var(--fg-2)' }}>{doc.name}</b> is complete and {businessName || 'the sender'} has been told.</>
            )}
          </p>
          {finalPdfUrl && (
            <a href={finalPdfUrl} target="_blank" rel="noopener noreferrer"
              className="btn btn-outline"
              style={{ marginTop: 22, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Icons.Doc size={14}/> Download signed PDF
            </a>
          )}
          {!handedOff && (
            <p style={{ color: 'var(--muted)', marginTop: 18, fontSize: 12.5 }}>
              A copy of the signed document is on its way to your email.
            </p>
          )}
          {backTo && (
            <div style={{ marginTop: 18 }}>
              <a href={backTo} className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                Back to Documents <Icons.Arrow size={12} sw={2}/>
              </a>
            </div>
          )}
        </div>
      </PageWrap>
    );
  }

  const started = !!focusId;

  return (
    <PageWrap tweaks={tweaks}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10, background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}><Icons.Doc size={18}/></div>
        <div style={{ minWidth: 0 }}>
          <div className="metric-label">{businessName ? `From ${businessName}` : 'Action needed'}</div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 22, overflowWrap: 'anywhere' }}>{doc.name}</h1>
        </div>
      </div>

      {signerInfo && signerInfo.total > 1 && (
        <div style={{
          padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--surface))',
          border: '1px solid var(--accent)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5,
        }}>
          <Icons.Users size={14} sw={1.7} stroke="var(--accent)"/>
          <span style={{ color: 'var(--fg-2)' }}>
            You're signer <strong style={{ color: 'var(--fg)' }}>{signerInfo.position}</strong>{' '}
            of <strong style={{ color: 'var(--fg)' }}>{signerInfo.total}</strong>.
            {signerInfo.position < signerInfo.total
              ? ' The next signer gets their link after you finish.'
              : " You're the last signer, so the document is complete when you finish."}
          </span>
        </div>
      )}

      {isPdf ? (
        <>
          <div style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 10, lineHeight: 1.5 }}>
            {myFields.length
              ? <>Tap <b>{started ? 'Next' : 'Start'}</b> below and fill in each highlighted box. Boxes with a * are required.</>
              : 'Nothing to fill in for you. Review the document and finish below.'}
          </div>
          <div className="card" style={{ padding: 'clamp(6px, 2vw, 16px)', marginBottom: 18, overflow: 'hidden' }}>
            <PdfFieldSigner
              pdfUrl={doc.fileUrl}
              fields={doc.fields || []}
              values={values}
              currentSignerIndex={signerInfo?.position ? signerInfo.position - 1 : 0}
              focusId={focusId}
              onActivate={activate}
            />
          </div>
        </>
      ) : (
        <div className="card" style={{ padding: 'clamp(18px, 5vw, 32px)', marginBottom: 18 }}>
          <div
            style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--fg)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            dangerouslySetInnerHTML={{ __html: sanitize(doc.contentHtml || '') }}
          />
        </div>
      )}

      <div id="sign-finish" className="card" style={{ padding: 'clamp(16px, 4vw, 24px)' }}>
        {!isPdf && priorFields.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div className="metric-label" style={{ marginBottom: 10 }}>Already signed</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {priorFields.map((f) => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'var(--fg-2)', flexWrap: 'wrap' }}>
                  <span style={{ minWidth: 120, color: 'var(--muted)', fontSize: 12 }}>{fieldLabel(f)}</span>
                  {(f.type === 'signature' || f.type === 'initial') && String(f.value).startsWith('data:image')
                    ? <img src={f.value} alt="Signature" style={{ height: 34, background: '#fff', borderRadius: 6, padding: '2px 8px' }}/>
                    : <span style={{ fontWeight: f.type === 'signature' ? 600 : 400 }}>{f.type === 'checkbox' ? (f.value === 'true' ? 'Yes' : 'No') : f.value}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {!isPdf && (
          <>
            <div className="metric-label" style={{ marginBottom: 16 }}>Please complete the following</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 20 }}>
              {myFields.map((f) => (
                <div key={f.id} id={`field-${f.id}`}>
                  <FieldInput field={f} signedDate={signedDate}
                    value={valueOf(f)}
                    onChange={(v) => setVal(f.id, v)}/>
                </div>
              ))}
            </div>
          </>
        )}

        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: 10,
          background: 'var(--surface-2)', border: `1px solid ${consent ? 'var(--accent)' : 'var(--border)'}`,
          fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-2)', cursor: 'pointer',
        }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
            data-consent
            style={{ marginTop: 2, width: 18, height: 18, flexShrink: 0 }}/>
          <span>
            I agree to sign this document electronically and to receive it and related records
            electronically. My electronic signature and initials are the legal equivalent of my
            handwritten ones. I can ask {businessName || 'the sender'} for a paper copy.
          </span>
        </label>

        {submitErr && (
          <div role="alert" style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 10,
            background: 'rgba(155,44,44,0.10)', border: '1px solid rgba(155,44,44,0.30)',
            color: 'var(--danger)', fontSize: 13,
          }}>{submitErr}</div>
        )}

        <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => setDeclineOpen(true)} disabled={submitting || declining}
            className="btn btn-ghost"
            style={{ color: 'var(--danger)', padding: '10px 12px' }}>
            Decline to sign
          </button>
          <div style={{ flex: 1 }}/>
          <button className="btn btn-primary" onClick={submit} disabled={submitting || declining}
            data-finish
            style={{ padding: '12px 22px', opacity: submitting ? 0.6 : 1 }}>
            {submitting ? 'Finishing…' : 'Finish and sign'}
            {!submitting && <Icons.Check size={14} sw={2.4}/>}
          </button>
        </div>
      </div>

      {/* Guided navigation, always in reach on a phone. */}
      {myFields.length > 0 && (
        <div style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 150,
          padding: '10px clamp(12px, 4vw, 24px) calc(10px + env(safe-area-inset-bottom, 0px))',
          background: 'color-mix(in srgb, var(--surface) 94%, transparent)',
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          borderTop: '1px solid var(--border)', boxShadow: '0 -4px 18px rgba(0,0,0,0.06)',
        }}>
          <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
                {nextField ? `${requiredDone} of ${required.length} required done` : 'All set'}
              </div>
              <div style={{ height: 4, borderRadius: 99, background: 'var(--surface-2)', marginTop: 6, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${required.length ? (requiredDone / required.length) * 100 : 100}%`, background: 'var(--ok)', transition: 'width .2s' }}/>
              </div>
            </div>
            {nextField ? (
              <button type="button" className="btn btn-primary" data-next-field
                onClick={() => scrollToField(nextField.id)}
                style={{ padding: '11px 18px', whiteSpace: 'nowrap' }}>
                {started ? `Next: ${fieldLabel(nextField)}` : 'Start'} <Icons.ArrowDown size={13} sw={2}/>
              </button>
            ) : (
              <button type="button" className="btn btn-primary"
                onClick={() => document.getElementById('sign-finish')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                style={{ padding: '11px 18px', whiteSpace: 'nowrap' }}>
                Finish <Icons.Check size={13} sw={2.4}/>
              </button>
            )}
          </div>
        </div>
      )}

      {modal && (
        <FieldModal
          field={modal.field}
          value={valueOf(modal.field)}
          adopted={adopted}
          signerName={signerInfo?.name || doc.recipientName || ''}
          onCancel={() => setModal(null)}
          onSave={(v) => {
            const f = modal.field;
            if (f.type === 'signature' || f.type === 'initial') applyAdopted(f.type, v, f.id);
            else setVal(f.id, v);
            setModal(null);
          }}
        />
      )}

      {declineOpen && (
        <div role="dialog" aria-modal="true" onClick={() => !declining && setDeclineOpen(false)} style={overlayS}>
          <div onClick={(e) => e.stopPropagation()} className="card"
            style={{ width: '100%', maxWidth: 460, padding: 24 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Decline to sign?</h3>
            <p style={{ margin: '4px 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              The sender will be told that you declined. You can add a short reason.
            </p>
            <textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)}
              rows={3} maxLength={500}
              placeholder="Optional reason"
              style={{ ...inputS, fontFamily: 'inherit', resize: 'vertical', marginBottom: 14 }}/>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeclineOpen(false)} className="btn btn-outline"
                disabled={declining}>Keep signing</button>
              <button onClick={decline} disabled={declining} className="btn btn-primary"
                style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff', opacity: declining ? 0.6 : 1 }}>
                {declining ? 'Recording…' : 'Decline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageWrap>
  );
}

// One modal for every kind of box: adopt a signature / initials (draw or
// type), pick a dropdown choice, or type an answer.
function FieldModal({ field, value, adopted, signerName, onCancel, onSave }) {
  const isSig = field.type === 'signature' || field.type === 'initial';
  const typedDefault = field.type === 'initial' ? initialsOf(signerName) : signerName;
  const [v, setV] = useState(isSig ? (adopted[field.type] || value || '') : (value || ''));
  const label = fieldLabel(field);
  const save = () => {
    let out = v;
    if (isSig && out && !out.startsWith('data:')) out = typedToPng(out, { initials: field.type === 'initial' }) || out;
    onSave(out);
  };
  const canSave = field.required === false || !!String(v || '').trim();
  return (
    <div role="dialog" aria-modal="true" aria-label={label} onClick={onCancel} style={overlayS}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: '100%', maxWidth: 480, padding: 'clamp(16px, 4vw, 22px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>
            {field.type === 'signature' ? 'Adopt your signature' : field.type === 'initial' ? 'Adopt your initials' : label}
            {!isSig && field.required !== false && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>}
          </h3>
          <button type="button" className="btn btn-ghost" onClick={onCancel} aria-label="Close" style={{ padding: 6 }}>
            <Icons.X size={14}/>
          </button>
        </div>
        {isSig && (
          <>
            <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
              {field.type === 'signature'
                ? 'This is used on every signature line in this document. Draw it, or type it.'
                : 'Used on every initials box in this document.'}
            </p>
            <SignaturePad value={v} onChange={setV} height={field.type === 'initial' ? 120 : 150}
              typedDefault={typedDefault}
              placeholder={field.type === 'initial' ? 'Your initials' : 'Type your full name'}/>
          </>
        )}
        {field.type === 'dropdown' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(field.options || []).map((o) => (
              <button key={o} type="button" onClick={() => setV(o)}
                style={{
                  ...inputS, textAlign: 'left', cursor: 'pointer', fontWeight: v === o ? 650 : 450,
                  borderColor: v === o ? 'var(--accent)' : 'var(--border-strong)',
                  background: v === o ? 'var(--accent-soft)' : 'var(--surface-2)',
                }}>{o}</button>
            ))}
          </div>
        )}
        {!isSig && field.type !== 'dropdown' && (
          <input value={v} onChange={(e) => setV(e.target.value.slice(0, 500))}
            placeholder={field.type === 'name' ? 'Your full name' : field.type === 'company' ? 'Company name' : field.type === 'title' ? 'Your title' : (field.label || 'Your answer')}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) save(); }}
            autoComplete={field.type === 'name' ? 'name' : field.type === 'company' ? 'organization' : field.type === 'title' ? 'organization-title' : 'off'}
            style={inputS}/>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-outline" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!canSave} data-adopt>
            {isSig ? (field.type === 'signature' ? 'Adopt and sign' : 'Adopt and initial') : 'Done'}
          </button>
        </div>
        {isSig && (
          <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--muted)', }}>
            By tapping {field.type === 'signature' ? 'Adopt and sign' : 'Adopt and initial'} you agree this mark is your electronic {field.type === 'signature' ? 'signature' : 'initials'}.
          </p>
        )}
      </div>
    </div>
  );
}

// Written documents: a simple form under the text.
function FieldInput({ field, value, onChange, signedDate }) {
  const label = fieldLabel(field);
  const required = field.required !== false;
  const head = (
    <div style={{ fontSize: 12.5, fontWeight: 550, color: 'var(--fg-2)', marginBottom: 8 }}>
      {label}{required && field.type !== 'date' && field.type !== 'email' && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>}
    </div>
  );
  if (field.type === 'signature') return <div>{head}<SignaturePad value={value} onChange={onChange} height={110}/></div>;
  if (field.type === 'initial') {
    return (
      <div>{head}
        <input value={value} maxLength={6} onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder="AB" style={{ ...inputS, width: 120, textTransform: 'uppercase', letterSpacing: '0.1em', textAlign: 'center', fontWeight: 600 }}/>
      </div>
    );
  }
  if (field.type === 'date') {
    return <div>{head}<div style={{ ...inputS, width: 'auto', display: 'inline-block', color: 'var(--fg-2)' }}>{signedDate || value} <span style={{ color: 'var(--muted)', fontSize: 12 }}>(filled in when you sign)</span></div></div>;
  }
  if (field.type === 'email') return <div>{head}<input value={value} readOnly style={{ ...inputS, color: 'var(--fg-2)' }}/></div>;
  if (field.type === 'checkbox') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, color: 'var(--fg)', cursor: 'pointer' }}>
        <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : '')} style={{ width: 18, height: 18 }}/>
        {label}{required && <span style={{ color: 'var(--danger)' }}>*</span>}
      </label>
    );
  }
  if (field.type === 'dropdown') {
    return (
      <div>{head}
        <select value={value} onChange={(e) => onChange(e.target.value)} style={inputS}>
          <option value="">Choose…</option>
          {(field.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  return <div>{head}<input value={value} onChange={(e) => onChange(e.target.value.slice(0, 500))} style={inputS}/></div>;
}

function PageWrap({ tweaks, children }) {
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', padding: 'clamp(16px, 5vw, 40px) clamp(10px, 3vw, 24px) 120px', background: 'var(--page)',
    }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

// Allow only a tight set of tags (h1/h2/h3, p, br, strong, em, ul/ol/li).
// Strip everything else. This is a safety net - content_html came from the
// owner of the document, but we still don't want script tags in there.
function sanitize(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<\/?(?!\/?(?:h[1-3]|p|br|strong|em|ul|ol|li)\b)[^>]+>/gi, '')
    .replace(/<(\/?)(h[1-3]|p|br|strong|em|ul|ol|li)\b[^>]*>/gi, '<$1$2>');
}

const overlayS = {
  position: 'fixed', inset: 0, zIndex: 230,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};

const inputS = {
  width: '100%', padding: '12px 14px', borderRadius: 10,
  background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 16, outline: 'none', boxSizing: 'border-box',
};
