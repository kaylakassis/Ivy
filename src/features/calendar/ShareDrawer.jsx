// Share booking link drawer — edit business name + handle, copy link.
// Both fields require an explicit Save (no silent on-blur). Status banner
// makes it obvious whether the handle is published yet.
import React, { useState, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { inputSty } from './Drawer.jsx';
import { slugify } from './utils.js';

export default function ShareDrawer({ settings, onSave, onClose }) {
  const [bizName, setBizName] = useState(settings.bizName || '');
  const [slug, setSlug]       = useState(settings.slug || '');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState(null);
  const [copied, setCopied]   = useState(false);

  // If the parent settings change (e.g. another save lands), pull them in.
  useEffect(() => { setBizName(settings.bizName || ''); }, [settings.bizName]);
  useEffect(() => { setSlug(settings.slug || ''); },       [settings.slug]);

  const dirty = bizName !== (settings.bizName || '') || slug !== (settings.slug || '');
  const savedSlug = settings.slug || null;
  const isPublished = !!savedSlug;
  const shareUrl = savedSlug ? `${window.location.origin}/book/${savedSlug}` : '';

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({
        bizName: bizName.trim() || 'My business',
        slug: slug ? slug.toLowerCase().trim() : null,
      });
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Drawer title="Share booking link" subtitle="Clients can book into your calendar from this page." onClose={onClose}>
      {/* Status banner */}
      <div style={{
        padding: '10px 12px', borderRadius: 10, marginBottom: 16,
        fontSize: 12.5, lineHeight: 1.5,
        background: isPublished
          ? 'color-mix(in srgb, var(--ok) 12%, transparent)'
          : 'var(--surface-2)',
        border: `1px solid ${isPublished ? 'color-mix(in srgb, var(--ok) 35%, transparent)' : 'var(--border)'}`,
        color: isPublished ? 'var(--ok)' : 'var(--muted)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {isPublished
          ? <><Icons.Check size={14} sw={2.2}/> Booking page is live at <code style={{ fontSize: 11.5 }}>/book/{savedSlug}</code></>
          : <><Icons.Globe size={14}/> Set a handle below and hit Save to publish your booking page.</>}
      </div>

      <Field label="Business name">
        <input value={bizName} onChange={(e) => setBizName(e.target.value)} style={inputSty}
          placeholder="Your business name"
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}/>
      </Field>

      <Field label="Your handle" hint="Lowercase letters, digits, and hyphens. 1–40 characters.">
        <div style={{
          display: 'flex', alignItems: 'center',
          border: '1px solid var(--border-strong)', borderRadius: 10, background: 'var(--surface)',
          overflow: 'hidden',
        }}>
          <span style={{ padding: '10px 12px', background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 13 }}>
            /book/
          </span>
          <input value={slug}
            onChange={(e) => setSlug(slugify(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            placeholder="your-handle"
            style={{ flex: 1, padding: '10px 12px', background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', fontSize: 14 }}/>
        </div>
      </Field>

      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 14,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      {/* Save button — explicit so users don't have to know about blur events. */}
      <button className="btn btn-primary" onClick={save}
        disabled={!dirty || busy}
        style={{
          width: '100%', justifyContent: 'center', padding: '11px 14px',
          opacity: (!dirty || busy) ? 0.5 : 1,
          marginBottom: 18,
        }}>
        {busy
          ? 'Saving…'
          : dirty
            ? (isPublished ? 'Save changes' : 'Save & publish')
            : 'Saved'}
        {!busy && dirty && <Icons.Check size={14} sw={2.2}/>}
      </button>

      {/* Shareable link card — only fully active once we have a saved handle */}
      <div style={{
        padding: 14, borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        marginBottom: 14, opacity: isPublished ? 1 : 0.55,
      }}>
        <div className="metric-label" style={{ marginBottom: 6 }}>Shareable link</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12, color: 'var(--fg-2)', wordBreak: 'break-all',
        }}>
          <Icons.Globe size={14} stroke="var(--muted)" sw={1.6}/>
          <span style={{ flex: 1, minWidth: 0 }}>
            {isPublished ? shareUrl : 'Save a handle above to generate your link'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-primary" onClick={copy} disabled={!isPublished}
            style={{ flex: 1, justifyContent: 'center', opacity: isPublished ? 1 : 0.5 }}>
            {copied
              ? <><Icons.Check size={14} sw={2.2}/> Copied</>
              : <><Icons.Copy size={14}/> Copy link</>}
          </button>
          <a className="btn btn-outline" href={shareUrl || '#'} target="_blank" rel="noreferrer"
            style={{ pointerEvents: isPublished ? 'auto' : 'none', opacity: isPublished ? 1 : 0.5 }}>
            <Icons.Arrow size={14}/> Open
          </a>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        Anyone with the link can see your available slots and book — they can't see your other
        bookings, clients, or notes.
      </div>
    </Drawer>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{hint}</div>}
    </div>
  );
}
