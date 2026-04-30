// Share booking link drawer — edit business name + handle, copy link.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { inputSty } from './Drawer.jsx';
import { slugify } from './utils.js';

export default function ShareDrawer({ settings, onSave, onClose }) {
  const [bizName, setBizName] = useState(settings.bizName || '');
  const [slug, setSlug]       = useState(settings.slug || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [copied, setCopied] = useState(false);

  const shareUrl = slug ? `${window.location.origin}/book/${slug}` : '';

  const persist = async (patch) => {
    setBusy(true);
    setErr(null);
    try { await onSave(patch); }
    catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
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
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>Business name</div>
        <input value={bizName} onChange={(e) => setBizName(e.target.value)}
          onBlur={() => bizName !== settings.bizName && persist({ bizName })}
          style={inputSty} placeholder="Your business name"/>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>Your handle</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 0,
          border: '1px solid var(--border-strong)', borderRadius: 10, background: 'var(--surface)',
          overflow: 'hidden',
        }}>
          <span style={{ padding: '10px 12px', background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 13 }}>
            /book/
          </span>
          <input value={slug} onChange={(e) => setSlug(slugify(e.target.value))}
            onBlur={() => slug !== settings.slug && persist({ slug: slug || null })}
            placeholder="your-handle"
            style={{ flex: 1, padding: '10px 12px', background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', fontSize: 14 }}/>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
          Lowercase letters, digits, and hyphens. Same handle as your website.
        </div>
      </div>

      {err && (
        <div style={{
          marginBottom: 14, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      <div style={{
        padding: 14, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
        marginBottom: 14, opacity: shareUrl ? 1 : 0.6,
      }}>
        <div className="metric-label" style={{ marginBottom: 6 }}>Shareable link</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12, color: 'var(--fg-2)', wordBreak: 'break-all',
        }}>
          <Icons.Globe size={14} stroke="var(--muted)" sw={1.6}/>
          <span style={{ flex: 1, minWidth: 0 }}>{shareUrl || 'Set a handle above to generate a link'}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-primary" onClick={copy} disabled={!shareUrl} style={{ flex: 1, justifyContent: 'center' }}>
            {copied
              ? <><Icons.Check size={14} sw={2.2}/> Copied</>
              : <><Icons.Copy size={14}/> Copy link</>}
          </button>
          <a className="btn btn-outline" href={shareUrl || '#'} target="_blank" rel="noreferrer"
            style={{ pointerEvents: shareUrl ? 'auto' : 'none', opacity: shareUrl ? 1 : 0.5 }}>
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
