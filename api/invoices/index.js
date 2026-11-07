// /api/invoices
//   GET  → list invoices for current workspace (?status=, ?archived=only|all)
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
import { encodeCursor, decodeCursor, cursorPageSize, looksLikeDate, looksLikeTimestamp } from '../_lib/listCursor.js';
// One page of the owner's invoice list, newest first, after the cursor.
// Same filters as the list below (?status=, ?archived=only|all).
async function listPage(req, res, workspaceId) {
  const limit = cursorPageSize(req.query.limit);
  let after = [null, null, null];
  if (req.query.cursor) {
    const c = decodeCursor(String(req.query.cursor), 3);
    if (!c || !looksLikeDate(c[0]) || !looksLikeTimestamp(c[1])) return badRequest(res, 'That page link is out of date. Reload the list.');
    after = c;
  }
  const status = req.query.status && VALID_STATUS.has(req.query.status) ? req.query.status : null;
  const archivedMode = ['only', 'all'].includes(String(req.query.archived || '')) ? String(req.query.archived) : 'none';
  const { rows } = await sql.query(
    `SELECT *, issue_date::text AS cursor_issue_date, created_at::text AS cursor_created_at
       FROM invoices
      WHERE workspace_id = $1
        AND ($2::text IS NULL OR status = $2::text)
        AND (CASE $3::text WHEN 'only' THEN archived_at IS NOT NULL
                           WHEN 'all'  THEN TRUE
                           ELSE archived_at IS NULL END)
        AND ($4::date IS NULL OR (issue_date, created_at, id) < ($4::date, $5::timestamptz, $6::uuid))
      ORDER BY issue_date DESC, created_at DESC, id DESC
      LIMIT $7`,
    [workspaceId, status, archivedMode, after[0], after[1], after[2], limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return ok(res, {
    invoices: page.map(serializeInvoice),
    hasMore,
    nextOffset: null,
    nextCursor: hasMore ? encodeCursor([last.cursor_issue_date, last.cursor_created_at, last.id]) : null,
  });
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      // Screen paging (the web Finance list): ?cursor= (empty for the first
      // page) returns `limit` invoices (default 50) plus nextCursor. The
      // tab counts and money totals come from GET /api/finance, never from
      // the loaded page. Without ?cursor the list below is unchanged.
      if (req.query.cursor !== undefined) return listPage(req, res, workspaceId);
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

        // Archived invoices (settled ones the owner hid) are left out by
        // default, so older app builds show the tidy list too.
        //   ?archived=only → just the archived ones
        //   ?archived=all  → everything (the current Finance page)
        const status = req.query.status && VALID_STATUS.has(req.query.status) ? req.query.status : null;
        const archivedMode = ['only', 'all'].includes(String(req.query.archived || '')) ? String(req.query.archived) : 'none';
        const { rows } = await sql.query(
          `SELECT * FROM invoices
            WHERE workspace_id = $1
              AND ($2::text IS NULL OR status = $2::text)
              AND (CASE $3::text WHEN 'only' THEN archived_at IS NOT NULL
                                 WHEN 'all'  THEN TRUE
                                 ELSE archived_at IS NULL END)
            ORDER BY issue_date DESC, created_at DESC
            LIMIT $4 OFFSET $5`,
          [workspaceId, status, archivedMode, probeLimit, offset],
        );
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

        // When the caller doesn't specify a rate, seed from the
        // workspace's default sales tax so every new invoice doesn't
        // silently start at 0% for retail-selling owners.
        let taxRate;
        if (body.taxRate == null) {
          const fs = await sql`SELECT default_tax_rate FROM finance_settings WHERE workspace_id = ${workspaceId}`;
          taxRate = Number(fs.rows[0]?.default_tax_rate || 0);
        } else {
          taxRate = Number(body.taxRate);
        }
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
