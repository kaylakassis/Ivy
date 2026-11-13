// Editor-toolbar modal that surfaces the "advanced" site features:
//   • Domain - set a custom domain + verify the DNS
//   • Forms  - send contact/newsletter forms to an email or another app
//   • Redirects - "old page address sends people to a new one" (301s)
//   • Popups - exit-intent + sticky CTA
//   • History - list / restore previous publishes
//   • Traffic - 30-day pageview rollup
//
// One panel keeps the toolbar uncluttered while giving owners a single
// place to find every "make my live site behave differently" knob.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { EditorContext, LinkField } from './editorKit.jsx';

const TABS = [
  { id: 'domain',    label: 'Domain',    icon: 'Globe' },
  { id: 'forms',     label: 'Forms',     icon: 'Mail' },
  { id: 'redirects', label: 'Redirects', icon: 'Arrow' },
  { id: 'popups',    label: 'Popups',    icon: 'Spark' },
  { id: 'history',   label: 'History',   icon: 'Clock' },
  { id: 'traffic',   label: 'Traffic',   icon: 'Trending' },
];

export default function AdvancedPanel({ site, set, onClose, restoreVersion }) {
  const [tab, setTab] = useState('domain');
  // The link pickers below offer the site's own pages.
  const ctx = { pages: site.pages || [], sections: [], mobile: false, onOpenLibrary: null };
  return (
    <EditorContext.Provider value={ctx}>
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxWidth: 720, maxHeight: '85vh',
        background: 'var(--surface)', border: '1px solid var(--border-strong)',
        borderRadius: 12, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Advanced</div>
          <div style={{ flex: 1 }}/>
          <button onClick={onClose} className="btn btn-ghost" style={{ padding: 6 }}>
            <Icons.X size={14}/>
          </button>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: 10, borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
          {TABS.map((t) => {
            const Icon = Icons[t.icon] || Icons.More;
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
                fontSize: 12, fontWeight: 600, borderRadius: 8,
                border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                color: on ? 'var(--accent)' : 'var(--fg-2)',
                whiteSpace: 'nowrap', cursor: 'pointer',
              }}>
                <Icon size={12}/>{t.label}
              </button>
            );
          })}
        </div>
        <div className="scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
          {tab === 'domain'    && <DomainTab    site={site} set={set}/>}
          {tab === 'forms'     && <FormsTab     site={site} set={set}/>}
          {tab === 'redirects' && <RedirectsTab site={site} set={set}/>}
          {tab === 'popups'    && <PopupsTab    site={site} set={set}/>}
          {tab === 'history'   && <HistoryTab   site={site} restoreVersion={restoreVersion}/>}
          {tab === 'traffic'   && <TrafficTab   site={site}/>}
        </div>
      </div>
    </div>
    </EditorContext.Provider>
  );
}

// ---------- Domain ----------
function DomainTab({ site, set }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const verify = async () => {
    setBusy(true); setResult(null);
    try { setResult(await api.post('/website/verify-domain')); }
    catch (e) { setResult({ error: e.message }); }
    finally { setBusy(false); }
  };
  const status = site.domainStatus || (site.customDomain ? 'unverified' : null);
  const statusStyle = {
    verified:    { color: '#0E8A4D', label: 'Verified' },
    dns_pending: { color: '#9A6B12', label: 'Waiting for your domain settings' },
    unverified:  { color: 'var(--muted)', label: 'Waiting for your domain settings' },
    failed:      { color: 'var(--danger)', label: 'Failed' },
  }[status || 'unverified'] || { color: 'var(--muted)', label: 'No domain' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        Use a domain you own, like rivers.com. Once it is connected, your site opens at your own address and search engines pick up the new address on their own.
      </div>
      <Field label="Your domain name">
        <input type="text" value={site.customDomain || ''}
          onChange={(e) => set({ customDomain: e.target.value })}
          placeholder="rivers.com"
          style={inputS}/>
      </Field>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: -6 }}>Just the name, with no "www" or "https://".</div>
      {site.customDomain && (
        <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: 12.5 }}>
          <div style={{ marginBottom: 8, lineHeight: 1.5 }}>
            <strong>Add this record where you bought your domain</strong> (look for DNS settings, then "Add record"):
          </div>
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, background: 'var(--surface)', borderRadius: 6, width: '100%' }}>
            <tbody>
              {[['Type', 'CNAME'], ['Name or host', '@ (or www)'], ['Value or points to', 'cname.joinivy.ai']].map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding: '6px 10px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{k}</td>
                  <td style={{ padding: '6px 10px', fontWeight: 600 }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-primary" onClick={verify} disabled={busy} style={{ padding: '6px 12px', fontSize: 12.5 }}>
              {busy ? 'Checking…' : 'Verify now'}
            </button>
            <span style={{ fontSize: 12, color: statusStyle.color, fontWeight: 600 }}>
              ● {statusStyle.label}
            </span>
            {result && result.live != null && (
              <span style={{ fontSize: 12, fontWeight: 600, color: result.live ? '#0E8A4D' : '#9A6B12' }}>
                ● {result.live ? 'Live and secure' : 'Setting up the secure connection…'}
              </span>
            )}
          </div>
          {result?.detail && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted)' }}>{result.detail}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Forms ----------
function FormsTab({ site, set }) {
  const dests = site.formDestinations || [];
  const update = (i, patch) => {
    const next = dests.slice();
    next[i] = { ...next[i], ...patch, config: { ...next[i]?.config, ...(patch.config || {}) } };
    set({ formDestinations: next });
  };
  const add = () => set({ formDestinations: [...dests, { formId: 'contact', type: 'email', config: { to: '' } }] });
  const remove = (i) => set({ formDestinations: dests.filter((_, idx) => idx !== i) });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        Choose where each form sends what people fill in: to an email address, or to another app you use.
        Forms without a choice here go to your account email.
      </div>
      {dests.length === 0 && (
        <div style={{ padding: 16, background: 'var(--surface-2)', borderRadius: 8, fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
          Nothing set up yet. Everything people send goes to your account email.
        </div>
      )}
      {dests.map((d, i) => (
        <div key={i} style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={['contact', 'newsletter'].includes(d.formId) ? d.formId : 'contact'} onChange={(e) => update(i, { formId: e.target.value })} aria-label="Which form" style={{ ...inputS, width: 150 }}>
              <option value="contact">Contact form</option>
              <option value="newsletter">Newsletter sign-ups</option>
            </select>
            <select value={d.type} onChange={(e) => update(i, { type: e.target.value })} aria-label="Send to" style={{ ...inputS, width: 150 }}>
              <option value="email">An email address</option>
              <option value="webhook">Another app</option>
            </select>
            <div style={{ flex: 1 }}/>
            <button onClick={() => remove(i)} className="btn btn-ghost" style={{ padding: 6 }}>
              <Icons.Trash size={12}/>
            </button>
          </div>
          <div style={{ marginTop: 8 }}>
            {d.type === 'email' && (
              <input value={d.config?.to || ''} onChange={(e) => update(i, { config: { to: e.target.value } })}
                placeholder="leads@yourdomain.com" style={inputS}/>
            )}
            {d.type === 'webhook' && (
              <>
                <input value={d.config?.url || ''} onChange={(e) => update(i, { config: { url: e.target.value } })}
                  placeholder="Paste the address the other app gave you" style={inputS}/>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                  Apps like Zapier or Make give you an address to paste here; they then receive each form as it comes in.
                </div>
              </>
            )}
          </div>
        </div>
      ))}
      <button className="btn btn-outline" onClick={add} style={{ alignSelf: 'flex-start' }}>
        <Icons.Plus size={12}/> Add a form
      </button>
    </div>
  );
}

// ---------- Redirects ----------
// Stored as { from: 'old-page' (no leading slash), to: '/new-page' or a
// full web address }. The owner picks the new page from a list.
const CUSTOM_TO = '__custom';
function RedirectsTab({ site, set }) {
  const rows = site.redirects || [];
  const pages = (site.pages || []).filter((p) => (p.slug || '') !== '');
  const update = (i, patch) => {
    const next = rows.slice();
    next[i] = { ...next[i], ...patch };
    set({ redirects: next });
  };
  const add = () => set({ redirects: [...rows, { from: '', to: '' }] });
  const remove = (i) => set({ redirects: rows.filter((_, idx) => idx !== i) });
  const pageValue = (slug) => (slug === '' ? '/' : `/${slug}`);
  const cleanOld = (v) => String(v || '').toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '').replace(/[^a-z0-9/-]+/g, '-').replace(/-+/g, '-');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        When someone opens an old page address, send them to a new one. Handy after you rename or remove a page, so old links and search results still work.
      </div>
      {rows.map((r, i) => {
        const to = String(r.to || '');
        const toMode = to === '' ? '' : (to === '/' || pages.some((p) => pageValue(p.slug) === to)) ? to : CUSTOM_TO;
        return (
          <div key={i} style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <Field label="Old page">
                  <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--border-strong)', borderRadius: 8, overflow: 'hidden', background: 'var(--surface)' }}>
                    <span style={{ padding: '8px 8px', color: 'var(--muted)', fontSize: 12, background: 'var(--surface-2)', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>your site /</span>
                    <input value={r.from} onChange={(e) => update(i, { from: cleanOld(e.target.value) })}
                      placeholder="old-page" aria-label="Old page address" style={{ ...inputS, border: 0, borderRadius: 0 }}/>
                  </div>
                </Field>
              </div>
              <button onClick={() => remove(i)} className="btn btn-ghost" title="Remove" aria-label="Remove this redirect" style={{ padding: 6, marginTop: 26 }}>
                <Icons.Trash size={12}/>
              </button>
            </div>
            <Field label="Send to">
              <select value={toMode} aria-label="Send to"
                onChange={(e) => update(i, { to: e.target.value === CUSTOM_TO ? 'https://' : e.target.value })}
                style={inputS}>
                <option value="">Choose a page…</option>
                <option value="/">Home page</option>
                {pages.map((p) => <option key={p.id || p.slug} value={pageValue(p.slug)}>{p.title || p.slug}</option>)}
                <option value={CUSTOM_TO}>A web address</option>
              </select>
            </Field>
            {toMode === CUSTOM_TO && (
              <input type="url" value={to} onChange={(e) => update(i, { to: e.target.value })}
                placeholder="Paste the web address" aria-label="Web address" style={inputS}/>
            )}
          </div>
        );
      })}
      <button className="btn btn-outline" onClick={add} style={{ alignSelf: 'flex-start' }}>
        <Icons.Plus size={12}/> Add one
      </button>
    </div>
  );
}

// ---------- Popups + sticky CTA ----------
function PopupsTab({ site, set }) {
  const popup = site.exitIntentPopup || { enabled: false, headline: '', sub: '', cta: '', ctaLink: '' };
  const sticky = site.stickyCta || { enabled: false, text: '', link: '', position: 'bottom' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>Popup when someone is about to leave</strong>
          <ToggleSwitch checked={popup.enabled} onChange={(v) => set({ exitIntentPopup: { ...popup, enabled: v } })}/>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>Shows once per visit, when the mouse heads for the close button.</div>
        <Field label="Headline">
          <input value={popup.headline} onChange={(e) => set({ exitIntentPopup: { ...popup, headline: e.target.value } })}
            placeholder="Wait - before you go" style={inputS}/>
        </Field>
        <Field label="Subtext">
          <input value={popup.sub} onChange={(e) => set({ exitIntentPopup: { ...popup, sub: e.target.value } })}
            placeholder="Get 10% off your first session" style={inputS}/>
        </Field>
        <Field label="Button label">
          <input value={popup.cta} onChange={(e) => set({ exitIntentPopup: { ...popup, cta: e.target.value } })}
            placeholder="Claim 10% off" style={inputS}/>
        </Field>
        <div style={{ marginTop: 8 }}>
          <LinkField value={popup.ctaLink} onChange={(v) => set({ exitIntentPopup: { ...popup, ctaLink: v } })} label="Button opens" emptyMeans="booking"/>
        </div>
      </section>
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>Bar that stays on screen</strong>
          <ToggleSwitch checked={sticky.enabled} onChange={(v) => set({ stickyCta: { ...sticky, enabled: v } })}/>
        </div>
        <Field label="Text">
          <input value={sticky.text} onChange={(e) => set({ stickyCta: { ...sticky, text: e.target.value } })}
            placeholder="Spring schedule open - book before April 1" style={inputS}/>
        </Field>
        <div style={{ marginTop: 8 }}>
          <LinkField value={sticky.link} onChange={(v) => set({ stickyCta: { ...sticky, link: v } })} label="Opens" emptyMeans="booking"/>
        </div>
        <Field label="Position">
          <select value={sticky.position || 'bottom'} onChange={(e) => set({ stickyCta: { ...sticky, position: e.target.value } })} style={inputS}>
            <option value="bottom">Bottom</option>
            <option value="top">Top</option>
          </select>
        </Field>
      </section>
    </div>
  );
}

// ---------- History ----------
function HistoryTab({ restoreVersion }) {
  const [versions, setVersions] = useState([]);
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    setBusy(true);
    try { const r = await api.get('/website/versions'); setVersions(r.versions || []); }
    finally { setBusy(false); }
  };
  useEffect(() => { reload(); }, []);
  const restore = async (id) => {
    if (!confirm('Roll back to this version? Your current state will be saved as a new version so you can undo.')) return;
    setBusy(true);
    try {
      // Through the editor so it picks up the restored site (and no pending
      // autosave can overwrite it). Falls back to the plain call.
      if (restoreVersion) await restoreVersion(id); else await api.post('/website/versions', { id });
      await reload();
    }
    finally { setBusy(false); }
  };
  if (busy && versions.length === 0) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (versions.length === 0) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>No published versions yet.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {versions.map((v) => (
        <div key={v.id} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 12px', background: 'var(--surface-2)',
          border: '1px solid var(--border)', borderRadius: 8,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 550 }}>{new Date(v.created_at).toLocaleString()}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              Template <strong>{v.template || '-'}</strong> · {v.page_count} page{Number(v.page_count) === 1 ? '' : 's'}
            </div>
          </div>
          <button className="btn btn-outline" onClick={() => restore(v.id)} disabled={busy} style={{ padding: '6px 10px', fontSize: 12 }}>
            Restore
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- Traffic ----------
function TrafficTab() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/website/traffic').then(setData).catch(() => setData({ total: 0, byDay: [], byPage: [], byReferrer: [] }));
  }, []);
  if (!data) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const max = Math.max(1, ...data.byDay.map((d) => d.n));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 600 }}>{data.total.toLocaleString()}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>pageviews · last 30 days</div>
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>By day</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 80 }}>
          {data.byDay.map((d) => (
            <div key={d.day} title={`${d.day}: ${d.n}`} style={{
              flex: 1, height: `${(d.n / max) * 100}%`,
              background: 'var(--accent)', borderRadius: 2, minHeight: 2,
            }}/>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <Group title="Top pages" rows={data.byPage.map((r) => ({ k: r.slug || 'Home', v: r.n }))}/>
        <Group title="Top referrers" rows={data.byReferrer.map((r) => ({ k: r.source, v: r.n }))}/>
      </div>
    </div>
  );
}

// ---------- Shared ----------
function Group({ title, rows }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.slice(0, 10).map((r, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{r.k || '-'}</span>
            <span style={{ color: 'var(--muted)' }}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      {children}
    </label>
  );
}

function ToggleSwitch({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)} style={{
      width: 36, height: 20, padding: 2, borderRadius: 99,
      background: checked ? 'var(--accent)' : 'var(--surface-2)',
      border: '1px solid var(--border)', cursor: 'pointer',
      position: 'relative',
    }}>
      <span style={{
        display: 'block', width: 14, height: 14, borderRadius: 99,
        background: '#fff',
        transform: `translateX(${checked ? 16 : 0}px)`,
        transition: 'transform 0.15s',
      }}/>
    </button>
  );
}

const inputS = {
  width: '100%',
  padding: '8px 11px',
  borderRadius: 8,
  border: '1px solid var(--border-strong)',
  background: 'var(--surface-2)',
  outline: 'none',
  fontSize: 13,
  color: 'var(--fg)',
};
