# Operator alerts

The operator should hear about a breakage by email first, not from Admin → Readiness
and not from a user. An hourly cron (`/api/cron/ops-alerts`, minute 17) runs a small
set of checks, remembers what it already told you, and emails only on change.

## Setup

Set one variable in Vercel (Production):

```
OPS_ALERT_EMAIL=you@example.com
```

If it is not set, alerts go to the first address in `SUPER_ADMIN_EMAIL`. If neither is
set, the cron still records state but sends nothing, and Admin → Readiness shows
"Operator alerts" as a warning.

Emails are sent with the normal provider (`RESEND_API_KEY`, `EMAIL_FROM`). They are
operator emails: not preference-gated, no unsubscribe.

Admin → Readiness has an "Operator alerts" line. It is green when a recipient is set
and the cron has run in the last 3 hours, and lists any condition that is currently
active.

## What fires

| Key | Condition | Threshold |
| --- | --- | --- |
| `ivy_failures` | Failed Ivy replies (`ivy_failures` rows) in the last 60 minutes | 5 or more failures, or a failure rate of 20% or more over at least 10 attempts. Attempts are failures plus `ivy_usage` request counts touched in the same window. The email names the most common error message. |
| `cron:<name>` | A cron listed in `vercel.json` has not succeeded within 2x its cadence, or its last run failed | Hourly or more frequent crons: no success in 3 hours. Daily crons: no success in 50 hours. Weekly crons: no success in 2 weeks plus 2 hours. A single failed last run is a warning; overdue is critical. A cron that has never run only counts once `cron_runs` has history older than its window. |
| `webhook_failures` | Rows in `webhook_failures` in the last hour (a handler threw, or a provider verification call failed) | 3 or more |
| `webhook_signature` | Signature or bearer rejections in `webhook_failures` in the last hour | 5 or more |
| `readiness:<key>` | A required Readiness item reports `fail`: `JWT_SECRET`, `ADMIN_SECRET`, `CRON_SECRET`, `SECRETS_KEY`, `APP_URL`, database, `RESEND_API_KEY`, `EMAIL_FROM` | Any `fail` |
| `check_error:<group>` | One of the checks above could not run | The error message |

The webhook rows are written from the catch blocks of `/api/webhooks/*`,
`/api/webhooks/billing` and `/api/billing/revenuecat-webhook` through
`api/_lib/webhookFailures.js`. Writing a row never changes what the webhook returns to
the provider. Rows older than 30 days are pruned by `db-prune`.

## How often you hear about it

State lives in the `ops_alert_state` table, one row per key.

- A condition that starts: one email, subject `[Ivy alert] <title>`, for example
  `[Ivy alert] Ivy failures: 7 in the last hour`.
- A condition that persists: a reminder at most every 6 hours, subject
  `[Ivy alert] Still active: <title>`.
- A condition that clears: one email, subject `[Ivy alert] Resolved: <title>`.
- Several conditions changing in the same run share one email per kind (started,
  reminder, resolved), so a broken `CRON_SECRET` is one email, not twenty-eight.

If the alert email itself cannot be sent, the condition stays marked as not yet
notified and the next hourly run tries again.

## How to silence an alert

Fix the cause. The condition clears on the next hourly run and you get the one
"Resolved" email. There is no mute switch on purpose: an alert that keeps coming
back every 6 hours is one that is still true.

To reset the state by hand (for example after a test), delete the row:

```sql
DELETE FROM ops_alert_state WHERE key = 'ivy_failures';
```

To run the check now instead of waiting for the hour:

```
curl -H "x-admin-secret: $ADMIN_SECRET" https://www.joinivy.ai/api/cron/ops-alerts
```

The response lists the active alerts and what was emailed this run.

## Where to look when one arrives

- Ivy failures: Admin → Readiness, "Ivy failed replies" and the "Ivy assistant" probe.
- Cron overdue or failed: Admin → Readiness (`CRON_SECRET`), then the cron health
  report at `/api/admin/cron-health` and the Vercel cron logs.
- Webhook failures: Admin → Readiness (webhook secrets), the Vercel function logs for
  `/api/webhooks/*`, and the provider's own webhook dashboard.
- Readiness regression: Admin → Readiness, the item named in the email.
