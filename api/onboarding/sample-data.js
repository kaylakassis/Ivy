// GET/POST/DELETE /api/onboarding/sample-data
//
// Lets a brand-new owner drop in ONE sample client + upcoming booking + draft
// invoice so the empty dashboard shows what the app looks like in use — then
// remove it all in one tap. Everything is tied to a single demo client
// (source='demo'), so cleanup is a reliable, complete delete. Idempotent:
// POSTing twice won't create duplicates.
//
//   GET    → { exists: boolean }        (does sample data exist?)
//   POST   → { exists: true }           (create it, or no-op if present)
//   DELETE → { exists: false }          (remove every demo-tagged row)
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

const DEMO_EMAIL = 'riley.sample@example.com';

async function demoClientIds(workspaceId) {
  const { rows } = await sql`SELECT id FROM clients WHERE workspace_id = ${workspaceId} AND source = 'demo'`;
  return rows.map((r) => r.id);
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const ids = await demoClientIds(workspaceId);
      return ok(res, { exists: ids.length > 0 });
    }

    if (req.method === 'POST') {
      // Idempotent: if demo data already exists, do nothing.
      const existing = await demoClientIds(workspaceId);
      if (existing.length > 0) return ok(res, { exists: true });

      const cli = await sql`
        INSERT INTO clients (workspace_id, name, email, phone, stage, source, tags, notes)
        VALUES (${workspaceId}, 'Riley Sample', ${DEMO_EMAIL}, '+15555550123', 'active', 'demo',
                ARRAY['sample']::text[], 'Sample record — remove anytime from your dashboard.')
        RETURNING id
      `;
      const clientId = cli.rows[0].id;

      // Link the booking to the owner's first service if they have one (nicer
      // display); otherwise leave it null. Booking is tomorrow, 10:00–11:00.
      const svc = await sql`SELECT id FROM services WHERE workspace_id = ${workspaceId} ORDER BY created_at ASC LIMIT 1`;
      const serviceId = svc.rows[0]?.id || null;
      await sql`
        INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, notes)
        VALUES (${workspaceId}, ${serviceId}, ${clientId}, 'Riley Sample', ${DEMO_EMAIL},
                (CURRENT_DATE + 1), 600, 660, '[Sample] Example appointment')
      `;

      // A draft invoice so Finance isn't empty. Draft = not counted as revenue.
      const number = `SAMPLE-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await sql`
        INSERT INTO invoices (workspace_id, number, client_id, client_name, client_email, items, status, notes)
        VALUES (
          ${workspaceId}, ${number}, ${clientId}, 'Riley Sample', ${DEMO_EMAIL},
          ${JSON.stringify([{ description: 'Sample service', quantity: 1, rate: 100 }])}::jsonb,
          'draft', '[Sample] Example invoice'
        )
      `;

      return ok(res, { exists: true });
    }

    if (req.method === 'DELETE') {
      const ids = await demoClientIds(workspaceId);
      if (ids.length > 0) {
        // Remove the linked bookings + invoices FIRST (their FK is ON DELETE
        // SET NULL, so deleting the client alone would orphan them), then the
        // demo clients themselves.
        await sql`DELETE FROM bookings WHERE workspace_id = ${workspaceId} AND client_id = ANY(${ids})`;
        await sql`DELETE FROM invoices WHERE workspace_id = ${workspaceId} AND client_id = ANY(${ids})`;
        await sql`DELETE FROM clients  WHERE workspace_id = ${workspaceId} AND source = 'demo'`;
      }
      return ok(res, { exists: false });
    }

    return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
