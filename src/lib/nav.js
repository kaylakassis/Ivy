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
// `section` groups items under a small label in the sidebar so the 13-item
// list reads as a few calm sections instead of a flat wall. Purely visual —
// every route stays reachable and deep-linkable. Items without a section
// (Dashboard, Ivy Pro, Admin) render pinned above the groups.
export const NAV = [
  { id: 'dashboard', to: '/dashboard',  label: 'Dashboard',      icon: 'Home' },
  { id: 'ivy',       to: '/ivy',        label: 'Ivy Pro',        icon: 'Spark', accent: true },
  // Run — the day-to-day.
  { id: 'clients',   to: '/clients',    label: 'Clients',        icon: 'Users',    section: 'Run' },
  { id: 'calendar',  to: '/calendar',   label: 'Calendar',       icon: 'Calendar', section: 'Run', productOnlyHidden: true },
  { id: 'comms',     to: '/messages',   label: 'Messages',       icon: 'Chat',     section: 'Run' },
  { id: 'projects',  to: '/projects',   label: 'Projects',       icon: 'Doc',      section: 'Run' },
  // Money.
  { id: 'finance',   to: '/finance',    label: 'Finance',        icon: 'Dollar',   section: 'Money' },
  // Grow.
  { id: 'campaigns', to: '/campaigns',  label: 'Campaigns',      icon: 'Mail',     section: 'Grow' },
  { id: 'reviews',   to: '/reviews',    label: 'Reviews',        icon: 'Heart',    section: 'Grow' },
  { id: 'rewards',   to: '/rewards',    label: 'Rewards',        icon: 'Gift',     section: 'Grow' },
  { id: 'website',   to: '/website',    label: 'Website',        icon: 'Globe',    section: 'Grow' },
  { id: 'workflows', to: '/workflows',  label: 'Workflows',      icon: 'Spark',    section: 'Grow' },
  // Tools.
  { id: 'docs',      to: '/documents',  label: 'Documents',      icon: 'Doc',      section: 'Tools' },
  { id: 'goals',     to: '/goals',      label: 'Goals & Tasks',  icon: 'Check',    section: 'Tools' },
  { id: 'admin',     to: '/admin',      label: 'Admin',          icon: 'Settings', superAdminOnly: true },
];

export const TITLES = {
  dashboard: { title: 'Dashboard',     subtitle: 'Home' },
  clients:   { title: 'Clients',       subtitle: 'Your people' },
  projects:  { title: 'Projects',      subtitle: 'Engagements' },
  calendar:  { title: 'Calendar',      subtitle: 'This week' },
  finance:   { title: 'Finance',       subtitle: 'Money in, money out' },
  goals:     { title: 'Goals & Tasks', subtitle: 'Stay on track' },
  workflows: { title: 'Workflows',     subtitle: 'Automations that run while you sleep' },
  rewards:   { title: 'Rewards',       subtitle: 'Loyalty & referrals' },
  reviews:   { title: 'Reviews',       subtitle: 'Publish & respond to client reviews' },
  comms:     { title: 'Messages',      subtitle: 'Inbox' },
  campaigns: { title: 'Campaigns',     subtitle: 'Newsletters & announcements' },
  docs:      { title: 'Documents',     subtitle: 'Notes & files' },
  website:   { title: 'Website',       subtitle: 'Public presence' },
  ivy:       { title: 'Ivy Pro',       subtitle: 'Your AI copilot' },
  admin:     { title: 'Admin',         subtitle: 'Operator console' },
  // /account isn't in NAV (it's reached from the sidebar profile menu)
  // but it has its own tutorial and Topbar title block, so it needs an
  // entry here for AppShell to look up.
  account:   { title: 'Account',       subtitle: 'Settings & billing' },
};
