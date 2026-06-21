# Manual rebrand checklist - what needs your hands

The codebase rebrand is done. Everything below has to happen **outside the repo** - in dashboards, registrars, or DNS - because the code can't reach in and change them for you. Do these in roughly this order; the deploy step at the bottom depends on most of the rest being done first.

## 1. Domain & DNS (do this first - everything else depends on it)

- [ ] **Register `getivyos.com`** (any registrar - Namecheap, Cloudflare, etc.).
- [ ] **Point `getivyos.com` at Vercel** - in Vercel → Project → Settings → Domains, add `getivyos.com` and `www.getivyos.com`, and copy the A/CNAME records Vercel shows into your registrar's DNS.
- [ ] **Add the apex CNAME target `cname.getivyos.com`** as a CNAME → `cname.vercel-dns.com` (or whatever Vercel tells you). This is the address customers' custom domains will point at via `WEBSITE_CNAME_TARGET`; without it the in-product "Connect a custom domain" flow can't verify.
- [ ] **Remove the old `getthryve.ai` domain from the Vercel project** so it stops serving stale content (or set up a redirect from `getthryve.ai` → `getivyos.com` if you want existing inbound links to survive - your call).

## 2. Email (mailboxes + sender verification)

- [ ] **Create these mailboxes** at `getivyos.com` (in Google Workspace, Fastmail, whatever you use - aliases to one inbox are fine):
  - `hello@getivyos.com` - sender + main reply-to (used in `EMAIL_FROM` and many templates)
  - `support@getivyos.com` - Terms / customer support
  - `privacy@getivyos.com` - Privacy Policy / Do-Not-Sell
  - `security@getivyos.com` - Security page vulnerability reports
  - `noreply@getivyos.com` - (optional; only one template references it)
- [ ] **Verify `getivyos.com` in Resend** (Resend dashboard → Domains → Add domain). Add the DKIM + SPF + return-path records they give you to your registrar's DNS.
- [ ] **Add a DMARC record** for `getivyos.com` (a permissive `v=DMARC1; p=none; rua=mailto:hello@getivyos.com` is fine to start). Without DMARC, Gmail and Yahoo started rejecting transactional mail in 2024.

## 3. Vercel env vars (rename THRYVE_* → IVY_*)

In Vercel → Project → Settings → Environment Variables, for **each environment** (Production, Preview, Development) where the old names exist:

| Old | New |
|---|---|
| `THRYVE_STRIPE_SECRET` | `IVY_STRIPE_SECRET` |
| `THRYVE_STRIPE_PUBLISHABLE_KEY` | `IVY_STRIPE_PUBLISHABLE_KEY` |
| `THRYVE_STRIPE_PRICE_ID` | `IVY_STRIPE_PRICE_ID` |
| `THRYVE_STRIPE_PRICE_ID_ANNUAL` | `IVY_STRIPE_PRICE_ID_ANNUAL` |
| `THRYVE_STRIPE_WEBHOOK_SECRET` | `IVY_STRIPE_WEBHOOK_SECRET` |
| `THRYVE_BILLING_WEBHOOK_SECRET` | `IVY_BILLING_WEBHOOK_SECRET` |
| `THRYVE_TWILIO_ACCOUNT_SID` | `IVY_TWILIO_ACCOUNT_SID` |
| `THRYVE_TWILIO_AUTH_TOKEN` | `IVY_TWILIO_AUTH_TOKEN` |
| `THRYVE_TWILIO_FROM_NUMBER` | `IVY_TWILIO_FROM_NUMBER` |
| `THRYVE_PLAN_MONTHLY_CENTS` | `IVY_PLAN_MONTHLY_CENTS` |
| `THRYVE_POSTAL_ADDRESS` | `IVY_POSTAL_ADDRESS` |

- [ ] **Also update the values that contain the old domain or brand text**:
  - `APP_URL` → `https://getivyos.com`
  - `VITE_APP_URL` → `https://getivyos.com`
  - `VITE_API_BASE_URL` (used by the iOS build) → `https://getivyos.com`
  - `EMAIL_FROM` → `Ivy OS <hello@getivyos.com>`
  - `EMAIL_REPLY_TO` → `hello@getivyos.com`
  - `VAPID_SUBJECT` → `mailto:hello@getivyos.com`
  - `WEBSITE_CNAME_TARGET` → `cname.getivyos.com` (if you've set it explicitly; otherwise the code default already points here)
  - `SQUARE_REDIRECT_URI` → `https://getivyos.com/api/finance/square-oauth-callback`
- [ ] **Generate `REVENUECAT_WEBHOOK_SECRET`** if you haven't yet (any long random string; used as the bearer token RC sends to our webhook). Set it in Vercel.
- [ ] **Generate `VITE_REVENUECAT_PUBLIC_KEY_IOS`** - actually, you'll get this from RevenueCat in step 8. Just remember to come back and set it.

⚠️ Renaming the env vars takes effect on the **next deploy**, not immediately. Don't delete the old `THRYVE_*` ones until the deploy succeeds with the new names.

### Optional: passwordless QA test login

Set **`DEV_LOGIN_SECRET`** (a long random string, **16+ chars** - e.g. `openssl rand -hex 24`) to enable a one-click, passwordless login into a dedicated **QA-only** account (`qa@getivyos.com`) for visually testing app states. Off by default; with no secret set the endpoint 404s and is invisible.

- Bookmark: `https://getivyos.com/api/auth/dev-login?token=YOUR_SECRET`
- Force a state with `&state=`:
  - `…&state=onboarding` - re-walk onboarding + walkthrough from the top (default for a fresh QA account)
  - `…&state=paywall` - jump straight to the hard paywall + priming screens
  - `…&state=trial` - in-trial app (14 days left)
  - `…&state=active` - paying-subscriber app

The QA account is a plain owner (never an admin) and the `state` switch only ever touches that one workspace, so a leaked link can't reach real users. Optionally set `QA_USER_EMAIL` to use a different QA address. To fully disable, delete `DEV_LOGIN_SECRET` and redeploy.

## 4. Stripe (platform side - your own billing)

In Stripe Dashboard, account-wide:

- [ ] **Account name** → "Ivy OS" (Stripe → Settings → Public details). Shows on receipts and the customer portal.
- [ ] **Public business name / statement descriptor** → "IVY OS" (≤22 chars, appears on credit-card statements).
- [ ] **Webhook endpoint URL** (Stripe → Developers → Webhooks → your "billing" endpoint) → `https://getivyos.com/api/webhooks/billing`. If you change the URL Stripe issues a new signing secret - update `IVY_BILLING_WEBHOOK_SECRET` in Vercel to match.
- [ ] **Stripe Connect** (Stripe → Settings → Connect → Branding) - update the "Connect platform" name, logo, and **redirect URL** to `https://getivyos.com/api/finance/stripe-connect-callback`.

## 5. Square (per-merchant Connect)

Square Developer Dashboard → your app:

- [ ] **App name** → "Ivy OS".
- [ ] **OAuth Redirect URL** → `https://getivyos.com/api/finance/square-oauth-callback`. Match `SQUARE_REDIRECT_URI` in Vercel.
- [ ] **Webhook subscription URL** → `https://getivyos.com/api/webhooks/square/<workspaceId>` (the pattern handler routes by workspace).

## 6. PayPal (per-merchant Partner onboarding)

PayPal Developer Dashboard → your app:

- [ ] **App / partner display name** → "Ivy OS".
- [ ] **Return URL after onboarding** → `https://getivyos.com/api/finance/paypal-onboard-return`.
- [ ] **Webhook URL** → `https://getivyos.com/api/webhooks/paypal` (or the per-workspace path your handler uses).

## 7. Twilio (your own sending number)

Twilio Console:

- [ ] **Voice / messaging webhook URLs** (if any) on your phone number → `https://getivyos.com/api/webhooks/twilio/...`.
- [ ] **A2P 10DLC brand registration** (if you've done one) - update the brand name to "Ivy OS". Required for US SMS deliverability.

## 8. RevenueCat (iOS in-app subscriptions)

RevenueCat dashboard:

- [ ] **Create or rename project** → "Ivy OS".
- [ ] **Add an iOS app** with bundle id **`com.getivyos.app`**.
- [ ] **Add two products** with exact ids:
  - `ivyos_monthly` ($49.99 / month)
  - `ivyos_yearly` ($499.99 / year)
- [ ] **Create one entitlement** called `pro`; attach both products.
- [ ] **Create the default offering** with a "Monthly" package linked to `ivyos_monthly` and an "Annual" package linked to `ivyos_yearly`. Order Annual first.
- [ ] **Copy the iOS public SDK key** into `VITE_REVENUECAT_PUBLIC_KEY_IOS` in Vercel.
- [ ] **Add a webhook**:
  - URL: `https://getivyos.com/api/billing/revenuecat-webhook`
  - Authorization header: paste the same value you used for `REVENUECAT_WEBHOOK_SECRET`.
- [ ] **App Store Connect integration**: generate the in-app purchase key (`.p8`) and App-Specific Shared Secret per RC's setup wizard.

## 9. Apple - App Store Connect + Developer

- [ ] **Register the bundle id `com.getivyos.app`** (Apple Developer → Identifiers → +).
- [ ] **Create the App Store Connect app record** with that bundle id, name "Ivy OS".
- [ ] **Subscription group** called `ivyos`. Add the two auto-renewable subscriptions with ids matching RevenueCat: `ivyos_monthly` and `ivyos_yearly`.
- [ ] In Xcode (`capacitor.config.ts` already has the new appId), enable capabilities: **In-App Purchase**, **Sign in with Apple**, **Push Notifications**.
- [ ] Full step-by-step is in `docs/IOS_SUBMISSION.md`.

## 10. Google OAuth (Calendar / Sign-in)

Google Cloud Console → APIs & Services → Credentials → your OAuth client:

- [ ] **Authorized JavaScript origins** → `https://getivyos.com`.
- [ ] **Authorized redirect URIs** → `https://getivyos.com/api/calendar/google/callback`.
- [ ] **OAuth consent screen** → app name "Ivy OS", support email `support@getivyos.com`, app logo, app domain, privacy + terms URLs (`https://getivyos.com/privacy`, `https://getivyos.com/terms`).

## 11. Sentry

- [ ] **Project name + slug** → "ivy-os" (Sentry → Settings → Projects → Edit). The DSN doesn't change.
- [ ] (Optional) **Organization name** if it was "thryve" - only if you want to.

## 12. Vercel Blob

- [ ] No dashboard rename needed - `BLOB_READ_WRITE_TOKEN` is scoped to the project, not the brand. Token value stays the same.

## 13. Anthropic / Resend / Neon

- [ ] **No mandatory action.** These are API keys without brand identifiers. Update the account display name if you want, but the code doesn't care.

## 14. GitHub

- [ ] (Optional) **Rename the repo** from `THRYVE` → `ivy-os` (Repo settings → General → Rename). GitHub will redirect the old URL automatically. Local working copies need `git remote set-url origin <new-url>` afterward.
- [ ] Update repo description + website link.

## 15. Social handles (cosmetic but match the brand)

- [ ] Twitter / X, Instagram, LinkedIn company page, etc. → update handle and bio to Ivy OS / getivyos.com.

## 16. Deploy

Once 1–8 are done:

- [ ] **Trigger a Vercel production deploy** (push to main, or redeploy). The build picks up the renamed env vars.
- [ ] **Verify after deploy**:
  - `https://getivyos.com` loads and shows the Ivy OS brand.
  - Log in works (note: **every existing user is logged out**, because the session cookie was renamed `thryve_session` → `ivy_session`. They just sign in again.)
  - A test signup arrives by email from `hello@getivyos.com`.
  - Stripe Connect onboarding flow returns to the new redirect URL.
  - RevenueCat dashboard shows the webhook URL as reachable (test event).

## 17. Optional: keep the old domain

If you want to keep `getthryve.ai` as a permanent 301 → `getivyos.com`:

- [ ] In Vercel → Domains, add `getthryve.ai` and set "Redirect to: `getivyos.com`" (308 permanent).
- [ ] Keep its DNS pointed at Vercel.

Otherwise, just let it expire at renewal.

---

That's the complete external surface. The code itself is fully rebranded and verified (lint clean, 51/51 tests pass).
