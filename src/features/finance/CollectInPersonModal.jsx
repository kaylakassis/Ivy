// "Collect in person" modal - owner shows it to a customer who pays on
// their own phone. Lazy-imports the qrcode lib so InvoiceEditor's bundle
// doesn't carry it on first paint.
//
// Flow:
//   1. POST /api/invoices/pay-link → mints a fresh public-pay token.
//   2. Renders the URL as a big QR code (200×200) + plain text.
//   3. Owner can: tap-to-copy, send via SMS (sms: protocol picks the
//      device's default SMS app), email it, or just show the screen so
//      the customer scans the QR with their camera.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';

export default function CollectInPersonModal({ invoice, onClose, onPaid }) {
  const [url, setUrl] = useState(null);
  const [qrSvg, setQrSvg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(true);
  const [copied, setCopied] = useState(false);

  // Mint the link + render the QR on open.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await api.post('/invoices/pay-link', { id: invoice.id });
        if (!live) return;
        setUrl(r.url);
        // Lazy-import qrcode only when the modal actually opens - keeps it
        // out of the InvoiceEditor first-paint bundle.
        const { default: QRCode } = await import('qrcode');
        const svg = await QRCode.toString(r.url, {
          type: 'svg',
          margin: 1,
          width: 240,
          color: { dark: '#1A1A1A', light: '#FFFFFF' },
          errorCorrectionLevel: 'M',
        });
        if (!live) return;
        setQrSvg(svg);
      } catch (e) {
        if (live) setErr(e.message || 'Could not create pay link');
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => { live = false; };
  }, [invoice.id]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {/* clipboard blocked - owner can long-press to copy */}
  };

  const total = Number(invoice.total || 0);
  const totalLabel = '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const smsBody = url
    ? `Pay ${totalLabel} for invoice ${invoice.number || ''}: ${url}`
    : '';

  useEscapeKey(onClose);
  return createPortal(
    <div
      onClick={onClose}
      role="dialog" aria-modal="true" aria-labelledby="collect-in-person-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(0,0,0,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card scroll"
        style={{
          width: '100%', maxWidth: 420,
          maxHeight: '90vh', overflowY: 'auto',
          padding: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>Collect in person</h3>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 16 }}>
          Show the QR or text the link. Your customer pays on their own phone - Apple Pay, Google Pay, or card.
        </div>

        <div style={{
          padding: '14px 16px', marginBottom: 16,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Invoice {invoice.number}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }} className="mono-num">
              {totalLabel}
            </div>
          </div>
          <Icons.Receipt size={28} sw={1.5}/>
        </div>

        {busy && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            Creating pay link…
          </div>
        )}

        {err && (
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
            border: '1px solid var(--danger)',
            color: 'var(--danger)', fontSize: 12,
          }}>
            {err}
          </div>
        )}

        {url && qrSvg && (
          <>
            <div style={{
              display: 'flex', justifyContent: 'center',
              padding: 14, marginBottom: 16,
              background: 'white', borderRadius: 14,
              border: '1px solid var(--border)',
            }}>
              <div
                style={{ width: 240, height: 240 }}
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            </div>

            <div style={{
              padding: '10px 12px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              fontSize: 11.5, color: 'var(--fg-2)',
              wordBreak: 'break-all',
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              marginBottom: 12,
            }}>
              {url}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <button className="btn btn-outline" onClick={copy}>
                <Icons.Copy size={13}/> {copied ? 'Copied!' : 'Copy link'}
              </button>
              <a className="btn btn-outline"
                href={`sms:?&body=${encodeURIComponent(smsBody)}`}
                style={{ textDecoration: 'none' }}>
                <Icons.Phone size={13}/> Send by text
              </a>
            </div>
            <a className="btn btn-ghost" style={{
              display: 'flex', justifyContent: 'center', textDecoration: 'none',
            }}
              href={`mailto:?subject=${encodeURIComponent('Invoice ' + (invoice.number || ''))}&body=${encodeURIComponent(smsBody)}`}>
              <Icons.Mail size={13}/> Send by email
            </a>

            <div style={{
              marginTop: 16, padding: '10px 12px',
              background: 'var(--accent-soft)',
              borderRadius: 10,
              fontSize: 11.5, color: 'var(--accent)',
              lineHeight: 1.5,
            }}>
              Once they finish paying, the invoice will mark itself paid here automatically - usually within a few seconds.
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
