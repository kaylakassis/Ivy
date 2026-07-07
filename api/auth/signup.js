// POST /api/auth/signup  { email, password, name?, acceptedTermsVersion }
//
// `acceptedTermsVersion` is required. It must equal the server's
// CURRENT_TERMS_VERSION; we record an immutable acceptance row in
// legal_acceptances at the same instant we create the user, so the
// proof-of-acceptance is bound to the same transaction as the account
// itself.
import { sql } from '../_lib/db.js';
import { hashPassword, signSession, setSessionCookie, validEmail, isNativeClient } from '../_lib/auth.js';
import { validatePassword } from '../_lib/passwordPolicy.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireGate, getLaunchMode, hasBypassCookie } from '../_lib/earlyAccess.js';
import { createToken, KIND_VERIFY, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { renderWelcome } from '../_lib/welcome-content.js';
import { emailIsSuperAdmin } from '../_lib/admin.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../_lib/legal.js';
import { recordReferralSignup } from '../_lib/referrals.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';

// Vercel default function timeout is 10s, which is tight when we're
// awaiting two Resend API calls in series after the DB work. Bump it
// so a slow email provider can't tank a successful signup.
export const config = { maxDuration: 30 };

// Used to render the user's name into the verification email body.
// Without this the line `${escapeHtml(user.name)}` throws ReferenceError
// the moment a name is provided - historically suppressed by the
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
  // Controlled launch: in waitlist mode, signup is blocked unless the
  // visitor entered the beta-bypass password (which sets the ea_pass
  // cookie). Beta testers + select users sail through to normal signup +
  // onboarding; everyone else is steered to the waitlist landing page.
  if (await getLaunchMode() === 'waitlist' && !(await hasBypassCookie(req))) {
    res.status(403).json({
      error: 'Signups open at launch — join the waitlist to get notified.',
      code:  'waitlist_only',
    });
    return;
  }
  try {
    // Critical: this endpoint has no requireUser() to trigger the
    // schema bootstrap, but it INSERTs into 4 tables (users,
    // legal_acceptances, workspaces, affiliate_uses). If the user is
    // the very first request to a cold-started function instance and
    // schema hasn't been applied yet, the SELECT users at line ~85
    // would 500. Bootstrap explicitly here.
    await ensureSchemaApplied();
    const { email, password, name, mode, ref, acceptedTermsVersion, acceptedPrivacyVersion } = await readBody(req);
    if (!validEmail(email)) return badRequest(res, 'Invalid email');
    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) return badRequest(res, pwCheck.error);
    // Name is required so we can address the user in emails + show
    // them in client portals. Trim + cap length defensively.
    const cleanName = (name || '').toString().trim().slice(0, 200);
    if (!cleanName) return badRequest(res, 'Your name is required');
    // Hard requirement: signup cannot proceed without an explicit
    // acceptance of the current Terms AND Privacy versions. Refuse
    // the request rather than silently default - we want the proof.
    // The frontend checkbox text says "I agree to the Terms and
    // Privacy Policy" so a single click is expected to send both.
    if (acceptedTermsVersion !== CURRENT_TERMS_VERSION) {
      return badRequest(res, `You must accept the current Terms (${CURRENT_TERMS_VERSION}) to create an account.`);
    }
    if (acceptedPrivacyVersion !== CURRENT_PRIVACY_VERSION) {
      return badRequest(res, `You must accept the current Privacy Policy (${CURRENT_PRIVACY_VERSION}) to create an account.`);
    }
    // 'owner' (default) creates a workspace; 'client' does not - they're
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
    // Owners: tight cap (5/10min) - a single person rarely makes many.
    // Clients: a business's customers commonly sign up the same day from
    // one shared office / clinic / carrier-grade-NAT IP, so a 5-cap
    // locks out legitimate invitees. Use a separate, higher client key.
    const rateRule = role === 'client'
      ? { key: `signup:client:ip:${ip}`, max: 30, windowSeconds: 10 * 60 }
      : { key: `signup:ip:${ip}`,        max: 5,  windowSeconds: 10 * 60 };
    // Global backstop: per-IP limits don't stop a botnet spread across many
    // IPs, and each new OWNER workspace comes with its own Ivy (Opus) budget —
    // so a signup flood converts straight into LLM spend. Cap total owner
    // signups/hour platform-wide at a ceiling no legitimate growth reaches
    // (env-tunable). Applied only to owner signups (client signups are the
    // owners' customers and scale with real businesses).
    const globalRule = role === 'client'
      ? null
      : { key: 'signup:owner:global', max: Number(process.env.SIGNUP_GLOBAL_HOURLY_MAX ?? 500), windowSeconds: 60 * 60 };
    const blocked = await enforce(req, res, [rateRule, ...(globalRule ? [globalRule] : [])]);
    if (blocked) return;

    const emailKey = email.toLowerCase();
    const existing = await sql`SELECT id FROM users WHERE email = ${emailKey}`;
    if (existing.rows.length > 0) return badRequest(res, 'Email already in use');

    const password_hash = await hashPassword(password);
    const insertUser = await sql`
      INSERT INTO users (
        email, password_hash, name,
        terms_version, terms_accepted_at,
        privacy_version, privacy_accepted_at
      )
      VALUES (
        ${emailKey}, ${password_hash}, ${cleanName},
        ${CURRENT_TERMS_VERSION}, NOW(),
        ${CURRENT_PRIVACY_VERSION}, NOW()
      )
      RETURNING id, email, name, created_at, email_verified_at
    `;
    const user = insertUser.rows[0];

    // The Neon HTTP driver isn't transactional across awaits, so the
    // user / legal-acceptance / workspace writes can't share one BEGIN.
    // Instead we compensate: if any follow-up write fails, delete the
    // just-created user so we never strand an account WITHOUT its
    // immutable Terms-acceptance proof or (for owners) its workspace.
    // Deleting the user cascades, cleaning up anything partial, and frees
    // the email for a clean retry.
    try {
      // Append the immutable acceptance rows right after user creation.
      // legal_acceptances is append-only - we never delete; the rows
      // plus IP + UA are the proof if it ever matters. Two rows: one
      // per document (terms + privacy) so a future change to either
      // one is independently auditable.
      const ua = req.headers['user-agent']?.toString().slice(0, 500) || null;
      await sql`
        INSERT INTO legal_acceptances (user_id, document, version, ip, user_agent)
        VALUES
          (${user.id}, 'terms',   ${CURRENT_TERMS_VERSION},   ${ip}, ${ua}),
          (${user.id}, 'privacy', ${CURRENT_PRIVACY_VERSION}, ${ip}, ${ua})
      `;

      if (role === 'owner') {
        // Card-backed-trial model: new owners start INACTIVE (no auto no-card
        // trial). They onboard freely (onboarding isn't subscription-gated),
        // then hit the hard paywall and start a card-on-file free trial
        // (Stripe trial-with-card on web / Apple intro offer on iOS). Override
        // the schema defaults explicitly so this doesn't silently regress if
        // the column defaults change.
        const wsIns = await sql`
          INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at)
          VALUES (${user.id}, 'incomplete', NULL)
          RETURNING id
        `;
        const newWorkspaceId = wsIns.rows[0].id;
        // Seed a LIVE booking handle immediately so /book/<slug> works the
        // moment they sign up (the natural shareable "aha") — instead of
        // 404'ing until they manually type a handle deep in onboarding.
        // Best-effort: never break signup. Derive a valid unique handle from
        // their name (matching VALID_HANDLE); retry with a random suffix on a
        // slug collision; fall back to biz-<rand> if the name yields nothing.
        try {
          const baseHandle = ((cleanName || emailKey.split('@')[0] || 'biz')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 32)
            .replace(/^-+|-+$/g, '')) || 'biz';
          const seed = baseHandle.length >= 2 ? baseHandle : `biz-${baseHandle}`;
          for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = attempt === 0
              ? seed
              : `${seed.slice(0, 30)}-${Math.random().toString(36).slice(2, 6)}`;
            try {
              await sql`
                INSERT INTO calendar_settings (workspace_id, biz_name, slug)
                VALUES (${newWorkspaceId}, ${cleanName.slice(0, 120)}, ${candidate})
                ON CONFLICT (workspace_id) DO NOTHING
              `;
              break; // seeded (or the row already existed) — done
            } catch (slugErr) {
              if (/duplicate|unique/i.test(slugErr.message || '') && attempt < 4) continue;
              throw slugErr;
            }
          }
        } catch (seedErr) {
          // eslint-disable-next-line no-console
          console.warn('[signup] booking-handle seed failed:', seedErr.message);
        }
        // Waitlist discount: if this owner's email is on the pre-launch
        // waitlist, stamp the workspace eligible for the shared 20%/12mo
        // coupon (applied later at checkout). This server-side email
        // match IS the exclusivity — the discount can't be granted via a
        // shareable code. Best-effort: never break signup over it.
        try {
          const wl = await sql`SELECT 1 FROM waitlist_signups WHERE LOWER(email) = ${emailKey} LIMIT 1`;
          if (wl.rows.length > 0) {
            await sql`UPDATE workspaces SET waitlist_discount_at = NOW() WHERE owner_id = ${user.id}`;
            await sql`
              UPDATE waitlist_signups
                 SET status = 'converted', converted_user_id = ${user.id}, converted_at = NOW()
               WHERE LOWER(email) = ${emailKey}
            `;
          }
        } catch (wlErr) {
          // eslint-disable-next-line no-console
          console.warn('[signup] waitlist discount stamp failed:', wlErr.message);
        }
      } else {
        // Client signup: claim every existing `clients` row that already
        // matches this email so they immediately see their data when they
        // hit /me. Idempotent.
        await sql`
          UPDATE clients SET user_id = ${user.id}
          WHERE email = ${emailKey} AND user_id IS NULL
        `;
      }
    } catch (setupErr) {
      await sql`DELETE FROM users WHERE id = ${user.id}`.catch(() => {});
      throw setupErr;
    }

    // Attribution. Both run best-effort - never fail signup over them.
    // The same ?ref= code is checked against TWO separate programs:
    //   1. affiliates  - admin/invite-only paid partners (existing).
    //   2. referrals   - the self-serve "refer one, get one" program
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

    const sessionToken = signSession(user.id);
    setSessionCookie(res, sessionToken);

    // Send the verification + welcome emails in parallel so we wait
    // ~max(t1, t2) instead of t1 + t2 - Resend's API can take 1-3s
    // each on a cold path, and back-to-back awaits used to push the
    // function over Vercel's 10s timeout, killing the second send
    // mid-flight. Promise.allSettled ensures one failure doesn't
    // cancel the other; the response carries which (if any) failed
    // so the frontend can show "verification email couldn't be sent -
    // resend it from your account" instead of silently swallowing.
    const verifyTokenP = createToken({
      userId: user.id, kind: KIND_VERIFY, ttlMinutes: VERIFY_TTL_MIN,
    });
    const verifyEmailP = verifyTokenP.then((raw) => {
      const link = `${appUrl()}/verify-email?token=${encodeURIComponent(raw)}`;
      return sendEmail({
        to: emailKey,
        subject: 'Confirm your email for Ivy OS',
        html: emailShell({
          heading: 'Confirm your email',
          body: `<p>${user.name ? `Hi ${escapeHtml(user.name)},` : 'Hi,'}</p>
                 <p>Tap the button below to confirm this is your email. It keeps your account secure and unlocks email notifications.</p>
                 <p>This link expires in 24 hours.</p>`,
          ctaText: 'Confirm my email',
          ctaUrl: link,
          footer: `If you didn't create an Ivy OS account, you can ignore this email.`,
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

    const responsePayload = {
      // Decorate with isSuperAdmin so the sidebar shows the Admin tab on
      // first paint when the signing-up email matches SUPER_ADMIN_EMAIL.
      user: { ...user, isSuperAdmin: emailIsSuperAdmin(user.email) || user.user_type === 'super_admin' },
      role,
      // Surface email send errors to the client. Frontend can show a
      // banner ("we couldn't send your verification email - resend it
      // from your account page") instead of pretending everything
      // worked. Empty object means both succeeded.
      emailErrors: Object.keys(emailErrors).length ? emailErrors : undefined,
    };
    // Native shells get the JWT in the body - see auth/login.js for the
    // explanation; same constraint applies here.
    if (isNativeClient(req)) responsePayload.token = sessionToken;
    return created(res, responsePayload);
  } catch (err) {
    return serverError(res, err);
  }
}
