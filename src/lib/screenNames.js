// Turns an address in the owner app into one of the fixed screen names the
// server accepts (api/_lib/screenVisits.js). Anything else gives null and is
// never reported. Kept apart from the sender so it can be tested alone.
const SEGMENT = {
  dashboard: 'dashboard', progress: 'progress', calendar: 'calendar', clients: 'clients', finance: 'finance',
  ivy: 'ivy', messages: 'messages', programs: 'programs', automation: 'automation', reviews: 'reviews',
  website: 'website', shops: 'shops', documents: 'documents', account: 'account', more: 'more',
};

// '/clients?view=rewards' → 'clients-rewards'; unknown paths → null.
export function screenFor(pathname, search = '') {
  const seg = String(pathname || '').split('/')[1] || '';
  const base = SEGMENT[seg];
  if (!base) return null;
  if (base === 'clients') {
    const v = new URLSearchParams(search || '').get('view');
    if (v === 'rewards' || v === 'reminders') return `clients-${v}`;
  }
  return base;
}
