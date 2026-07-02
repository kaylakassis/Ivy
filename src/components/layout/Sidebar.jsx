import React, { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { Icons } from '../Icons.jsx';
import { NAV } from '../../lib/nav.js';
import { useAuth } from '../../lib/auth.jsx';
import { useUserContext } from '../../lib/userContext.jsx';
import ReportBugModal from '../ReportBugModal.jsx';

function initialsOf(user) {
  if (!user) return '?';
  const src = user.name || user.email || '';
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0] || '').toUpperCase();
}

export default function Sidebar({ direction, variant = 'full' }) {
  const { user, signOut } = useAuth();
  const { ctx } = useUserContext();
  const nav = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [bugOpen, setBugOpen]   = useState(false);
  const compact = variant === 'compact';
  // Filter out super-admin-only items unless the user qualifies.
  // Also hide product-only-hidden items (currently just Calendar) when
  // the workspace is product-only - a candle maker doesn't take
  // appointments. The route still exists in App.jsx so deep links work.
  const businessType = ctx?.owns?.businessType || 'both';
  const visibleNav = NAV.filter((n) => {
    if (n.superAdminOnly && !user?.isSuperAdmin) return false;
    if (n.productOnlyHidden && businessType === 'product') return false;
    return true;
  });
  // Workspace badge values. Real biz_name when the owner finished
  // onboarding, otherwise a CTA. Either way clicking takes them to
  // /calendar where the name + slug live.
  const bizName = ctx?.bizName?.trim() || null;
  const bookingSlug = ctx?.bookingSlug || null;

  const doSignOut = async () => {
    await signOut();
    nav('/signin', { replace: true });
  };

  // Compact sidebar (tablet): icons only, ~64px wide.
  if (compact) {
    return (
      <aside style={{
        width: 64, minWidth: 64,
        background: 'var(--sidebar-bg)',
        borderRight: '1px solid var(--border)',
        padding: '14px 8px',
        display: 'flex', flexDirection: 'column', gap: 14,
        height: '100vh', position: 'sticky', top: 0,
      }}>
        <div style={{
          width: 36, height: 36, margin: '0 auto', borderRadius: 8,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Logo size={22} color="currentColor"/>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {visibleNav.map((item) => {
            const Icon = Icons[item.icon] || Icons.Home;
            return (
              <NavLink key={item.id} to={item.to} end={item.to === '/'} title={item.label}
                data-tour={`nav-${item.id}`}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                style={{ justifyContent: 'center', padding: 10 }}
              >
                {({ isActive }) => (
                  <Icon size={19} sw={isActive ? 1.9 : 1.6}
                    stroke={item.accent && !isActive ? 'var(--accent)' : 'currentColor'}/>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div style={{ flex: 1 }}/>

        <button onClick={doSignOut} title="Sign out"
          style={{
            width: 36, height: 36, margin: '0 auto', borderRadius: 99,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            fontSize: 12, fontWeight: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          {initialsOf(user)}
        </button>
      </aside>
    );
  }

  // Full sidebar (desktop): unchanged.
  return (
    <aside style={{
      width: 248, minWidth: 248,
      background: 'var(--sidebar-bg)',
      borderRight: '1px solid var(--border)',
      padding: '18px 14px',
      display: 'flex', flexDirection: 'column', gap: 18,
      height: '100vh', position: 'sticky', top: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px' }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Logo size={20} color="currentColor" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <span style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 500, fontSize: 18, letterSpacing: '-0.01em',
            color: 'var(--sidebar-fg)',
          }}>Ivy OS</span>
          <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {direction === 'bold' ? 'OS v2' : 'Business OS'}
          </span>
        </div>
      </div>

      <button onClick={() => nav('/calendar')} style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 10,
        background: 'var(--surface)',
        border: '1px ' + (bizName ? 'solid' : 'dashed') + ' var(--border-strong)',
        textAlign: 'left', fontSize: 13, color: 'var(--fg-2)', cursor: 'pointer',
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: 6,
          background: bizName ? 'var(--accent)' : 'var(--surface-2)',
          color: bizName ? 'var(--accent-ink)' : 'var(--muted)',
          border: bizName ? 'none' : '1px solid var(--border)',
          fontSize: 11, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{bizName ? bizName[0].toUpperCase() : '+'}</div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{
            fontWeight: 550, color: 'var(--fg)', fontSize: 13, lineHeight: 1.1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {bizName || 'Name your workspace'}
          </div>
          <div style={{
            fontSize: 11, color: 'var(--muted)', marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {bookingSlug ? `/book/${bookingSlug}` : 'Untitled'}
          </div>
        </div>
        <Icons.ArrowDown size={14} stroke="var(--muted)" sw={1.8} />
      </button>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {visibleNav.map((item, i) => {
          const IconComp = Icons[item.icon] || Icons.Home;
          // Section label the first time a new section appears (NAV is ordered
          // by section). Purely visual grouping; every route stays reachable.
          const showHeader = item.section && item.section !== visibleNav[i - 1]?.section;
          return (
            <React.Fragment key={item.id}>
              {showHeader && (
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: 'var(--muted)',
                  padding: '12px 12px 4px', opacity: 0.75,
                }}>{item.section}</div>
              )}
            <NavLink
              to={item.to}
              end={item.to === '/'}
              data-tour={`nav-${item.id}`}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              {({ isActive }) => (
                <>
                  <IconComp size={17} sw={isActive ? 1.8 : 1.5} stroke={item.accent && !isActive ? 'var(--accent)' : 'currentColor'} />
                  <span>{item.label}</span>
                  {item.accent && !isActive && (
                    <span style={{
                      marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                      color: 'var(--accent)', letterSpacing: '0.06em',
                    }}>NEW</span>
                  )}
                </>
              )}
            </NavLink>
            </React.Fragment>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <div style={{ position: 'relative' }}>
        {menuOpen && (
          <div style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0,
            padding: 4, borderRadius: 10,
            background: 'var(--surface)', border: '1px solid var(--border-strong)',
            boxShadow: 'var(--shadow)', zIndex: 50,
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            <Link
              to="/account"
              onClick={() => setMenuOpen(false)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', borderRadius: 8, textAlign: 'left',
                fontSize: 13, color: 'var(--fg)', textDecoration: 'none',
              }}
            >
              <Icons.Settings size={13}/> Account settings
            </Link>
            <Link
              to="/account?support=1"
              onClick={() => setMenuOpen(false)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', borderRadius: 8, textAlign: 'left',
                fontSize: 13, color: 'var(--fg)', textDecoration: 'none',
              }}
            >
              <Icons.Chat size={13}/> Help &amp; support
            </Link>
            <button
              type="button"
              onClick={() => { setMenuOpen(false); setBugOpen(true); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', borderRadius: 8, textAlign: 'left',
                fontSize: 13, color: 'var(--fg)', cursor: 'pointer',
              }}
            >
              <Icons.Spark size={13}/> Report a bug
              <span style={{
                marginLeft: 'auto', fontSize: 9.5, fontWeight: 700,
                color: 'var(--accent)', letterSpacing: '0.08em',
              }}>BETA</span>
            </button>
            <button
              onClick={doSignOut}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', borderRadius: 8, textAlign: 'left',
                fontSize: 13, color: 'var(--fg)', cursor: 'pointer',
              }}
            >
              <Icons.Arrow size={13} />
              Sign out
            </button>
          </div>
        )}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 10,
            padding: 6, borderRadius: 10,
            background: menuOpen ? 'var(--surface)' : 'transparent',
            border: `1px solid ${menuOpen ? 'var(--border)' : 'transparent'}`,
            textAlign: 'left', cursor: 'pointer',
          }}
        >
          <div style={{
            width: 30, height: 30, borderRadius: 99,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            fontSize: 12, fontWeight: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {initialsOf(user)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--sidebar-fg)', lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.name || user?.email?.split('@')[0] || 'Signed in'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email || ''}
            </div>
          </div>
          <Icons.More size={14} stroke="var(--muted)" />
        </button>
      </div>
      {bugOpen && <ReportBugModal onClose={() => setBugOpen(false)}/>}
    </aside>
  );
}
