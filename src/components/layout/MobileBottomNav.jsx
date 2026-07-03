// Fixed-bottom 5-slot nav for mobile. Picks the most-used routes; the
// hamburger drawer covers the rest (Finance, Goals, Rewards, Documents, Website).
// Super-admins get a 6th slot so the Admin console is reachable without
// opening the drawer - they tend to bounce in/out of it constantly.
import React from 'react';
import { NavLink } from 'react-router-dom';
import { Icons } from '../Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';

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

export default function MobileBottomNav() {
  const { user } = useAuth();
  // Honor the owner's hidden tabs so the bottom bar stays consistent with the
  // rest of the nav. Home + Ivy are never hideable, so the bar keeps anchors.
  const hidden = new Set(user?.ui_prefs?.hiddenNav || []);
  const primary = PRIMARY.filter((i) => !hidden.has(i.id));
  const items = user?.isSuperAdmin ? [...primary, ADMIN_ITEM] : primary;
  return (
    <nav className="mobile-nav" aria-label="Primary">
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
