# Referral rewards for iPhone (Apple) subscribers

Owners who subscribe through the iPhone app pay Apple, not us, so a referral
free week cannot be a Stripe credit for them. Instead we push their next
renewal date out by 7 days per earned week using the App Store Server API
("Extend a Subscription Renewal Date"). This document covers the setup, the
rule that shapes delivery, and how to confirm it works.

## 1. Environment variables (Vercel)

Use the **same In-App Purchase key already uploaded to RevenueCat**. In App
Store Connect: Users and Access → Integrations → In-App Purchase. Set these in
Vercel → Project → Settings → Environment Variables (Production, and Preview
if you test there):

| Variable | Value |
| --- | --- |
| `APP_STORE_ISSUER_ID` | The Issuer ID shown at the top of the In-App Purchase keys page (a UUID). |
| `APP_STORE_KEY_ID` | The Key ID of that key (10 characters). |
| `APP_STORE_PRIVATE_KEY` | The full contents of the `.p8` file, including the `BEGIN PRIVATE KEY` and `END PRIVATE KEY` lines. Pasting it as multiple lines is fine; a single line with literal `\n` escapes also works. |
| `APP_STORE_BUNDLE_ID` | Optional. The app's bundle id. Falls back to `APNS_BUNDLE_ID`, then `ai.joinivy.app`. |
| `APP_STORE_ENV` | Optional. `production` (default) or `sandbox`. Falls back to `APNS_ENV`. Use `sandbox` only when testing against a sandbox Apple account; the two environments hold different subscriptions. |

Redeploy after setting them. The private key is never logged and is read
only when a token is minted.

The key must be an In-App Purchase key (EC P-256). An APNs key or a
general App Store Connect API key will not be accepted by Apple for this
endpoint.

## 2. How delivery works

Every earned free week is a row on `referral_reward_ledger`. For a Stripe
owner the row is applied right away as a customer-balance credit. For an
Apple owner the week is "banked" on the ledger and delivered as a renewal
extension by `applyBankedAppleWeeks` in `api/_lib/referrals.js`.

Apple's limits on renewal extensions:

- at most **two extensions per subscription in any 365-day window**
- at most **90 days per extension**

So the sweep works like this:

1. Count the extensions already recorded for this subscription in the last
   365 days (`apple_renewal_extensions`).
2. If fewer than two: send one extension for all banked weeks at once, in
   whole weeks, up to 90 days (12 weeks). Anything over the cap stays banked.
   For example 3 banked weeks go out as one 21-day extension; 14 banked
   weeks go out as 84 days with 2 weeks left banked.
3. If two slots are already used: leave the weeks banked and show the owner
   the date the oldest extension drops out of the window (`nextEligibleAt`),
   which is when the next batch will be sent.

The sweep runs:

- when a referred owner converts (both sides are rewarded),
- on every RevenueCat `RENEWAL` for the workspace,
- when the owner opens Account → Referrals (GET `/api/referrals`).

If the App Store Server API is not configured or a call fails, the ledger
row stays unapplied with the reason in its `note` column and nothing is
lost; the next sweep retries. Webhooks never fail because of a referral
problem.

Owners who have not subscribed yet on either platform keep their weeks
pending until their first payment, exactly as before.

### Conversion from RevenueCat

`api/billing/revenuecat-webhook.js` marks a referral converted on the first
real charge: `INITIAL_PURCHASE` with `period_type` `NORMAL`, or a `RENEWAL`
with `period_type` `NORMAL` that ends the trial (RevenueCat sends
`is_trial_conversion: true`; as a safety net any `NORMAL` renewal for an
owner whose referral is not yet converted also counts).

## 3. Entering a code in the app

The signup form has an optional "Referral code" field (hidden when the
signup link already carries `?ref=`). Owners who signed up without a code
can add one under Account → Referrals ("Were you referred? Enter a code")
within 30 days of signing up, as long as they have not paid yet and it is
not their own code. Each account can attach one referral only.

## 4. Verifying in Readiness

Admin → Readiness runs the `apple_server_api` check:

- **ok**: all variables are present and a signed token was minted locally
  (no call to Apple). The detail names the key id and environment.
- **warn**: one or more variables are missing. Apple rewards stay banked
  until they are set.
- **fail**: the variables are present but the key could not sign. Almost
  always the `.p8` contents were pasted incompletely.

To check an actual delivery, look at `referral_reward_ledger` for the
workspace: `method = 'apple_extension'`, `applied_at` set, and
`apple_effective_date` holding the new renewal date Apple returned. The
owner also sees "added 7 days to your Apple subscription" on their Referrals
page, and RevenueCat shows the extended expiration on the customer.
