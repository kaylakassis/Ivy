// "More" tab of the native app: everything that is not on the tab bar,
// as an iOS-style grouped list. Replaces the hamburger drawer inside the
// phone app (the web keeps its drawer). Sections mirror lib/nav.js.
import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { CORE_NAV } from '../../lib/nav.js';
import { useNavGroups } from '../../lib/useNavGroups.js';
import { useAuth } from '../../lib/auth.jsx';
import { useUserContext } from '../../lib/userContext.jsx';
import { isNative } from '../../lib/platform.js';

// Two short lists instead of the old Run / Grow / Tools map: what this
// business uses (plus Progress, which Home links to), then every other tool.
// The five places on the tab bar are not repeated here.
const PROGRESS = { id: 'progress', to: '/progress', label: 'Progress', icon: 'Trending' };

function initialsOf(user) {
  const src = user?.name || user?.email || '';
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export default function MorePage() {
  const { user, signOut } = useAuth();
  const { ctx } = useUserContext();
  const navigate = useNavigate();
  const { main, more } = useNavGroups();
  const inUse = main.filter((i) => !CORE_NAV.includes(i.id) && !i.superAdminOnly);
  const groups = [
    { label: 'Your business', items: [PROGRESS, ...inUse] },
    { label: 'More tools', items: more },
  ].filter((g) => g.items.length);
  const loose = main.filter((i) => i.superAdminOnly); // Admin, for super-admins

  const doSignOut = async () => {
    await signOut();
    navigate(isNative() ? '/welcome' : '/signin', { replace: true });
  };

  return (
    <div className="more-page">
      <NavLink to="/account" className="more-group more-profile">
        <div className="more-avatar">{initialsOf(user)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="more-name">{user?.name || user?.email?.split('@')[0] || 'Your account'}</div>
          <div className="more-sub">{ctx?.owns?.name || user?.email || 'Account settings'}</div>
        </div>
        <Icons.Arrow size={16} sw={1.8} stroke="var(--muted-2)"/>
      </NavLink>

      {groups.map((g) => (
        <section key={g.label}>
          <div className="more-label">{g.label}</div>
          <div className="more-group">
            {g.items.map((item) => <Row key={item.id} item={item}/>)}
          </div>
        </section>
      ))}

      <section>
        <div className="more-label">Account</div>
        <div className="more-group">
          <Row item={{ id: 'account', to: '/account', label: 'Account settings', icon: 'Settings' }}/>
          {ctx?.isClient && (
            <Row item={{ id: 'client', to: '/me', label: 'Switch to client view', icon: 'Users' }}/>
          )}
          {loose.map((item) => <Row key={item.id} item={item}/>)}
          <button type="button" className="more-row more-danger" onClick={doSignOut}>
            <span className="more-icon" aria-hidden="true"><Icons.X size={16} sw={1.8}/></span>
            <span style={{ flex: 1, textAlign: 'left' }}>Sign out</span>
          </button>
        </div>
      </section>

      <div className="more-foot">Ivy · joinivy.ai</div>
    </div>
  );
}

function Row({ item }) {
  const Icon = Icons[item.icon] || Icons.Home;
  return (
    <NavLink to={item.to} className="more-row" data-tour={`nav-${item.id}`}>
      <span className="more-icon" aria-hidden="true"><Icon size={16} sw={1.7}/></span>
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.accent && <span className="more-new">NEW</span>}
      <Icons.Arrow size={15} sw={1.8} stroke="var(--muted-2)"/>
    </NavLink>
  );
}
