// Layout shell for the /me/* client portal. Mirrors AppShell but with a
// pared-down sidebar and a tinted "for clients" brand mark so people always
// know which view they're in.
//
// On phones (and inside the iPhone app) the four things clients use most
// sit in a bottom tab bar (Home, Bookings, Messages, Payments) with a fifth
// "More" tab that opens a sheet with everything else. Messages and
// Payments carry badges for unread messages and unpaid invoices.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import VerifyEmailBanner from '../../components/VerifyEmailBanner.jsx';
import TermsAcceptModal from '../../components/TermsAcceptModal.jsx';
import { SkelLine, SkelBlock, SkelRowList } from '../../components/Skeleton.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import { useViewport } from '../../lib/viewport.js';
import { useAuth } from '../../lib/auth.jsx';
import { isNative } from '../../lib/platform.js';
import { useClientPortal, ClientPortalProvider } from './clientContext.jsx';
import { ViewSwitch } from '../../components/ViewToggle.jsx';
import { initNative } from '../../lib/native.js';
import PullToRefresh from '../../components/PullToRefresh.jsx';
import OfflineBanner from '../../components/OfflineBanner.jsx';

// Primary destinations (tab bar on phones, top of the sidebar on desktop).
const PRIMARY = [
  { to: '/me',          label: 'Home',     icon: 'Home',     end: true },
  { to: '/me/bookings', label: 'Bookings', icon: 'Calendar' },
  { to: '/me/messages', label: 'Messages', icon: 'Chat',     badge: 'unread' },
  { to: '/me/invoices', label: 'Payments', icon: 'Dollar',   badge: 'invoices' },
];
// Everything else: under "More" on phones, a second group on desktop.
const SECONDARY = [
  { to: '/me/programs',      label: 'Programs',      icon: 'Trophy', hint: 'Courses and plans you have joined' },
  { to: '/me/documents',     label: 'Documents',     icon: 'Doc',    hint: 'Forms and agreements to sign', badge: 'docs' },
  { to: '/me/discover',      label: 'Discover',      icon: 'Globe',  hint: 'Find businesses on Ivy' },
  { to: '/me/notifications', label: 'Notifications', icon: 'Bell',   hint: 'Choose what we email or text you' },
  { to: '/me/profile',       label: 'Profile',       icon: 'Users',  hint: 'Your details, sign-in and privacy' },
];
// Old addresses that now live inside another page (titles only).
const TITLES = { '/me/billing': 'Payments', '/me/orders': 'Payments' };

function badgeCount(kind, summary) {
  if (!summary) return 0;
  if (kind === 'unread') return summary.unreadMessages || 0;
  if (kind === 'invoices') return summary.openInvoices || 0;
  if (kind === 'docs') return summary.pendingDocs || 0;
  return 0;
}
const isActive = (item, pathname) => (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(item.to + '/'));

export default function ClientShell() {
  return (
    <ClientPortalProvider>
      <ClientShellInner/>
    </ClientPortalProvider>
  );
}

function ClientShellInner() {
  const [tweaks] = useTweaks();
  const viewport = useViewport();
  const { data, loading, refresh } = useClientPortal();
  useEffect(() => { initNative(); }, []);
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    document.body.classList.remove('dir-calm', 'dir-bold');
    document.body.classList.add(`dir-${tweaks.direction}`);
    return () => document.body.classList.remove(`dir-${tweaks.direction}`);
  }, [tweaks.direction]);

  useEffect(() => {
    if (viewport.isMobile) document.body.classList.add('has-mobile-nav');
    else document.body.classList.remove('has-mobile-nav');
    return () => document.body.classList.remove('has-mobile-nav');
  }, [viewport.isMobile]);

  useEffect(() => { setMoreOpen(false); }, [location.pathname]);

  // Badges go stale after paying or reading; refresh them on navigation
  // (cheap: one /api/me) so the tab bar does not keep showing old counts.
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) { firstPath.current = false; return; }
    refresh?.().catch(() => {});
  }, [location.pathname, refresh]);

  if (loading) {
    return <ClientShellSkeleton tweaks={tweaks} viewport={viewport}/>;
  }

  return (
    <div className={`app-root client-portal dir-${tweaks.direction}`}>
      <div style={{ display: 'flex', alignItems: 'stretch', minHeight: '100vh' }}>
        {!viewport.isMobile && (
          <ClientSidebar variant={viewport.isTablet ? 'compact' : 'full'}
            data={data} direction={tweaks.direction}/>
        )}

        <main style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column',
          minHeight: '100vh',
        }}>
          <VerifyEmailBanner/>
          <ClientTopbar isMobile={viewport.isMobile}/>
          {/* Keyed on the path so each portal page fades in while rising
              (.page-enter in global.css). Enter-only: no exit animation, so
              pages that fetch on mount never double-render. */}
          <div key={location.pathname} className="page-frame page-enter">
            <Outlet/>
            <PullToRefresh onRefresh={refresh} fallbackReload/>
            <OfflineBanner/>
          </div>
        </main>
      </div>

      {viewport.isMobile && <ClientMobileNav summary={data?.summary} onMore={() => setMoreOpen(true)} moreOpen={moreOpen}/>}
      {viewport.isMobile && moreOpen && (
        <MoreSheet data={data} summary={data?.summary} onClose={() => setMoreOpen(false)}/>
      )}
      <TermsAcceptModal/>
    </div>
  );
}

function Badge({ n, compact }) {
  if (!n) return null;
  return <span className={compact ? 'portal-tab-badge' : 'nav-badge'} aria-label={`${n} new`}>{n > 99 ? '99+' : n}</span>;
}

// ----- desktop / tablet sidebar -----
function ClientSidebar({ variant, data, direction }) {
  const compact = variant === 'compact';
  const summary = data?.summary;
  const renderItem = (item) => {
    const Icon = Icons[item.icon] || Icons.Home;
    const n = badgeCount(item.badge, summary);
    return (
      <NavLink key={item.to} to={item.to} end={item.end} title={item.label}
        className={({ isActive: a }) => `nav-item ${a ? 'active' : ''}`}
        style={compact ? { justifyContent: 'center', padding: 10, position: 'relative' } : null}>
        {({ isActive: a }) => (
          <>
            <Icon size={compact ? 19 : 17} sw={a ? 1.9 : 1.5}/>
            {!compact && <span>{item.label}</span>}
            {compact ? (n > 0 && <span className="portal-dot" aria-label={`${n} new`}/>) : <Badge n={n}/>}
          </>
        )}
      </NavLink>
    );
  };
  return (
    <aside style={{
      width: compact ? 64 : 248, minWidth: compact ? 64 : 248,
      background: 'var(--sidebar-bg)',
      borderRight: '1px solid var(--border)',
      padding: compact ? '14px 8px' : '18px 14px',
      display: 'flex', flexDirection: 'column', gap: compact ? 14 : 18,
      height: '100vh', position: 'sticky', top: 0,
    }}>
      <BrandMark direction={direction} compact={compact}/>
      {!compact && <ViewSwitch showHelper={!!data?.isHelper}/>}
      <nav style={{
        display: 'flex', flexDirection: 'column', gap: compact ? 4 : 2,
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain',
      }}>
        {PRIMARY.map(renderItem)}
        {!compact && (
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--muted)',
            padding: '14px 12px 4px', opacity: 0.75,
          }}>More</div>
        )}
        {compact && <div style={{ height: 1, background: 'var(--border)', margin: '6px 4px' }}/>}
        {SECONDARY.map(renderItem)}
      </nav>
      <UserBlock data={data} compact={compact}/>
    </aside>
  );
}

function BrandMark({ compact }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: compact ? 0 : '4px 6px',
      justifyContent: compact ? 'center' : 'flex-start' }}>
      <div style={{
        width: compact ? 36 : 30, height: compact ? 36 : 30, borderRadius: 8,
        background: '#042b25', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <img src="/icon-512.png" alt="" draggable="false" style={{ width: '100%', height: '100%', display: 'block' }}/>
      </div>
      {!compact && (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, flex: 1 }}>
          <span style={{
            fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 18,
            letterSpacing: '-0.01em', color: 'var(--sidebar-fg)',
          }}>Ivy</span>
          <span style={{
            fontSize: 10, color: 'var(--accent)', marginTop: 3,
            letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
          }}>For clients</span>
        </div>
      )}
    </div>
  );
}

function initialsOf(user) {
  return (user?.name || user?.email || '?')
    .split(/[\s@.]+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0].toUpperCase()).join('');
}

function UserBlock({ data, compact }) {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const initials = initialsOf(user);
  const doSignOut = async () => { await signOut(); nav('/signin', { replace: true }); };

  if (compact) {
    return (
      <Link to="/me/profile" title="Your profile"
        style={{
          width: 36, height: 36, margin: '0 auto', borderRadius: 99,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          fontSize: 12, fontWeight: 600, textDecoration: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{initials}</Link>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0,
          padding: 4, borderRadius: 10,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          boxShadow: 'var(--shadow)', zIndex: 50,
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {data?.isOwner && (
            <button onClick={() => nav('/')} style={menuBtn}>
              <Icons.Trending size={13}/> Switch to business view
            </button>
          )}
          {data?.isHelper && (
            <button onClick={() => nav('/helper')} style={menuBtn}>
              <Icons.Calendar size={13}/> Switch to helper view
            </button>
          )}
          <NavLink to="/me/profile" onClick={() => setOpen(false)} style={{ ...menuBtn, textDecoration: 'none' }}>
            <Icons.Edit size={13}/> Your profile
          </NavLink>
          {data?.isOwner && (
            <NavLink to="/account" onClick={() => setOpen(false)} style={{ ...menuBtn, textDecoration: 'none' }}>
              <Icons.Settings size={13}/> Account settings
            </NavLink>
          )}
          <button onClick={doSignOut} style={menuBtn}>
            <Icons.Arrow size={13}/> Sign out
          </button>
        </div>
      )}
      <button onClick={() => setOpen((v) => !v)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 10,
        padding: 6, borderRadius: 10,
        background: open ? 'var(--surface)' : 'transparent',
        border: `1px solid ${open ? 'var(--border)' : 'transparent'}`,
        textAlign: 'left', cursor: 'pointer',
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: 99,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--sidebar-fg)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.name || user?.email?.split('@')[0]}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.email || ''}
          </div>
        </div>
        <Icons.More size={14} stroke="var(--muted)"/>
      </button>
    </div>
  );
}

const menuBtn = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
  padding: '8px 10px', borderRadius: 8, textAlign: 'left',
  fontSize: 13, color: 'var(--fg)', cursor: 'pointer',
};

// ----- topbar -----
function ClientTopbar({ isMobile }) {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const all = [...PRIMARY, ...SECONDARY];
  const current = all.find((n) => isActive(n, pathname))
    || (TITLES[pathname] ? { label: TITLES[pathname] } : PRIMARY[0]);
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 16,
      padding: isMobile ? '12px 16px' : '22px 32px 18px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--page)',
      position: 'sticky', top: 0, zIndex: 40,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>
            <span>Your portal</span>
            <span>·</span>
            <span style={{ color: 'var(--fg-2)' }}>{current.label}</span>
          </div>
        )}
        <h1 className="page-title" style={{ margin: 0, fontSize: isMobile ? 21 : 28, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {current.label}
        </h1>
      </div>
      {isMobile && pathname !== '/me/profile' && (
        <Link to="/me/profile" aria-label="Your profile" style={{
          width: 36, height: 36, borderRadius: 99, flexShrink: 0,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          fontSize: 13, fontWeight: 600, textDecoration: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{initialsOf(user)}</Link>
      )}
    </header>
  );
}

// ----- phone tab bar + More sheet -----
function ClientMobileNav({ summary, onMore, moreOpen }) {
  const { pathname } = useLocation();
  const native = isNative();
  const navRef = useRef(null);
  // Publish the bar's real height (home-indicator inset included) so the
  // page can reserve exactly that much and nothing hides under it.
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return undefined;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--mobile-nav-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty('--mobile-nav-h'); };
  }, []);
  const onSecondary = SECONDARY.some((i) => isActive(i, pathname));
  const moreBadge = SECONDARY.reduce((s, i) => s + badgeCount(i.badge, summary), 0);
  const iconSize = native ? 24 : 21;
  return (
    <nav ref={navRef} className={native ? 'mobile-nav native' : 'mobile-nav'} aria-label="Primary">
      {PRIMARY.map((item) => {
        const Icon = Icons[item.icon];
        const n = badgeCount(item.badge, summary);
        return (
          <NavLink key={item.to} to={item.to} end={item.end}
            className={({ isActive: a }) => `mobile-nav-item ${a ? 'active' : ''}`}>
            {({ isActive: a }) => (
              <>
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  <Icon size={iconSize} sw={a ? 1.9 : 1.6}/>
                  <Badge n={n} compact/>
                </span>
                <span>{item.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
      <button type="button" onClick={onMore} aria-expanded={moreOpen} aria-haspopup="dialog"
        aria-label={moreBadge ? `More, ${moreBadge} new` : 'More'}
        className={`mobile-nav-item ${onSecondary || moreOpen ? 'active' : ''}`}
        style={{ background: (onSecondary || moreOpen) && !native ? 'var(--surface-2)' : 'none', border: 0, cursor: 'pointer', font: 'inherit' }}>
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <Icons.More size={iconSize} sw={1.6}/>
          <Badge n={moreBadge} compact/>
        </span>
        <span style={{ fontSize: native ? 10 : 10.5 }}>More</span>
      </button>
    </nav>
  );
}

function MoreSheet({ data, summary, onClose }) {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const doSignOut = async () => { await signOut(); nav('/signin', { replace: true }); };
  const row = {
    display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', borderRadius: 12,
    textDecoration: 'none', color: 'var(--fg)', background: 'transparent', border: 0,
    width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit',
  };
  const iconBox = {
    width: 36, height: 36, borderRadius: 10, flexShrink: 0,
    background: 'var(--accent-soft)', color: 'var(--accent)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
  return (
    <div className="portal-sheet-backdrop" onClick={onClose}>
      <div className="portal-sheet card" role="dialog" aria-modal="true" aria-label="More"
        onClick={(e) => e.stopPropagation()} style={{ gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 4px 10px', borderBottom: '1px solid var(--border)', marginBottom: 6 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 99, background: 'var(--accent)', color: 'var(--accent-ink)',
            fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>{initialsOf(user)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.name || user?.email?.split('@')[0]}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost" style={{ padding: 8 }}>
            <Icons.X size={18}/>
          </button>
        </div>
        {SECONDARY.map((item) => {
          const Icon = Icons[item.icon] || Icons.Home;
          const n = badgeCount(item.badge, summary);
          return (
            <Link key={item.to} to={item.to} style={row} onClick={onClose}>
              <span style={iconBox}><Icon size={18} sw={1.7}/></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>{item.label}</span>
                <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', marginTop: 1 }}>{item.hint}</span>
              </span>
              {n > 0 && <span className="nav-badge" style={{ marginLeft: 0 }}>{n}</span>}
              <Icons.Arrow size={14} stroke="var(--muted)"/>
            </Link>
          );
        })}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {data?.isOwner && (
            <Link to="/" style={row} onClick={onClose}>
              <span style={{ ...iconBox, background: 'var(--surface-2)', color: 'var(--fg-2)' }}><Icons.Trending size={18}/></span>
              <span style={{ fontSize: 15, fontWeight: 550 }}>Switch to business view</span>
            </Link>
          )}
          {data?.isHelper && (
            <Link to="/helper" style={row} onClick={onClose}>
              <span style={{ ...iconBox, background: 'var(--surface-2)', color: 'var(--fg-2)' }}><Icons.Calendar size={18}/></span>
              <span style={{ fontSize: 15, fontWeight: 550 }}>Switch to helper view</span>
            </Link>
          )}
          <button type="button" style={row} onClick={doSignOut}>
            <span style={{ ...iconBox, background: 'var(--surface-2)', color: 'var(--fg-2)' }}><Icons.Arrow size={18}/></span>
            <span style={{ fontSize: 15, fontWeight: 550 }}>Sign out</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Renders the shell chrome with skeleton placeholders for the page body.
function ClientShellSkeleton({ tweaks, viewport }) {
  return (
    <div className={`app-root client-portal dir-${tweaks.direction}`}>
      <div style={{ display: 'flex', alignItems: 'stretch', minHeight: '100vh' }}>
        {!viewport.isMobile && (
          <aside style={{
            width: viewport.isTablet ? 64 : 248, minWidth: viewport.isTablet ? 64 : 248,
            background: 'var(--sidebar-bg)', borderRight: '1px solid var(--border)',
            padding: viewport.isTablet ? '14px 8px' : '18px 14px',
            display: 'flex', flexDirection: 'column', gap: 14,
            height: '100vh', position: 'sticky', top: 0,
          }}>
            <SkelLine width="80%" height={28} style={{ borderRadius: 8 }}/>
            {Array.from({ length: 6 }, (_, i) => (
              <SkelLine key={i} width="100%" height={32} style={{ borderRadius: 8 }}/>
            ))}
          </aside>
        )}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            height: 56, padding: '0 20px',
            display: 'flex', alignItems: 'center', gap: 12,
            borderBottom: '1px solid var(--border)',
          }}>
            <SkelLine width={140} height={16} style={{ borderRadius: 6 }}/>
          </div>
          <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, width: '100%' }}>
            <SkelLine width={220} height={26} style={{ borderRadius: 8 }}/>
            <SkelBlock height={150} radius={16}/>
            <SkelRowList rows={3} withAvatar/>
          </div>
        </main>
      </div>
    </div>
  );
}
