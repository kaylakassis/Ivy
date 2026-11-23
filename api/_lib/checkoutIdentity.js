// Who is really at the keyboard of a public checkout?
//
// Stripe's hosted checkout page, when it is opened for an existing Stripe
// customer, prefills that customer's name, saved card and billing address,
// and lets whoever is looking at the page pay with that card. That is the
// right thing for the person the card belongs to, and exactly the wrong
// thing for a stranger. And the public checkout forms (memberships,
// packages, programs, booking deposits) only ask the visitor to TYPE an
// email: anyone can type a returning client's address.
//
// So an existing Stripe customer is attached to a public checkout only when
// the request proves who is asking: it carries a signed-in Ivy session
// whose own confirmed email is the email on the form. Everyone else gets a
// checkout that starts clean, with the typed email filled in and nothing
// else. The purchase is still tied to the right client afterwards, by the
// client id carried in the checkout's own metadata, never by the Stripe
// customer.
import { sql } from './db.js';
import { readSession } from './auth.js';

export async function buyerIsSignedInAs(req, email) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return false;
  try {
    const session = readSession(req);
    if (!session?.sub) return false;
    const { rows } = await sql`
      SELECT email, email_verified_at, deleted_at, password_changed_at
        FROM users WHERE id = ${session.sub}`;
    const u = rows[0];
    if (!u || u.deleted_at || !u.email_verified_at) return false;
    // Same rule as requireUser: a session from before a password change is dead.
    if (u.password_changed_at && session.iat && session.iat * 1000 < new Date(u.password_changed_at).getTime()) return false;
    return String(u.email || '').trim().toLowerCase() === want;
  } catch {
    return false;   // any doubt: treat as a stranger
  }
}
