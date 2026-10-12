# PayPal for client payments

Ivy's PayPal integration lets a business owner connect their own PayPal
account (Finance → Payments → PayPal) and lets their clients pay invoices,
deposits and memberships through PayPal checkout. The money goes to the
owner's PayPal account; Ivy takes nothing.

## What clients can pay with

Ivy sends the client to PayPal's hosted checkout. On it PayPal offers:

- PayPal balance or linked bank/card
- Debit and credit cards as a guest (no PayPal account needed)
- Pay Later (US, where the buyer qualifies)
- **Venmo** for US buyers on a phone, when the owner's PayPal account is
  eligible (PayPal decides per account; most US business accounts are)

Not available through PayPal checkout:

- **Zelle**: bank-to-bank only, no processor supports it as a checkout method.
- **Cash App Pay**: offered through Stripe, not PayPal. Turn it on in Stripe
  (below) and clients who pay by card link will see it.
- **Apple Pay / Google Pay**: PayPal supports them only through its JavaScript
  button with extra merchant approval, which Ivy's redirect checkout does not
  use. Both are available to clients through Stripe instead.

## One-time setup (Ivy operator)

PayPal onboarding for other people's accounts uses PayPal's Partner Referrals
API, which requires a PayPal **partner** account for Ivy.

1. Apply at developer.paypal.com → "Become a partner" (PayPal Commerce
   Platform for marketplaces and platforms). PayPal reviews the application.
2. Once approved, in the PayPal Developer Dashboard create a REST app for
   Ivy and note the Client ID and Secret (Live).
3. Create a webhook for that app pointing at
   `https://www.joinivy.ai/api/webhooks/paypal` with these events:
   `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`,
   `PAYMENT.CAPTURE.REVERSED`, `BILLING.SUBSCRIPTION.*`. Note the Webhook ID.
4. In Vercel → Environment Variables (Production):

   | Variable | Value |
   |---|---|
   | `PAYPAL_CLIENT_ID` | from the REST app |
   | `PAYPAL_CLIENT_SECRET` | from the REST app |
   | `PAYPAL_PARTNER_ID` | your partner merchant ID (PayPal account → Business information → PayPal Merchant ID) |
   | `PAYPAL_WEBHOOK_ID` | from step 3 |
   | `PAYPAL_ENVIRONMENT` | `live` (use `sandbox` while testing with sandbox credentials) |
   | `VITE_FLAG_PAYPAL` | `true` to show the PayPal card on the Finance page |

5. Redeploy. Admin → Readiness → "PayPal" turns OK when everything is present
   and the environment is live.

Owners then press Connect on the PayPal card, sign in to PayPal, grant
permissions, and are bounced back to Finance with PayPal active.

## Cash App Pay, Apple Pay and Google Pay through Stripe

These are Stripe payment methods and need no code change:

1. Stripe Dashboard → Settings → **Payment methods** → turn on Cash App Pay,
   Apple Pay and Google Pay.
2. Because owners use Stripe Connect accounts, also open Settings → Connect →
   **Payment methods** and turn the same ones on for connected accounts.

Stripe shows them automatically on the checkout page when the client's
device and country support them.
