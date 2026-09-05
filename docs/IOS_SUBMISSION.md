# Shipping Ivy to the iOS App Store

End-to-end checklist for taking a release from `main` to the App Store.
Everything past the "Generate the iOS project" step has to happen on a
Mac - Xcode is required.

## Prerequisites (one-time)

- **Apple Developer Program** membership ($99/yr) on the Apple ID you'll
  use for App Store Connect. The team ID goes into Xcode's signing tab.
- **Xcode 16+** with the iOS 17 SDK. Install Command Line Tools
  (`xcode-select --install`).
- **CocoaPods 1.15+** (`sudo gem install cocoapods`). Capacitor pulls
  native dependencies via Pods.
- No TypeScript needed. The Capacitor config is `capacitor.config.js`
  (plain ESM, which `"type": "module"` makes native) precisely so a
  fresh clone can run `npx cap add ios` without installing a compiler
  the project otherwise has no use for. If you rename it back to
  `.ts`, `cap` refuses to run until `typescript` is installed.
- **RevenueCat account** (free up to $2.5K MRR). Create a project named
  "Ivy" with one iOS app entry.
- **A `.env` file ON THE MAC** carrying the two build-time values below.
  This trips people up: the iOS bundle is produced by `npm run build`
  *on the Mac* and copied into the `.ipa` by `cap sync`, so these are
  baked in from the Mac's environment. Setting them in Vercel does
  nothing for the app - Vercel only builds the web app.
  - `VITE_API_BASE_URL` (e.g. `https://joinivy.ai`) - the cross-origin
    API base. Without it every API call from the device resolves to
    `https://localhost/api/…` and fails, in a signed build you won't
    notice until TestFlight.
  - `VITE_REVENUECAT_PUBLIC_KEY_IOS` - the iOS public SDK key (it ships
    in the JS bundle; it is NOT a secret). Without it the paywall loads
    with nothing to buy, which is a 3.1.1 rejection.

  `npm run ios:sync` runs `scripts/check-ios-env.mjs` first. The two are
  treated differently, because they are not equally fatal:
  a missing/malformed `VITE_API_BASE_URL` **stops the build** (the app
  would be completely non-functional), while a missing
  `VITE_REVENUECAT_PUBLIC_KEY_IOS` only **warns and continues** - that
  build is perfectly good for trying the app through TestFlight, it just
  has an empty paywall and must not be submitted for review. Override the
  fatal one with `IVY_SKIP_IOS_ENV_CHECK=1` for a throwaway simulator
  bundle.

  Both stay EMPTY in Vercel: the web app calls `/api` relatively and
  never touches StoreKit.
- Server-side vars that DO belong in Vercel (runtime, read by the API
  routes): `REVENUECAT_WEBHOOK_SECRET` - a long random string used as
  the bearer token for `/api/billing/revenuecat-webhook` - plus the
  `APNS_*` set in the push section below.

## App Store Connect setup

0. **Paid Applications Agreement - DO THIS FIRST.** Developer Program
   membership alone does not let you sell anything. Go to App Store
   Connect -> Business -> Agreements, Tax, and Banking, accept the
   **Paid Applications** agreement, then add a bank account and complete
   the tax forms. Subscriptions cannot be approved (and the app cannot
   ship) until the status reads **Active**. Bank/tax verification is the
   single slowest step in this document - it can take several business
   days - so start it before anything else and let it process while you
   work through the rest.
1. **Bundle ID:** `ai.joinivy.app` - must match `capacitor.config.js`.
2. **App record:** create under "My Apps" → primary language English,
   bundle ID matching above.
3. **In-app purchases:**
   - Create a **Subscription Group** called `Ivy`.
   - Add two auto-renewable subscriptions in that group:
     - Product ID `ivyos_weekly`, price $8.99 / week (Weekly is a native
       StoreKit duration, so it matches the web weekly plan exactly)
     - Product ID `ivyos_yearly`, price $375 / year
   - Both must be in the same group so Apple offers proration when
     users upgrade/downgrade between them.
   - **Add a 14-day Introductory Offer → Free Trial to each product**
     (App Store Connect → the subscription → Introductory Offers → Create
     → Free, 2 weeks). This is what makes the StoreKit sheet read
     "Free for 14 days, then $X" and is the iOS half of the
     hard-paywall-after-onboarding funnel. Apple grants one intro per
     Apple ID; our RevenueCat webhook stamps `trial_started_at` on the
     trial `INITIAL_PURCHASE` and `converted_at` on the first paid
     renewal. Keep the 14 days in sync with `TRIAL_DAYS`
     (`src/lib/pricing.js` / `api/_lib/billing.js`).
   - Submit at least one introductory screenshot per product, plus
     localized display name + description.
4. **App Privacy:** declare data collection per the questions:
   - Contact Info (email, name): yes - linked to user, for app
     functionality.
   - User Content (messages, files): yes - linked to user.
   - Identifiers (user ID): yes - linked to user.
   - Health / Financial / Location data: no.
5. **Sign in with Apple: NOT required.** Guideline 4.8 only applies to
   apps that offer a *third-party or social* login (Google, Facebook,
   etc.) for the primary account. Ivy authenticates with email +
   password only - the Google OAuth in this codebase is Calendar sync,
   not sign-in - so plain email/password does not trigger the
   requirement. Do not add the capability; it costs setup time and an
   extra review surface for nothing.

## RevenueCat setup

1. **Project → API keys:** copy the **iOS app public SDK key** into
   `VITE_REVENUECAT_PUBLIC_KEY_IOS` in Vercel.
2. **Products:** add `ivyos_weekly` and `ivyos_yearly` exactly as in
   App Store Connect.
3. **Entitlement:** create a single entitlement called `pro`. Attach
   both products to it. (We don't check entitlement name server-side
   - RC tells us *which* product was bought and we route on that - but
   the SDK needs an entitlement to surface the offering.)
4. **Offering:** create the default offering, add a "Weekly" package
   (linked to `ivyos_weekly`) and an "Annual" package (linked to
   `ivyos_yearly`). Order them Annual first so it's the highlighted
   default in the paywall.
5. **App Store Connect integration:** RC walks you through generating
   the App-Specific Shared Secret + the in-app purchase key (`.p8`).
   Without these RC can't validate Apple receipts.
6. **Webhook:**
   - URL: `https://joinivy.ai/api/billing/revenuecat-webhook`
   - Authorization header: paste the same string as
     `REVENUECAT_WEBHOOK_SECRET` above (RC sends it verbatim, we
     constant-time compare).

## Generate the iOS project

From the repo root, on the Mac:

```bash
cp .env.example .env        # then fill in the two VITE_* values
npm install
npx cap add ios            # one-time - creates ios/ tree
npm run ios:sync           # env preflight + build + copy into ios/ + pods
npm run ios:open           # opens ios/App/App.xcworkspace in Xcode
```

The `ios/` directory IS committed (so the project metadata, Info.plist,
entitlements, and asset catalog are reviewable in diffs). `ios/App/App/public`
is `.gitignore`d - it's a copy of `dist/` and gets regenerated by
`cap sync`.

## Xcode configuration (one-time)

In Xcode, with the `App` target selected:

1. **Signing & Capabilities:**
   - Team: your Apple Developer team.
   - Add capability: **In-App Purchase**.
   - Add capability: **Push Notifications**.
   - Do NOT add **Sign in with Apple** - see the App Store Connect
     section above; email/password-only apps don't need it.
   - Add capability: **Associated Domains** if/when we want universal
     links - not required for v1.
2. **Info → Custom iOS Target Properties:**
   - `NSCameraUsageDescription`: "Ivy uses your camera so you can
     attach photos to client notes and upload service images."
   - `NSPhotoLibraryUsageDescription`: "Ivy accesses your photo
     library so you can attach images to client notes and services."
   - `NSMicrophoneUsageDescription`: "Ivy uses the microphone so
     you can send voice messages from the inbox."
   - `NSLocationWhenInUseUsageDescription`: "Ivy uses your location
     to autofill your business address when setting up your booking
     site."
3. **General → Minimum Deployments:** iOS 16.0.
   - **Supported Destinations:** remove iPad, keep iPhone. Shipping
     iPhone-only means App Store Connect stops requiring a separate
     iPad screenshot set for every release.
4. **Build Settings → Versioning:** Marketing Version = `1.0.0`, Build
   number = `1`. Bump build number on every TestFlight upload.

## Push notifications (APNs)

Native pushes ride the SAME pipeline as web push - every existing
`notifyOwnerSafe` call fans out to iOS devices automatically once this
is configured. Code: `api/_lib/apns.js` (sender), `api/push/device.js`
(token registry), `src/lib/nativePush.js` (registration + tap routing).

1. **Developer portal → Certificates, IDs & Profiles → Keys → “+”.**
   Create a key with **Apple Push Notifications service (APNs)**
   enabled. Download the `.p8` file (one-time download - keep it), note
   the **Key ID** and your **Team ID** (Membership page).
2. **Xcode → target → Signing & Capabilities → “+ Capability” → Push
   Notifications.** (No Background Modes needed for alert pushes.)
3. **Vercel env (Production):**
   - `APNS_TEAM_ID`     - 10-char Team ID
   - `APNS_KEY_ID`      - 10-char Key ID
   - `APNS_PRIVATE_KEY` - the full contents of the `.p8` file
   - `APNS_BUNDLE_ID`   - `ai.joinivy.app` (only if you changed it)
   - `APNS_ENV`         - leave unset. TestFlight + App Store use
     production APNs; set `sandbox` ONLY when testing a build run
     directly from Xcode.
4. Redeploy, then install a TestFlight build, allow notifications, and
   send yourself a booking - the phone should light up.

Notes:
- Permission is requested in-app from the notifications prompt /
  Account → Notifications toggle (same surfaces as web push), never
  cold on launch - Apple rejects permission ambushes.
- Dead tokens self-clean: Apple's 410/Unregistered responses delete the
  row, same as web push 404/410 handling.

## Submission

```bash
npm run ios:sync           # build + cap sync; idempotent
# In Xcode:
# Product → Archive
# Organizer → Distribute App → App Store Connect → Upload
```

After upload, in App Store Connect:

1. Wait for the build to finish processing (~10 min).
2. Add the build to the version, fill in:
   - **What to Test** (TestFlight) or release notes.
   - Demo account credentials - REQUIRED. Create a fresh demo workspace
     with at least one client, one booking, one invoice, one document.
     Reviewers will sign in as this user.
   - **App Review notes:** explain that Ivy is a business-management
     SaaS, that the iOS app uses the same backend as the web app, and
     that the StoreKit subscription unlocks the same workspace the web
     app does (i.e. it's not a separate product).
3. Submit for review.

## Common rejection causes (and our defenses)

- **3.1.1 - IAP required for digital goods sold in-app.** Our paywall
  uses StoreKit on iOS (see `src/features/billing/Paywall.jsx`); the
  Stripe checkout path is never reachable when `isIos()` is true.
- **3.1.1 - Restore Purchases.** Visible button on the paywall in the
  iOS build (`Restore purchases` next to the trial / log-out row).
- **5.1.1(v) - Account deletion.** Already implemented at
  `/account` → Delete account (`api/account/delete.js`).
- **2.1 - Demo account.** Provide a working demo workspace in App
  Review Notes (see Submission step 2).
- **4.0 - Spam / minimum functionality.** Ivy is a full SaaS -
  bookings, invoices, messaging, documents - so this shouldn't fire.
  Make sure screenshots cover at least 4 distinct features.

## Post-release plumbing

- **Webhook health:** RevenueCat dashboard → Webhooks → Logs shows
  every delivery. Replay from there if our endpoint was down.
- **Subscription state in Postgres:** `workspaces.subscription_source =
  'apple'` for iOS-billed workspaces; `apple_product_id` /
  `apple_original_transaction_id` for forensics. Audit query:
  ```sql
  SELECT id, subscription_status, apple_product_id,
         subscription_period_end
    FROM workspaces
   WHERE subscription_source = 'apple'
   ORDER BY created_at DESC LIMIT 50;
  ```
- **Cancel UX on iOS:** users cancel in Apple's Subscriptions UI (deep
  link: `itms-apps://apps.apple.com/account/subscriptions`). The
  "Manage billing" button is hidden on iOS - replaced by the Restore
  Purchases / system Settings flow.
