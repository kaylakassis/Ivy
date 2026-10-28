// "Your business is ready" - the first-win cards shown at the end of
// onboarding (manual wizard and Ivy-guided setup) and, for an owner who
// already finished onboarding, on their first dashboard visit.
//
// On mount it asks the server to draft, from the owner's REAL answers only:
//   1. the booking link (business name + at least one service)
//   2. an unpublished website draft (name, services, hours, booking, contact)
//   3. a first invoice draft priced from the first service, no client yet
// and renders one card each with a single clear action. Nothing is public
// until the owner acts: the website stays a draft until Publish, the invoice
// stays a draft until they add a name and send. When an answer is missing
// the card asks for it inline instead of inventing a value.
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import QRCodeModal from '../../components/QRCodeModal.jsx';
import { api } from '../../lib/api.js';
import { publicOrigin } from '../../lib/publicUrl.js';
import { stagger } from '../../components/motion/stagger.jsx';

function fmtMoney(n, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n || 0));
  } catch { return `$${Number(n || 0).toFixed(2)}`; }
}

export default function ReadyStep({ onContinue, continueLabel = 'Go to my dashboard', showHeader = true, embedded = false }) {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const prepare = useCallback(async (answers) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/onboarding/first-win', { action: 'prepare', ...(answers ? { answers } : {}) });
      setStatus(r.status);
    } catch (e) {
      setErr(e?.message || 'Could not get your drafts ready. Try again.');
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { prepare(); }, [prepare]);

  const continueNow = async () => {
    try { await api.post('/onboarding/first-win', { action: 'seen' }); } catch { /* best-effort */ }
    onContinue?.();
  };

  const missing = status?.missing || [];
  const needsName = missing.includes('businessName');
  const needsService = missing.includes('service');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {showHeader && (
        <div style={{ textAlign: embedded ? 'left' : 'center' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: embedded ? 22 : 28, fontWeight: 600, margin: '0 0 6px' }}>
            Your business is ready.
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: 14.5, lineHeight: 1.55, margin: 0, maxWidth: 520, ...(embedded ? {} : { marginLeft: 'auto', marginRight: 'auto' }) }}>
            Ivy drafted these from your answers. Nothing goes public until you say so.
          </p>
        </div>
      )}

      {err && (
        <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(155,44,44,0.10)', border: '1px solid rgba(155,44,44,0.30)', color: 'var(--danger)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>{err}</span>
          <button type="button" className="btn btn-outline" onClick={() => prepare()} disabled={busy} style={{ fontSize: 12.5, padding: '6px 10px' }}>Try again</button>
        </div>
      )}

      {!status && !err && (
        <div style={{ color: 'var(--muted)', fontSize: 13.5, textAlign: 'center', padding: '18px 0' }}>Getting your drafts ready...</div>
      )}

      {status && (
        <div className="stagger" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <BookingLinkCard status={status} needsName={needsName} needsService={needsService} onAnswer={prepare} busy={busy} index={0}/>
          <WebsiteCard status={status} needsName={needsName} onChanged={() => prepare()} index={1}/>
          <InvoiceCard status={status} needsService={needsService} index={2}/>
        </div>
      )}

      {onContinue && (
        <div style={{ textAlign: embedded ? 'right' : 'center', marginTop: 4 }}>
          <button type="button" onClick={continueNow} className={embedded ? 'btn btn-outline' : 'btn btn-ghost'} style={{ fontSize: 14, gap: 6 }}>
            {continueLabel} <Icons.Arrow size={14} sw={2}/>
          </button>
        </div>
      )}
    </div>
  );
}

function CardShell({ icon, title, done, children, index }) {
  const Icon = Icons[icon] || Icons.Spark;
  return (
    <div className="card" style={{ padding: 16, display: 'flex', gap: 14, alignItems: 'flex-start', ...stagger(index) }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
        background: done ? 'color-mix(in srgb, var(--ok) 16%, transparent)' : 'var(--accent-soft)',
        color: done ? 'var(--ok)' : 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {done ? <Icons.Check size={17} sw={2.4}/> : <Icon size={17} sw={1.8}/>}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 14.5, fontWeight: 650 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

const subStyle = { fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5, margin: 0 };
const rowStyle = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };

// 1. Booking link: copy / share / QR. Asks inline for the business name or
//    first service when either is missing.
function BookingLinkCard({ status, needsName, needsService, onAnswer, busy, index }) {
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [name, setName] = useState('');
  const [svc, setSvc] = useState({ name: '', durationMinutes: 60, price: '' });
  const b = status.booking;
  const link = b.slug ? `${publicOrigin()}/book/${b.slug}` : null;
  const pretty = link ? link.replace(/^https?:\/\//, '') : '';

  const markShared = () => { api.post('/onboarding/first-win', { action: 'shared' }).catch(() => {}); };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked; Open still works */ }
    markShared();
  };
  const share = async () => {
    try {
      await navigator.share({ title: status.businessName || 'Book with me', text: 'Book a time with me here:', url: link });
      markShared();
    } catch { /* cancelled */ }
  };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  if (needsName) {
    return (
      <CardShell icon="Calendar" title="Your booking link" index={index}>
        <p style={subStyle}>What is your business called? Your booking link is built from the name.</p>
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onAnswer({ bizName: name.trim() }); }} style={rowStyle}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Business name" style={{ flex: '1 1 200px' }} autoFocus/>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Save</button>
        </form>
      </CardShell>
    );
  }
  if (needsService) {
    return (
      <CardShell icon="Calendar" title="Your booking link" index={index}>
        <p style={subStyle}>Clients book a service. What is the main one you offer?</p>
        <form onSubmit={(e) => { e.preventDefault(); if (svc.name.trim()) onAnswer({ service: { name: svc.name.trim(), durationMinutes: Number(svc.durationMinutes) || 60, price: Number(svc.price) || 0 } }); }}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input className="input" value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} placeholder="Service name" autoFocus/>
          <div style={rowStyle}>
            <label style={{ flex: '1 1 110px', fontSize: 12, color: 'var(--muted)' }}>Minutes
              <input className="input" type="number" min={5} step={5} value={svc.durationMinutes} onChange={(e) => setSvc({ ...svc, durationMinutes: e.target.value })} style={{ marginTop: 4 }}/>
            </label>
            <label style={{ flex: '1 1 110px', fontSize: 12, color: 'var(--muted)' }}>Price
              <input className="input" type="number" min={0} step="1" value={svc.price} onChange={(e) => setSvc({ ...svc, price: e.target.value })} placeholder="0" style={{ marginTop: 4 }}/>
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || !svc.name.trim()} style={{ alignSelf: 'flex-end' }}>Save</button>
          </div>
        </form>
      </CardShell>
    );
  }

  const svcLine = b.services.length === 1
    ? `${b.services[0].name}, ${b.services[0].durationMinutes} min`
    : `${b.services.length} services`;
  // firstBookingAt is set only when a CLIENT booked through the link (not
  // an owner-added booking), so "working" is only ever said when it is true.
  const clientBooked = !!b.firstBookingAt;
  const done = clientBooked || b.realBookings > 0 || !!b.sharedAt;
  return (
    <CardShell icon="Calendar" title={clientBooked ? 'Your booking link is working' : 'Your booking link'} done={done} index={index}>
      <p style={subStyle}>
        {clientBooked ? 'A client has already booked through it. ' : ''}Clients pick a time for {svcLine} and it lands on your calendar.
      </p>
      {link && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 10px)' }}>
          <Icons.Calendar size={15} sw={1.8} color="var(--accent)"/>
          <span style={{ flex: 1, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pretty}</span>
        </div>
      )}
      <div style={rowStyle}>
        <button type="button" onClick={copy} className="btn btn-primary" style={{ gap: 7 }}>
          <Icons.Copy size={14} sw={1.9}/> {copied ? 'Copied' : 'Copy link'}
        </button>
        {canShare && (
          <button type="button" onClick={share} className="btn btn-outline">Share</button>
        )}
        <button type="button" onClick={() => setShowQR(true)} className="btn btn-outline" style={{ gap: 6 }}>
          <Icons.Image size={14} sw={1.9}/> QR
        </button>
        <a href={link} target="_blank" rel="noopener noreferrer" className="btn btn-ghost" style={{ textDecoration: 'none', gap: 6 }} onClick={markShared}>
          Open <Icons.Arrow size={13} sw={2}/>
        </a>
      </div>
      {showQR && <QRCodeModal url={link} label="Scan to book" sublabel={status.businessName || 'Your booking page'} onClose={() => setShowQR(false)}/>}
    </CardShell>
  );
}

// 2. Website: a draft until Publish. Preview opens the editor (the draft is
//    not public anywhere until it is published).
function WebsiteCard({ status, needsName, onChanged, index }) {
  const w = status.website;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const publish = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/website/publish');
      setConfirming(false);
      onChanged?.();
    } catch (e) {
      setErr(e?.message || 'Could not publish. You can publish from Website too.');
    } finally { setBusy(false); }
  };

  if (needsName) {
    return (
      <CardShell icon="Globe" title="Your website" index={index}>
        <p style={subStyle}>Ivy drafts your site once your business has a name. Add it above.</p>
      </CardShell>
    );
  }
  if (!w.ready) {
    return (
      <CardShell icon="Globe" title="Your website" index={index}>
        <p style={subStyle}>No draft yet. You can build one in Website whenever you like.</p>
        <div style={rowStyle}><Link to="/website" className="btn btn-outline">Open Website</Link></div>
      </CardShell>
    );
  }
  if (w.launched) {
    return (
      <CardShell icon="Globe" title="Your website is live" done index={index}>
        <p style={subStyle}>Published at <span style={{ color: 'var(--fg)' }}>{(w.url || '').replace(/^https?:\/\//, '')}</span>. Edit it anytime in Website.</p>
        <div style={rowStyle}>
          {w.url && <a href={w.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary" style={{ textDecoration: 'none', gap: 6 }}>Open site <Icons.Arrow size={13} sw={2}/></a>}
          <Link to="/website" className="btn btn-ghost">Edit</Link>
        </div>
      </CardShell>
    );
  }
  return (
    <CardShell icon="Globe" title="Your website draft" index={index}>
      <p style={subStyle}>
        A one-page draft built from your answers: {w.sectionCount} sections, with a button to your booking page. Only you can see it until you publish.
      </p>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      {!confirming ? (
        <div style={rowStyle}>
          <Link to="/website" className="btn btn-primary" style={{ gap: 6 }}>Preview website <Icons.Arrow size={13} sw={2}/></Link>
          <button type="button" className="btn btn-outline" onClick={() => setConfirming(true)} disabled={!w.handle}>Publish</button>
          {!w.handle && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Pick a web address in Website to publish.</span>}
        </div>
      ) : (
        <div style={rowStyle}>
          <span style={{ fontSize: 13 }}>Make it live at <b>{(w.url || '').replace(/^https?:\/\//, '')}</b>?</span>
          <button type="button" className="btn btn-primary" onClick={publish} disabled={busy}>{busy ? 'Publishing...' : 'Yes, publish'}</button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Not yet</button>
        </div>
      )}
    </CardShell>
  );
}

// 3. First invoice: a draft with the first service as its line item and no
//    client. The owner adds a name in the editor and sends.
function InvoiceCard({ status, needsService, index }) {
  const inv = status.invoice;
  if (inv.sentCount > 0) {
    return (
      <CardShell icon="Receipt" title="Your first invoice is out" done index={index}>
        <p style={subStyle}>You have sent {inv.sentCount === 1 ? 'an invoice' : `${inv.sentCount} invoices`}. Finance tracks who has paid.</p>
        <div style={rowStyle}><Link to="/finance?section=invoices" className="btn btn-outline">Open Finance</Link></div>
      </CardShell>
    );
  }
  if (needsService || !inv.ready) {
    return (
      <CardShell icon="Receipt" title="Your first invoice" index={index}>
        <p style={subStyle}>
          {needsService
            ? 'Ivy drafts your first invoice from your first service. Add one above.'
            : 'Build one in Finance when you are ready; Ivy can draft it for you.'}
        </p>
        {!needsService && <div style={rowStyle}><Link to="/finance?section=invoices" className="btn btn-outline">Open Finance</Link></div>}
      </CardShell>
    );
  }
  return (
    <CardShell icon="Receipt" title="Your first invoice draft" index={index}>
      <p style={subStyle}>
        {inv.number}: {inv.description || 'your first service'} for {fmtMoney(inv.amount, inv.currency)}. Add the client's name and send it.
      </p>
      <div style={rowStyle}>
        <Link to={`/finance?invoice=${encodeURIComponent(inv.id)}`} className="btn btn-primary" style={{ gap: 6 }}>
          Send your first invoice <Icons.Arrow size={13} sw={2}/>
        </Link>
      </div>
    </CardShell>
  );
}
