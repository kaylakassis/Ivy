// Shared helpers for Ivy's proactive "here's your day" greeting. The server
// (api/_lib/ivy.js buildBriefing) returns the facts and a prioritized items[]
// list; the time-of-day word is computed HERE, on the client, because only the
// browser knows the owner's local clock (the server runs in UTC).

export function timeGreeting(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// The full opening line, e.g. "Good morning, Bright & Co." — falls back to a
// bare greeting when the business has no name yet.
export function greetingLine(bizName, date = new Date()) {
  const g = timeGreeting(date);
  const name = (bizName || '').trim();
  return name ? `${g}, ${name}.` : `${g}.`;
}

// True when the briefing has something worth proactively saying.
export function hasBriefing(briefing) {
  return !!(briefing && Array.isArray(briefing.items) && briefing.items.length > 0);
}
