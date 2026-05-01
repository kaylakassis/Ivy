import React, { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { Icons } from '../Icons.jsx';
import { NAV } from '../../lib/nav.js';
import { useAuth } from '../../lib/auth.jsx';

function initialsOf(user) {
  if (!user) return '?';
  const src = user.name || user.email || '';
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0] || '').toUpperCase();
}

export default function Sidebar({ direction, variant = 'full' }) {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const compact = variant === 'compact';

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
          {NAV.map((item) => {
            const Icon = Icons[item.icon] || Icons.Home;
            return (
              <NavLink key={item.id} to={item.to} end={item.to === '/'} title={item.label}
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
          }}>thryve</span>
          <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {direction === 'bold' ? 'OS v2' : 'Business OS'}
          </span>
        </div>
      </div>

      <button style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 10,
        background: 'var(--surface)', border: '1px dashed var(--border-strong)',
        textAlign: 'left', fontSize: 13, color: 'var(--fg-2)',
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: 6,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          color: 'var(--muted)', fontSize: 11, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>+</div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontWeight: 550, color: 'var(--fg)', fontSize: 13, lineHeight: 1.1 }}>Name your workspace</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Untitled</div>
        </div>
        <Icons.ArrowDown size={14} stroke="var(--muted)" sw={1.8} />
      </button>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map(item => {
          const IconComp = Icons[item.icon] || Icons.Home;
          return (
            <NavLink
              key={item.id}
              to={item.to}
              end={item.to === '/'}
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
    </aside>
  );
}
