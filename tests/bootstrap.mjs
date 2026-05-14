// Bootstraps test env: registers the Neon→pg loader hook + sets env.
// Tests are invoked via `node --import ./tests/bootstrap.mjs ...`.
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

register(pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'loader.mjs'),
).href);

// Standard local-test env. The shim picks up DATABASE_URL.
process.env.DATABASE_URL ||= 'postgres://thryve_test:test@localhost:5432/thryve_test';
process.env.JWT_SECRET ||= 'test_secret_for_local_dev_only_at_least_32_chars';
process.env.PUBLIC_HOST ||= 'localhost:3001';
// Mute outbound mail/SMS/push in tests — set fake but non-empty so
// handlers don't refuse on missing-config branches.
process.env.RESEND_API_KEY ||= '__test__';
process.env.EMAIL_FROM ||= 'THRYVE <test@example.com>';
