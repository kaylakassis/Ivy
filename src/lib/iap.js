// In-App Purchase wrapper (iOS), on RevenueCat.
//
// RevenueCat is the SDK *and* the server-side source of truth for iOS
// subscription state: it handles the StoreKit minutiae (receipt
// validation, renewals, refunds, grace periods, family sharing, the App
// Store Server Notifications firehose) and forwards a clean event to
// /api/billing/revenuecat-webhook, which is what actually flips a
// workspace to 'active'.
//
// The native SDK is already linked through the Capacitor plugin
// (@revenuecat/purchases-capacitor → PurchasesHybridCommon → RevenueCat
// via CocoaPods). Do NOT also add the RevenueCat Swift Package: that
// links a second copy of the framework into the same binary.
//
// Conventions that must hold, or purchases go to the wrong place:
//   • OUR workspace id is the RevenueCat appUserID. The webhook reads
//     event.app_user_id and updates `workspaces WHERE id = that`, so if
//     the SDK is still anonymous at purchase time the payment lands on
//     an id we can't match and the customer pays for nothing. Call
//     identifyIapUser() as soon as the workspace is known, and
//     logOutIap() on sign-out so the next person on this device does
//     not inherit the previous customer.
//   • Entitlement: PRO_ENTITLEMENT below must match the entitlement
//     identifier configured in the RevenueCat dashboard.
//   • Products are matched by RevenueCat *package type* (ANNUAL vs the
//     recurring one), not by product id, so renaming products in App
//     Store Connect can't break the paywall.
import { isIos } from './platform.js';

const PUBLIC_KEY = import.meta.env.VITE_REVENUECAT_PUBLIC_KEY_IOS || '';

// The entitlement that unlocks the paid product. Overridable so a
// dashboard rename doesn't need a code change.
export const PRO_ENTITLEMENT =
  import.meta.env.VITE_REVENUECAT_ENTITLEMENT_ID || 'ivy_for_solo_businesses_pro';

// PURCHASES_ERROR_CODE values (strings) from the SDK's enum. We branch on
// the code, never on the message text - messages are localized and change.
const CODE = {
  CANCELLED: '1',
  STORE_PROBLEM: '2',
  NOT_ALLOWED: '3',
  PRODUCT_UNAVAILABLE: '5',
  ALREADY_PURCHASED: '6',
  RECEIPT_IN_USE: '13',
  NETWORK: '10',
  PAYMENT_PENDING: '20',
  CONFIGURATION: '23',
  OFFLINE: '35',
};

// Plain-language messages. No numeric codes in anything a user reads.
function messageFor(err) {
  switch (String(err?.code)) {
    case CODE.STORE_PROBLEM:      return 'The App Store had a problem. Please try again in a moment.';
    case CODE.NOT_ALLOWED:        return 'This device is not allowed to make purchases. Check Screen Time restrictions.';
    case CODE.PRODUCT_UNAVAILABLE:return "This plan isn't available on the App Store yet. Please try again later.";
    case CODE.ALREADY_PURCHASED:  return 'You already have this subscription. Tap Restore purchases to bring it over.';
    case CODE.RECEIPT_IN_USE:     return 'This subscription is already attached to a different Ivy account.';
    case CODE.NETWORK:
    case CODE.OFFLINE:            return 'Could not reach the App Store. Check your connection and try again.';
    case CODE.PAYMENT_PENDING:    return 'Your payment is pending approval. Access unlocks once it clears.';
    case CODE.CONFIGURATION:      return 'In-app purchases are not set up yet. Please contact support.';
    default:                      return err?.message || 'Purchase failed. Please try again.';
  }
}

let configured = false;
let configuring = null;
let currentAppUserId = null;
let purchasesPromise = null;

// Resolves to the MODULE, never the Purchases proxy: resolving a promise
// with a Capacitor plugin proxy makes the engine look up `.then` on it,
// which becomes a native call that does not exist and never settles.
async function purchases() {
  if (!isIos()) throw new Error('IAP is iOS-only');
  if (!purchasesPromise) purchasesPromise = import('@revenuecat/purchases-capacitor');
  return purchasesPromise;
}

// Is in-app purchasing usable at all on this build/device?
export function iapAvailable() {
  return isIos() && !!PUBLIC_KEY;
}

export async function initIAP() {
  if (!iapAvailable()) return false;
  if (configured) return true;
  if (configuring) return configuring;
  configuring = (async () => {
    try {
      const { Purchases: P } = await purchases();
      await P.configure({ apiKey: PUBLIC_KEY });
      configured = true;
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[iap] configure failed:', err?.message || err);
      return false;
    } finally {
      configuring = null;
    }
  })();
  return configuring;
}

// Tie the RevenueCat customer to OUR workspace. Safe to call repeatedly;
// the SDK call is skipped when the id is already current.
export async function identifyIapUser(workspaceId) {
  const id = workspaceId ? String(workspaceId) : '';
  if (!iapAvailable() || !id) return false;
  if (!(await initIAP())) return false;
  if (currentAppUserId === id) return true;
  try {
    const { Purchases: P } = await purchases();
    await P.logIn({ appUserID: id });
    currentAppUserId = id;
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[iap] logIn failed:', err?.message || err);
    return false;
  }
}

// Sign-out: drop the RevenueCat identity so the next account on this
// device starts as a fresh anonymous customer instead of inheriting the
// previous owner's subscription.
export async function logOutIap() {
  if (!iapAvailable() || !configured || !currentAppUserId) return;
  try {
    const { Purchases: P } = await purchases();
    await P.logOut();
  } catch (err) {
    // LOG_OUT_ANONYMOUS_USER_ERROR just means there was nothing to drop.
    // eslint-disable-next-line no-console
    if (String(err?.code) !== '22') console.error('[iap] logOut failed:', err?.message || err);
  } finally {
    currentAppUserId = null;
  }
}

// True when the customer holds the paid entitlement.
//
// Deliberately forgiving: if the named entitlement is missing but some
// other entitlement is active, treat the customer as paid and warn. A
// dashboard rename should never lock out somebody who is paying.
export function hasProEntitlement(customerInfo) {
  const active = customerInfo?.entitlements?.active || {};
  if (active[PRO_ENTITLEMENT]) return true;
  const other = Object.keys(active);
  if (other.length) {
    // eslint-disable-next-line no-console
    console.warn(`[iap] active entitlement(s) ${other.join(', ')} but not "${PRO_ENTITLEMENT}" - check the RevenueCat dashboard.`);
    return true;
  }
  return false;
}

// Current entitlement state, straight from the SDK's cache.
// { active, productId, willRenew, expiresAt, periodType } - all null when unavailable.
export async function checkIapEntitlement({ fresh = false } = {}) {
  const empty = { active: false, productId: null, willRenew: false, expiresAt: null, periodType: null };
  if (!iapAvailable()) return empty;
  if (!(await initIAP())) return empty;
  try {
    const { Purchases: P } = await purchases();
    if (fresh) await P.invalidateCustomerInfoCache().catch(() => {});
    const { customerInfo } = await P.getCustomerInfo();
    const ent = customerInfo?.entitlements?.active?.[PRO_ENTITLEMENT]
      || Object.values(customerInfo?.entitlements?.active || {})[0]
      || null;
    return {
      active: hasProEntitlement(customerInfo),
      productId: ent?.productIdentifier || null,
      willRenew: !!ent?.willRenew,
      expiresAt: ent?.expirationDate || null,
      periodType: ent?.periodType || null,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[iap] getCustomerInfo failed:', err?.message || err);
    return empty;
  }
}

// Subscribe to entitlement changes (renewals, cancellations, purchases
// made on another device). Returns an unsubscribe function.
export async function onIapCustomerInfoChange(cb) {
  if (!iapAvailable() || typeof cb !== 'function') return () => {};
  if (!(await initIAP())) return () => {};
  try {
    const { Purchases: P } = await purchases();
    const id = await P.addCustomerInfoUpdateListener((customerInfo) => {
      try { cb({ active: hasProEntitlement(customerInfo), customerInfo }); } catch { /* listener must never throw */ }
    });
    return async () => {
      try {
        const { Purchases: P2 } = await purchases();
        await P2.removeCustomerInfoUpdateListener({ listenerToRemove: id });
      } catch { /* the page is going away anyway */ }
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[iap] listener failed:', err?.message || err);
    return () => {};
  }
}

// The current offering's packages, normalized for the paywall.
// Empty array on any failure - the paywall falls back to its plain state.
export async function getIapOfferings() {
  if (!iapAvailable()) return [];
  if (!(await initIAP())) return [];
  try {
    const { Purchases: P } = await purchases();
    const result = await P.getOfferings();
    const cur = result?.current;
    if (!cur?.availablePackages?.length) return [];
    return cur.availablePackages.map((pkg) => ({
      identifier: pkg.identifier,
      // RevenueCat gives a localized, currency-correct price string.
      priceString: pkg.product?.priceString || '',
      title: pkg.product?.title || '',
      productId: pkg.product?.identifier || '',
      // 'WEEKLY' | 'MONTHLY' | 'ANNUAL' | 'CUSTOM' …
      period: pkg.packageType || '',
      raw: pkg,
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[iap] getOfferings failed:', err?.message || err);
    return [];
  }
}

// StoreKit purchase sheet for one package. Resolves to:
//   { ok: true, hasPro, productId, transactionId }
//   { ok: false, userCancelled: true }
//   { ok: false, error: 'plain language' }
//
// On success RevenueCat fires INITIAL_PURCHASE to our webhook, which is
// what flips subscription_status. `hasPro` lets the UI unlock optimistically
// while that round trip lands.
export async function purchaseIapPackage(pkg) {
  if (!iapAvailable()) return { ok: false, error: 'In-app purchase is not available on this device.' };
  if (!pkg?.raw) return { ok: false, error: 'That plan is unavailable. Please try again.' };
  try {
    const { Purchases: P } = await purchases();
    const r = await P.purchasePackage({ aPackage: pkg.raw });
    return {
      ok: true,
      hasPro: hasProEntitlement(r?.customerInfo),
      productId: r?.productIdentifier || null,
      transactionId: r?.transaction?.transactionIdentifier || null,
    };
  } catch (err) {
    if (String(err?.code) === CODE.CANCELLED || err?.userCancelled) return { ok: false, userCancelled: true };
    return { ok: false, error: messageFor(err) };
  }
}

// Apple requires every app selling subscriptions to offer this, so a
// customer who reinstalls or switches device can recover access.
export async function restoreIapPurchases() {
  if (!iapAvailable()) return { ok: false, error: 'In-app purchase is not available on this device.' };
  try {
    const { Purchases: P } = await purchases();
    // The SDK returns { customerInfo } - reading entitlements off the top
    // level silently reports "nothing to restore" for everyone.
    const { customerInfo } = await P.restorePurchases();
    return { ok: true, hasPro: hasProEntitlement(customerInfo) };
  } catch (err) {
    return { ok: false, error: messageFor(err) };
  }
}

// Push any local StoreKit transactions up to RevenueCat. Useful when a
// purchase completed but our webhook never saw it.
export async function syncIapPurchases() {
  if (!iapAvailable() || !configured) return false;
  try {
    const { Purchases: P } = await purchases();
    await P.syncPurchases();
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[iap] syncPurchases failed:', err?.message || err);
    return false;
  }
}
