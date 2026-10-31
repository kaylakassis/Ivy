// Who sees the "Get the free Ivy app" prompt (src/components/GetAppBanner.jsx).
export const APP_STORE_URL = 'https://apps.apple.com/us/app/ivy-for-solo-businesses/id6808542331';

// Client-facing pages a client opens from a link: invoices, quotes,
// documents to sign, booking pages, programs, and the client portal.
export const CLIENT_PATHS = [/^\/invoice\//, /^\/quote\//, /^\/sign\//, /^\/book\//, /^\/p\//, /^\/me(\/|$)/];

export function isClientPath(pathname) {
  return CLIENT_PATHS.some((re) => re.test(pathname || ''));
}

// iPhone, iPod or iPad, in any browser (Safari, Chrome, Instagram's...).
// iPadOS reports a desktop Mac user agent; touch support gives it away.
export function isAppleMobile(ua = '', maxTouchPoints = 0) {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && maxTouchPoints > 1;
}
