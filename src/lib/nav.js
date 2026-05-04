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
  { id: 'calendar',  to: '/calendar',   label: 'Calendar',       icon: 'Calendar' },
  { id: 'finance',   to: '/finance',    label: 'Finance',        icon: 'Dollar' },
  { id: 'goals',     to: '/goals',      label: 'Goals & Tasks',  icon: 'Check' },
  { id: 'rewards',   to: '/rewards',    label: 'Rewards',        icon: 'Gift' },
  { id: 'comms',     to: '/messages',   label: 'Messages',       icon: 'Chat' },
  { id: 'docs',      to: '/documents',  label: 'Documents',      icon: 'Doc' },
  { id: 'website',   to: '/website',    label: 'Website',        icon: 'Globe' },
  { id: 'ivy',       to: '/ivy',        label: 'Ivy Pro',        icon: 'Spark', accent: true },
  { id: 'admin',     to: '/admin',      label: 'Admin',          icon: 'Settings', superAdminOnly: true },
];

export const TITLES = {
  dashboard: { title: 'Dashboard',     subtitle: 'Home' },
  clients:   { title: 'Clients',       subtitle: 'Your people' },
  calendar:  { title: 'Calendar',      subtitle: 'This week' },
  finance:   { title: 'Finance',       subtitle: 'Money in, money out' },
  goals:     { title: 'Goals & Tasks', subtitle: 'Stay on track' },
  rewards:   { title: 'Rewards',       subtitle: 'Loyalty & referrals' },
  comms:     { title: 'Messages',      subtitle: 'Inbox' },
  docs:      { title: 'Documents',     subtitle: 'Notes & files' },
  website:   { title: 'Website',       subtitle: 'Public presence' },
  ivy:       { title: 'Ivy Pro',       subtitle: 'Your AI coach' },
  admin:     { title: 'Admin',         subtitle: 'Operator console' },
};
