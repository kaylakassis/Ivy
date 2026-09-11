// Fixed-bottom 5-slot nav for mobile. Picks the most-used routes; the
// hamburger drawer covers the rest (Finance, Goals, Rewards, Documents, Website).
// Super-admins get a 6th slot so the Admin console is reachable without
// opening the drawer - they tend to bounce in/out of it constantly.
import React, { useLayoutEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { Icons } from '../Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { isNative } from '../../lib/platform.js';

const PRIMARY = [
  { id: 'dashboard', to: '/dashboard', icon: 'Home',     label: 'Home' },
  { id: 'calendar',  to: '/calendar',  icon: 'Calendar', label: 'Calendar' },
  // Getting paid is a top daily action for a solo owner — keep Finance one tap
  // away instead of buried in the drawer. Clients stays reachable via the
  // drawer and from Calendar/Messages context.
  { id: 'finance',   to: '/finance',   icon: 'Dollar',   label: 'Money' },
  { id: 'comms',     to: '/messages',  icon: 'Chat',     label: 'Messages' },
  { id: 'ivy',       to: '/ivy',       icon: 'Spark',    label: 'Ivy' },
];

const ADMIN_ITEM = { id: 'admin', to: '/admin', icon: 'Settings', label: 'Admin' };

// Native app: iOS-style tab bar. Messages moves under More (and stays one
// tap away in the header), so the fifth slot can hold More, which replaces
// the hamburger drawer. Admin lives inside More for super-admins.
const NATIVE = [
  { id: 'dashboard', to: '/dashboard', icon: 'Home',     label: 'Home' },
  { id: 'calendar',  to: '/calendar',  icon: 'Calendar', label: 'Calendar' },
  { id: 'finance',   to: '/finance',   icon: 'Dollar',   label: 'Money' },
  { id: 'ivy',       to: '/ivy',       icon: 'Spark',    label: 'Ivy' },
  { id: 'more',      to: '/more',      icon: 'More',     label: 'More' },
];

export default function MobileBottomNav() {
  const { user } = useAuth();
  // Honor the owner's hidden tabs so the bottom bar stays consistent with the
  // rest of the nav. Home + Ivy are never hideable, so the bar keeps anchors.
  const hidden = new Set(user?.ui_prefs?.hiddenNav || []);
  const native = isNative();
  const primary = (native ? NATIVE : PRIMARY).filter((i) => i.id === 'more' || !hidden.has(i.id));
  const items = user?.isSuperAdmin && !native ? [...primary, ADMIN_ITEM] : primary;
  // Publish the bar's real height (it varies with the home-indicator inset
  // and the native/web styling) so full-height screens can reserve exactly
  // that much and sit flush against it. See body.ivy-fill in global.css.
  const navRef = useRef(null);
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
  return (
    <nav ref={navRef} className={native ? 'mobile-nav native' : 'mobile-nav'} aria-label="Primary">
      {items.map((item) => {
        const Icon = Icons[item.icon] || Icons.Home;
        return (
          <NavLink key={item.to}
            to={item.to} end={item.to === '/'}
            data-tour={`nav-${item.id}`}
            className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}
          >
            {({ isActive }) => (
              <>
                <Icon size={native ? 24 : 20} sw={isActive ? 1.9 : 1.6}/>
                <span>{item.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}
