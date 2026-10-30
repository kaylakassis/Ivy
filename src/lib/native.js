// Native-only polish for the iPhone app, started once from the app shells.
// Everything here no-ops on the web.
//
//   • Keyboard: the web view shrinks above the keyboard (capacitor.config
//     Keyboard.resize = native), the tab bar hides while typing, the
//     focused field scrolls into view, and the keyboard gets Apple's
//     "Done" accessory bar.
//   • Outside links open in an in-app Safari sheet (SFSafariViewController)
//     with a Done button, instead of throwing people out to Safari. App
//     Store, mail, phone and text links still go to their own apps.
import { isNative, isIos } from './platform.js';

let started = false;

// Hosts that should leave Ivy entirely (their own apps handle them).
const SYSTEM_HOSTS = /(^|\.)apps\.apple\.com$|(^|\.)itunes\.apple\.com$/i;

export function shouldOpenInSheet(href, currentOrigin) {
  if (!href || typeof href !== 'string') return false;
  let u;
  try { u = new URL(href, currentOrigin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false; // mailto:, tel:, sms:, itms-apps:
  if (SYSTEM_HOSTS.test(u.hostname)) return false;
  if (u.origin === currentOrigin) return false; // the app's own pages
  return true;
}

async function openInSheet(url) {
  try {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url, presentationStyle: 'popover' });
    return true;
  } catch {
    return false;
  }
}

function startKeyboard() {
  import('@capacitor/keyboard').then(({ Keyboard }) => {
    Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(() => {});
    Keyboard.addListener('keyboardWillShow', (info) => {
      document.body.classList.add('keyboard-open');
      document.documentElement.style.setProperty('--kb-h', `${Math.round(info?.keyboardHeight || 0)}px`);
    });
    Keyboard.addListener('keyboardDidShow', () => {
      const el = document.activeElement;
      if (el && typeof el.scrollIntoView === 'function' && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* old WebKit */ }
      }
    });
    Keyboard.addListener('keyboardWillHide', () => {
      document.body.classList.remove('keyboard-open');
      document.documentElement.style.setProperty('--kb-h', '0px');
    });
  }).catch(() => {});
}

function startLinkSheets() {
  // Anchors: capture phase so we run before React handlers navigate.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
    const a = e.target?.closest?.('a[href]');
    if (!a || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!shouldOpenInSheet(href, window.location.origin)) return;
    e.preventDefault();
    openInSheet(new URL(href, window.location.origin).href).then((ok) => {
      if (!ok) window.location.href = href;
    });
  }, true);
  // window.open(...) for outside pages.
  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    if (shouldOpenInSheet(url, window.location.origin)) {
      openInSheet(new URL(url, window.location.origin).href);
      return null;
    }
    return nativeOpen(url, target, features);
  };
}

export function initNative() {
  if (started || !isNative()) return;
  started = true;
  if (isIos()) startKeyboard();
  startLinkSheets();
}
