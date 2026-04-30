// Shared helpers for the messages feature.

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const isYest = d.toDateString() === yesterday.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isYest)  return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Insert iMessage-style timestamp dividers before the first message and
// before any message that arrived 15+ minutes after the previous one.
export function computeTimestampPoints(messages) {
  const points = new Set();
  const GAP = 15 * 60 * 1000;
  for (let i = 0; i < messages.length; i++) {
    if (i === 0) { points.add(0); continue; }
    const prev = new Date(messages[i - 1].createdAt).getTime();
    const cur  = new Date(messages[i].createdAt).getTime();
    if (cur - prev >= GAP) points.add(i);
  }
  return points;
}

export function fmtTimestampHeader(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const isYest = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86400e3);
  if (sameDay) return `Today · ${time}`;
  if (isYest)  return `Yesterday · ${time}`;
  if (daysAgo < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} · ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const datePart = sameYear
    ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return `${datePart} · ${time}`;
}
