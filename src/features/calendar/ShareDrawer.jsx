// Share booking link drawer - edit business name + handle, copy link.
// Both fields require an explicit Save (no silent on-blur). Status banner
// makes it obvious whether the handle is published yet.
import React, { useState, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { inputSty } from './Drawer.jsx';
import { slugify } from './utils.js';
import { api } from '../../lib/api.js';
import { publicOrigin } from '../../lib/publicUrl.js';
import QRCodeModal from '../../components/QRCodeModal.jsx';
import { CATEGORY_IDS } from '../../lib/categories.js';

const CATEGORIES = CATEGORY_IDS;

export default function ShareDrawer({ settings, onSave, onClose }) {
  const [bizName, setBizName] = useState(settings.bizName || '');
  const [slug, setSlug]       = useState(settings.slug || '');
  const [tagline, setTagline] = useState(settings.tagline || '');
  const [discoverable, setDiscoverable] = useState(!!settings.discoverable);
  const [leadReply, setLeadReply] = useState(settings.leadInstantReplyEnabled !== false);
  const [leadMsg, setLeadMsg]     = useState(settings.leadInstantReplyMessage || '');
  const [category, setCategory] = useState(settings.category || '');
  const [addressLabel, setAddressLabel] = useState(settings.addressLabel || '');
  const [lat, setLat]         = useState(settings.lat ?? '');
  const [lng, setLng]         = useState(settings.lng ?? '');
  const [locating, setLocating] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState(null);
  const [copied, setCopied]   = useState(false);
  const [qrOpen, setQrOpen]   = useState(false);

  // If the parent settings change (e.g. another save lands), pull them in.
  useEffect(() => { setBizName(settings.bizName || ''); }, [settings.bizName]);
  useEffect(() => { setSlug(settings.slug || ''); },       [settings.slug]);
  useEffect(() => { setTagline(settings.tagline || ''); }, [settings.tagline]);
  useEffect(() => { setDiscoverable(!!settings.discoverable); }, [settings.discoverable]);
  useEffect(() => { setLeadReply(settings.leadInstantReplyEnabled !== false); }, [settings.leadInstantReplyEnabled]);
  useEffect(() => { setLeadMsg(settings.leadInstantReplyMessage || ''); }, [settings.leadInstantReplyMessage]);
  useEffect(() => { setCategory(settings.category || ''); }, [settings.category]);
  useEffect(() => { setAddressLabel(settings.addressLabel || ''); }, [settings.addressLabel]);
  useEffect(() => { setLat(settings.lat ?? ''); }, [settings.lat]);
  useEffect(() => { setLng(settings.lng ?? ''); }, [settings.lng]);

  const dirty = bizName !== (settings.bizName || '')
    || slug !== (settings.slug || '')
    || tagline !== (settings.tagline || '')
    || discoverable !== !!settings.discoverable
    || leadReply !== (settings.leadInstantReplyEnabled !== false)
    || leadMsg !== (settings.leadInstantReplyMessage || '')
    || category !== (settings.category || '')
    || addressLabel !== (settings.addressLabel || '')
    || String(lat ?? '') !== String(settings.lat ?? '')
    || String(lng ?? '') !== String(settings.lng ?? '');

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setErr('Geolocation is not supported in this browser.');
      return;
    }
    setLocating(true); setErr(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(5));
        setLng(pos.coords.longitude.toFixed(5));
        setLocating(false);
      },
      (e) => { setLocating(false); setErr(e.message || 'Could not read your location.'); },
      { maximumAge: 5 * 60 * 1000, timeout: 10000 },
    );
  };

  // Resolve the typed address to coordinates via /api/geocode (Nominatim).
  // Owner reviews + accepts before save, so an imperfect match is fine.
  const lookupAddress = async () => {
    const a = addressLabel.trim();
    if (!a) { setErr('Type an address first'); return; }
    setLocating(true); setErr(null);
    try {
      const r = await api.post('/geocode', { address: a });
      if (!r.match) {
        setErr("Couldn't find that address. Try adding the city, or paste coordinates manually.");
        return;
      }
      setLat(r.match.lat.toFixed(5));
      setLng(r.match.lng.toFixed(5));
      // If the geocoder gave a more canonical label (e.g. "123 Main St,
      // Austin, TX 78701, USA"), suggest it but don't overwrite - owner
      // chose what to show on their card.
    } catch (e) {
      setErr(e.message || 'Could not look up that address.');
    } finally {
      setLocating(false);
    }
  };
  const savedSlug = settings.slug || null;
  const isPublished = !!savedSlug;
  const shareUrl = savedSlug ? `${publicOrigin()}/book/${savedSlug}` : '';

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const latNum = lat === '' ? null : Number(lat);
      const lngNum = lng === '' ? null : Number(lng);
      await onSave({
        bizName: bizName.trim() || 'My business',
        slug: slug ? slug.toLowerCase().trim() : null,
        tagline: tagline.trim() || null,
        discoverable,
        leadInstantReplyEnabled: leadReply,
        leadInstantReplyMessage: leadMsg.trim() || null,
        category: category || null,
        addressLabel: addressLabel.trim() || null,
        lat: Number.isFinite(latNum) ? latNum : null,
        lng: Number.isFinite(lngNum) ? lngNum : null,
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

      <Field label="Tagline" hint="Optional one-liner shown on your booking page and in Discover.">
        <input value={tagline}
          onChange={(e) => setTagline(e.target.value.slice(0, 140))}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          placeholder="Massage therapy in downtown Austin"
          maxLength={140}
          style={inputSty}/>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, textAlign: 'right' }}>
          {tagline.length}/140
        </div>
      </Field>

      {/* Instant lead reply. Auto-acknowledges website contact-form leads
          with the booking link so nobody waits. On by default. */}
      <div style={{
        padding: '12px 14px', borderRadius: 10, marginBottom: 16,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
      }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={leadReply}
            onChange={(e) => setLeadReply(e.target.checked)}
            style={{ marginTop: 3 }}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icons.Mail size={13} sw={1.7}/> Instant reply to new leads
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              When someone messages you through your website contact form, auto-send them a friendly reply with your booking link, so no lead waits while you're busy.
            </div>
          </div>
        </label>
        {leadReply && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 6 }}>
              Custom message <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(optional — leave blank for the default)</span>
            </div>
            <textarea value={leadMsg}
              onChange={(e) => setLeadMsg(e.target.value.slice(0, 2000))}
              placeholder="Thanks for reaching out, {{firstName}}! I'll get back to you shortly. In the meantime, feel free to grab a time on my calendar."
              rows={3}
              style={{ ...inputSty, resize: 'vertical', lineHeight: 1.5 }}/>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Use <code>{'{{firstName}}'}</code> and <code>{'{{businessName}}'}</code> to personalize. Your booking link is added automatically.
            </div>
          </div>
        )}
      </div>

      {/* Discover opt-in. Only meaningful once a handle is saved - Discover
          listings link to /book/<slug>, so a business with no slug has nothing
          to point at. */}
      <div style={{
        padding: '12px 14px', borderRadius: 10, marginBottom: 16,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        opacity: isPublished ? 1 : 0.55,
      }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: isPublished ? 'pointer' : 'not-allowed' }}>
          <input type="checkbox" checked={discoverable}
            disabled={!isPublished}
            onChange={(e) => setDiscoverable(e.target.checked)}
            style={{ marginTop: 3 }}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icons.Globe size={13} sw={1.7}/> List me in Discover
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              {isPublished
                ? "Show your business in the Ivy directory. Any signed-in user can find you and book through your public link."
                : "Save a handle above first - Discover entries link to your public booking page."}
            </div>
            {discoverable && isPublished && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 6 }}>
                    Category <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(helps clients find you)</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {CATEGORIES.map((c) => {
                      const on = category === c;
                      return (
                        <button type="button" key={c}
                          onClick={() => setCategory(on ? '' : c)}
                          style={{
                            padding: '4px 10px', borderRadius: 99, fontSize: 11.5, fontWeight: 600,
                            background: on ? 'var(--fg)' : 'var(--surface)',
                            color: on ? 'var(--page)' : 'var(--fg-2)',
                            border: `1px solid ${on ? 'var(--fg)' : 'var(--border)'}`,
                            cursor: 'pointer',
                          }}>{c}</button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 6 }}>
                    Location <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(powers distance search)</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={addressLabel}
                      onChange={(e) => setAddressLabel(e.target.value.slice(0, 140))}
                      placeholder="e.g. 123 Main St, Austin, TX"
                      maxLength={140}
                      style={{
                        flex: 1, padding: '8px 10px', borderRadius: 8,
                        border: '1px solid var(--border-strong)', background: 'var(--surface)',
                        color: 'var(--fg)', fontSize: 13,
                      }}/>
                    <button type="button" onClick={lookupAddress} disabled={locating || !addressLabel.trim()}
                      className="btn btn-outline" style={{ fontSize: 11.5, padding: '5px 10px', whiteSpace: 'nowrap' }}>
                      {locating ? 'Looking up…' : 'Find coordinates'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input value={lat} placeholder="lat"
                      type="number" inputMode="decimal" step="0.00001"
                      onChange={(e) => setLat(e.target.value)}
                      style={{
                        width: 100, padding: '6px 8px', borderRadius: 6,
                        border: '1px solid var(--border-strong)', background: 'var(--surface)',
                        color: 'var(--fg)', fontSize: 12.5, fontFamily: 'ui-monospace, monospace',
                      }}/>
                    <input value={lng} placeholder="lng"
                      type="number" inputMode="decimal" step="0.00001"
                      onChange={(e) => setLng(e.target.value)}
                      style={{
                        width: 110, padding: '6px 8px', borderRadius: 6,
                        border: '1px solid var(--border-strong)', background: 'var(--surface)',
                        color: 'var(--fg)', fontSize: 12.5, fontFamily: 'ui-monospace, monospace',
                      }}/>
                    <button type="button" onClick={useMyLocation} disabled={locating}
                      className="btn btn-ghost" style={{ fontSize: 11.5, padding: '5px 10px', color: 'var(--muted)' }}>
                      {locating ? '…' : 'or use my current location'}
                    </button>
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.45 }}>
                    Without coordinates, your business won't show up when clients search by distance - but you'll still match category, price, and service searches.
                  </div>
                </div>
              </div>
            )}
          </div>
        </label>
      </div>

      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 14,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      {/* Save button - explicit so users don't have to know about blur events. */}
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

      {/* Shareable link card - only fully active once we have a saved handle */}
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
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={copy} disabled={!isPublished}
            style={{ flex: 1, justifyContent: 'center', opacity: isPublished ? 1 : 0.5, minWidth: 120 }}>
            {copied
              ? <><Icons.Check size={14} sw={2.2}/> Copied</>
              : <><Icons.Copy size={14}/> Copy link</>}
          </button>
          <button className="btn btn-outline" type="button"
            onClick={() => setQrOpen(true)} disabled={!isPublished}
            style={{ opacity: isPublished ? 1 : 0.5 }}
            title="Generate a printable QR for this booking link">
            <Icons.Image size={14}/> QR code
          </button>
          <a className="btn btn-outline" href={shareUrl || '#'} target="_blank" rel="noreferrer"
            style={{ pointerEvents: isPublished ? 'auto' : 'none', opacity: isPublished ? 1 : 0.5 }}>
            <Icons.Arrow size={14}/> Open
          </a>
        </div>
        {qrOpen && (
          <QRCodeModal
            url={shareUrl}
            label={`${savedSlug || 'Booking link'} QR`}
            sublabel="Print on flyers, drop in stories, stick on the front desk - anyone who scans lands on your booking page."
            onClose={() => setQrOpen(false)}
          />
        )}
        {isPublished && <LinkTest slug={savedSlug}/>}
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        Anyone with the link can see your available slots and book - they can't see your other
        bookings, clients, or notes.
      </div>

      {isPublished && <EmbedSnippets slug={savedSlug}/>}
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

// Hits /api/calendar/public/<slug> directly so the owner can see whether the
// public booking page is actually serving - useful when the deploy is lagging
// or schema isn't migrated.
function LinkTest({ slug }) {
  const [state, setState] = useState({ kind: 'idle' });

  const test = async () => {
    setState({ kind: 'pending' });
    try {
      const res = await fetch('/api/calendar/public/' + encodeURIComponent(slug), { credentials: 'omit' });
      if (res.ok) {
        const j = await res.json();
        const services = j.calendar?.services?.length || 0;
        setState({ kind: 'ok', text: `Live · ${services} service${services === 1 ? '' : 's'} published` });
      } else {
        const txt = await res.text().catch(() => '');
        let detail = '';
        try { detail = JSON.parse(txt).error || ''; } catch { detail = txt.slice(0, 200); }
        setState({ kind: 'error', status: res.status, text: detail || res.statusText });
      }
    } catch (e) {
      setState({ kind: 'error', text: e.message || 'Network error' });
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <button className="btn btn-ghost" onClick={test}
          style={{ fontSize: 12, padding: '4px 8px' }}>
          <Icons.Globe size={12}/> Test link
        </button>
        {state.kind === 'pending' && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Checking…</span>}
        {state.kind === 'ok'      && <span style={{ fontSize: 11.5, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icons.Check size={12} sw={2.4}/>{state.text}</span>}
        {state.kind === 'error'   && <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>{state.status ? `${state.status}: ` : ''}{state.text}</span>}
      </div>
    </>
  );
}

// Embed snippets - copyable <script> tags owners drop onto their own
// website to render an Ivy booking widget or contact form. The
// script's loader lives at /embed.js (in public/); the inner page is
// our /embed/book/:slug or /embed/contact/:slug route. Auto-sized via
// postMessage so the host never has to set a fixed iframe height.
function EmbedSnippets({ slug }) {
  const origin = (typeof window !== 'undefined' && window.location)
    ? window.location.origin : 'https://joinivy.ai';
  const bookSnippet = `<script async src="${origin}/embed.js" data-Ivy="book" data-slug="${slug}"></script>`;
  const contactSnippet = `<script async src="${origin}/embed.js" data-Ivy="contact" data-slug="${slug}"></script>`;
  const [tab, setTab] = useState('book'); // 'book' | 'contact'
  const [copied, setCopied] = useState(false);

  const current = tab === 'book' ? bookSnippet : contactSnippet;
  const copy = () => {
    if (!navigator?.clipboard) return;
    navigator.clipboard.writeText(current).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>Embed on your existing website</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>
          One-line snippet - drops a booking widget or a lead-capture form
          right into your Squarespace / Wix / WordPress / Instagram-link page.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => setTab('book')}
          className={`btn ${tab === 'book' ? 'btn-primary' : 'btn-outline'}`}
          style={{ padding: '5px 12px', fontSize: 12.5 }}>
          Booking widget
        </button>
        <button onClick={() => setTab('contact')}
          className={`btn ${tab === 'contact' ? 'btn-primary' : 'btn-outline'}`}
          style={{ padding: '5px 12px', fontSize: 12.5 }}>
          Lead form
        </button>
      </div>

      <pre style={{
        margin: 0, padding: '10px 12px',
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: 8, fontSize: 11.5, lineHeight: 1.55,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--fg-2)',
      }}>{current}</pre>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={copy} className="btn btn-outline" style={{ padding: '6px 12px', fontSize: 12.5 }}>
          {copied ? <><Icons.Check size={12} sw={2.4}/> Copied</> : <><Icons.Copy size={12}/> Copy snippet</>}
        </button>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          Paste anywhere HTML is allowed. Iframe auto-resizes to fit.
        </span>
      </div>
    </div>
  );
}
