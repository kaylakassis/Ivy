# Promo codes: a free month (or any discount) for specific people

Two systems, one for each place people subscribe. Both are set up in the
provider's dashboard; nothing in Ivy's code needs to change per code.

## iPhone app: Apple Offer Codes (through RevenueCat)

Apple's free durations are 3 days, 1 week, 2 weeks, 1 month, 2 months, 3
months, 6 months or 1 year. "4 weeks free" is **1 month**.

1. App Store Connect → your app → **Subscriptions** → the **Ivy** group →
   **Ivy Weekly** → scroll to **Offer Codes** → **+**.
2. Reference name: something you'll recognise, e.g. `Founders free month`.
3. Offer type: **Free**. Duration: **1 month**.
4. Customer eligibility: tick **New subscribers** (and **Existing** or
   **Expired** if you want current or lapsed subscribers to be able to use it).
5. Choose how the code works:
   - **Custom codes**: you type the code (e.g. `IVYFOUNDER`), set a redemption
     limit and an expiry. One code, shareable with a group. Best for most uses.
   - **One-time use codes**: Apple generates a CSV of unique codes, each
     redeemable once. Best when you want to control exactly who gets one.
6. Save. The offer is live within an hour; no app update needed.

How a person redeems it, either way works:
- In the app: on the subscription screen tap **Have a promo code?**, enter the
  code in Apple's sheet. Ivy refreshes and the month starts immediately.
- From a link you send them: `https://apps.apple.com/redeem?ctx=offercodes&id=APP_ID&code=THECODE`
  where `APP_ID` is the numeric Apple ID from App Store Connect → App
  Information. Opens the App Store, redeems, then they open Ivy.

After the free month Apple bills $8.99 a week automatically unless they cancel.
RevenueCat records the redemption (it reads Apple's server notifications), so
the Admin → Users row shows them as subscribed and the usual webhook flow
applies. Nothing to do on the RevenueCat side beyond the setup you already have.

Repeat the same steps on **Ivy Annually** if you want a code for that plan.

## Web: Stripe promotion codes

1. Stripe Dashboard → **Product catalog → Coupons → + New**.
   - For a free month on the weekly plan: **Percentage off 100%**, duration
     **Repeating**, **1 month**. (A coupon applies per invoice; one month of
     weekly invoices is the free month.)
2. On the coupon, **+ Promotion code**: the code people type (e.g.
   `IVYFOUNDER`), optional limits (first-time customers only, max
   redemptions, expiry).
3. Done. Ivy's checkout page already shows an **Add promotion code** field, so
   the person enters it there. The subscription screen in Ivy says so.

## Giving a specific person free time without any code

Admin → Users → open the person → **Grant free access** sets a date until
which the paywall is lifted on both web and iPhone. No code, no billing
provider involved. Good for testers, partners and refunds-in-kind.
