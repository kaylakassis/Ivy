// /shops - the owner's Shop area.
//   • Shop pages I run: create, edit details (address, hours, photos,
//     amenities, theme, settings), invite pros, manage the roster, share
//     link + QR, preview, publish / unpublish, counts per member.
//   • Invites waiting for my business: what will show and what never will,
//     Accept / Decline.
//   • Shop pages I am listed on: my own listing (title, bio, which services
//     show), my own counts, Leave shop.
// Everything a shop owner sees about other members is counts only; the API
// never sends another business's clients, money or messages.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import QRCodeModal from '../../components/QRCodeModal.jsx';
import { api } from '../../lib/api.js';
import { publicOrigin } from '../../lib/publicUrl.js';
import { uploadFile } from '../../lib/blobUpload.js';
import { timezoneOptions } from '../../lib/timezones.js';
import { TimeInput } from '../calendar/Drawer.jsx';
import { slugify, WEEKDAYS_LONG, minToHM } from '../calendar/utils.js';
import { WhatIsShared } from './AcceptShopInvite.jsx';
import { hoursLines } from './shopHelpers.js';

const sectionTitle = { fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 10px' };
const lbl = { display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 6 };
const hint = { fontSize: 12, color: 'var(--muted)', marginTop: 5, lineHeight: 1.45 };
const row = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' };

function Err({ children }) {
  if (!children) return null;
  return <div role="alert" style={{ padding: '10px 12px', borderRadius: 10, background: 'color-mix(in srgb, var(--danger) 10%, var(--surface))', color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>{children}</div>;
}
function Ok({ children }) {
  if (!children) return null;
  return <div role="status" style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 13, marginTop: 10 }}>{children}</div>;
}
function Toggle({ on, onChange, label, help }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', minHeight: 44, padding: '6px 0' }}>
      <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="seg-btn" style={{
        width: 40, height: 24, borderRadius: 99, border: 0, position: 'relative', flexShrink: 0, marginTop: 1,
        background: on ? 'var(--accent)' : 'var(--border-strong)', cursor: 'pointer',
      }}>
        <span style={{ position: 'absolute', top: 3, left: on ? 19 : 3, width: 18, height: 18, borderRadius: 99, background: '#fff', transition: 'left .12s' }}/>
      </button>
      <span style={{ fontSize: 13.5, lineHeight: 1.45 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {help && <span style={{ display: 'block', color: 'var(--muted)', fontSize: 12.5 }}>{help}</span>}
      </span>
    </label>
  );
}

export default function ShopsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(() => new URLSearchParams(location.search).get('shop'));

  const load = () => api.get('/shops').then(setData).catch((e) => setErr(e));
  useEffect(() => { load(); }, []);

  if (err) {
    return (
      <div className="page-pad"><div className="card" style={{ padding: 40 }}>
        <EmptyNote icon="Store" title="Could not load your shop pages" hint={err.message || 'Try again in a moment.'}
          action={<button className="btn btn-outline" onClick={() => { setErr(null); load(); }}>Retry</button>}/>
      </div></div>
    );
  }
  if (!data) return <div className="page-pad" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;

  const openShop = (id) => {
    setOpenId(id);
    const p = new URLSearchParams(location.search);
    if (id) p.set('shop', id); else p.delete('shop');
    navigate({ pathname: location.pathname, search: p.toString() }, { replace: true });
  };

  if (creating) {
    return <div className="page-pad"><CreateShop onCancel={() => setCreating(false)} onCreated={(shop) => { setCreating(false); load().then(() => openShop(shop.id)); }}/></div>;
  }
  const openOwned = data.owned.find((s) => s.id === openId);
  if (openOwned) return <div className="page-pad"><ShopEditor shopId={openOwned.id} meta={data} onBack={() => { openShop(null); load(); }}/></div>;
  const openMembership = data.memberships.find((m) => m.shop.id === openId);
  if (openMembership) return <div className="page-pad"><MyListing entry={openMembership} meta={data} onBack={() => { openShop(null); load(); }}/></div>;

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 'clamp(26px, 4.5vw, 36px)', letterSpacing: '-0.03em', margin: '0 0 6px', lineHeight: 1.05 }}>
          One page for everyone at your location.
        </h2>
        <p style={{ color: 'var(--fg-2)', fontSize: 14.5, maxWidth: 620, margin: 0, lineHeight: 1.5 }}>
          A shop page lists every pro who works at your address, with the first available time across all of them. Each pro stays their own business: their link, prices, policies, clients and money. You see booking counts, never their clients.
        </p>
      </div>

      {data.invites.length > 0 && (
        <section>
          <div style={sectionTitle}>Invites for you</div>
          <div style={{ display: 'grid', gap: 12 }}>
            {data.invites.map((inv) => <InviteCard key={inv.inviteId} inv={inv} meta={data} onDone={load}/>)}
          </div>
        </section>
      )}

      <section>
        <div style={{ ...row, justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ ...sectionTitle, margin: 0 }}>Shop pages you run</div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Icons.Plus size={14}/> New shop page</button>
        </div>
        {data.owned.length === 0 ? (
          <div className="card" style={{ padding: 28 }}>
            <EmptyNote icon="Store" title="No shop page yet"
              hint="Create one for your location, invite the pros who work there, and share one link that books any of you."
              action={<button className="btn btn-primary" onClick={() => setCreating(true)}>Create a shop page</button>}/>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {data.owned.map((s) => (
              <button key={s.id} type="button" className="card" onClick={() => openShop(s.id)}
                style={{ padding: 16, textAlign: 'left', display: 'flex', gap: 14, alignItems: 'center', cursor: 'pointer' }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, flexShrink: 0, background: s.photos?.[0] ? `url(${s.photos[0]}) center/cover` : 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {!s.photos?.[0] && <Icons.Store size={20}/>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 650 }}>{s.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>/shop/{s.slug} · {s.status === 'published' ? 'Published' : 'Draft'}{s.pageViews ? ` · ${s.pageViews} page views` : ''}</div>
                </div>
                <Icons.Arrow size={16} stroke="var(--muted)"/>
              </button>
            ))}
          </div>
        )}
        <p style={{ ...hint, marginTop: 10 }}>{data.planNote}</p>
      </section>

      {data.memberships.length > 0 && (
        <section>
          <div style={sectionTitle}>Shop pages you are listed on</div>
          <div style={{ display: 'grid', gap: 10 }}>
            {data.memberships.map((m) => (
              <button key={m.shop.id} type="button" className="card" onClick={() => openShop(m.shop.id)}
                style={{ padding: 16, textAlign: 'left', display: 'flex', gap: 14, alignItems: 'center', cursor: 'pointer' }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, flexShrink: 0, background: 'var(--surface-2)', color: 'var(--fg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icons.Users size={20}/></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 650 }}>{m.shop.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    Run by {m.shop.ownerBusinessName || 'another business'} · {m.member.status === 'active' ? (m.shop.status === 'published' ? 'Your listing is live' : 'Shows when they publish') : m.member.status === 'left' ? 'You left' : m.member.status === 'removed' ? 'You were removed' : m.member.status}
                  </div>
                </div>
                <Icons.Arrow size={16} stroke="var(--muted)"/>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Invite card (member side) ───────────────────────────────────────────
function InviteCard({ inv, meta, onDone }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const answer = async (action) => {
    setBusy(action); setErr(null);
    try { await api.post('/shops/invite', { inviteId: inv.inviteId, action }); onDone(); }
    catch (e) { setErr(e.message || 'Something went wrong'); }
    finally { setBusy(null); }
  };
  return (
    <div className="card" style={{ padding: 18, borderColor: 'var(--accent)' }}>
      <div style={{ fontSize: 15.5, fontWeight: 650 }}>{inv.shop.name} invited you to be listed on their shop page</div>
      <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 4, lineHeight: 1.5 }}>
        Run by {inv.shop.ownerBusinessName || 'another Ivy business'}{inv.shop.addressLabel ? ` at ${inv.shop.addressLabel}` : ''}. Clients who book you from it book with you directly, at your prices and under your policies. Your clients stay yours, and you can leave with one tap.
      </div>
      <WhatIsShared shared={meta.shared} neverShared={meta.neverShared}/>
      <Err>{err}</Err>
      <div style={{ ...row, marginTop: 14 }}>
        <button className="btn btn-primary" disabled={!!busy} onClick={() => answer('accept')}>{busy === 'accept' ? 'Joining…' : 'Accept'}</button>
        <button className="btn btn-outline" disabled={!!busy} onClick={() => answer('decline')}>{busy === 'decline' ? 'Declining…' : 'Decline'}</button>
      </div>
    </div>
  );
}

// ── Create ───────────────────────────────────────────────────────────────
function useSlugCheck(slug, shopId) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!slug) { setState(null); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api.get(`/shops/slug-check?slug=${encodeURIComponent(slug)}${shopId ? `&shopId=${encodeURIComponent(shopId)}` : ''}`)
        .then((r) => live && setState(r)).catch(() => live && setState(null));
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [slug, shopId]);
  return state;
}

function SlugField({ slug, onChange, shopId }) {
  const check = useSlugCheck(slug, shopId);
  const tone = !slug ? null : check == null ? 'muted' : check.valid && check.available ? 'ok' : 'danger';
  return (
    <div>
      <span style={lbl}>Web address</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, border: '1px solid var(--border-strong)', borderRadius: 10, overflow: 'hidden', background: 'var(--surface)' }}>
        <span style={{ padding: '0 0 0 12px', fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{publicOrigin().replace(/^https?:\/\//, '')}/shop/</span>
        <input className="input" value={slug} onChange={(e) => onChange(slugify(e.target.value))} placeholder="main-street-barbers"
          style={{ border: 0, borderRadius: 0, flex: 1, minWidth: 0 }} aria-label="Web address"/>
      </div>
      <div style={{ ...hint, color: tone === 'ok' ? 'var(--ok)' : tone === 'danger' ? 'var(--danger)' : 'var(--muted)' }}>
        {!slug ? 'Lowercase letters, digits and hyphens.' : check == null ? 'Checking…' : !check.valid ? 'Not a valid address. Lowercase letters, digits and hyphens, up to 40.' : check.available ? 'Available.' : 'Taken. Try another.'}
      </div>
    </div>
  );
}

function CreateShop({ onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const setNameAuto = (v) => { setName(v); if (!touched) setSlug(slugify(v)); };
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api.post('/shops', { name: name.trim(), slug }); onCreated(r.shop); }
    catch (ex) { setErr(ex.message || 'Could not create the shop page'); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="card" style={{ padding: 22, maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' }}>New shop page</div>
        <p style={{ ...hint, fontSize: 13 }}>Your hours, address and time zone are copied from your calendar to start. You can change everything after.</p>
      </div>
      <label><span style={lbl}>Shop name</span><input className="input" value={name} onChange={(e) => setNameAuto(e.target.value)} placeholder="Main Street Barbers" maxLength={120} required autoFocus/></label>
      <SlugField slug={slug} onChange={(v) => { setTouched(true); setSlug(v); }}/>
      <Err>{err}</Err>
      <div style={row}>
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim() || !slug}>{busy ? 'Creating…' : 'Create shop page'}</button>
        <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── Owner editor ─────────────────────────────────────────────────────────
function ShopEditor({ shopId, meta, onBack }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('details');
  const load = () => api.get(`/shops/${encodeURIComponent(shopId)}`).then(setDetail).catch((e) => setErr(e));
  useEffect(() => { load(); }, [shopId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="card" style={{ padding: 28 }}><EmptyNote icon="Store" title="Could not open this shop page" hint={err.message} action={<button className="btn btn-outline" onClick={onBack}>Back</button>}/></div>;
  if (!detail) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const { shop, members, stats } = detail;
  const tabs = [['details', 'Details'], ['team', 'Team'], ['share', 'Share']];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <button className="btn btn-ghost" onClick={onBack} style={{ paddingLeft: 6 }}><Icons.ArrowLeft size={15}/> All shop pages</button>
        <PublishControl shop={shop} onChange={(s) => setDetail((d) => ({ ...d, shop: s }))}/>
      </div>
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(22px, 4vw, 30px)', fontWeight: 500, letterSpacing: '-0.02em' }}>{shop.name}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
          <a href={shop.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{publicOrigin().replace(/^https?:\/\//, '')}{shop.url}</a>
          {' '}· {shop.status === 'published' ? 'Published' : 'Draft, only you can see it'} · {stats.pageViews} page view{stats.pageViews === 1 ? '' : 's'} · {stats.total} booking{stats.total === 1 ? '' : 's'} through the page ({stats.last30} in the last 30 days)
        </div>
      </div>
      <div role="tablist" className="tab-row" style={{ display: 'inline-flex', flexWrap: 'wrap' }}>
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className="seg-btn" onClick={() => setTab(id)} style={{
            padding: '7px 14px', borderRadius: 8, border: 0, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            background: tab === id ? 'var(--surface)' : 'transparent', color: tab === id ? 'var(--fg)' : 'var(--muted)', boxShadow: tab === id ? 'var(--shadow-sm)' : 'none',
          }}>{label}</button>
        ))}
      </div>
      {tab === 'details' && <DetailsForm shop={shop} meta={meta} onSaved={(s) => setDetail((d) => ({ ...d, shop: s }))}/>}
      {tab === 'team' && <TeamPanel shop={shop} members={members} meta={meta} reload={load}/>}
      {tab === 'share' && <SharePanel shop={shop} onChange={(s) => setDetail((d) => ({ ...d, shop: s }))} onDeleted={onBack}/>}
    </div>
  );
}

function PublishControl({ shop, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const flip = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.post(`/shops/${encodeURIComponent(shop.id)}/publish`, { status: shop.status === 'published' ? 'draft' : 'published' }); onChange(r.shop); }
    catch (e) { setErr(e.message || 'Could not change that'); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ textAlign: 'right' }}>
      <button className={`btn ${shop.status === 'published' ? 'btn-outline' : 'btn-primary'}`} disabled={busy} onClick={flip}>
        {busy ? 'Working…' : shop.status === 'published' ? 'Unpublish' : 'Publish'}
      </button>
      {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
    </div>
  );
}

function DetailsForm({ shop, meta, onSaved }) {
  const [f, setF] = useState(() => ({
    name: shop.name, slug: shop.slug, tagline: shop.tagline, description: shop.description, addressLabel: shop.addressLabel,
    city: shop.city, region: shop.region, country: shop.country, lat: shop.lat ?? '', lng: shop.lng ?? '', phone: shop.phone,
    timezone: shop.timezone || '', hours: shop.hours || {}, photos: shop.photos || [], amenities: shop.amenities || [], settings: { ...shop.settings },
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const [locating, setLocating] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setS = (k, v) => setF((x) => ({ ...x, settings: { ...x.settings, [k]: v } }));

  const lookup = async () => {
    const a = f.addressLabel.trim();
    if (!a) { setErr('Type an address first'); return; }
    setLocating(true); setErr(null);
    try {
      const r = await api.post('/geocode', { address: a });
      if (!r.match) { setErr('Could not find that address. Try adding the city.'); return; }
      setF((x) => ({ ...x, lat: Number(r.match.lat.toFixed(5)), lng: Number(r.match.lng.toFixed(5)) }));
      setOk('Map pin set.');
    } catch (e) { setErr(e.message || 'Could not look up that address.'); }
    finally { setLocating(false); }
  };
  const save = async (e) => {
    e?.preventDefault?.(); setBusy(true); setErr(null); setOk(null);
    try {
      const body = { ...f, lat: f.lat === '' ? null : Number(f.lat), lng: f.lng === '' ? null : Number(f.lng), timezone: f.timezone || null };
      const r = await api.patch(`/shops/${encodeURIComponent(shop.id)}`, body);
      onSaved(r.shop); setOk('Saved.');
    } catch (ex) { setErr(ex.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={save} style={{ display: 'grid', gap: 14 }}>
      <div className="card" style={{ padding: 18, display: 'grid', gap: 14 }}>
        <div style={sectionTitle}>About the shop</div>
        <label><span style={lbl}>Shop name</span><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} required/></label>
        <SlugField slug={f.slug} onChange={(v) => set('slug', v)} shopId={shop.id}/>
        <label><span style={lbl}>Tagline</span><input className="input" value={f.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={160} placeholder="Cuts, color and beards under one roof"/></label>
        <label><span style={lbl}>About</span><textarea className="input" rows={4} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} placeholder="A few lines about the shop, who works here and what to expect."/></label>
        <label><span style={lbl}>Shop phone (optional)</span><input className="input" value={f.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} placeholder="(555) 010-2030" inputMode="tel"/><div style={hint}>Shown on the page. Leave empty to show none.</div></label>
      </div>

      <div className="card" style={{ padding: 18, display: 'grid', gap: 14 }}>
        <div style={sectionTitle}>Address and map</div>
        <label><span style={lbl}>Address</span><input className="input" value={f.addressLabel} onChange={(e) => set('addressLabel', e.target.value)} maxLength={300} placeholder="123 Main St, Austin, TX 78701"/></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <label><span style={lbl}>City</span><input className="input" value={f.city} onChange={(e) => set('city', e.target.value)} maxLength={80}/></label>
          <label><span style={lbl}>State or region</span><input className="input" value={f.region} onChange={(e) => set('region', e.target.value)} maxLength={80}/></label>
          <label><span style={lbl}>Country</span><input className="input" value={f.country} onChange={(e) => set('country', e.target.value)} maxLength={80}/></label>
        </div>
        <div style={row}>
          <button type="button" className="btn btn-outline" onClick={lookup} disabled={locating || !f.addressLabel.trim()}>{locating ? 'Looking up…' : 'Set map pin from address'}</button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{f.lat !== '' && f.lng !== '' ? `Pin: ${f.lat}, ${f.lng}` : 'No map pin yet'}</span>
          {f.lat !== '' && <button type="button" className="btn btn-ghost" onClick={() => setF((x) => ({ ...x, lat: '', lng: '' }))}>Clear pin</button>}
        </div>
        <label><span style={lbl}>Time zone</span>
          <select className="input" value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
            <option value="">Not set</option>
            {timezoneOptions(f.timezone || undefined).map((o) => <option key={o.value || o} value={o.value || o}>{o.label || o}</option>)}
          </select>
          <div style={hint}>Used for "Open until" on the page.</div>
        </label>
      </div>

      <div className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <div style={sectionTitle}>Opening hours</div>
        <HoursEditor hours={f.hours} onChange={(h) => set('hours', h)}/>
        <div style={hint}>These are the shop's door hours. Each pro's bookable times still come from their own calendar.</div>
      </div>

      <div className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
        <div style={sectionTitle}>Photos</div>
        <PhotosEditor photos={f.photos} onChange={(p) => set('photos', p)} onError={setErr}/>
      </div>

      <div className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
        <div style={sectionTitle}>Good to know</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(meta.amenities || []).map((a) => {
            const on = f.amenities.includes(a.id);
            return (
              <button key={a.id} type="button" aria-pressed={on} onClick={() => set('amenities', on ? f.amenities.filter((x) => x !== a.id) : [...f.amenities, a.id])}
                style={{ minHeight: 36, padding: '5px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: on ? 'var(--fg)' : 'var(--surface)', color: on ? 'var(--page)' : 'var(--fg-2)', border: `1px solid ${on ? 'var(--fg)' : 'var(--border-strong)'}` }}>
                {a.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ padding: 18, display: 'grid', gap: 6 }}>
        <div style={sectionTitle}>Page settings</div>
        <label><span style={lbl}>Look</span>
          <select className="input" value={f.settings.theme} onChange={(e) => setS('theme', e.target.value)}>
            {(meta.themes || []).map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
          </select>
          <div style={hint}>The same looks as the website builder, so the page can match a member's site.</div>
        </label>
        <Toggle on={f.settings.firstAvailable !== false} onChange={(v) => setS('firstAvailable', v)} label="First available" help="Visitors can pick a service and get the soonest time across every pro who offers it. They see who it is before confirming."/>
        <Toggle on={f.settings.showPrices !== false} onChange={(v) => setS('showPrices', v)} label="Show prices" help="Each pro's own prices, as 'from' when they differ."/>
        <Toggle on={f.settings.showReviews !== false} onChange={(v) => setS('showReviews', v)} label="Show reviews" help="Each pro's own reviews, labelled with their name. The shop rating is count-weighted and never rounded up."/>
        <label><span style={lbl}>Booking note (optional)</span><textarea className="input" rows={2} value={f.settings.bookingRulesNote} onChange={(e) => setS('bookingRulesNote', e.target.value)} maxLength={400} placeholder="Walk-ins are welcome when a chair is free. Booked clients come first."/></label>
      </div>

      <Err>{err}</Err><Ok>{ok}</Ok>
      <div style={row}>
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <a className="btn btn-outline" href={shop.url} target="_blank" rel="noopener noreferrer">Preview</a>
      </div>
    </form>
  );
}

function HoursEditor({ hours, onChange }) {
  const dayList = [1, 2, 3, 4, 5, 6, 0];
  const setDay = (d, windows) => onChange({ ...hours, [String(d)]: windows });
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {dayList.map((d) => {
        const w = hours[String(d)] || [];
        return (
          <div key={d} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minHeight: 40 }}>
            <div style={{ width: 92, fontSize: 13.5, fontWeight: 600 }}>{WEEKDAYS_LONG[d]}</div>
            {w.length === 0 ? (
              <>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>Closed</span>
                <button type="button" className="btn btn-ghost" onClick={() => setDay(d, [{ start: 540, end: 1020 }])}>Open</button>
              </>
            ) : w.map((win, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <TimeInput minutes={win.start} onChange={(m) => setDay(d, w.map((x, j) => (j === i ? { ...x, start: m } : x)))}/>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
                <TimeInput minutes={win.end} onChange={(m) => setDay(d, w.map((x, j) => (j === i ? { ...x, end: m } : x)))}/>
                <button type="button" className="btn btn-ghost" aria-label={`Remove ${minToHM(win.start)} to ${minToHM(win.end)}`} onClick={() => setDay(d, w.filter((_, j) => j !== i))} style={{ padding: 6 }}><Icons.X size={13}/></button>
                {i === w.length - 1 && w.length < 4 && (
                  <button type="button" className="btn btn-ghost" onClick={() => setDay(d, [...w, { start: Math.min(win.end + 60, 1380), end: Math.min(win.end + 180, 1439) }])} style={{ padding: 6 }} aria-label="Add a window"><Icons.Plus size={13}/></button>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function PhotosEditor({ photos, onChange, onError }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const add = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { onError('Please pick an image file.'); return; }
    if (file.size > 5 * 1024 * 1024) { onError('Photos must be under 5 MB.'); return; }
    if (photos.length >= 12) { onError('Up to 12 photos.'); return; }
    setBusy(true);
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
      const blob = await uploadFile(`shops/photo-${Date.now()}.${ext}`, file, { access: 'public', handleUploadUrl: '/api/calendar/services/photo-token', contentType: file.type || 'image/jpeg' });
      onChange([...photos, blob.url]);
    } catch (e) { onError(e.message || 'Upload failed'); }
    finally { setBusy(false); }
  };
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= photos.length) return;
    const next = photos.slice(); [next[i], next[j]] = [next[j], next[i]]; onChange(next);
  };
  return (
    <div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" style={{ display: 'none' }}
        onChange={(e) => { add(e.target.files?.[0]); e.target.value = ''; }}/>
      {photos.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginBottom: 10 }}>
          {photos.map((u, i) => (
            <div key={u} style={{ position: 'relative', aspectRatio: '4/3', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', background: `url(${u}) center/cover` }}>
              <div style={{ position: 'absolute', bottom: 4, left: 4, right: 4, display: 'flex', gap: 4, justifyContent: 'space-between' }}>
                <button type="button" className="btn btn-outline" style={{ padding: 4, background: 'var(--surface)' }} aria-label="Move earlier" onClick={() => move(i, -1)} disabled={i === 0}><Icons.ArrowLeft size={12}/></button>
                <button type="button" className="btn btn-outline" style={{ padding: 4, background: 'var(--surface)' }} aria-label="Remove photo" onClick={() => onChange(photos.filter((x) => x !== u))}><Icons.Trash size={12}/></button>
                <button type="button" className="btn btn-outline" style={{ padding: 4, background: 'var(--surface)' }} aria-label="Move later" onClick={() => move(i, 1)} disabled={i === photos.length - 1}><Icons.Arrow size={12}/></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-outline" disabled={busy || photos.length >= 12} onClick={() => fileRef.current?.click()}>
        <Icons.Camera size={14}/> {busy ? 'Uploading…' : 'Add photo'}
      </button>
      <div style={hint}>The first photo is the cover. Up to 12, 5 MB each.</div>
    </div>
  );
}

// ── Team (owner) ─────────────────────────────────────────────────────────
function TeamPanel({ shop, members, meta, reload }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const active = members.filter((m) => m.status === 'active');
  const invited = members.filter((m) => m.status === 'invited');
  const gone = members.filter((m) => ['left', 'removed', 'declined'].includes(m.status));

  const invite = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setOk(null);
    try {
      const r = await api.post(`/shops/${encodeURIComponent(shop.id)}/members`, { email: email.trim() });
      setOk(r.sent ? `Invite sent to ${email.trim()}. It explains what shows and what stays private, and expires in ${r.ttlDays} days.` : `Added to the roster as invited, but the email could not be sent (${r.reason || 'the email service did not answer'}). You can also send them your share link.`);
      setEmail(''); reload();
    } catch (ex) { setErr(ex.message || 'Could not send the invite'); }
    finally { setBusy(false); }
  };
  const patchRoster = async (items) => {
    setErr(null);
    try { await api.patch(`/shops/${encodeURIComponent(shop.id)}/members`, { items }); reload(); }
    catch (ex) { setErr(ex.message || 'Could not update the team'); }
  };
  const remove = async (m) => {
    const what = m.status === 'invited' ? `Cancel the invite for ${m.inviteEmail || m.businessName}?` : `Remove ${m.businessName} from ${shop.name}? Their listing comes off right away and they are told. Their own booking page is unchanged.`;
    if (!window.confirm(what)) return;
    setErr(null);
    try { await api.del(`/shops/${encodeURIComponent(shop.id)}/members`, { memberId: m.id }); reload(); }
    catch (ex) { setErr(ex.message || 'Could not remove them'); }
  };
  const move = (m, dir) => {
    const list = active.slice();
    const i = list.findIndex((x) => x.id === m.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    patchRoster(list.map((x, k) => ({ id: x.id, displayOrder: k + 1 })));
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <form onSubmit={invite} className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <div style={sectionTitle}>Invite a pro</div>
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          They get an email that says exactly what the page shows about them and what it never shows. Nothing appears until they accept. They need their own Ivy business on a plan or trial.
          {' '}<button type="button" className="btn btn-ghost" style={{ padding: '0 4px', fontSize: 13 }} onClick={() => setShowPrivacy((v) => !v)}>{showPrivacy ? 'Hide' : 'What they see'}</button>
        </div>
        {showPrivacy && <WhatIsShared shared={meta.shared} neverShared={meta.neverShared}/>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pro@example.com" required style={{ flex: 1, minWidth: 220 }} aria-label="Email of the pro to invite"/>
          <button className="btn btn-primary" type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send invite'}</button>
        </div>
        <Err>{err}</Err><Ok>{ok}</Ok>
      </form>

      <div className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <div style={sectionTitle}>On the page ({active.length})</div>
        {active.map((m, i) => (
          <div key={m.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderTop: i ? '1px solid var(--border)' : 0, flexWrap: 'wrap' }}>
            {m.photoUrl ? <img src={m.photoUrl} alt="" width="44" height="44" style={{ width: 44, height: 44, borderRadius: 12, objectFit: 'cover', border: '1px solid var(--border)' }}/>
              : <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{(m.proName || m.businessName || '?')[0]}</div>}
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 15, fontWeight: 650 }}>{m.proName || m.businessName} {m.role === 'owner' && <span className="pb-chip" style={{ marginLeft: 6, fontSize: 10.5, padding: '1px 7px', borderRadius: 99, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>You</span>}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{m.businessName}{!m.planActive && ' · Plan lapsed: hidden from the page until it is active again'}</div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginTop: 4 }}>
                {m.stats ? `${m.stats.total} booking${m.stats.total === 1 ? '' : 's'} through the page · ${m.stats.last30} in 30 days · ${m.stats.upcoming} upcoming` : ''}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input className="input" defaultValue={m.title} placeholder="Title, e.g. Barber" maxLength={60} style={{ maxWidth: 220, minHeight: 36, padding: '6px 10px', fontSize: 13 }}
                  aria-label={`Title for ${m.businessName}`}
                  onBlur={(e) => { if (e.target.value !== m.title) patchRoster([{ id: m.id, title: e.target.value }]); }}/>
                <button type="button" className={`btn ${m.featured ? 'btn-primary' : 'btn-outline'}`} style={{ minHeight: 36, fontSize: 12.5 }} onClick={() => patchRoster([{ id: m.id, featured: !m.featured }])}>
                  <Icons.Star size={12}/> {m.featured ? 'Featured' : 'Feature'}
                </button>
                <button type="button" className="btn btn-ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(m, -1)} style={{ padding: 6 }}><Icons.ArrowUp size={14}/></button>
                <button type="button" className="btn btn-ghost" aria-label="Move down" disabled={i === active.length - 1} onClick={() => move(m, 1)} style={{ padding: 6 }}><Icons.ArrowDown size={14}/></button>
                {m.role !== 'owner' && <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)', fontSize: 12.5 }} onClick={() => remove(m)}>Remove</button>}
              </div>
            </div>
          </div>
        ))}
        <div style={hint}>You see how many bookings came through the page for each pro. Who booked, what they paid and their messages stay with that pro.</div>
      </div>

      {invited.length > 0 && (
        <div className="card" style={{ padding: 18, display: 'grid', gap: 8 }}>
          <div style={sectionTitle}>Invited, waiting ({invited.length})</div>
          {invited.map((m) => (
            <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minHeight: 40 }}>
              <div style={{ flex: 1, minWidth: 180, fontSize: 13.5 }}>
                <b>{m.businessName || m.inviteEmail}</b>{m.businessName && m.inviteEmail ? <span style={{ color: 'var(--muted)' }}> · {m.inviteEmail}</span> : null}
                <div style={{ fontSize: 12, color: m.inviteExpired ? 'var(--danger)' : 'var(--muted)' }}>{m.inviteExpired ? 'Invite expired' : `Expires ${m.inviteExpiresAt ? new Date(m.inviteExpiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'soon'}`}</div>
              </div>
              <button type="button" className="btn btn-outline" style={{ fontSize: 12.5 }} onClick={() => { setEmail(m.inviteEmail || ''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Resend</button>
              <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)', fontSize: 12.5 }} onClick={() => remove(m)}>Cancel</button>
            </div>
          ))}
        </div>
      )}

      {gone.length > 0 && (
        <div className="card" style={{ padding: 18 }}>
          <div style={sectionTitle}>No longer on the page</div>
          {gone.map((m) => (
            <div key={m.id} style={{ fontSize: 13, color: 'var(--muted)', padding: '4px 0' }}>
              {m.businessName || m.inviteEmail} · {m.status === 'left' ? 'left' : m.status === 'removed' ? 'removed by you' : 'declined'}{m.leftAt ? ` on ${new Date(m.leftAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
            </div>
          ))}
          <div style={hint}>Invite them again any time from the form above.</div>
        </div>
      )}
    </div>
  );
}

// ── Share (owner) ────────────────────────────────────────────────────────
function SharePanel({ shop, onChange, onDeleted }) {
  const url = `${publicOrigin()}${shop.url}`;
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState(false);
  const [joinLink, setJoinLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const copy = (text, done) => navigator.clipboard?.writeText(text).then(done).catch(() => setErr('Could not copy. Select the link and copy it by hand.'));
  const mintJoin = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.post(`/shops/${encodeURIComponent(shop.id)}/join-link`, {}); setJoinLink(r); onChange({ ...shop, hasJoinLink: true, joinLinkExpiresAt: r.expiresAt }); }
    catch (e) { setErr(e.message || 'Could not make a link'); }
    finally { setBusy(false); }
  };
  const clearJoin = async () => {
    setBusy(true); setErr(null);
    try { await api.del(`/shops/${encodeURIComponent(shop.id)}/join-link`); setJoinLink(null); onChange({ ...shop, hasJoinLink: false, joinLinkExpiresAt: null }); }
    catch (e) { setErr(e.message || 'Could not turn the link off'); }
    finally { setBusy(false); }
  };
  const del = async () => {
    if (!window.confirm(`Delete the shop page "${shop.name}"? The page goes away for good. Every pro keeps their own booking page.`)) return;
    setBusy(true); setErr(null);
    try { await api.del(`/shops/${encodeURIComponent(shop.id)}`); onDeleted(); }
    catch (e) { setErr(e.message || 'Could not delete'); setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <div style={sectionTitle}>Shop link</div>
        {shop.status !== 'published' && <div style={{ fontSize: 13, color: 'var(--warn)' }}>The page is a draft. Publish it before you share the link.</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" readOnly value={url} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220 }} aria-label="Shop page link"/>
          <button type="button" className="btn btn-primary" onClick={() => copy(url, () => { setCopied(true); setTimeout(() => setCopied(false), 1600); })}><Icons.Copy size={14}/> {copied ? 'Copied' : 'Copy link'}</button>
          <button type="button" className="btn btn-outline" onClick={() => setQr(true)}>QR code</button>
          <a className="btn btn-outline" href={shop.url} target="_blank" rel="noopener noreferrer">Preview</a>
        </div>
        <div style={hint}>Put it in the window, on receipts and on every pro's Instagram. It books any of you.</div>
      </div>

      <div className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <div style={sectionTitle}>Join link for pros</div>
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          Any Ivy business owner on a plan who opens this link can join your page in one tap, no email invite needed. It works for 14 days; make a new one to stop the old one.
        </div>
        {joinLink ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" readOnly value={joinLink.link} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220 }} aria-label="Join link"/>
            <button type="button" className="btn btn-primary" onClick={() => copy(joinLink.link, () => setErr(null))}><Icons.Copy size={14}/> Copy</button>
          </div>
        ) : shop.hasJoinLink ? (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>A join link is active until {shop.joinLinkExpiresAt ? new Date(shop.joinLinkExpiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'it expires'}. Links are shown once; make a new one if you lost it.</div>
        ) : null}
        <div style={row}>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={mintJoin}>{shop.hasJoinLink || joinLink ? 'Make a new link' : 'Make a join link'}</button>
          {(shop.hasJoinLink || joinLink) && <button type="button" className="btn btn-ghost" disabled={busy} onClick={clearJoin}>Turn the link off</button>}
        </div>
      </div>

      <div className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <div style={sectionTitle}>Delete</div>
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)' }}>Deleting the page removes it for everyone. Each pro keeps their own Ivy business and booking page.</div>
        <div><button type="button" className="btn btn-outline" style={{ color: 'var(--danger)' }} disabled={busy} onClick={del}>Delete shop page</button></div>
      </div>
      <Err>{err}</Err>
      {qr && <QRCodeModal url={url} label={shop.name} sublabel="Scan to see the team and book" onClose={() => setQr(false)}/>}
    </div>
  );
}

// ── My listing (member) ──────────────────────────────────────────────────
function MyListing({ entry, meta, onBack }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState(null);
  const load = () => api.get(`/shops/${encodeURIComponent(entry.shop.id)}`).then((d) => {
    setDetail(d);
    setF({ title: d.me?.title || '', bio: d.me?.bio || '', all: d.me?.visibleServiceIds == null, ids: new Set(d.me?.visibleServiceIds || []) });
  }).catch((e) => setErr(e));
  useEffect(() => { load(); }, [entry.shop.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !detail) return <div className="card" style={{ padding: 28 }}><EmptyNote icon="Store" title="Could not open this shop page" hint={err.message} action={<button className="btn btn-outline" onClick={onBack}>Back</button>}/></div>;
  if (!detail || !f) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const { shop, me, myStats, services, teamNames } = detail;
  const activeHere = me?.status === 'active';
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setOk(null);
    try {
      const r = await api.patch(`/shops/${encodeURIComponent(shop.id)}/listing`, { title: f.title, bio: f.bio, visibleServiceIds: f.all ? null : [...f.ids] });
      setDetail((d) => ({ ...d, me: r.me })); setOk('Saved. The page updates right away.');
    } catch (ex) { setErr(ex.message || 'Could not save'); }
    finally { setBusy(false); }
  };
  const leave = async () => {
    if (!window.confirm(`Leave ${shop.name}? Your listing comes off their page right away and nothing of yours stays on it. Your own booking page is unchanged.`)) return;
    setBusy(true); setErr(null);
    try { await api.del(`/shops/${encodeURIComponent(shop.id)}/listing`); onBack(); }
    catch (ex) { setErr(ex.message || 'Could not leave'); setBusy(false); }
  };
  const summary = hoursLines(shop.hours).filter((l) => l.text !== 'Closed');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button className="btn btn-ghost" onClick={onBack} style={{ alignSelf: 'flex-start', paddingLeft: 6 }}><Icons.ArrowLeft size={15}/> All shop pages</button>
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(22px, 4vw, 30px)', fontWeight: 500, letterSpacing: '-0.02em' }}>{shop.name}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
          {shop.addressLabel ? `${shop.addressLabel} · ` : ''}{shop.status === 'published' ? <a href={shop.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>See the page</a> : 'Not published yet'}
          {teamNames?.length ? ` · ${teamNames.length} on the page: ${teamNames.join(', ')}` : ''}
          {summary.length ? ` · ${summary.length} open days` : ''}
        </div>
      </div>

      {!activeHere ? (
        <div className="card" style={{ padding: 18, fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
          {me?.status === 'left' ? 'You left this shop page. Nothing of yours shows on it.' : me?.status === 'removed' ? 'The shop owner removed your listing. Nothing of yours shows on it.' : 'You are not listed on this page.'} The owner can invite you again.
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 18, display: 'grid', gap: 6 }}>
            <div style={sectionTitle}>Bookings through this page</div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {[['Total', myStats?.total], ['Last 30 days', myStats?.last30], ['Upcoming', myStats?.upcoming]].map(([k, v]) => (
                <div key={k}><div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 500 }}>{v ?? 0}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>{k}</div></div>
              ))}
            </div>
            <div style={hint}>Only you see these. The shop owner sees your count, never who booked or what they paid.</div>
          </div>

          <form onSubmit={save} className="card" style={{ padding: 18, display: 'grid', gap: 14 }}>
            <div style={sectionTitle}>My listing</div>
            <WhatIsShared shared={meta.shared} neverShared={meta.neverShared}/>
            <label><span style={lbl}>Title</span><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={60} placeholder="Barber, Color specialist, Massage therapist"/></label>
            <label><span style={lbl}>Short bio</span><textarea className="input" rows={3} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={600} placeholder="A couple of lines about you and what you do best."/><div style={hint}>Leave empty to show your booking page tagline.</div></label>
            <div>
              <span style={lbl}>Services shown on the page</span>
              <Toggle on={f.all} onChange={(v) => setF({ ...f, all: v })} label="Show every public service" help="Private and hidden services never show on a shop page."/>
              {!f.all && (
                <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                  {services.filter((s) => s.visibility === 'public').map((s) => (
                    <label key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13.5, minHeight: 36 }}>
                      <input type="checkbox" checked={f.ids.has(s.id)} onChange={(e) => { const ids = new Set(f.ids); if (e.target.checked) ids.add(s.id); else ids.delete(s.id); setF({ ...f, ids }); }}/>
                      <span style={{ flex: 1 }}>{s.name}</span><span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{s.price ? `$${s.price}` : 'Free'} · {s.durationMinutes} min</span>
                    </label>
                  ))}
                  {services.filter((s) => s.visibility === 'public').length === 0 && <div style={hint}>You have no public services yet. Add some in Calendar, or stay listed as a pro without bookable services.</div>}
                </div>
              )}
            </div>
            <Err>{err}</Err><Ok>{ok}</Ok>
            <div style={row}><button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save listing'}</button></div>
          </form>

          <div className="card" style={{ padding: 18, display: 'grid', gap: 8 }}>
            <div style={sectionTitle}>Leave this shop page</div>
            <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>One tap. Your listing comes off right away and nothing of yours stays on the page. Your own booking page, clients and money are not affected.</div>
            <div><button type="button" className="btn btn-outline" style={{ color: 'var(--danger)' }} disabled={busy} onClick={leave}>Leave shop</button></div>
          </div>
        </>
      )}
    </div>
  );
}
