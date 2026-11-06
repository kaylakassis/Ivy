// Turns what an owner types for a social section (a username, "@name",
// or a pasted link) into the profile link the site shows. Plain JS so the
// editor and Ivy's website tools share one rule.
const str = (v) => (v == null ? '' : String(v));

export function normalizeInstagram(input) {
  const v = str(input).trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(www\.)?instagram\.com\//i.test(v)) return `https://${v.replace(/^www\./i, 'www.')}`;
  const user = v.replace(/^@/, '').replace(/\/+$/, '');
  if (/^[A-Za-z0-9._]{1,30}$/.test(user)) return `https://www.instagram.com/${user}/`;
  return v;
}

export const SOCIAL_PLATFORMS = [
  { id: 'tiktok',   label: 'TikTok',   host: 'tiktok.com',   example: 'https://www.tiktok.com/@yourstudio' },
  { id: 'x',        label: 'X',        host: 'x.com',        example: 'https://x.com/yourstudio' },
  { id: 'linkedin', label: 'LinkedIn', host: 'linkedin.com', example: 'https://www.linkedin.com/in/yourname' },
  { id: 'facebook', label: 'Facebook', host: 'facebook.com', example: 'https://www.facebook.com/yourstudio' },
  { id: 'youtube',  label: 'YouTube',  host: 'youtube.com',  example: 'https://www.youtube.com/@yourstudio' },
  { id: 'threads',  label: 'Threads',  host: 'threads.net',  example: 'https://www.threads.net/@yourstudio' },
];
export const SOCIAL_PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id);

export function normalizeSocialPlatform(p) {
  const v = str(p).toLowerCase().trim();
  if (v === 'twitter') return 'x';
  return SOCIAL_PLATFORM_IDS.includes(v) ? v : null;
}

export function normalizeSocialUrl(platform, input) {
  const v = str(input).trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  const p = SOCIAL_PLATFORMS.find((x) => x.id === normalizeSocialPlatform(platform));
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(v)) return `https://${v}`;
  if (p && /^@?[A-Za-z0-9._-]{1,60}$/.test(v)) {
    const user = v.replace(/^@/, '');
    if (p.id === 'tiktok' || p.id === 'youtube' || p.id === 'threads') return `https://www.${p.host}/@${user}`;
    if (p.id === 'linkedin') return `https://www.linkedin.com/in/${user}`;
    if (p.id === 'x') return `https://x.com/${user}`;
    return `https://www.${p.host}/${user}`;
  }
  return v;
}
