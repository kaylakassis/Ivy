// In-app replacements for the browser's own confirm(), alert() and
// prompt() boxes. Those boxes say "www.joinivy.ai says", always read
// "OK / Cancel", cannot be styled, and look like a system error inside the
// iPhone app. These open Ivy's own pop-up instead (see ConfirmHost.jsx).
//
//   if (!(await confirmAction({ title: 'Delete this expense?', confirmLabel: 'Delete', danger: true }))) return;
//   showNotice('Could not send. Please try again.');
//   const year = await askText({ title: 'Which year?', defaultValue: '2026' });
//
// confirmAction resolves true / false. askText resolves the text, or null
// when cancelled. showNotice resolves when it is dismissed (no need to wait).
//
// If the host is not mounted (a test, or a crash before it renders), they
// fall back to the browser's boxes so a risky action is never left
// unconfirmed.

let host = null;

export function registerConfirmHost(open) {
  host = open;
  return () => { if (host === open) host = null; };
}

const text = (o) => [o.title, typeof o.body === 'string' ? o.body : null].filter(Boolean).join('\n\n');
const norm = (o) => (typeof o === 'string' ? { title: o } : (o || {}));

export function confirmAction(options) {
  const o = norm(options);
  if (host) return host({ kind: 'confirm', ...o });
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return Promise.resolve(false);
  return Promise.resolve(window.confirm(text(o)));
}

export function showNotice(options) {
  const o = norm(options);
  if (host) return host({ kind: 'notice', ...o });
  if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(text(o));
  return Promise.resolve(true);
}

export function askText(options) {
  const o = norm(options);
  if (host) return host({ kind: 'text', ...o });
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return Promise.resolve(null);
  return Promise.resolve(window.prompt(text(o), o.defaultValue ?? ''));
}
