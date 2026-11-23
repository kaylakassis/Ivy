// Shared navigation config for Sidebar + breadcrumbs.
//
// Items with `superAdminOnly: true` are filtered out of the rendered
// sidebar for everyone except super-admins (Sidebar.jsx checks
// useAuth().user.isSuperAdmin and skips them otherwise). The route still
// exists in App.jsx - visibility is purely cosmetic; the API endpoints
// behind /admin already enforce super-admin auth.
// `productOnlyHidden: true` items are filtered out of the sidebar when
// the workspace's business_type === 'product' - Calendar is meaningless
// to a candle-maker / retailer. Sidebar.jsx pulls business_type from
// useUserContext() and drops these. The route still exists in App.jsx
// so deep links + manual navigation still work.
// `section` is the group a tool is listed under on the iPhone app's More
// screen. The menu itself is not grouped: it shows the five core places
// (CORE_NAV), then any tool the business uses, then "More" (splitNav).
export const NAV = [
  { id: 'dashboard', to: '/dashboard',  label: 'Home',           icon: 'Home' },
  { id: 'ivy',       to: '/ivy',        label: 'Ivy',        icon: 'Spark', accent: true },
  // Run — the day-to-day.
  { id: 'clients',   to: '/clients',    label: 'Clients',        icon: 'Users',    section: 'Run' },
  { id: 'calendar',  to: '/calendar',   label: 'Calendar',       icon: 'Calendar', section: 'Run', productOnlyHidden: true },
  { id: 'comms',     to: '/messages',   label: 'Messages',       icon: 'Chat',     section: 'Run' },
  // Money sits with the day-to-day: getting paid is part of running the
  // business. (It was its own one-item group, and was called "Finance"
  // here while the phone bar called it "Money".)
  { id: 'finance',   to: '/finance',    label: 'Money',          icon: 'Dollar',   section: 'Run' },
  // Grow.
  { id: 'programs',  to: '/programs',   label: 'Programs',       icon: 'Gift',     section: 'Grow', accent: true },
  // Automation (it was "Marketing"): what Ivy noticed the owner repeats, and
  // their workflows. Rewards and the birthday-type reminders are in Clients.
  { id: 'automation', to: '/automation', label: 'Automation',    icon: 'Repeat',   section: 'Grow' },
  { id: 'reviews',   to: '/reviews',    label: 'Reviews',        icon: 'Heart',    section: 'Grow' },
  { id: 'website',   to: '/website',    label: 'Website',        icon: 'Globe',    section: 'Grow' },
  { id: 'shops',     to: '/shops',      label: 'Shop',           icon: 'Store',    section: 'Grow' },
  // Tools.
  { id: 'docs',      to: '/documents',  label: 'Documents',      icon: 'Doc',      section: 'Tools' },
  { id: 'admin',     to: '/admin',      label: 'Admin',          icon: 'Settings', superAdminOnly: true },
];

// Tabs an owner can never hide from their own nav: the home landing and the
// flagship copilot. Everything else is theirs to customize (Settings ->
// Navigation). `admin` isn't here because it's already super-admin-only.
export const ALWAYS_VISIBLE_NAV = new Set(['dashboard', 'ivy']);

// The set of tabs the Navigation settings card lets an owner hide/show:
// everything except the always-visible anchors and the super-admin console.
export function hideableNav() {
  return NAV.filter((n) => !n.superAdminOnly && !ALWAYS_VISIBLE_NAV.has(n.id));
}

// THE single source of truth for which nav items a given user sees. Composes
// three rules (union of everything hidden):
//   • superAdminOnly  — hidden unless the user is a super-admin
//   • productOnlyHidden — hidden for product-only businesses (e.g. Calendar)
//   • hiddenNav        — the owner's own per-account hide list (ui_prefs)
// An always-visible id (dashboard/ivy) is never dropped, even if it somehow
// appears in hiddenNav. Used by Sidebar, MobileDrawer, and CommandPalette.
export function visibleNavFor({ isSuperAdmin = false, businessType = 'both', hiddenNav = [] } = {}) {
  const hidden = new Set(Array.isArray(hiddenNav) ? hiddenNav : []);
  // An owner who hid "Marketing" before it was renamed keeps it hidden.
  if (hidden.has('marketing')) hidden.add('automation');
  return NAV.filter((n) => {
    if (n.superAdminOnly && !isSuperAdmin) return false;
    if (n.productOnlyHidden && businessType === 'product') return false;
    if (hidden.has(n.id) && !ALWAYS_VISIBLE_NAV.has(n.id)) return false;
    return true;
  });
}

// The menu starts with five places: today, the calendar, their people,
// getting paid, and Ivy. The same five, in the same order, as the bar at the
// bottom of the phone.
export const CORE_NAV = ['dashboard', 'calendar', 'clients', 'finance', 'ivy'];

// Splits what an owner may see into the menu itself and what waits under
// "More". A tool moves up into the menu by itself once the business has
// something in it (`usedNav`, worked out by the server from the owner's own
// records: api/_lib/navUsage.js). When that is not known yet, the tool stays
// under "More", where it is still one tap away. Admin is the operator's and
// is always in the menu for them.
export function splitNav(items, usedNav) {
  const used = new Set(Array.isArray(usedNav) ? usedNav : []);
  const main = [];
  for (const id of CORE_NAV) {
    const hit = items.find((n) => n.id === id);
    if (hit) main.push(hit);
  }
  const more = [];
  for (const n of items) {
    if (CORE_NAV.includes(n.id)) continue;
    if (n.superAdminOnly || used.has(n.id)) main.push(n); else more.push(n);
  }
  return { main, more };
}

export const TITLES = {
  dashboard: { title: 'Home',          subtitle: 'Today and what needs you' },
  progress:  { title: 'Progress',      subtitle: 'Your numbers, this week, goals and tasks' },
  clients:   { title: 'Clients',       subtitle: 'Your people, their rewards and reminders' },
  programs:  { title: 'Programs',      subtitle: 'Courses, plans and paid communities' },
  calendar:  { title: 'Calendar',      subtitle: 'This week' },
  finance:   { title: 'Money',       subtitle: 'Money in, money out' },
  automation: { title: 'Automation',   subtitle: 'What Ivy noticed, and your workflows' },
  reviews:   { title: 'Reviews',       subtitle: 'Publish & respond to client reviews' },
  comms:     { title: 'Messages',      subtitle: 'Inbox' },
  docs:      { title: 'Documents',     subtitle: 'Waivers, agreements, signatures' },
  website:   { title: 'Website',       subtitle: 'Public presence' },
  shops:     { title: 'Shop',          subtitle: 'One page for everyone at your location' },
  ivy:       { title: 'Ivy',       subtitle: 'Your AI copilot' },
  admin:     { title: 'Admin',         subtitle: 'Operator console' },
  // /account isn't in NAV (it's reached from the sidebar profile menu)
  // but it has its own tutorial and Topbar title block, so it needs an
  // entry here for AppShell to look up.
  account:   { title: 'Account',       subtitle: 'Settings & billing' },
  // /more is the native app's fifth tab (everything not on the tab bar).
  more:      { title: 'More',          subtitle: 'Everything else' },
};
