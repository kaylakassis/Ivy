// POST /api/auth/signup  { email, password, name?, acceptedTermsVersion,
//                          acceptedAccountEmails?, marketingOptIn? }
//
// Email consent (api/_lib/emailConsent.js): current clients send
// acceptedAccountEmails: true (required box) and marketingOptIn (optional
// box). A request that sends acceptedAccountEmails as anything but true is
// refused; a request without the field (iPhone app 1.0.4) still succeeds
// and records no account-email consent (NULL).
//
// `acceptedTermsVersion` is required. It must equal the server's
// CURRENT_TERMS_VERSION; we record an immutable acceptance row in
// legal_acceptances at the same instant we create the user, so the
// proof-of-acceptance is bound to the same transaction as the account
// itself.
import { sql } from '../_lib/db.js';
import {
  hashPassword, signSession, setSessionCookie, validEmail, isNativeClient,
  normalizeAccountEmail, isUniqueViolation, ACCOUNT_EXISTS_MESSAGE,
} from '../_lib/auth.js';
import { validatePassword } from '../_lib/passwordPolicy.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp, rateLimit } from '../_lib/rate-limit.js';
import { makeSignupTicket, makeDecoyTicket } from '../_lib/signupTicket.js';
import { checkHuman } from '../_lib/humanCheck.js';
import { isDisposableEmail, DISPOSABLE_EMAIL_MESSAGE } from '../_lib/disposableEmail.js';

// Two-letter country of the request, from the hosting network's header
// (Vercel sets x-vercel-ip-country; Cloudflare cf-ipcountry). null when
// unknown. Never trusted for access decisions, only shown to the operator.
function signupCountryOf(req) {
  const raw = String(req.headers?.['x-vercel-ip-country'] || req.headers?.['cf-ipcountry'] || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(raw) && raw !== 'XX' ? raw : null;
}
import { requireSameOrigin } from '../_lib/security.js';
import { requireGate, getLaunchMode, hasBypassCookie } from '../_lib/earlyAccess.js';
import { createToken, KIND_VERIFY, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { renderWelcome } from '../_lib/welcome-content.js';
import { emailIsSuperAdmin } from '../_lib/admin.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION, acceptablePrivacyVersion, acceptableTermsVersion } from '../_lib/legal.js';
import { recordReferralSignup } from '../_lib/referrals.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { parseSignupConsent, recordSignupConsent, ACCOUNT_EMAILS_REQUIRED_MESSAGE } from '../_lib/emailConsent.js';

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
      error: 'Signups open at launch. Join the waitlist to get notified.',
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
    const body = await readBody(req);
    const { email, password, name, mode, ref, acceptedTermsVersion, acceptedPrivacyVersion } = body;
    // One account per address, whatever the capitals or stray spaces:
    // everything below works on the normalised key.
    const emailKey = normalizeAccountEmail(email);
    if (!validEmail(emailKey)) return badRequest(res, 'Invalid email');
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
    // The version this copy of the app showed the person (an iPhone app
    // from before a Terms update still shows, and sends, the earlier one).
    const termsVersionAccepted = acceptableTermsVersion(acceptedTermsVersion);
    if (!termsVersionAccepted) {
      return badRequest(res, `You must accept the current Terms (${CURRENT_TERMS_VERSION}) to create an account.`);
    }
    const privacyVersionAccepted = acceptablePrivacyVersion(acceptedPrivacyVersion);
    if (!privacyVersionAccepted) {
      return badRequest(res, `You must accept the current Privacy Policy (${CURRENT_PRIVACY_VERSION}) to create an account.`);
    }
    const consent = parseSignupConsent(body);
    if (consent.refuse) {
      return badRequest(res, ACCOUNT_EMAILS_REQUIRED_MESSAGE, { code: 'account_emails_required' });
    }
    // 'owner' (default) creates a workspace; 'client' does not - they're
    // signing up to view their bookings/invoices/messages from businesses
    // that already added them to a workspace as a client record.
    const role = mode === 'client' ? 'client' : 'owner';

    // Sign-up hardening (1.0.7, fraud protection).
    // A script filling the form: refuse before any rate-limit budget or
    // database work is spent on it.
    const human = checkHuman(req, body);
    if (!human.ok) return badRequest(res, human.message, { code: human.code });
    // A business account needs an address its owner keeps. Clients are a
    // business's own customers and are left alone.
    if (role === 'owner' && isDisposableEmail(emailKey)) {
      return badRequest(res, DISPOSABLE_EMAIL_MESSAGE, { code: 'disposable_email' });
    }
    // Where the sign-up came from, as the network reports it (two-letter
    // country). Admin > Risk flags businesses that start outside the US.
    const signupCountry = signupCountryOf(req);
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

    // Case-insensitive: an older row stored as "Irene@x.com" still owns
    // "irene@x.com".
    // Confirm-first (the website and current app builds send confirmFirst):
    // the answer is "check your email" whatever was typed, and the truth
    // goes to the inbox, so sign-up cannot be used to test which addresses
    // have an Ivy account (api/_lib/signupTicket.js). iPhone app versions
    // from before this do not send the flag and are answered the way they
    // expect, with the "already has an account" answer capped per network.
    const confirmFirst = body.confirmFirst === true;
    const existing = await sql`SELECT id, email, name, deleted_at, confirm_required, email_verified_at FROM users WHERE LOWER(email) = ${emailKey}`;
    const live = existing.rows.find((row) => !row.deleted_at);
    // Hashed before the branch so an existing address takes as long to
    // answer as a new one.
    const password_hash = await hashPassword(password);
    if (live && !confirmFirst) {
      if (await enforce(req, res, [{ key: `signup-taken:ip:${ip}`, max: 5, windowSeconds: 60 * 60 }])) return;
      return badRequest(res, ACCOUNT_EXISTS_MESSAGE, { code: 'email_taken' });
    }
    if (live && confirmFirst) {
      const unfinished = live.confirm_required && !live.email_verified_at;
      if (!unfinished) {
        // A real account. Tell its owner, by email, at most a few times a
        // day (so this cannot be used to pester someone).
        const quota = await rateLimit({ key: `signup-exists-mail:${emailKey}`, max: 3, windowSeconds: 24 * 60 * 60 });
        if (quota.allowed) {
          await sendEmail({
            to: emailKey,
            subject: 'You already have an Ivy account',
            html: emailShell({
              heading: 'You already have an Ivy account',
              body: `<p>${live.name ? `Hi ${escapeHtml(firstName(live.name))},` : 'Hi,'}</p>
                     <p>Someone just tried to create an Ivy account with this email address. There is already one, so nothing was changed.</p>
                     <p>If that was you, sign in instead. If you do not remember your password, you can reset it from the sign-in page.</p>`,
              ctaText: 'Sign in',
              ctaUrl: `${appUrl()}/signin`,
              footer: 'If this was not you, you can ignore this email. Your account is safe.',
            }),
          }).catch((e) => console.error('[signup] existing-account email failed:', e?.message));
        }
        return res.status(202).json({ checkEmail: true, ticket: makeDecoyTicket() });
      }
      // An earlier sign-up for this address that was never finished. The
      // newest attempt replaces it (its details and password are the ones
      // that count, and the older email's link stops working). Capped so
      // it cannot be used to keep cancelling someone's sign-up.
      const quota = await rateLimit({ key: `signup-redo:${emailKey}`, max: 5, windowSeconds: 24 * 60 * 60 });
      if (!quota.allowed) return res.status(202).json({ checkEmail: true, ticket: makeDecoyTicket() });
      await sql`DELETE FROM users WHERE id = ${live.id} AND confirm_required = TRUE AND email_verified_at IS NULL`;
    }
    for (const row of existing.rows) {
      // Self-heal: a soft-deleted row squatting on an unmangled email
      // (deletion paths mangle the address to free it, but a legacy or
      // partially-failed delete can leave it behind). The account is dead
      // either way - free the address now so the signup can proceed,
      // instead of telling the user their email is taken by a ghost.
      const mangled = emailKey.replace(/^([^@]+)@(.+)$/, `$1+deleted-${row.id}@$2`);
      await sql`UPDATE users SET email = ${mangled}, updated_at = NOW() WHERE id = ${row.id} AND deleted_at IS NOT NULL`;
    }

    // Two signups for the same address racing each other (double tap, two
    // tabs) both pass the check above; the unique indexes on users.email and
    // LOWER(users.email) let exactly one INSERT win. The loser gets the same
    // friendly answer as a sequential duplicate, never a 500.
    let insertUser;
    try {
      insertUser = await sql`
        INSERT INTO users (
          email, password_hash, name,
          terms_version, terms_accepted_at,
          privacy_version, privacy_accepted_at,
          last_login_at, last_active_at, signup_country, signup_role, confirm_required
        )
        VALUES (
          ${emailKey}, ${password_hash}, ${cleanName},
          ${termsVersionAccepted}, NOW(),
          ${privacyVersionAccepted}, NOW(),
          ${confirmFirst ? null : new Date().toISOString()}, NOW(), ${signupCountry}, ${role}, ${confirmFirst}
        )
        RETURNING id, email, name, created_at, email_verified_at
      `;
    } catch (insErr) {
      if (isUniqueViolation(insErr)) {
        if (confirmFirst) return res.status(202).json({ checkEmail: true, ticket: makeDecoyTicket() });
        return badRequest(res, ACCOUNT_EXISTS_MESSAGE, { code: 'email_taken' });
      }
      throw insErr;
    }
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
          (${user.id}, 'terms',   ${termsVersionAccepted},   ${ip}, ${ua}),
          (${user.id}, 'privacy', ${privacyVersionAccepted}, ${ip}, ${ua})
      `;
      // Email consent: the required account-emails box and the optional
      // marketing box, with their own proof rows.
      await recordSignupConsent(req, { userId: user.id, consent, source: 'signup' });

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
        // Comp invites and the waitlist discount are NOT granted here:
        // they go to whoever owns the email address, so they wait until
        // the address is verified (api/_lib/signupPerks.js, called from
        // api/auth/verify-email.js). Granting them at sign-up let anyone
        // who knew an invitee's address sign up as them and take it.
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
      }
      // Client signup used to claim every `clients` row with this email
      // right here. That let anyone who knew a client's address sign up as
      // them and read their bookings, invoices and messages before ever
      // proving they own the inbox. The claim now happens only after email
      // verification (myClientIds in api/_lib/clientPortal.js).
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

    // Confirm-first: no session yet. One email with the link that finishes
    // the account; the welcome email follows once it is opened
    // (api/auth/verify-email.js).
    if (confirmFirst) {
      try {
        const raw = await createToken({ userId: user.id, kind: KIND_VERIFY, ttlMinutes: VERIFY_TTL_MIN });
        await sendEmail({
          to: emailKey,
          subject: 'Finish creating your Ivy account',
          html: emailShell({
            heading: 'One tap to finish',
            body: `<p>${user.name ? `Hi ${escapeHtml(firstName(user.name))},` : 'Hi,'}</p>
                   <p>Tap the button below to confirm this is your email and finish creating your Ivy account.</p>
                   <p>This link expires in 24 hours.</p>`,
            ctaText: 'Finish creating my account',
            ctaUrl: `${appUrl()}/verify-email?token=${encodeURIComponent(raw)}`,
            footer: 'If you did not ask for an Ivy account, you can ignore this email and nothing will be created.',
          }),
        });
      } catch (mailErr) {
        // The account exists but cannot be finished without the link. The
        // screen offers "Send it again", which redoes the sign-up.
        console.error('[signup] confirmation email failed:', mailErr?.message);
      }
      return res.status(202).json({ checkEmail: true, ticket: makeSignupTicket(user.id) });
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
        subject: 'Confirm your email for Ivy',
        html: emailShell({
          heading: 'Confirm your email',
          body: `<p>${user.name ? `Hi ${escapeHtml(user.name)},` : 'Hi,'}</p>
                 <p>Tap the button below to confirm this is your email. It keeps your account secure and unlocks email notifications.</p>
                 <p>This link expires in 24 hours.</p>`,
          ctaText: 'Confirm my email',
          ctaUrl: link,
          footer: `If you didn't create an Ivy account, you can ignore this email.`,
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
