// GET /api/admin/email-status
// Returns Resend's verification status for every domain in your account.
// Use after adding DNS records to confirm SPF / DKIM / DMARC are healthy.
//
//   curl https://thryve-pink.vercel.app/api/admin/email-status \
//     -H "x-admin-secret: $ADMIN_SECRET"
//
// Sample response:
//   {
//     "ok": true,
//     "from": "THRYVE <noreply@thryve.app>",
//     "replyTo": "support@thryve.app",
//     "domains": [
//       {
//         "id": "...",
//         "name": "thryve.app",
//         "status": "verified",
//         "region": "us-east-1",
//         "createdAt": "2026-...",
//         "records": [
//           { "record": "SPF",   "name": "send",  "type": "MX",  "status": "verified" },
//           { "record": "DKIM",  "name": "...",   "type": "TXT", "status": "verified" },
//           { "record": "DMARC", "name": "_dmarc", "type": "TXT", "status": "verified" }
//         ]
//       }
//     ]
//   }
//
// Status values worth knowing:
//   • verified — DNS records are correct, you're good to send
//   • pending  — Resend is still polling DNS; usually clears in <30 min
//   • failed   — record missing or wrong; copy the value from Resend
//                dashboard and re-add it at your DNS provider
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(500).json({ error: 'RESEND_API_KEY not set' });

  try {
    const resp = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return res.status(resp.status).json({
        error: 'Resend API error',
        detail: detail.slice(0, 400),
      });
    }
    const json = await resp.json();
    const domains = (json.data || []).map((d) => ({
      id:        d.id,
      name:      d.name,
      status:    d.status,
      region:    d.region,
      createdAt: d.created_at,
      records:   (d.records || []).map((r) => ({
        record: r.record,
        name:   r.name,
        type:   r.type,
        ttl:    r.ttl,
        status: r.status,
        value:  r.value,
        priority: r.priority,
      })),
    }));
    return ok(res, {
      ok: true,
      from: process.env.EMAIL_FROM || 'THRYVE <onboarding@resend.dev>',
      replyTo: process.env.EMAIL_REPLY_TO || null,
      domains,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
