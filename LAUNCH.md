# Ivy OS - Go-Live Runbook

The code is launch-ready. This document is the operator checklist to flip
the app from staging to public. Every step is real; none is optional
unless explicitly marked `(optional)`.

After every env-var change, hit `GET /api/admin/prod-readiness` with the
`x-admin-secret` header (or the Admin → Readiness tab in the UI) and
confirm `blockers: 0`.

---

## 1 · Generate secrets (one minute)

```bash
openssl rand -hex 32  # JWT_SECRET
openssl rand -hex 32  # ADMIN_SECRET
openssl rand -hex 32  # CRON_SECRET
openssl rand -hex 32  # SECRETS_KEY
npx web-push generate-vapid-keys  # VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
```

Keep them somewhere safe - you'll never see them again after pasting.

## 2 · Vercel project env vars

In **Vercel → Project → Settings → Environment Variables**, add each of
these. Mark every secret as **Sensitive**. Apply to Production +
Preview + Development.

**Hard blockers** (the probe will say `BLOCKER` until each is set):

| Variable | Value | Notes |
|---|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` output | Session signing |
| `ADMIN_SECRET` | `openssl rand -hex 32` output | Admin endpoints + cron fallback |
| `CRON_SECRET` | `openssl rand -hex 32` output | **Vercel cron jobs reject without this** |
| `SECRETS_KEY` | `openssl rand -hex 32` output | At-rest encryption of provider tokens |
| `DATABASE_URL` | From Vercel → Storage → Neon | Auto-injected when Neon is linked |
| `APP_URL` | `https://joinivy.ai` (or your domain) | Used in email links - **must be HTTPS** |
| `VITE_APP_URL` | Same as `APP_URL` | Frontend mirror |
| `STRIPE_SECRET_KEY` | `sk_live_…` | TEST mode shows as a WARN |
| `STRIPE_WEBHOOK_SECRET` | From Stripe → Developers → Webhooks (see §4) | Connect platform webhook signing |
| `IVY_BILLING_WEBHOOK_SECRET` | From Stripe → Developers → Webhooks (see §4a) | Subscription billing webhook signing |
| `STRIPE_CONNECT_CLIENT_ID` | Stripe → Settings → Connect → "Connect platform" | OAuth |
| `IVY_STRIPE_PRICE_ID` | The Price for Ivy OS's $49/mo subscription (see §4a) | |
| `RESEND_API_KEY` | From Resend dashboard | Outbound email |
| `EMAIL_FROM` | `Ivy OS <hello@joinivy.ai>` | **Domain must be verified in Resend** |
| `EMAIL_REPLY_TO` | `hello@joinivy.ai` | |
| `SUPER_ADMIN_EMAIL` | Your account email | Auto-promotes you to super-admin on sign-in |

**Recommended** (the probe shows `WARN`, app works without):

| Variable | What breaks without it |
|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Push notifications - Ivy nudges, message alerts, payment receipts go email-only |
| `BLOB_READ_WRITE_TOKEN` | Document uploads, e-signature PDFs, message attachments |
| `ANTHROPIC_API_KEY` | Ivy falls back to canned mock responses |
| `SENTRY_DSN` | No error tracking - day-one bugs go unnoticed unless you tail Vercel logs |

**Optional providers** (skip if not using):

`IVY_TWILIO_*` (SMS) · `GOOGLE_OAUTH_*` (Calendar busy-sync)

> Square + PayPal: tabled for the initial launch. Backend code remains
> intact; the UI surface is hidden behind `VITE_FLAG_SQUARE_PAYPAL=true`.
> Set that env var and redeploy when you're ready to re-expose them
> (and add the corresponding `SQUARE_*` + `PAYPAL_*` provider keys).

## 3 · Apply the database schema

One-time, after the first deploy:

```bash
curl -X POST https://<your-domain>/api/admin/migrate \
  -H "x-admin-secret: $ADMIN_SECRET"
```

Returns `{ "applied": N }`. Idempotent - safe to re-run after every
deploy. The schema is designed to be applied repeatedly with
`IF NOT EXISTS` everywhere.

## 4 · Configure Stripe webhooks

In **Stripe Dashboard → Developers → Webhooks → Add endpoint**:

- **URL:** `https://<your-domain>/api/webhooks/stripe-platform`
- **Events:**
  - `checkout.session.completed`
  - `payment_intent.succeeded` (safety net - added in 2026-05)
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `account.updated`

After saving, click the endpoint and copy the **Signing secret** into
`STRIPE_WEBHOOK_SECRET`. Redeploy so the new env var takes effect.

## 4a · Subscription billing setup ($49/mo)

The webhook in §4 handles owner-facing payments (the money clients send
to owners via Stripe Connect). Ivy OS's own subscription - the $49/mo
that owners pay us - is a separate Product, separate webhook endpoint,
separate signing secret.

### Create the Ivy OS subscription Product

In **Stripe Dashboard → Products → Add product**:

- **Name:** `Ivy OS Business Platform`
- **Description:** `All-in-one platform for service businesses - bookings, clients, payments, marketing, Ivy AI.`
- **Pricing:** Recurring · **$49.00 USD** · billed **monthly**.
- Save. Open the product, copy the `price_…` id from the Pricing
  section, paste it into `IVY_STRIPE_PRICE_ID` in Vercel.

### Enable the Customer Portal

**Stripe Dashboard → Settings → Billing → Customer portal**. Enable.
Allow customers to: update payment method, cancel subscription, view
invoices. Save. (The portal link in Account → Billing won't work until
this is on.)

### Add the subscription webhook endpoint

**Stripe Dashboard → Developers → Webhooks → Add endpoint** - this is
a *second* endpoint, separate from the §4 one.

- **URL:** `https://<your-domain>/api/webhooks/billing`
- **Events:**
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.upcoming`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`

Save. Copy the new endpoint's **Signing secret** into
`IVY_BILLING_WEBHOOK_SECRET` in Vercel (mark Sensitive). This is a
**different** secret than `STRIPE_WEBHOOK_SECRET` from §4 - Stripe
issues one signing secret per endpoint URL, so the two webhook handlers
each need their own. If you reuse the §4 secret here, the subscription
webhook will reject every event with "signature verification failed."
Redeploy after pasting.

### Subscription smoke test

1. Sign up fresh on `https://<your-domain>` → click "Start free trial"
   → DB row reads `subscription_status='trialing'`,
   `trial_ends_at` 28 days out.
2. Open `/dashboard` → confirm trial banner shows correct days remaining.
3. Click "Subscribe" on the Paywall → Stripe Checkout opens at $49/mo.
4. Pay with test card `4242 4242 4242 4242` (any future expiry, any CVC).
5. Redirect back to app → DB row reads `subscription_status='active'`,
   `subscription_period_end` set.
6. Account → Billing → "Manage billing" → opens Stripe Portal in a new
   tab, shows the subscription.
7. In Stripe Dashboard, cancel the test subscription → the billing
   webhook fires → DB row reads `subscription_status='canceled'` →
   Paywall reappears in the app on next reload.

## 5 · Verify the readiness probe is green

In the Admin sidebar → **Readiness** tab. Every required check should
read `READY`. The header banner should say _"All required config
present"_. Optional providers show `WARN`; that's fine.

Or via curl:

```bash
curl https://<your-domain>/api/admin/prod-readiness \
  -H "x-admin-secret: $ADMIN_SECRET" | jq
```

The response includes `ok: true` and `blockers: 0` when you're ready.

## 6 · Live smoke test (last gate)

1. Sign up with a real email on `https://<your-domain>`. Confirm the
   verification email arrives in the **inbox** (not spam - if it's in
   spam, your Resend sending domain isn't fully warmed; ride it out a
   few days or set up SPF/DKIM properly).
2. Click "Forgot password," confirm the reset email lands.
3. From an incognito window, open the public booking page at
   `/book/<slug>` and submit a booking.
4. Open Stripe → Developers → Events, fire a test
   `checkout.session.completed` against the platform webhook; confirm
   the invoice flips to paid in `/finance` and your push notification
   fires (if VAPID is configured).
5. From `/admin` → Readiness, re-probe and confirm still green.

If everything passes, you're live.

## 7 · Post-launch monitoring (first 24h)

- Tail Vercel function logs for `[api] server error:` entries.
- If `SENTRY_DSN` is set, watch the Sentry project for any first
  occurrences.
- Watch the **Readiness** tab daily for the first week - env-var drift
  is the most common silent failure.

## Rollback

If something goes catastrophically wrong, redeploy the previous Vercel
build (Deployments → click the older one → Promote to Production). The
schema migration is idempotent and additive, so rolling back the app
does not require rolling back the database.

---

_Last reviewed: 2026-05. Code is on `claude/fervent-volta-VLg96`. The
readiness probe lives at `api/admin/prod-readiness.js`._
