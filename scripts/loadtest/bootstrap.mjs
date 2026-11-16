// Load-test environment: the real handlers, a pooled + timed database
// driver, and outside services (email, texts, payments, AI) answered by a
// stand-in so nothing leaves this machine.
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);

process.env.DATABASE_URL = process.env.LOAD_DB || 'postgres://ivy_test:test@localhost:5432/ivy_load';
process.env.JWT_SECRET ||= 'test_secret_for_local_dev_only_at_least_32_chars';
process.env.PUBLIC_HOST ||= 'localhost:5500';
process.env.RESEND_API_KEY ||= '__load__';
process.env.EMAIL_FROM ||= 'Ivy <test@example.com>';
process.env.SIGNUP_HUMAN_CHECK ||= 'off';
process.env.CRON_SECRET ||= 'load-cron-secret';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.SUPER_ADMIN_EMAIL ||= 'load-owner-1@example.com';
// Hot cache stays ON, as in production.

const realFetch = globalThis.fetch;
export const outbound = { email: 0, sms: 0, other: 0 };
globalThis.__loadOutbound = outbound;
const PROVIDER_MS = Number(process.env.PROVIDER_MS || 120);   // a realistic provider round trip
globalThis.fetch = async (url, init) => {
  const u = String(url?.url || url);
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u)) return realFetch(url, init);
  if (/resend\.com/.test(u)) outbound.email++;
  else if (/twilio\.com/.test(u)) outbound.sms++;
  else outbound.other++;
  await new Promise((r) => setTimeout(r, PROVIDER_MS));
  const body = /resend\.com/.test(u) ? { id: 'load-' + outbound.email } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
