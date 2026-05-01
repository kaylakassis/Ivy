// Slide-in drawer for mobile. Triggered from the hamburger button in
// Topbar; closes on backdrop tap, ESC, or route change (handled by AppShell).
import React, { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Icons } from '../Icons.jsx';
import { NAV } from '../../lib/nav.js';
import { useAuth } from '../../lib/auth.jsx';

function initialsOf(user) {
  if (!user) return '?';
  const src = user.name || user.email || '';
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0] || '').toUpperCase();
}

export default function MobileDrawer({ direction, onClose }) {
  const { user, signOut } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const doSignOut = async () => {
    await signOut();
    nav('/signin', { replace: true });
  };

  return (
    <>
      <div className="mobile-drawer-backdrop" onClick={onClose}/>
      <aside className="mobile-drawer">
        <div style={{ padding: '18px 16px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icons.Logo size={22} color="currentColor"/>
          </div>
          <div style={{ flex: 1, lineHeight: 1 }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 18,
              letterSpacing: '-0.01em', color: 'var(--sidebar-fg)',
            }}>thryve</div>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              {direction === 'bold' ? 'OS v2' : 'Business OS'}
            </div>
          </div>
          <button onClick={onClose}
            style={{
              padding: 8, borderRadius: 8, color: 'var(--muted)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
            aria-label="Close menu">
            <Icons.X size={18}/>
          </button>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 12px' }}>
          {NAV.map((item) => {
            const Icon = Icons[item.icon] || Icons.Home;
            return (
              <NavLink key={item.id}
                to={item.to} end={item.to === '/'}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                {({ isActive }) => (
                  <>
                    <Icon size={18} sw={isActive ? 1.8 : 1.5}
                      stroke={item.accent && !isActive ? 'var(--accent)' : 'currentColor'}/>
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
            );
          })}
        </nav>

        <div style={{ flex: 1 }}/>

        <div style={{
          padding: 12, borderTop: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <NavLink to="/account"
            className="nav-item"
            style={{ padding: '10px 12px' }}>
            <Icons.Settings size={16} sw={1.6}/> Account settings
          </NavLink>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            paddingTop: 4, borderTop: '1px solid var(--border)',
          }}>
            <div style={{
              width: 34, height: 34, borderRadius: 99,
              background: 'var(--accent)', color: 'var(--accent-ink)',
              fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{initialsOf(user)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 500, color: 'var(--sidebar-fg)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{user?.name || user?.email?.split('@')[0] || 'Signed in'}</div>
              <div style={{
                fontSize: 11, color: 'var(--muted)', marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{user?.email || ''}</div>
            </div>
            <button onClick={doSignOut}
              className="btn btn-ghost"
              style={{ padding: '6px 10px', fontSize: 12.5 }}>
              Sign out
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
