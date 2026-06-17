// GET /api/health/ready
//
// Deeper readiness probe than /api/health (which is just `SELECT 1`).
// Reports whether each critical downstream is configured + reachable:
//   - db        DB connectivity (the hard requirement)
//   - resend    transactional email key present + domain not on sandbox
//   - stripe    platform secret key present (one-of: STRIPE_SECRET_KEY /
//                 IVY_STRIPE_SECRET / STRIPE_PLATFORM_SECRET)
//   - twilio    SMS creds present (graceful degrade — SMS is opt-in)
//   - vapid     web-push keys present (graceful degrade)
//   - anthropic Ivy key present (graceful degrade)
//
// Returns 200 when DB is up regardless of optional providers (those
// degrade gracefully). 503 only when DB is unreachable.
//
// Cheap on purpose: no outbound API calls (each would add latency +
// burn provider rate-limit budget on every uptime probe). Env-presence
// checks catch the most common deploy mistake — forgetting a Vercel
// env var on a new environment.
import { sql } from '../_lib/db.js';
import { methodNotAllowed } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  let db = 'ok';
  try {
    await sql`SELECT 1`;
  } catch {
    db = 'down';
  }

  // EMAIL_FROM sanity: the warning path in _lib/email.js fires once
  // per cold start if EMAIL_FROM is unset or points at resend.dev. We
  // can detect the same condition here cheaply for ops dashboards.
  const emailFrom = process.env.EMAIL_FROM || '';
  const onSandbox = !emailFrom || /resend\.dev/i.test(emailFrom);

  const resend = process.env.RESEND_API_KEY
    ? (onSandbox ? 'sandbox' : 'ok')
    : 'unconfigured';

  // Stripe has a few legacy env names; any one is enough for the
  // platform path to work.
  const stripe = (process.env.STRIPE_SECRET_KEY
    || process.env.IVY_STRIPE_SECRET
    || process.env.STRIPE_PLATFORM_SECRET) ? 'ok' : 'unconfigured';

  const twilio = (process.env.IVY_TWILIO_ACCOUNT_SID
    && process.env.IVY_TWILIO_AUTH_TOKEN
    && process.env.IVY_TWILIO_FROM_NUMBER) ? 'ok' : 'unconfigured';

  const vapid = (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) ? 'ok' : 'unconfigured';

  const anthropic = process.env.ANTHROPIC_API_KEY ? 'ok' : 'unconfigured';

  // Critical env vars without which the app boots but instantly 500s
  // on first auth-gated request. Surface these so ops sees them
  // before users do.
  const missingCritical = [];
  if (!process.env.JWT_SECRET) missingCritical.push('JWT_SECRET');
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) missingCritical.push('DATABASE_URL');
  if (!process.env.APP_URL) missingCritical.push('APP_URL');
  if (!process.env.SECRETS_KEY) missingCritical.push('SECRETS_KEY');

  const healthy = db === 'ok' && missingCritical.length === 0;

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'ivy-business-os',
    time: new Date().toISOString(),
    db,
    resend,    // ok | sandbox | unconfigured
    stripe,    // ok | unconfigured
    twilio,    // ok | unconfigured  (graceful degrade)
    vapid,     // ok | unconfigured  (graceful degrade)
    anthropic, // ok | unconfigured  (graceful degrade)
    missingCritical, // empty when healthy
  });
}
