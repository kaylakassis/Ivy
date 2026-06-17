// Ivy OS — clean-slate data. No demo content.
// Arrays are empty; static config (nav, metric labels) remains.

const CLIENTS = [];
const APPOINTMENTS = [];
const REVENUE_SERIES = [];
const EXPENSE_SERIES = [];
const ACTIVITY = [];
const IVY_INSIGHTS = [];
const TASKS = [];

// Metric shells — value = null means no data yet. Labels + suffixes kept so UI has structure.
const METRICS = {
  mrr:     { value: null, delta: null, label: 'Monthly revenue' },
  clients: { value: null, delta: null, label: 'Active clients',   suffix: '' },
  booked:  { value: null, delta: null, label: 'Booked this month',suffix: '%' },
  hours:   { value: null, delta: null, label: 'Coaching hours',   suffix: 'h' },
};

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'Home',     badge: null },
  { id: 'clients',   label: 'Clients',   icon: 'Users',    badge: null },
  { id: 'calendar',  label: 'Calendar',  icon: 'Calendar', badge: null },
  { id: 'finance',   label: 'Finance',   icon: 'Dollar',   badge: null },
  { id: 'goals',     label: 'Goals & Tasks', icon: 'Check', badge: null },
  { id: 'rewards',   label: 'Rewards',   icon: 'Gift',     badge: null },
  { id: 'comms',     label: 'Messages',  icon: 'Chat',     badge: null },
  { id: 'docs',      label: 'Documents', icon: 'Doc',      badge: null },
  { id: 'website',   label: 'Website',   icon: 'Globe',    badge: null },
  { id: 'ivy',       label: 'Ivy Pro',   icon: 'Spark',    badge: null, accent: true },
];

window.IVY_DATA = {
  CLIENTS, APPOINTMENTS, REVENUE_SERIES, EXPENSE_SERIES,
  METRICS, ACTIVITY, IVY_INSIGHTS, TASKS, NAV,
};
