// Fixed-bottom 5-slot nav for mobile. Picks the most-used routes; the
// hamburger drawer covers the rest (Finance, Goals, Rewards, Documents, Website).
import React from 'react';
import { NavLink } from 'react-router-dom';
import { Icons } from '../Icons.jsx';

const PRIMARY = [
  { id: 'dashboard', to: '/dashboard', icon: 'Home',     label: 'Home' },
  { id: 'clients',   to: '/clients',   icon: 'Users',    label: 'Clients' },
  { id: 'calendar',  to: '/calendar',  icon: 'Calendar', label: 'Calendar' },
  { id: 'comms',     to: '/messages',  icon: 'Chat',     label: 'Messages' },
  { id: 'ivy',       to: '/ivy',       icon: 'Spark',    label: 'Ivy' },
];

export default function MobileBottomNav() {
  return (
    <nav className="mobile-nav" aria-label="Primary">
      {PRIMARY.map((item) => {
        const Icon = Icons[item.icon];
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
