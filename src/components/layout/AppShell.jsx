import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';
import VerifyEmailBanner from '../VerifyEmailBanner.jsx';
import { NAV, TITLES } from '../../lib/nav.js';
import { useTweaks } from '../../lib/tweaks.js';

export default function AppShell() {
  const [tweaks] = useTweaks();
  const location = useLocation();
  const current = NAV.find(n => n.to === location.pathname) || NAV[0];
  const t = TITLES[current.id] || TITLES.dashboard;

  return (
    <div className={`app-root dir-${tweaks.direction}`}>
      <div style={{ display: 'flex', alignItems: 'stretch', minHeight: '100vh' }}>
        <Sidebar direction={tweaks.direction} />
        <main style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column',
          minHeight: '100vh',
        }}>
          <VerifyEmailBanner />
          <Topbar title={t.title} subtitle={t.subtitle} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
