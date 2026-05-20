// POST /api/auth/signup  { email, password, name?, acceptedTermsVersion }
//
// `acceptedTermsVersion` is required. It must equal the server's
// CURRENT_TERMS_VERSION; we record an immutable acceptance row in
// legal_acceptances at the same instant we create the user, so the
// proof-of-acceptance is bound to the same transaction as the account
// itself.
import { sql } from '../_lib/db.js';
import { hashPassword, signSession, setSessionCookie, validEmail } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireGate } from '../_lib/earlyAccess.js';
import { createToken, KIND_VERIFY, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { renderWelcome } from '../_lib/welcome-content.js';
import { emailIsSuperAdmin } from '../_lib/admin.js';
import { CURRENT_TERMS_VERSION } from '../_lib/legal.js';
import { recordReferralSignup } from '../_lib/referrals.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';

// Vercel default function timeout is 10s, which is tight when we're
// awaiting two Resend API calls in series after the DB work. Bump it
// so a slow email provider can't tank a successful signup.
export const config = { maxDuration: 30 };

// Used to render the user's name into the verification email body.
// Without this the line `${escapeHtml(user.name)}` throws ReferenceError
// the moment a name is provided — historically suppressed by the
// surrounding try/catch, which manifested as "verification email
// silently doesn't arrive when the user typed their name."
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function firstName(name) {
  if (!name) return null;
  return String(name).trim().split(/\s+/)[0] || null;
}

const VERIFY_TTL_MIN = 60 * 24; // 24 hours

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  // Temporary early-access gate: blocks new signups when the operator
  // has turned it on in /admin → Settings.
  if (!(await requireGate(req, res))) return;
  try {
    // Critical: this endpoint has no requireUser() to trigger the
    // schema bootstrap, but it INSERTs into 4 tables (users,
    // legal_acceptances, workspaces, affiliate_uses). If the user is
    // the very first request to a cold-started function instance and
    // schema hasn't been applied yet, the SELECT users at line ~85
    // would 500. Bootstrap explicitly here.
    await ensureSchemaApplied();
    const { email, password, name, mode, ref, acceptedTermsVersion } = await readBody(req);
    if (!validEmail(email)) return badRequest(res, 'Invalid email');
    if (typeof password !== 'string' || password.length < 8) {
      return badRequest(res, 'Password must be at least 8 characters');
    }
    // Name is required so we can address the user in emails + show
    // them in client portals. Trim + cap length defensively.
    const cleanName = (name || '').toString().trim().slice(0, 200);
    if (!cleanName) return badRequest(res, 'Your name is required');
    // Hard requirement: signup cannot proceed without an explicit
    // acceptance of the current Terms version. Refuse the request
    // rather than silently default — we want the proof.
    if (acceptedTermsVersion !== CURRENT_TERMS_VERSION) {
      return badRequest(res, `You must accept the current Terms (${CURRENT_TERMS_VERSION}) to create an account.`);
    }
    // 'owner' (default) creates a workspace; 'client' does not — they're
    // signing up to view their bookings/invoices/messages from businesses
    // that already added them to a workspace as a client record.
    const role = mode === 'client' ? 'client' : 'owner';
    // Affiliate code: only honored if it matches an active affiliates row.
    // Stored on affiliate_uses by id so a later code rotation doesn't
    // detach attribution.
    const refCode = typeof ref === 'string' && ref.trim()
      ? ref.trim().toUpperCase().slice(0, 40)
      : null;

    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `signup:ip:${ip}`, max: 5, windowSeconds: 10 * 60 },
    ]);
    if (blocked) return;

    const emailKey = email.toLowerCase();
    const existing = await sql`SELECT id FROM users WHERE email = ${emailKey}`;
    if (existing.rows.length > 0) return badRequest(res, 'Email already in use');

    const password_hash = await hashPassword(password);
    const insertUser = await sql`
      INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
      VALUES (${emailKey}, ${password_hash}, ${cleanName}, ${CURRENT_TERMS_VERSION}, NOW())
      RETURNING id, email, name, created_at, email_verified_at
    `;
    const user = insertUser.rows[0];

    // Append the immutable acceptance row in the same transaction as
    // the user creation. legal_acceptances is append-only — we never
    // delete; this row plus its IP + UA is the proof if it ever
    // matters.
    const ua = req.headers['user-agent']?.toString().slice(0, 500) || null;
    await sql`
      INSERT INTO legal_acceptances (user_id, document, version, ip, user_agent)
      VALUES (${user.id}, 'terms', ${CURRENT_TERMS_VERSION}, ${ip}, ${ua})
    `;

    if (role === 'owner') {
      await sql`INSERT INTO workspaces (owner_id) VALUES (${user.id})`;
    } else {
      // Client signup: claim every existing `clients` row that already
      // matches this email so they immediately see their data when they
      // hit /me. Idempotent.
      await sql`
        UPDATE clients SET user_id = ${user.id}
        WHERE email = ${emailKey} AND user_id IS NULL
      `;
    }

    // Attribution. Both run best-effort — never fail signup over them.
    // The same ?ref= code is checked against TWO separate programs:
    //   1. affiliates  — admin/invite-only paid partners (existing).
    //   2. referrals   — the self-serve "refer one, get one" program
    //      every paying owner can use (api/_lib/referrals.js).
    // A given code resolves to at most one of them (setCode rejects
    // codes that collide with affiliate codes), so there's no
    // double-attribution in practice.
    if (refCode) {
      try {
        const aff = await sql`SELECT id FROM affiliates WHERE code = ${refCode} AND active = TRUE`;
        if (aff.rows.length > 0) {
          await sql`
            INSERT INTO affiliate_uses (affiliate_id, referred_user_id)
            VALUES (${aff.rows[0].id}, ${user.id})
            ON CONFLICT (referred_user_id) DO NOTHING
          `;
        }
      } catch (refErr) {
        // eslint-disable-next-line no-console
        console.warn('[signup] affiliate attribution failed:', refErr.message);
      }
      try {
        await recordReferralSignup({ referredUserId: user.id, rawCode: refCode });
      } catch (refErr) {
        // eslint-disable-next-line no-console
        console.warn('[signup] referral attribution failed:', refErr.message);
      }
    }

    setSessionCookie(res, signSession(user.id));

    // Send the verification + welcome emails in parallel so we wait
    // ~max(t1, t2) instead of t1 + t2 — Resend's API can take 1-3s
    // each on a cold path, and back-to-back awaits used to push the
    // function over Vercel's 10s timeout, killing the second send
    // mid-flight. Promise.allSettled ensures one failure doesn't
    // cancel the other; the response carries which (if any) failed
    // so the frontend can show "verification email couldn't be sent —
    // resend it from your account" instead of silently swallowing.
    const verifyTokenP = createToken({
      userId: user.id, kind: KIND_VERIFY, ttlMinutes: VERIFY_TTL_MIN,
    });
    const verifyEmailP = verifyTokenP.then((raw) => {
      const link = `${appUrl()}/verify-email?token=${encodeURIComponent(raw)}`;
      return sendEmail({
        to: emailKey,
        subject: 'Confirm your email for THRYVE',
        html: emailShell({
          heading: 'Confirm your email',
          body: `<p>${user.name ? `Hi ${escapeHtml(user.name)},` : 'Hi,'}</p>
                 <p>Tap the button below to confirm this is your email. It keeps your account secure and unlocks email notifications.</p>
                 <p>This link expires in 24 hours.</p>`,
          ctaText: 'Confirm my email',
          ctaUrl: link,
          footer: `If you didn't create a THRYVE account, you can ignore this email.`,
        }),
      });
    });

    const welcomeOut = renderWelcome({
      name: firstName(cleanName),
      appUrl: appUrl(),
      variant: role === 'client' ? 'client' : 'owner',
    });
    const welcomeEmailP = sendEmail({
      to: emailKey, subject: welcomeOut.subject, html: welcomeOut.html,
    });

    const [verifyResult, welcomeResult] = await Promise.allSettled([
      verifyEmailP, welcomeEmailP,
    ]);
    const emailErrors = {};
    if (verifyResult.status === 'rejected') {
      console.error('[signup] verification email failed:', verifyResult.reason?.message);
      emailErrors.verification = verifyResult.reason?.message || 'send failed';
    }
    if (welcomeResult.status === 'rejected') {
      console.error('[signup] welcome email failed:', welcomeResult.reason?.message);
      emailErrors.welcome = welcomeResult.reason?.message || 'send failed';
    }

    return created(res, {
      // Decorate with isSuperAdmin so the sidebar shows the Admin tab on
      // first paint when the signing-up email matches SUPER_ADMIN_EMAIL.
      user: { ...user, isSuperAdmin: emailIsSuperAdmin(user.email) },
      role,
      // Surface email send errors to the client. Frontend can show a
      // banner ("we couldn't send your verification email — resend it
      // from your account page") instead of pretending everything
      // worked. Empty object means both succeeded.
      emailErrors: Object.keys(emailErrors).length ? emailErrors : undefined,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
