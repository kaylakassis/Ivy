// The "aha" finish screen: hands the new owner their LIVE, shareable booking
// link (copy / QR / open) instead of dropping them onto an empty dashboard.
// Reused at the end of the Ivy-guided setup and available as a standalone win
// moment. Themed with the app tokens; reuses the shared QRCodeModal.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import QRCodeModal from '../../components/QRCodeModal.jsx';
import { publicOrigin } from '../../lib/publicUrl.js';

export default function BookingWin({ slug, bizName, onContinue, continueLabel = 'Go to my dashboard' }) {
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const link = `${publicOrigin()}/book/${slug}`;
  const pretty = link.replace(/^https?:\/\//, '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — user can still tap Open */ }
  };

  return (
    <div style={{ textAlign: 'center', padding: '8px 0' }}>
      <div style={{
        width: 60, height: 60, borderRadius: 18, margin: '0 auto 16px',
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Check size={30} sw={2.2}/>
      </div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 600, margin: '0 0 8px' }}>
        You're live. 🎉
      </h1>
      <p style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.55, maxWidth: 460, margin: '0 auto 22px' }}>
        {bizName ? <b style={{ color: 'var(--fg)' }}>{bizName}</b> : 'Your business'} has a booking page.
        Share this link and clients can book you in seconds — no back-and-forth.
      </p>

      {/* The shareable link card */}
      <div className="card" style={{
        maxWidth: 460, margin: '0 auto', padding: 16, textAlign: 'left',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, letterSpacing: '0.03em', textTransform: 'uppercase' }}>
          Your booking link
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
          background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 10px)',
        }}>
          <Icons.Calendar size={16} sw={1.8} color="var(--accent)"/>
          <span style={{ flex: 1, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pretty}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={copy} className="btn btn-primary" style={{ flex: '1 1 130px', justifyContent: 'center', gap: 8 }}>
            <Icons.Copy size={15} sw={1.9}/> {copied ? 'Copied!' : 'Copy link'}
          </button>
          <button type="button" onClick={() => setShowQR(true)} className="btn btn-outline" style={{ flex: '0 0 auto', justifyContent: 'center', gap: 8 }}>
            <Icons.Image size={15} sw={1.9}/> QR
          </button>
          <a href={link} target="_blank" rel="noopener noreferrer" className="btn btn-outline" style={{ flex: '0 0 auto', justifyContent: 'center', gap: 8, textDecoration: 'none' }}>
            <Icons.Arrow size={15} sw={1.9}/> Open
          </a>
        </div>
      </div>

      <div style={{ marginTop: 22 }}>
        <button type="button" onClick={onContinue} className="btn btn-ghost" style={{ fontSize: 14 }}>
          {continueLabel} <Icons.Arrow size={14} sw={2}/>
        </button>
      </div>

      {showQR && (
        <QRCodeModal
          url={link}
          label="Scan to book"
          sublabel={bizName || 'Your booking page'}
          onClose={() => setShowQR(false)}
        />
      )}
    </div>
  );
}
