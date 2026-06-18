# Security model

Last reviewed: April 2026.

## Tenancy

Every user owns exactly one **workspace**. Every piece of user-generated content
(`clients`, `websites`, `services`, `calendar_blocks`, `bookings`,
`message_threads`, `messages`, etc.) is keyed by `workspace_id`. Every
authenticated API endpoint resolves the caller's workspace from their session
and uses that workspace_id in every read and write.

### Cross-tenant guarantees

- **Authorization on every endpoint.** Every API handler under `/api/**` (except
  the explicitly public ones below) calls `requireUser(req, res)` first.
- **Workspace-scoped queries.** Every SQL query against a workspace-owned table
  filters by `workspace_id` (or by an id that's already been verified to belong
  to that workspace, e.g. via `fetchOwnedClient` / `fetchOwnedThread`). There is
  no endpoint that returns or mutates data on a `WHERE id = ?` alone.
- **No cross-tenant FK shortcuts.** Inserts that reference a service / client /
  booking always re-verify ownership before using the id, even though the FK
  constraint already prevents pointing at a row in another workspace. (This
  matters for messages with `attachments[].clientId` etc.)
- **Future Ivy chats.** When the AI assistant ships, every conversation will be
  stored on a `workspace_id`-keyed table and every prompt/response will pass
  through the same `requireUser` + `workspace_id` filter. The model will not be
  given access to data from other workspaces, ever.

### Public endpoints (intentional)

- `GET /api/website/public/:handle` - serves only published sites
  (`published_at IS NOT NULL`). Returns the chosen template + section content
  the owner explicitly published.
- `GET /api/calendar/public/:slug` - serves only the slots needed to book.
  Booking rows are returned with `clientName`, `clientEmail`, and `notes`
  redacted to `null` (`serializeBooking(_, { redactClient: true })`) so a
  visitor can see the times that are taken without learning who took them.
- `POST /api/calendar/public/:slug` - public booking. Validates the slot is in
  the owner's published availability, the service exists in this workspace, and
  the time isn't in the past. Auto-attaches the booking to (or creates) a
  `clients` row for that email.
- `GET /api/health` - returns a fixed string. No data.

## Authentication

- **Password hashing.** `bcryptjs` with cost factor 10. Plain passwords never
  reach the DB.
- **Session.** A 30-day JWT signed with `JWT_SECRET`, kept in a single httpOnly
  cookie (`ivy_session`). Cookie flags: `httpOnly: true`, `secure: true`,
  `sameSite: 'lax'`, `path: '/'`. Cleared on logout.
- **Email verification.** Signup auto-logs the user in but stamps
  `email_verified_at = NULL`. The user can dismiss the in-app banner; the
  feature gate is in place for future flows that should require a verified
  email (e.g. payments).
- **Password reset.** A 32-byte random token is sha256-hashed and stored in
  `auth_tokens` with a 1-hour TTL. Redemption is one-shot (`used_at = NOW()`)
  and invalidates every other live reset token for that user.
- **Forgot password is enumeration-safe.** The endpoint always returns 200,
  whether the email matches an account or not, so an attacker can't probe for
  registered emails.

## CSRF / cross-site request defense

Two layers:

1. **`SameSite=lax`** on the session cookie. Blocks the cookie on most
   cross-origin POST/PATCH/DELETE.
2. **Origin check.** `requireSameOrigin(req, res)` runs at the top of every
   state-changing endpoint and rejects with 403 if the request's `Origin` or
   `Referer` doesn't match the request's own host.

If you embed any Ivy OS asset in another domain (e.g. an iframe of the public
booking page), the booking POST still works because the form lives inside an
iframe served from Ivy OS's origin. A third-party page POSTing directly to
`/api/calendar/public/:slug` from its own origin will be blocked.

## Rate limiting

Postgres-backed sliding-window limiter on:

| endpoint                       | limit                                          |
|--------------------------------|------------------------------------------------|
| `POST /api/auth/signup`        | 5 per IP / 10 min                              |
| `POST /api/auth/login`         | 10 per IP / hr · 5 per email / hr              |
| `POST /api/auth/forgot-password` | 5 per IP / hr · 3 per email / hr             |
| `POST /api/auth/reset-password`  | 10 per IP / hr                               |
| `POST /api/auth/resend-verification` | 3 per user / hr · 5 per IP / hr          |
| `POST /api/calendar/public/:slug` (booking) | 10 per IP / hr · 30 per slug / hr |

## Other defenses

- **No SQL injection.** All queries use parameter binding via Neon's tagged
  template literals. Dynamic UPDATEs use indexed `$1, $2, ...` placeholders.
- **No XSS via React.** No `dangerouslySetInnerHTML` is used. All user content
  is rendered as text.
- **No analytics, no tracking.** No third-party scripts in `index.html`. No
  analytics packages in `package.json`. No first-party event collection. The
  only telemetry is Vercel's standard deployment / function logs (which the
  user controls in their Vercel project).
- **Production error responses sanitised.** `serverError(res, err)` logs the
  full error server-side but returns a generic message to the client when
  `NODE_ENV === 'production'`, unless the message is short and clearly
  intentional (no SQL/stack patterns).

### HTTP response headers (set in `vercel.json`)

| header | value |
|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | denies geolocation/payment/usb/magnetometer/accelerometer/gyroscope |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cache-Control` | `no-store` on every `/api/**` response |

## Operator checklist before onboarding real users

- [ ] Generate a fresh, long random `JWT_SECRET` and `ADMIN_SECRET` (≥256 bits each)
      - `openssl rand -hex 32` for both - and set them in Vercel's project env vars.
      Mark both **Sensitive**. Apply to all environments.
- [ ] Confirm `RESEND_API_KEY` is set and the sending domain is verified in
      Resend (so password-reset / verification emails land in inboxes, not spam).
- [ ] In Vercel → Settings → Functions, confirm Node 22 is selected
      (already pinned via `package.json` engines).
- [ ] Run the migration once (`POST /api/admin/migrate` with the
      `x-admin-secret` header) - see README.
- [ ] Open `https://<your-domain>` in a new browser, sign up, and verify you
      receive: (a) the verification email and (b) the password-reset email
      flow if you click "Forgot your password?".
- [ ] Optional: add a custom domain in Vercel → Domains, point DNS, confirm
      HSTS preload eligibility once HTTPS is live.

## Reporting issues

If you find a security issue, email the maintainer directly rather than filing
a public GitHub issue.
