# tests

End-to-end tests that run the real API handlers against a local Postgres
instead of Neon. The handlers are unchanged — a loader hook redirects
`@neondatabase/serverless` to a `pg`-backed shim at import time.

## Prerequisites

1. Local Postgres 14+ running on `localhost:5432`
2. A test database + role:
   ```sql
   CREATE ROLE ivy_test WITH LOGIN PASSWORD 'test' CREATEDB;
   CREATE DATABASE ivy_test OWNER ivy_test;
   ```
3. `pg` installed: `npm install pg --no-save` (or add to devDependencies)

## Running

```bash
# Behavior tests for the email-prefs layer (~1s)
node --import ./tests/bootstrap.mjs ./tests/email-prefs.test.mjs

# Lifecycle email flow tests (cancellation, reschedule, subscription, ...)
node --import ./tests/bootstrap.mjs ./tests/email-flows.test.mjs

# Quick smoke: signup → onboarding → notifications PATCH round-trip
node --import ./tests/bootstrap.mjs ./tests/smoke-runner.mjs
```

Override `DATABASE_URL` via env if your Postgres lives elsewhere; the
bootstrap defaults are minimal.

## Files

| File                    | What it does                                                 |
|-------------------------|--------------------------------------------------------------|
| `bootstrap.mjs`         | Registers the loader hook + sets minimal test env vars       |
| `loader.mjs`            | ESM resolver hook — rewrites `@neondatabase/serverless` URL  |
| `neon-shim.mjs`         | `neon(url, opts)` factory backed by `pg.Client`              |
| `email-prefs.test.mjs`  | 34 assertions over `userAllowsEmail` / `clientAllowsEmail` / `sendEmail*` wrappers + `/me/bookings` PHI redaction |
| `email-flows.test.mjs`  | 12 assertions exercising every new lifecycle helper end-to-end |
| `smoke-runner.mjs`      | Signup + onboarding + notifications PATCH round-trip          |

## What "passing" proves

- `SCHEMA_SQL` applies idempotently against a fresh DB (the multi-pass
  migrator at `api/_lib/ensureSchema.js` resolves cross-table
  dependencies in two passes)
- Every new email helper (`notifyBookingCancellation`,
  `notifyBookingRescheduled`, `notifyInvoicePaid`, `notifyInvoiceOverdue`,
  `notifySubscription*`) runs its DB queries + reaches the Resend
  transport without throwing
- The prefs gate at `sendEmailToClient` / `sendEmailToUser` /
  `sendEmailToClientByAddress` correctly mutes opted-out recipients
- `CRITICAL_EMAIL_TYPES` bypass the prefs gate
- Server-side redaction on `/api/me/bookings` strips notes + attachments
  when `completion_log[date].visibleToClient = false`
- The new `/api/cron/invoice-overdue` cron picks up overdue invoices,
  scans them, and stamps `last_overdue_reminder_at`

## What's NOT covered

- Real Resend delivery (`RESEND_API_KEY` is `__test__`; the wrapper
  records the transport rejection without re-throwing)
- Real Stripe webhooks (signature verification is bypassed in tests by
  exercising the helper functions directly, not the webhook handler)
- Real push notifications (no VAPID keys configured)
- UI behavior (frontend has no automated coverage yet)
