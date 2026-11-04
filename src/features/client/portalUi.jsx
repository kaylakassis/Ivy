// Small shared pieces for the client portal (/me/*): date and money
// formatting, the business avatar, the "Add to calendar" menu, section
// headings, a phone-friendly sheet and a few skeletons. Kept here so Home,
// Bookings and Payments look and behave the same.
import React, { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { SkelLine } from '../../components/Skeleton.jsx';
import { fmtMoney as fmtMoneyShared } from '../../lib/money.js';

export function fmtDay(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return d.toLocaleDateString('en-US', opts);
}
export function fmtLongDay(iso) {
  return fmtDay(iso, { weekday: 'long', month: 'long', day: 'numeric' });
}
export function fmtTime(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
export function fmtTimeRange(start, end) {
  if (start == null) return '';
  return end != null ? `${fmtTime(start)} to ${fmtTime(end)}` : fmtTime(start);
}
export function fmtMoney(n, currency = 'USD') {
  return fmtMoneyShared(Number(n || 0), currency || 'USD');
}
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// "Today", "Tomorrow", or "in 5 days" for the next-appointment card.
export function relativeDay(iso) {
  if (!iso) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  const days = Math.round((d - today) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return `In ${days} days`;
  return '';
}

// Booking page link, optionally deep-linked to one service.
export function bookHref(slug, serviceId) {
  if (!slug) return null;
  const base = `/book/${encodeURIComponent(slug)}`;
  return serviceId ? `${base}?service=${encodeURIComponent(serviceId)}` : base;
}

export function BusinessAvatar({ name, logoUrl, size = 40 }) {
  const [broken, setBroken] = useState(false);
  const initial = (String(name || '?').trim()[0] || '?').toUpperCase();
  const box = {
    width: size, height: size, borderRadius: Math.round(size / 4), flexShrink: 0,
    background: 'var(--accent-soft)', color: 'var(--accent)', overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 600, fontSize: Math.round(size * 0.4),
    border: '1px solid var(--border)',
  };
  if (logoUrl && !broken && /^https:\/\//i.test(logoUrl)) {
    return (
      <div style={{ ...box, background: 'var(--surface)' }}>
        <img src={logoUrl} alt="" onError={() => setBroken(true)}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}/>
      </div>
    );
  }
  return <div style={box} aria-hidden="true">{initial}</div>;
}

export function SectionTitle({ children, action, id }) {
  return (
    <div id={id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '4px 2px 8px', scrollMarginTop: 80 }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 650, flex: 1, minWidth: 0 }}>{children}</h3>
      {action}
    </div>
  );
}

// Close a popover on outside tap / Escape.
function useDismiss(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  return ref;
}

// A small popover menu anchored under its button. `items` are
// { label, href?, onClick?, external?, danger?, icon? }.
export function MenuButton({ label, icon = 'More', items, ariaLabel, buttonClass = 'btn btn-outline', buttonStyle, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const Icon = Icons[icon] || Icons.More;
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" className={buttonClass} aria-haspopup="menu" aria-expanded={open}
        aria-label={ariaLabel || label} onClick={() => setOpen((v) => !v)}
        style={{ ...actionBtn, ...buttonStyle }}>
        <Icon size={14} sw={1.8}/>{label && <span>{label}</span>}
      </button>
      {open && (
        <div role="menu" style={{
          position: 'absolute', top: 'calc(100% + 6px)', [align]: 0, zIndex: 30,
          minWidth: 200, maxWidth: 'calc(100vw - 32px)', padding: 4, borderRadius: 12,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          boxShadow: 'var(--shadow-lg, var(--shadow))',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {items.filter(Boolean).map((it) => {
            const I = it.icon ? Icons[it.icon] : null;
            const style = {
              display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderRadius: 8,
              fontSize: 14, color: it.danger ? 'var(--danger)' : 'var(--fg)', textDecoration: 'none',
              textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer', width: '100%',
            };
            const inner = <>{I && <I size={15} sw={1.7}/>}<span>{it.label}</span></>;
            if (it.href) {
              return (
                <a key={it.label} role="menuitem" href={it.href} style={style}
                  {...(it.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  onClick={() => setOpen(false)}>{inner}</a>
              );
            }
            return (
              <button key={it.label} type="button" role="menuitem" style={style}
                onClick={() => { setOpen(false); it.onClick?.(); }}>{inner}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// One "Add to calendar" button that opens Google / Apple-Outlook choices.
export function AddToCalendarMenu({ links, align = 'left' }) {
  if (!links?.google || !links?.ics) return null;
  return (
    <MenuButton label="Add to calendar" icon="Calendar" align={align} items={[
      { label: 'Google Calendar', href: links.google, external: true, icon: 'Globe' },
      { label: 'Apple or Outlook', href: links.ics, icon: 'Calendar' },
    ]}/>
  );
}

// Shared sizing for the row of actions under a card: comfortable tap
// targets that wrap onto a second line on narrow phones.
export const actionBtn = { fontSize: 13, padding: '9px 14px', minHeight: 40, justifyContent: 'center', gap: 6, textDecoration: 'none' };

// "Nov 24" (adds the year when it isn't this year).
export function fmtDate(value) {
  if (!value) return '';
  const s = String(value);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}
export const actionRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 };

// Modal that becomes a bottom sheet on phones.
export function Sheet({ onClose, children, maxWidth = 460, busy = false, labelledBy }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  return (
    <div className="portal-sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="portal-sheet card" role="dialog" aria-modal="true" aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()} style={{ maxWidth }}>
        {children}
      </div>
    </div>
  );
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div role="alert" style={{
      padding: '9px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
      background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)', color: 'var(--danger)',
    }}>{children}</div>
  );
}

// Skeleton card shaped like a booking / invoice card.
export function SkelCards({ rows = 3 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card" style={{ padding: 16, display: 'flex', gap: 14 }}>
          <SkelLine width={48} height={52} style={{ borderRadius: 10, flexShrink: 0 }}/>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SkelLine width="55%" height={14}/>
            <SkelLine width="40%" height={11}/>
            <SkelLine width="70%" height={11}/>
          </div>
        </div>
      ))}
    </div>
  );
}

// A friendly empty state inside a card, with one clear action.
export function EmptyCard({ icon = 'Check', title, hint, action }) {
  const I = Icons[icon] || Icons.Check;
  return (
    <div className="card" style={{ padding: '28px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 2,
      }}><I size={20} sw={1.7}/></div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      {hint && <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 320, lineHeight: 1.5 }}>{hint}</div>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}
