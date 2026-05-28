# THRYVE — Go-Live Runbook

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

Keep them somewhere safe — you'll never see them again after pasting.

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
| `APP_URL` | `https://getthryve.ai` (or your domain) | Used in email links — **must be HTTPS** |
| `VITE_APP_URL` | Same as `APP_URL` | Frontend mirror |
| `STRIPE_SECRET_KEY` | `sk_live_…` | TEST mode shows as a WARN |
| `STRIPE_WEBHOOK_SECRET` | From Stripe → Developers → Webhooks (see §4) | Webhook signing |
| `STRIPE_CONNECT_CLIENT_ID` | Stripe → Settings → Connect → "Connect platform" | OAuth |
| `THRYVE_STRIPE_PRICE_ID` | The Price for THRYVE's monthly subscription | |
| `RESEND_API_KEY` | From Resend dashboard | Outbound email |
| `EMAIL_FROM` | `THRYVE <hello@getthryve.ai>` | **Domain must be verified in Resend** |
| `EMAIL_REPLY_TO` | `hello@getthryve.ai` | |
| `SUPER_ADMIN_EMAIL` | Your account email | Auto-promotes you to super-admin on sign-in |

**Recommended** (the probe shows `WARN`, app works without):

| Variable | What breaks without it |
|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Push notifications — Ivy nudges, message alerts, payment receipts go email-only |
| `BLOB_READ_WRITE_TOKEN` | Document uploads, e-signature PDFs, message attachments |
| `ANTHROPIC_API_KEY` | Ivy falls back to canned mock responses |
| `SENTRY_DSN` | No error tracking — day-one bugs go unnoticed unless you tail Vercel logs |

**Optional providers** (skip if not using):

`THRYVE_TWILIO_*` (SMS) · `SQUARE_*` (Square checkout) · `PAYPAL_*` (PayPal checkout) · `GOOGLE_OAUTH_*` (Calendar busy-sync)

## 3 · Apply the database schema

One-time, after the first deploy:

```bash
curl -X POST https://<your-domain>/api/admin/migrate \
  -H "x-admin-secret: $ADMIN_SECRET"
```

Returns `{ "applied": N }`. Idempotent — safe to re-run after every
deploy. The schema is designed to be applied repeatedly with
`IF NOT EXISTS` everywhere.

## 4 · Configure Stripe webhooks

In **Stripe Dashboard → Developers → Webhooks → Add endpoint**:

- **URL:** `https://<your-domain>/api/webhooks/stripe-platform`
- **Events:**
  - `checkout.session.completed`
  - `payment_intent.succeeded` (safety net — added in 2026-05)
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `account.updated`

After saving, click the endpoint and copy the **Signing secret** into
`STRIPE_WEBHOOK_SECRET`. Redeploy so the new env var takes effect.

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
   verification email arrives in the **inbox** (not spam — if it's in
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
- Watch the **Readiness** tab daily for the first week — env-var drift
  is the most common silent failure.

## Rollback

If something goes catastrophically wrong, redeploy the previous Vercel
build (Deployments → click the older one → Promote to Production). The
schema migration is idempotent and additive, so rolling back the app
does not require rolling back the database.

---

_Last reviewed: 2026-05. Code is on `claude/fervent-volta-VLg96`. The
readiness probe lives at `api/admin/prod-readiness.js`._
