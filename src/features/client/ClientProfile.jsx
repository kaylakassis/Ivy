// /me/profile - the client's own settings, grouped:
//   Your details        photo (upload + crop to a circle), name, email
//                       (read-only), phone, address
//   Sign-in and security password reset, 2-step verification
//   Payment methods     cards saved with each business
//   Notifications       link to /me/notifications
//   Privacy             blocked businesses, reports, download my data,
//                       delete my account (client-only accounts)
//
// Phone / address / photo live on each business's client record and are
// saved to all of them at once (api/me/profile.js). Email is the sign-in
// and the key that links businesses to this person; there is no verified
// email-change flow yet, so it stays read-only with a support contact.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SkelLine, SkelBlock } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { isNative } from '../../lib/platform.js';
import { uploadUserFile } from '../../lib/blobUpload.js';
import { BlockedCard, ReportsCard, clientModeration } from '../../components/Moderation.jsx';
import TwoFactor from '../account/TwoFactor.jsx';
import { useClientPortal } from './clientContext.jsx';
import { SectionTitle, Sheet, ErrorNote, actionBtn } from './portalUi.jsx';

const SUPPORT_EMAIL = 'support@joinivy.ai';

export default function ClientProfile() {
  const { data: portal } = useClientPortal();
  const { refresh: refreshUser } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');

  const load = useCallback(() => api.get('/me/profile')
    .then((r) => {
      setProfile(r.profile);
      setName(r.profile.name || '');
      setPhone(r.profile.phone || '');
      setAddress(r.profile.address || '');
    })
    .catch((e) => setLoadErr(e.message || 'Could not load your profile')), []);
  useEffect(() => { load(); }, [load]);

  const dirty = !!profile && (
    name !== (profile.name || '') || phone !== (profile.phone || '') || address !== (profile.address || ''));

  const save = async (e) => {
    e?.preventDefault();
    setBusy(true); setErr(null); setSaved(false);
    try {
      const r = await api.patch('/me/profile', { name, phone, address });
      setProfile(r.profile);
      setSaved(true);
      Promise.resolve(refreshUser?.()).catch(() => {});
      setTimeout(() => setSaved(false), 2500);
    } catch (e2) {
      setErr(e2.message || 'Could not save your details');
    } finally {
      setBusy(false);
    }
  };

  if (loadErr && !profile) {
    return (
      <div className="page-pad"><div className="portal-page">
        <ErrorNote>{loadErr}</ErrorNote>
        <button className="btn btn-primary" style={{ ...actionBtn, alignSelf: 'flex-start' }} onClick={() => { setLoadErr(null); load(); }}>Try again</button>
      </div></div>
    );
  }
  if (!profile) {
    return (
      <div className="page-pad"><div className="portal-page" aria-busy="true" aria-label="Loading">
        <SkelBlock height={360} radius={16}/>
        <SkelLine width="40%" height={14}/>
        <SkelBlock height={160} radius={16}/>
      </div></div>
    );
  }

  const isClientOnly = portal && !portal.isOwner && !portal.isHelper;

  return (
    <div className="page-pad"><div className="portal-page" style={{ maxWidth: 640 }}>
      <section aria-label="Your details">
        <SectionTitle>Your details</SectionTitle>
        <form onSubmit={save} className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <PhotoField userId={portal?.user?.id} photoUrl={profile.photoUrl} name={name}
            onSaved={(p) => setProfile((cur) => ({ ...cur, photoUrl: p.photoUrl }))}/>
          <Field label="Name" hint="Shown to the businesses you book with.">
            <input type="text" className="input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Your full name" maxLength={120} required autoComplete="name" style={inputStyle}/>
          </Field>
          <Field label="Email" hint={<>Used to sign in. To change your email, contact <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Change my email')}`} style={{ color: 'var(--accent)' }}>{SUPPORT_EMAIL}</a>.</>}>
            <input type="email" className="input" value={profile.email || ''} readOnly aria-readonly="true"
              style={{ ...inputStyle, opacity: 0.7 }}/>
          </Field>
          <Field label="Phone" hint={<>So businesses can reach you. Text reminders also need your OK under <Link to="/me/notifications" style={{ color: 'var(--accent)' }}>Notifications</Link>.</>}>
            <input type="tel" inputMode="tel" autoComplete="tel" className="input" value={phone}
              onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 555 1234" style={inputStyle}/>
          </Field>
          <Field label="Address" hint="Only needed for businesses that come to you.">
            <textarea className="input" value={address} onChange={(e) => setAddress(e.target.value)}
              placeholder="Street, city, postal code" rows={2} maxLength={500} autoComplete="street-address"
              style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }}/>
          </Field>
          <ErrorNote>{err}</ErrorNote>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={!dirty || busy} style={actionBtn}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            {saved && (
              <span role="status" style={{ fontSize: 13.5, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icons.Check size={14}/> Saved
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Your phone, address and photo are shared with every business you are a client of.
          </div>
        </form>
      </section>

      <section aria-label="Sign-in and security">
        <SectionTitle id="security">Sign-in and security</SectionTitle>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingBottom: 16, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14.5 }}>Password</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>We email you a link to choose a new one.</div>
            </div>
            <Link to="/forgot-password" className="btn btn-outline" style={actionBtn}>Reset password</Link>
          </div>
          <TwoFactor bare/>
        </div>
      </section>

      <section aria-label="Payment methods">
        <SectionTitle id="payment-methods" action={<Link to="/me/invoices#cards" style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>Manage</Link>}>
          Payment methods
        </SectionTitle>
        <PaymentMethodsCard/>
      </section>

      <section aria-label="Notifications">
        <SectionTitle>Notifications</SectionTitle>
        <Link to="/me/notifications" className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'inherit' }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icons.Bell size={17}/>
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 600, fontSize: 14.5 }}>Emails and texts</span>
            <span style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Choose which reminders and updates you get</span>
          </span>
          <Icons.Arrow size={14} stroke="var(--muted)"/>
        </Link>
      </section>

      <section aria-label="Privacy" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SectionTitle id="privacy">Privacy</SectionTitle>
        <BlockedCard id="blocked"
          hint="Blocked businesses can't message you and you can't message them. You can unblock any time."
          load={clientModeration.loadBlocks}
          labelOf={(b) => b.businessName || 'Business'}
          unblock={(b) => clientModeration.unblock(b.workspaceId)}/>
        <ReportsCard id="reports" load={clientModeration.loadReports} subjectOf={(r) => r.businessName}/>
        <MyDataCard email={profile.email} canDelete={isClientOnly}/>
      </section>
    </div></div>
  );
}

// ── Photo: pick, crop to a circle, upload to the person's own folder ────
function PhotoField({ userId, photoUrl, name, onSaved }) {
  const fileRef = useRef(null);
  const [src, setSrc] = useState(null);      // object URL being cropped
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [linkMode, setLinkMode] = useState(false);
  const [link, setLink] = useState('');
  const initials = (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';

  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setErr(null);
    if (!/^image\//.test(f.type || 'image/')) { setErr('Please choose a photo.'); return; }
    if (f.size > 25 * 1024 * 1024) { setErr('That photo is too large. Please choose one under 25 MB.'); return; }
    setSrc(URL.createObjectURL(f));
  };

  const savePhotoUrl = async (url) => {
    const r = await api.patch('/me/profile', { photoUrl: url });
    onSaved(r.profile);
  };

  const upload = async (blob) => {
    setBusy(true); setErr(null);
    try {
      const up = await uploadUserFile(userId, 'photo.jpg', blob, {
        access: 'public', handleUploadUrl: '/api/me/photo-token', contentType: 'image/jpeg',
      });
      await savePhotoUrl(up.url);
      setSrc(null);
    } catch (e) {
      const msg = e?.message || '';
      setErr(/aren't available/i.test(msg)
        ? 'Photo uploads are not available right now. You can paste a link to a photo instead.'
        : 'Your photo did not upload. Please try again.');
      if (/aren't available/i.test(msg)) setLinkMode(true);
      setSrc(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Remove your photo?')) return;
    setBusy(true); setErr(null);
    try { await savePhotoUrl(null); } catch (e) { setErr(e.message || 'Could not remove it'); } finally { setBusy(false); }
  };

  const saveLink = async () => {
    setBusy(true); setErr(null);
    try { await savePhotoUrl(link.trim()); setLinkMode(false); setLink(''); } catch (e) { setErr(e.message || 'Could not use that link'); } finally { setBusy(false); }
  };

  const showPhoto = photoUrl && /^https:\/\//i.test(photoUrl);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{
          width: 84, height: 84, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
          background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 28, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border)',
        }}>
          {showPhoto ? <img src={photoUrl} alt="Your photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/> : initials}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '1 1 160px' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-outline" onClick={() => fileRef.current?.click()} disabled={busy || !userId} style={actionBtn}>
              <Icons.Camera size={14} sw={1.8}/> {busy ? 'Saving…' : showPhoto ? 'Change photo' : 'Add a photo'}
            </button>
            {photoUrl && (
              <button type="button" className="btn btn-ghost" onClick={remove} disabled={busy} style={{ ...actionBtn, color: 'var(--muted)' }}>
                Remove
              </button>
            )}
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>A clear photo of your face helps businesses recognise you.</span>
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*" onChange={pick} hidden/>
      </div>
      {linkMode && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input type="url" className="input" value={link} onChange={(e) => setLink(e.target.value)}
            placeholder="https://..." maxLength={1000} style={{ ...inputStyle, flex: '1 1 200px' }} aria-label="Photo link"/>
          <button type="button" className="btn btn-outline" onClick={saveLink} disabled={busy || !/^https:\/\//i.test(link.trim())} style={actionBtn}>Use link</button>
        </div>
      )}
      <ErrorNote>{err}</ErrorNote>
      {src && <CropSheet src={src} busy={busy} onCancel={() => setSrc(null)} onDone={upload} onError={(m) => { setErr(m); setSrc(null); }}/>}
    </div>
  );
}

// Square stage with a circular mask: drag to move, slider to zoom. The
// result is drawn to a 512x512 canvas and saved as a small JPEG, so what
// gets uploaded is exactly what the circle showed.
const STAGE = 260;
const OUT = 512;
function CropSheet({ src, busy, onCancel, onDone, onError }) {
  const [img, setImg] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef(null);

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => onError("We couldn't open that photo. Please try a JPG or PNG.");
    i.src = src;
  }, [src, onError]);

  // Base scale makes the shorter side fill the circle.
  const base = img ? STAGE / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = base * zoom;
  const w = img ? img.naturalWidth * scale : 0;
  const h = img ? img.naturalHeight * scale : 0;
  const clamp = (p) => ({
    x: Math.min(Math.max(p.x, (STAGE - w) / 2 - 0), (w - STAGE) / 2),
    y: Math.min(Math.max(p.y, (STAGE - h) / 2), (h - STAGE) / 2),
  });
  const cur = img ? clamp(pos) : pos;

  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, start: cur }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    if (!drag.current) return;
    setPos(clamp({ x: drag.current.start.x + (e.clientX - drag.current.x), y: drag.current.start.y + (e.clientY - drag.current.y) }));
  };
  const onUp = () => { drag.current = null; };

  const done = () => {
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUT; canvas.height = OUT;
    const ctx = canvas.getContext('2d');
    const k = OUT / STAGE;
    // Image top-left within the stage, centred then offset by the drag.
    const left = (STAGE - w) / 2 + cur.x;
    const top = (STAGE - h) / 2 + cur.y;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUT, OUT);
    ctx.drawImage(img, left * k, top * k, w * k, h * k);
    canvas.toBlob((blob) => {
      if (!blob) { onError('Your photo could not be prepared. Please try another one.'); return; }
      onDone(blob);
    }, 'image/jpeg', 0.88);
  };

  return (
    <Sheet onClose={onCancel} busy={busy} labelledBy="crop-title" maxWidth={400}>
      <div id="crop-title" style={{ fontSize: 16, fontWeight: 650 }}>Position your photo</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: -6 }}>Drag to move. Use the slider to zoom.</div>
      <div
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={{
          width: STAGE, height: STAGE, margin: '0 auto', position: 'relative', overflow: 'hidden',
          borderRadius: 16, background: '#111', touchAction: 'none', cursor: 'grab', userSelect: 'none',
        }}>
        {img && (
          <img src={src} alt="" draggable={false} style={{
            position: 'absolute', left: (STAGE - w) / 2 + cur.x, top: (STAGE - h) / 2 + cur.y,
            width: w, height: h, maxWidth: 'none', pointerEvents: 'none',
          }}/>
        )}
        {/* Darken everything outside the circle. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0, borderRadius: '50%', pointerEvents: 'none',
          boxShadow: '0 0 0 400px rgba(0,0,0,0.55)', border: '2px solid rgba(255,255,255,0.85)',
        }}/>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--fg-2)' }}>
        <span>Zoom</span>
        <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
          style={{ flex: 1 }} aria-label="Zoom"/>
      </label>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy} style={{ ...actionBtn, flex: 1 }}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={done} disabled={busy || !img} style={{ ...actionBtn, flex: 2 }}>
          {busy ? 'Saving…' : 'Use this photo'}
        </button>
      </div>
    </Sheet>
  );
}

// ── Privacy: download my data, delete my account ────────────────────────
function MyDataCard({ email, canDelete }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const native = isNative();

  const emailCopy = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.post('/me/export');
      setMsg(r.attached ? `We emailed your data to ${email}.` : `We emailed ${email} with how to download your data.`);
    } catch (e) {
      setErr(e.message || 'Could not send it. Please try again later.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14.5 }}>Your data</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>
          Get a copy of your bookings, invoices, messages and documents with every business you see on Ivy.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {!native && (
            <a href="/api/me/export" download className="btn btn-outline" style={{ ...actionBtn, textDecoration: 'none' }}>
              <Icons.ArrowDown size={14} sw={1.8}/> Download my data
            </a>
          )}
          <button type="button" className="btn btn-outline" onClick={emailCopy} disabled={busy} style={actionBtn}>
            <Icons.Mail size={14} sw={1.8}/> {busy ? 'Sending…' : 'Email me a copy'}
          </button>
        </div>
        {msg && <div role="status" style={{ fontSize: 13, color: 'var(--ok)', marginTop: 8 }}>{msg}</div>}
        {err && <div style={{ marginTop: 8 }}><ErrorNote>{err}</ErrorNote></div>}
      </div>
      {canDelete && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 14.5 }}>Delete my account</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>
            Closes your Ivy sign-in and portal. The businesses you see keep their own records of your visits and payments.
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => setDeleting(true)}
            style={{ ...actionBtn, color: 'var(--danger)', marginTop: 8, paddingLeft: 0 }}>
            Delete my account
          </button>
        </div>
      )}
      {deleting && <DeleteAccountSheet email={email} onClose={() => setDeleting(false)}/>}
    </div>
  );
}

function DeleteAccountSheet({ email, onClose }) {
  const nav = useNavigate();
  const { signOut } = useAuth();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const matches = confirm.trim().toLowerCase() === (email || '').toLowerCase();
  const submit = async (e) => {
    e.preventDefault();
    if (!matches) { setErr("That email doesn't match."); return; }
    setBusy(true); setErr(null);
    try {
      await api.post('/account/delete', { confirmEmail: confirm.trim() });
      try { await signOut(); } catch { /* already signed out server side */ }
      nav('/signin', { replace: true });
    } catch (ex) {
      setErr(ex.message || 'Could not delete your account');
      setBusy(false);
    }
  };
  return (
    <Sheet onClose={onClose} busy={busy} labelledBy="del-title" maxWidth={440}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div id="del-title" style={{ fontSize: 16, fontWeight: 650 }}>Delete your account?</div>
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          You will be signed out and your portal closes. You have 30 days to change your mind: we email you a link to restore it.
          The businesses you see keep their own records.
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--fg-2)' }}>
          To confirm, type your email: <strong style={{ color: 'var(--fg)', overflowWrap: 'anywhere' }}>{email}</strong>
          <input type="email" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off" required style={inputStyle}/>
        </label>
        <ErrorNote>{err}</ErrorNote>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy} style={{ ...actionBtn, flex: 1 }}>Keep account</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !matches}
            style={{ ...actionBtn, flex: 1, background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

// Profile → Payment methods. Cards a client saved while paying an invoice
// are kept per business on that business's payment processor; Ivy only
// knows the brand and last four digits. Removing a card detaches it there
// too, so the business can no longer charge it.
export function PaymentMethodsCard() {
  const [cards, setCards] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () => api.get('/me/payment-methods')
    .then((r) => setCards((r.cards || []).filter((c) => c.hasCard)))
    .catch((e) => setErr(e.message || 'Could not load your cards'));
  useEffect(() => { load(); }, []);

  const remove = async (c) => {
    if (!window.confirm(`Remove the ${capitalize(c.brand) || 'card'} ending in ${c.last4} saved with ${c.businessName}?`)) return;
    setBusy(c.clientId); setErr(null);
    try {
      await api.del('/me/payment-methods/' + encodeURIComponent(c.clientId));
      await load();
    } catch (e) {
      setErr(e.message || 'Could not remove the card');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div id="payment-methods-card" className="card" style={{ padding: 18 }}>
      {err && <div style={{ marginBottom: 10 }}><ErrorNote>{err}</ErrorNote></div>}
      {cards === null ? (
        <SkelLine width="60%" height={14}/>
      ) : cards.length === 0 ? (
        <div style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          No saved cards. When you pay an invoice by card you can save it for next time.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {cards.map((c, i) => (
            <div key={c.clientId} style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            }}>
              <div style={{
                width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><Icons.Lock size={15} sw={1.7}/></div>
              <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600 }}>{c.businessName}</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
                  {capitalize(c.brand) || 'Card'} ending in {c.last4}
                  {c.expMonth ? `, expires ${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}` : ''}
                </div>
              </div>
              <button type="button" className="btn btn-ghost" disabled={busy === c.clientId} onClick={() => remove(c)}
                style={{ ...actionBtn, color: 'var(--danger)' }}>
                {busy === c.clientId ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function capitalize(s) {
  if (!s) return s;
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)' }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{hint}</span>}
    </label>
  );
}

const inputStyle = { padding: '11px 12px', fontSize: 16, width: '100%' };
