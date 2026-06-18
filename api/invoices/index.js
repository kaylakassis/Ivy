// /api/invoices
//   GET  → list invoices for current workspace (filterable by status)
//   POST → create a new draft invoice (auto-numbered)

import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  serializeInvoice, cleanItems, nextInvoiceNumber, VALID_STATUS,
} from '../_lib/finance.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { withIdempotency } from '../_lib/idempotency.js';
export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      try {
        // Bounded pagination guardrail (see /api/clients for context).
        // Default 1000, hard ceiling 5000, returns hasMore + nextOffset.
        const requestedLimit = Number.parseInt(req.query.limit, 10);
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.min(5000, requestedLimit)
          : 1000;
        const requestedOffset = Number.parseInt(req.query.offset, 10);
        const offset = Number.isFinite(requestedOffset) && requestedOffset > 0
          ? requestedOffset
          : 0;
        const probeLimit = limit + 1;

        const status = req.query.status;
        let rows;
        if (status && VALID_STATUS.has(status)) {
          const r = await sql`
            SELECT * FROM invoices
            WHERE workspace_id = ${workspaceId} AND status = ${status}
            ORDER BY issue_date DESC, created_at DESC
            LIMIT ${probeLimit} OFFSET ${offset}
          `;
          rows = r.rows;
        } else {
          const r = await sql`
            SELECT * FROM invoices
            WHERE workspace_id = ${workspaceId}
            ORDER BY issue_date DESC, created_at DESC
            LIMIT ${probeLimit} OFFSET ${offset}
          `;
          rows = r.rows;
        }
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        return ok(res, {
          invoices: page.map(serializeInvoice),
          hasMore,
          nextOffset: hasMore ? offset + limit : null,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[invoices GET] failed (returning empty):', e.message);
        return ok(res, { invoices: [], hasMore: false, nextOffset: null });
      }
    }

    if (req.method === 'POST') {
      // Block writes when the workspace's subscription is suspended
      // (set by api/cron/subscription-dunning after grace period
      // elapses). Reads still work - owner can see what's there.
      // Idempotent: client may supply Idempotency-Key. A network
      // retry with the same key replays the cached response instead
      // of creating a duplicate invoice. See api/_lib/idempotency.js.
      const result = await withIdempotency(req, user.id, async () => {
        const body = await readBody(req);
        const items = cleanItems(body.items ?? []);
        if (items === null) return { status: 400, body: { error: 'Invalid items' } };

        const taxRate  = Number(body.taxRate ?? 0);
        const discount = Number(body.discount ?? 0);
        if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)
          return { status: 400, body: { error: 'taxRate must be 0–100' } };
        if (!Number.isFinite(discount) || discount < 0)
          return { status: 400, body: { error: 'discount must be a non-negative number' } };

        const issueDate = body.issueDate || new Date().toISOString().slice(0, 10);
        const dueDate   = body.dueDate || null;
        if (issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(issueDate))
          return { status: 400, body: { error: 'issueDate must be YYYY-MM-DD' } };
        if (dueDate   && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
          return { status: 400, body: { error: 'dueDate must be YYYY-MM-DD' } };

        const notes = body.notes ? String(body.notes).slice(0, 4000) : null;

        let clientId    = body.clientId ? String(body.clientId) : null;
        let clientName  = body.clientName  ? String(body.clientName).slice(0, 200)  : null;
        let clientEmail = body.clientEmail ? String(body.clientEmail).slice(0, 200).toLowerCase() : null;

        if (clientId) {
          const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
          if (cl.rows.length === 0) return { status: 400, body: { error: 'Unknown client' } };
          clientName = clientName || cl.rows[0].name;
          clientEmail = clientEmail || cl.rows[0].email;
        }

        const num = await nextInvoiceNumber(workspaceId);
        const number = `INV-${num}`;

        // Currency: use the explicit value if the client sent one
        // (validated against ISO-4217 shape), otherwise fall back to
        // the workspace's default from finance_settings.currency.
        let currency = null;
        if (body.currency) {
          const c = String(body.currency).toUpperCase().trim();
          if (!/^[A-Z]{3}$/.test(c)) return { status: 400, body: { error: 'currency must be a 3-letter ISO 4217 code' } };
          currency = c;
        } else {
          const { rows: fs } = await sql`SELECT currency FROM finance_settings WHERE workspace_id = ${workspaceId}`;
          currency = fs[0]?.currency || 'USD';
        }

        const insert = await sql`
          INSERT INTO invoices (
            workspace_id, number, client_id, client_name, client_email,
            issue_date, due_date, items, tax_rate, discount, notes, status, currency
          ) VALUES (
            ${workspaceId}, ${number}, ${clientId}, ${clientName}, ${clientEmail},
            ${issueDate}, ${dueDate}, ${JSON.stringify(items)}::jsonb, ${taxRate}, ${discount}, ${notes}, 'draft', ${currency}
          )
          RETURNING *
        `;
        return { status: 201, body: { invoice: serializeInvoice(insert.rows[0]) } };
      });
      if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
      return res.status(result.status).json(result.body);
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
