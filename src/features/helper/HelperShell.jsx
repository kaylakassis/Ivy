// Layout shell for /helper/* - the deliberately small view a business
// owner's helper gets (assistant, second shooter, Saturday cover).
//
// Two destinations only: Schedule and Account. No money, invoices, Ivy,
// messages, settings, website, other staff or other clients - those
// stay with the owner. Mirrors ClientShell's chrome (sidebar on desktop,
// hamburger drawer + bottom nav on the phone) so switching between the
// business, client and helper views feels like one product.
import React, { useEffect, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import TermsAcceptModal from '../../components/TermsAcceptModal.jsx';
import { SkelLine, SkelRowList } from '../../components/Skeleton.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import { useViewport } from '../../lib/viewport.js';
import { useAuth } from '../../lib/auth.jsx';
import { useUserContext, UserContextProvider } from '../../lib/userContext.jsx';
import { ViewSwitch } from '../../components/ViewToggle.jsx';
import { useExitAnimation } from '../../components/motion/useExitAnimation.js';
import { HelperProvider, useHelper } from './helperContext.jsx';
import HelperGone from './HelperGone.jsx';

const NAV = [
  { to: '/helper',         label: 'Schedule', icon: 'Calendar', end: true },
  { to: '/helper/account', label: 'Account',  icon: 'Settings' },
];

export default function HelperShell() {
  return (
    <UserContextProvider>
      <HelperProvider>
        <HelperShellInner/>
      </HelperProvider>
    </UserContextProvider>
  );
}

function HelperShellInner() {
  const [tweaks] = useTweaks();
  const viewport = useViewport();
  const location = useLocation();
  const { me, paused, loading, error, helps, workspaceId, switchBusiness } = useHelper();
  const { ctx } = useUserContext();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerExit = useExitAnimation(viewport.isMobile && drawerOpen);

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

  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // The owner removed this helper: the API answers 403 { error: 'revoked' }
  // and /api/me still lists the team with status 'revoked'. Anyone else
  // with a 403 (a plain owner/client who typed /helper) gets a plain note.
  const revoked = error?.status === 403 && (
    error?.details?.error === 'revoked' || (ctx?.helps || []).some((h) => h.status === 'revoked')
  );
  const notHelper = error?.status === 403 && !revoked;

  if (loading && !me && !paused) return <HelperShellSkeleton tweaks={tweaks} viewport={viewport}/>;

  const businessName = me?.business?.businessName || paused?.businessName || 'Helper';
  const showSwitch = !!(ctx?.isOwner || ctx?.isClient);

  return (
    <div className={`app-root dir-${tweaks.direction}`}>
      <div style={{ display: 'flex', alignItems: 'stretch', minHeight: '100vh' }}>
        {!viewport.isMobile && (
          <HelperSidebar compact={viewport.isTablet} businessName={businessName}
            showSwitch={showSwitch} helps={helps} workspaceId={workspaceId} onSwitchBusiness={switchBusiness}/>
        )}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
          <HelperTopbar isMobile={viewport.isMobile} onMenuClick={() => setDrawerOpen(true)} businessName={businessName}/>
          <div key={location.pathname} className="page-frame page-enter">
            {revoked ? (
              <div className="page-pad"><HelperGone kind="revoked" ctx={ctx}/></div>
            ) : notHelper ? (
              <div className="page-pad"><NotAHelper/></div>
            ) : paused ? (
              <div className="page-pad"><HelperGone kind="paused" ctx={ctx}/></div>
            ) : error ? (
              <div className="page-pad"><div className="card" style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>{error.message}</div></div>
            ) : (
              <Outlet/>
            )}
          </div>
        </main>
      </div>
      {viewport.isMobile && <HelperMobileNav/>}
      {drawerExit.mounted && (
        <HelperMobileDrawer closing={drawerExit.closing} onClose={() => setDrawerOpen(false)}
          businessName={businessName} showSwitch={showSwitch}
          helps={helps} workspaceId={workspaceId} onSwitchBusiness={switchBusiness}/>
      )}
      <TermsAcceptModal/>
    </div>
  );
}

function BrandMark({ compact, businessName }) {
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
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, flex: 1, minWidth: 0 }}>
          <span style={{
            fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 18,
            letterSpacing: '-0.01em', color: 'var(--sidebar-fg)',
          }}>Ivy</span>
          <span style={{
            fontSize: 10, color: 'var(--accent)', marginTop: 3,
            letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>Helping {businessName}</span>
        </div>
      )}
    </div>
  );
}

// A helper at two businesses picks which schedule they are looking at.
function BusinessPicker({ helps, workspaceId, onSwitchBusiness }) {
  if (!helps || helps.length < 2) return null;
  return (
    <label style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
      <span style={{ display: 'block', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 4 }}>Business</span>
      <select value={workspaceId || ''} onChange={(e) => onSwitchBusiness(e.target.value)} className="input"
        style={{ width: '100%', fontSize: 13 }}>
        {helps.map((h) => (
          <option key={h.workspaceId} value={h.workspaceId}>{h.businessName}{h.active ? '' : ' (paused)'}</option>
        ))}
      </select>
    </label>
  );
}

function HelperSidebar({ compact, businessName, showSwitch, helps, workspaceId, onSwitchBusiness }) {
  return (
    <aside style={{
      width: compact ? 64 : 248, minWidth: compact ? 64 : 248,
      background: 'var(--sidebar-bg)', borderRight: '1px solid var(--border)',
      padding: compact ? '14px 8px' : '18px 14px',
      display: 'flex', flexDirection: 'column', gap: compact ? 14 : 18,
      height: '100vh', position: 'sticky', top: 0,
    }}>
      <BrandMark compact={compact} businessName={businessName}/>
      {!compact && showSwitch && <ViewSwitch showHelper/>}
      {!compact && <BusinessPicker helps={helps} workspaceId={workspaceId} onSwitchBusiness={onSwitchBusiness}/>}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: compact ? 4 : 2, flex: 1 }}>
        {NAV.map((item) => {
          const Icon = Icons[item.icon] || Icons.Home;
          return (
            <NavLink key={item.to} to={item.to} end={item.end} title={item.label}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              style={compact ? { justifyContent: 'center', padding: 10 } : null}>
              {({ isActive }) => (
                <>
                  <Icon size={compact ? 19 : 17} sw={isActive ? 1.9 : 1.5}/>
                  {!compact && <span>{item.label}</span>}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
      <UserBlock compact={compact}/>
    </aside>
  );
}

function UserBlock({ compact }) {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  const initials = (user?.name || user?.email || '?')
    .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  const doSignOut = async () => { await signOut(); nav('/signin', { replace: true }); };
  if (compact) {
    return (
      <button onClick={doSignOut} title="Sign out" style={{
        width: 36, height: 36, margin: '0 auto', borderRadius: 99,
        background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 12, fontWeight: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{initials}</button>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 6 }}>
      <div style={{
        width: 30, height: 30, borderRadius: 99, background: 'var(--accent)', color: 'var(--accent-ink)',
        fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{initials}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--sidebar-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {user?.name || user?.email?.split('@')[0]}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {user?.email || ''}
        </div>
      </div>
      <button onClick={doSignOut} className="btn btn-ghost" title="Sign out" style={{ padding: 6 }}>
        <Icons.Arrow size={14}/>
      </button>
    </div>
  );
}

function HelperTopbar({ isMobile, onMenuClick, businessName }) {
  const { pathname } = useLocation();
  const current = NAV.find((n) => n.end ? pathname === n.to : pathname.startsWith(n.to)) || NAV[0];
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 16,
      padding: isMobile ? '12px 14px' : '22px 32px 18px',
      borderBottom: '1px solid var(--border)', background: 'var(--page)',
      position: 'sticky', top: 0, zIndex: 40,
    }}>
      {isMobile && (
        <button onClick={onMenuClick} aria-label="Open menu"
          style={{ padding: 8, borderRadius: 8, color: 'var(--fg-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icons.Menu size={20} sw={1.8}/>
        </button>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>
            <span>Helping {businessName}</span>
            <span>·</span>
            <span style={{ color: 'var(--fg-2)' }}>{current.label}</span>
          </div>
        )}
        <h1 className="page-title" style={{ margin: 0, fontSize: isMobile ? 20 : 28, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {isMobile ? `${current.label} · ${businessName}` : current.label}
        </h1>
      </div>
    </header>
  );
}

function HelperMobileNav() {
  return (
    <nav className="mobile-nav" aria-label="Primary">
      {NAV.map((item) => {
        const Icon = Icons[item.icon];
        return (
          <NavLink key={item.to} to={item.to} end={item.end}
            className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}>
            {({ isActive }) => (
              <>
                <Icon size={20} sw={isActive ? 1.9 : 1.6}/>
                <span>{item.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

function HelperMobileDrawer({ closing, onClose, businessName, showSwitch, helps, workspaceId, onSwitchBusiness }) {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);
  const doSignOut = async () => { await signOut(); nav('/signin', { replace: true }); };
  return (
    <>
      <div className={`mobile-drawer-backdrop${closing ? ' is-closing' : ''}`} onClick={onClose}/>
      <aside className={`mobile-drawer${closing ? ' is-closing' : ''}`}>
        <div style={{ padding: '18px 16px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}><BrandMark compact={false} businessName={businessName}/></div>
          <button onClick={onClose} aria-label="Close menu"
            style={{ padding: 8, borderRadius: 8, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icons.X size={18}/>
          </button>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 12px' }}>
          {NAV.map((item) => {
            const Icon = Icons[item.icon];
            return (
              <NavLink key={item.to} to={item.to} end={item.end}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                {({ isActive }) => (<><Icon size={18} sw={isActive ? 1.8 : 1.5}/><span>{item.label}</span></>)}
              </NavLink>
            );
          })}
        </nav>
        <div style={{ padding: '4px 12px' }}>
          <BusinessPicker helps={helps} workspaceId={workspaceId} onSwitchBusiness={onSwitchBusiness}/>
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {showSwitch && <ViewSwitch showHelper/>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--sidebar-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.name || user?.email?.split('@')[0]}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.email || ''}
              </div>
            </div>
            <button onClick={doSignOut} className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12.5 }}>Sign out</button>
          </div>
        </div>
      </aside>
    </>
  );
}

function NotAHelper() {
  const nav = useNavigate();
  return (
    <div className="card" style={{ padding: 28, maxWidth: 480, textAlign: 'center', margin: '24px auto' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.02em' }}>
        You are not helping at a business right now
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.55, marginTop: 8 }}>
        If a business invited you, open the link in their email. If your access was removed, ask the owner to invite you again.
      </div>
      <div style={{ marginTop: 16 }}>
        <button className="btn btn-primary" onClick={() => nav('/', { replace: true })}>Continue</button>
      </div>
    </div>
  );
}

function HelperShellSkeleton({ tweaks, viewport }) {
  return (
    <div className={`app-root dir-${tweaks.direction}`}>
      <div style={{ display: 'flex', alignItems: 'stretch', minHeight: '100vh' }}>
        {!viewport.isMobile && (
          <aside style={{
            width: viewport.isTablet ? 64 : 248, minWidth: viewport.isTablet ? 64 : 248,
            background: 'var(--sidebar-bg)', borderRight: '1px solid var(--border)',
            padding: viewport.isTablet ? '14px 8px' : '18px 14px',
            display: 'flex', flexDirection: 'column', gap: 14, height: '100vh', position: 'sticky', top: 0,
          }}>
            <SkelLine width="80%" height={28} style={{ borderRadius: 8 }}/>
            <SkelLine width="100%" height={32} style={{ borderRadius: 8 }}/>
            <SkelLine width="100%" height={32} style={{ borderRadius: 8 }}/>
          </aside>
        )}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: 56, padding: '0 20px', display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
            <SkelLine width={140} height={16} style={{ borderRadius: 6 }}/>
          </div>
          <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <SkelLine width={220} height={26} style={{ borderRadius: 8 }}/>
            <SkelRowList rows={3}/>
          </div>
        </main>
      </div>
    </div>
  );
}
