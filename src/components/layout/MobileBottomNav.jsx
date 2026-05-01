// Fixed-bottom 5-slot nav for mobile. Picks the most-used routes; the
// hamburger drawer covers the rest (Finance, Goals, Rewards, Documents, Website).
import React from 'react';
import { NavLink } from 'react-router-dom';
import { Icons } from '../Icons.jsx';

const PRIMARY = [
  { to: '/',         icon: 'Home',     label: 'Home' },
  { to: '/clients',  icon: 'Users',    label: 'Clients' },
  { to: '/calendar', icon: 'Calendar', label: 'Calendar' },
  { to: '/messages', icon: 'Chat',     label: 'Messages' },
  { to: '/ivy',      icon: 'Spark',    label: 'Ivy' },
];

export default function MobileBottomNav() {
  return (
    <nav className="mobile-nav" aria-label="Primary">
      {PRIMARY.map((item) => {
        const Icon = Icons[item.icon];
        return (
          <NavLink key={item.to}
            to={item.to} end={item.to === '/'}
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
