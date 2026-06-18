// Runtime platform detection. Single import everywhere so we never
// scatter `typeof window` or user-agent sniffing across the codebase.
//
// We avoid importing @capacitor/core unconditionally because (a) on the
// web we don't want it in the critical-path bundle and (b) on a fresh
// developer install before `npm install` runs the module may not be
// present. Capacitor injects a global `Capacitor` object into the WebView
// at runtime when the app is running natively - that's the cheap probe.
const cap = () => (typeof window !== 'undefined' ? window.Capacitor : null);

export function isNative() {
  // Capacitor's own `isNativePlatform()` returns true for iOS and Android,
  // false in any browser (including the web preview during `cap serve`).
  return !!cap()?.isNativePlatform?.();
}

export function getPlatform() {
  // 'ios' | 'android' | 'web'.
  return cap()?.getPlatform?.() || 'web';
}

export function isIos() { return getPlatform() === 'ios'; }
export function isAndroid() { return getPlatform() === 'android'; }
