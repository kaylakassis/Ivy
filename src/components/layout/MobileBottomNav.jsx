// Fixed-bottom 5-slot nav for mobile. Picks the most-used routes; the menu
// button in the header covers the rest.
// Super-admins get a 6th slot so the Admin console is reachable without
// opening the drawer - they tend to bounce in/out of it constantly.
import React, { useLayoutEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { Icons } from '../Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { isNative } from '../../lib/platform.js';

// The five places an owner goes every day: today, the calendar, their
// people, getting paid, and Ivy. The same five on the phone website and in
// the iPhone app, in the same order, with the same names as the desktop
// menu. Clients used to be missing here (it was two taps away under More,
// for the thing owners open most).
//
// Everything else is one tap away at the top of the screen: Messages has
// its own button in the header, and the menu button opens the rest (the
// drawer on the website, the More screen in the app).
const PRIMARY = [
  { id: 'dashboard', to: '/dashboard', icon: 'Home',     label: 'Home' },
  { id: 'calendar',  to: '/calendar',  icon: 'Calendar', label: 'Calendar' },
  { id: 'clients',   to: '/clients',   icon: 'Users',    label: 'Clients' },
  { id: 'finance',   to: '/finance',   icon: 'Dollar',   label: 'Money' },
  { id: 'ivy',       to: '/ivy',       icon: 'Spark',    label: 'Ivy' },
];

const ADMIN_ITEM = { id: 'admin', to: '/admin', icon: 'Settings', label: 'Admin' };

// The app uses the same five. Admin stays inside More for super-admins.
const NATIVE = PRIMARY;

// iOS convention: tapping the tab you are already on scrolls it back to the
// top. The page itself scrolls the window; full-height screens (Ivy,
// Messages) scroll an inner box, so the tallest scrolled box goes too.
export function scrollCurrentToTop() {
  if (typeof window === 'undefined') return;
  const smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const behavior = smooth ? 'smooth' : 'auto';
  try { window.scrollTo({ top: 0, behavior }); } catch { window.scrollTo(0, 0); }
  document.querySelectorAll('.app-page *').forEach((el) => {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') { try { el.scrollTo({ top: 0, behavior }); } catch { el.scrollTop = 0; } }
    }
  });
}

export default function MobileBottomNav() {
  const { user } = useAuth();
  // Honor the owner's hidden tabs so the bottom bar stays consistent with the
  // rest of the nav. Home + Ivy are never hideable, so the bar keeps anchors.
  const hidden = new Set(user?.ui_prefs?.hiddenNav || []);
  const native = isNative();
  const primary = (native ? NATIVE : PRIMARY).filter((i) => !hidden.has(i.id));
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
            onClick={(e) => { if (e.currentTarget.classList.contains('active')) scrollCurrentToTop(); }}
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
