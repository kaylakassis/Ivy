// /api/me/profile
//   GET   → returns the signed-in user's profile (name + email from
//           users, plus phone / address / photoUrl which live on the
//           per-workspace clients row).
//   PATCH → updates name (on users) + phone/address/photoUrl (on every
//           clients row connected to this user). Email is read-only -
//           changing it is auth-critical and goes through a separate
//           flow (not built yet; documented).
//
// Why phone/address/photo live on clients, not users: those columns
// were originally owner-controlled per-workspace (owner types in a
// new client's phone, etc.). When the client later claims their
// portal account, we link the clients row to the user via user_id.
// Letting the CLIENT edit their own contact info means propagating
// the update across every workspace they're a member of - owners
// see the latest value the client supplied next time they open the
// drawer.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { normalizePhone } from '../_lib/sms.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      // Surface the first clients row connected to this user for the
      // contact info. If the client is in multiple workspaces and the
      // values diverge (owner edited it differently in each), we show
      // the first (alphabetical by business name, matching myClientIds
      // ordering) and document that PATCH overwrites them all.
      const u = await sql`SELECT name, email FROM users WHERE id = ${user.id}`;
      const ux = u.rows[0] || {};
      let phone = null;
      let address = null;
      let photoUrl = null;
      try {
        const c = await sql`
          SELECT phone, address, photo_url
          FROM clients
          WHERE user_id = ${user.id}
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 1
        `;
        if (c.rows[0]) {
          phone    = c.rows[0].phone || null;
          address  = c.rows[0].address || null;
          photoUrl = c.rows[0].photo_url || null;
        }
      } catch (e) {
        console.error('[me/profile GET] client read failed:', e.message);
      }
      return ok(res, {
        profile: {
          name:     ux.name || '',
          email:    ux.email || '',
          phone, address, photoUrl,
        },
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      const errors = [];

      if ('name' in body) {
        const name = String(body.name || '').trim();
        if (!name) errors.push('Name is required');
        else if (name.length > 120) errors.push('Name is too long');
        else patch.name = name;
      }

      let phoneToSet; // undefined = don't touch; null = explicitly clear
      if ('phone' in body) {
        if (body.phone == null || String(body.phone).trim() === '') {
          phoneToSet = null;
        } else {
          const norm = normalizePhone(body.phone);
          if (!norm) errors.push('Phone number is not a valid format');
          else phoneToSet = norm;
        }
      }

      let addressToSet;
      if ('address' in body) {
        if (body.address == null || String(body.address).trim() === '') {
          addressToSet = null;
        } else {
          const a = String(body.address).trim();
          if (a.length > 500) errors.push('Address is too long');
          else addressToSet = a;
        }
      }

      let photoUrlToSet;
      if ('photoUrl' in body) {
        if (body.photoUrl == null || String(body.photoUrl).trim() === '') {
          photoUrlToSet = null;
        } else {
          const u = String(body.photoUrl).trim();
          if (u.length > 1000) errors.push('Photo URL is too long');
          // No protocol whitelist - caller already uploaded to Vercel
          // Blob and got an https:// URL.
          else photoUrlToSet = u;
        }
      }

      if (errors.length) return badRequest(res, errors.join(' · '));

      if (patch.name !== undefined) {
        await sql`UPDATE users SET name = ${patch.name}, updated_at = NOW() WHERE id = ${user.id}`;
      }

      // Fan out the contact fields across every clients row this user
      // owns. Builds the SET clause dynamically so we only touch
      // columns the caller actually supplied (a PATCH that omits
      // `phone` should not nuke the existing phone everywhere).
      const sets = [];
      const params = [user.id];
      const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (phoneToSet     !== undefined) push('phone',     phoneToSet);
      if (addressToSet   !== undefined) push('address',   addressToSet);
      if (photoUrlToSet  !== undefined) push('photo_url', photoUrlToSet);
      if (sets.length > 0) {
        sets.push('updated_at = NOW()');
        try {
          await sql.query(
            `UPDATE clients SET ${sets.join(', ')} WHERE user_id = $1`,
            params,
          );
        } catch (e) {
          // Most likely a missing column on a partial-schema dev DB -
          // log + continue so the name update sticks.
          console.error('[me/profile PATCH] clients update failed:', e.message);
        }
      }

      // Return the freshly-saved shape so the client can update local
      // state without a second round-trip.
      const u = await sql`SELECT name, email FROM users WHERE id = ${user.id}`;
      const c = await sql`
        SELECT phone, address, photo_url
        FROM clients
        WHERE user_id = ${user.id}
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
      `;
      return ok(res, {
        profile: {
          name:     u.rows[0]?.name || '',
          email:    u.rows[0]?.email || '',
          phone:    c.rows[0]?.phone || null,
          address:  c.rows[0]?.address || null,
          photoUrl: c.rows[0]?.photo_url || null,
        },
      });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
