// Haptics for the iPhone app, in one place so every screen feels the same.
//
//   hapticTap()       light tap: a primary confirmation (Complete, Approve,
//                     Send, Pay, Save, Book, Publish)
//   hapticSuccess()   Apple's success pattern: a "done" toast (paid, booked,
//                     published)
//   hapticWarning()   Apple's warning pattern: a destructive confirm (Delete,
//                     Void, Refund, Turn off partner)
//   haptic(kind)      the general form: 'light' | 'medium' | 'success' | 'warning'
//
// Rules: never on every scroll or tap, only on moments that mean something.
// Two calls of the same kind inside 400ms collapse into one, so a toast and
// the action that opened it never buzz twice. On the web this is a no-op
// apart from the Vibration API where it exists (Android browsers; iOS
// Safari ignores it). Never throws.
import { isNative } from './platform.js';

const DEBOUNCE_MS = 400;
const last = new Map();

export function haptic(kind = 'light') {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - (last.get(kind) || 0) < DEBOUNCE_MS) return;
  last.set(kind, now);
  if (isNative()) {
    import('@capacitor/haptics').then(({ Haptics, ImpactStyle, NotificationType }) => {
      if (kind === 'success') return Haptics.notification({ type: NotificationType.Success });
      if (kind === 'warning') return Haptics.notification({ type: NotificationType.Warning });
      return Haptics.impact({ style: kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light });
    }).catch(() => {});
    return;
  }
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    navigator.vibrate(kind === 'success' ? [12, 60, 18] : typeof kind === 'number' ? kind : 15);
  } catch { /* unsupported - ignore */ }
}

export const hapticTap = () => haptic('light');
export const hapticSuccess = () => haptic('success');
export const hapticWarning = () => haptic('warning');
