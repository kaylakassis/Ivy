// Turns the link an owner copies from YouTube, Vimeo or Loom (a normal
// watch / share link) into the address the site can show in a frame.
// Only those three hosts are allowed - they are the ones the site's
// frame policy (vercel.json CSP frame-src) permits - so anything else
// returns null and the editor shows a friendly message instead.
//
// Plain JS (no React) so the public renderer, the server HTML renderer
// and Ivy's website tools all share one rule.
export const VIDEO_HOSTS_LABEL = 'YouTube, Vimeo or Loom';

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;
const NUM = /^\d{3,20}$/;
const LOOM_ID = /^[A-Za-z0-9]{8,64}$/;

export function videoEmbedUrl(input) {
  if (input == null) return null;
  let raw = String(input).trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  // YouTube: watch?v=ID, /shorts/ID, /live/ID, /embed/ID, youtu.be/ID
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    let id = u.searchParams.get('v');
    if (!id && parts.length >= 2 && ['shorts', 'live', 'embed', 'v'].includes(parts[0])) id = parts[1];
    if (id && YT_ID.test(id)) return `https://www.youtube.com/embed/${id}`;
    return null;
  }
  if (host === 'youtu.be') {
    const id = parts[0];
    return id && YT_ID.test(id) ? `https://www.youtube.com/embed/${id}` : null;
  }
  // Vimeo: vimeo.com/ID, vimeo.com/channels/x/ID, player.vimeo.com/video/ID
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = [...parts].reverse().find((p) => NUM.test(p));
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }
  // Loom: loom.com/share/ID or loom.com/embed/ID
  if (host === 'loom.com') {
    if (parts.length >= 2 && (parts[0] === 'share' || parts[0] === 'embed') && LOOM_ID.test(parts[1])) {
      return `https://www.loom.com/embed/${parts[1]}`;
    }
    return null;
  }
  return null;
}

// True when the link is one the site can show.
export function isSupportedVideoLink(input) {
  return !!videoEmbedUrl(input);
}

// Instagram post / reel link → its embed page, or null. Only an https link
// on instagram.com counts: the old "/p/ anywhere in the text" test put any
// string (even a javascript: URL) straight into the frame's src.
const IG_SHORTCODE = /^[A-Za-z0-9_-]{4,64}$/;
export function instagramEmbedUrl(input) {
  if (input == null) return null;
  let raw = String(input).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  if (host !== 'instagram.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const i = parts.findIndex((p) => p === 'p' || p === 'reel');
  if (i < 0 || !IG_SHORTCODE.test(parts[i + 1] || '')) return null;
  return `https://www.instagram.com/${parts[i]}/${parts[i + 1]}/embed`;
}
