// Shared navigation config for Sidebar + breadcrumbs.
//
// Items with `superAdminOnly: true` are filtered out of the rendered
// sidebar for everyone except super-admins (Sidebar.jsx checks
// useAuth().user.isSuperAdmin and skips them otherwise). The route still
// exists in App.jsx — visibility is purely cosmetic; the API endpoints
// behind /admin already enforce super-admin auth.
export const NAV = [
  { id: 'dashboard', to: '/dashboard',  label: 'Dashboard',      icon: 'Home' },
  { id: 'clients',   to: '/clients',    label: 'Clients',        icon: 'Users' },
  { id: 'projects',  to: '/projects',   label: 'Projects',       icon: 'Doc' },
  { id: 'calendar',  to: '/calendar',   label: 'Calendar',       icon: 'Calendar' },
  { id: 'finance',   to: '/finance',    label: 'Finance',        icon: 'Dollar' },
  { id: 'goals',     to: '/goals',      label: 'Goals & Tasks',  icon: 'Check' },
  { id: 'workflows', to: '/workflows',  label: 'Workflows',      icon: 'Spark' },
  { id: 'rewards',   to: '/rewards',    label: 'Rewards',        icon: 'Gift' },
  { id: 'comms',     to: '/messages',   label: 'Messages',       icon: 'Chat' },
  { id: 'campaigns', to: '/campaigns',  label: 'Campaigns',      icon: 'Mail' },
  { id: 'docs',      to: '/documents',  label: 'Documents',      icon: 'Doc' },
  { id: 'website',   to: '/website',    label: 'Website',        icon: 'Globe' },
  { id: 'ivy',       to: '/ivy',        label: 'Ivy Pro',        icon: 'Spark', accent: true },
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
  comms:     { title: 'Messages',      subtitle: 'Inbox' },
  campaigns: { title: 'Campaigns',     subtitle: 'Newsletters & announcements' },
  docs:      { title: 'Documents',     subtitle: 'Notes & files' },
  website:   { title: 'Website',       subtitle: 'Public presence' },
  ivy:       { title: 'Ivy Pro',       subtitle: 'Your AI coach' },
  admin:     { title: 'Admin',         subtitle: 'Operator console' },
  // /account isn't in NAV (it's reached from the sidebar profile menu)
  // but it has its own tutorial and Topbar title block, so it needs an
  // entry here for AppShell to look up.
  account:   { title: 'Account',       subtitle: 'Settings & billing' },
};
