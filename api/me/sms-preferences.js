// /api/me/sms-preferences
//   GET  → current phone + consent across the user's client records
//          (one phone per signed-in user - we apply changes uniformly
//          across every workspace they're a client of)
//   POST → body { phone?, smsConsent? }. Updates phone (normalized to
//          E.164) and/or consent. Setting smsConsent: false clears the
//          timestamp; true stamps NOW() if not already set.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import { normalizePhone } from '../_lib/sms.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return ok(res, { phone: null, smsConsentAt: null });

    if (req.method === 'GET') {
      // Pull the most recently updated row's phone/consent - usually
      // they're the same across rows, but if they're not, the latest
      // edit wins for display. POST applies uniformly.
      const { rows } = await sql.query(
        `SELECT phone, sms_consent_at FROM clients
         WHERE id = ANY($1)
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1`,
        [myIds],
      );
      const r = rows[0] || {};
      return ok(res, {
        phone:        r.phone || null,
        smsConsentAt: r.sms_consent_at || null,
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('phone' in body) {
        const raw = body.phone ? String(body.phone).trim() : null;
        if (raw === null || raw === '') push('phone', null);
        else {
          const norm = normalizePhone(raw);
          if (!norm) return badRequest(res, 'Phone number is not a valid format');
          push('phone', norm);
        }
      }
      if ('smsConsent' in body) {
        if (body.smsConsent) {
          // Use COALESCE to preserve existing consent timestamps so we
          // don't reset the consent date every time the toggle is
          // re-confirmed (audit trail clarity).
          values.push(new Date().toISOString());
          sets.push(`sms_consent_at = COALESCE(sms_consent_at, $${values.length})`);
        } else {
          push('sms_consent_at', null);
        }
      }
      if (sets.length === 0) return ok(res, { ok: true, noop: true });

      values.push(myIds);
      const queryText = `
        UPDATE clients SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = ANY($${values.length})
      `;
      await sql.query(queryText, values);
      return ok(res, { ok: true });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
