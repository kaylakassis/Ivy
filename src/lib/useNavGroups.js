// The owner's menu, split into what is always there and what waits under
// "More" (src/lib/nav.js splitNav). One hook so the desktop sidebar, the
// phone drawer and the iPhone app's More screen always agree.
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { visibleNavFor, splitNav } from './nav.js';
import { useAuth } from './auth.jsx';
import { useUserContext } from './userContext.jsx';

export function useNavGroups() {
  const { user } = useAuth();
  const { ctx } = useUserContext();
  const { pathname } = useLocation();
  const items = visibleNavFor({
    isSuperAdmin: user?.isSuperAdmin,
    businessType: ctx?.owns?.businessType || 'both',
    hiddenNav: user?.ui_prefs?.hiddenNav,
  });
  const { main, more } = splitNav(items, ctx?.usedNav);
  // Standing on a page that lives under "More" keeps it open, so the owner
  // can always see where they are.
  const onMorePage = more.some((n) => pathname === n.to || pathname.startsWith(`${n.to}/`));
  const [opened, setOpened] = useState(false);
  return { main, more, moreOpen: opened || onMorePage, toggleMore: () => setOpened((o) => !o) };
}
