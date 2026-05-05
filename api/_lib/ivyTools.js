// Ivy tool definitions + executors.
//
// Each tool has:
//   • A schema Anthropic can read to decide when + how to call it
//   • An async executor that runs server-side with the caller's
//     workspace context. Tools never trust user-supplied workspaceId
//     — every query is scoped to the workspace passed in by the
//     surrounding /api/ivy handler.
//
// Read-only tools (list_*, search_*, get_*) execute automatically. Write
// tools (send_message_to_client, mark_invoice_paid, send_invoice,
// add_client) also execute automatically — Ivy is scoped to the user's
// own workspace and worst-case is fully reversible (delete the message,
// re-mark unpaid). If we want a confirmation step later, we can have
// the loop emit `tool_pending` blocks the UI surfaces as buttons.
import { sql } from './db.js';
import { sendEmail, emailShell } from './email.js';
import { appUrl, generateRawToken } from './tokens.js';
import { sendPushToUser, notifyClientSafe } from './push.js';
import crypto from 'node:crypto';

// ── Tool schema (passed to Anthropic on every call) ──────────────────

export const IVY_TOOLS = [
  {
    name: 'list_quiet_clients',
    description: "Lists clients who haven't been messaged or seen in a while. Use when the user asks who they should follow up with, who's gone quiet, or to draft a check-in.",
    input_schema: {
      type: 'object',
      properties: {
        days_quiet: { type: 'integer', description: 'Minimum days since last contact. Default 21.' },
        limit: { type: 'integer', description: 'Max rows to return. Default 20, cap 50.' },
      },
    },
  },
  {
    name: 'list_overdue_invoices',
    description: "Lists invoices that are sent or past their due date and not yet paid. Use when the user asks about money owed, invoices to chase, or revenue at risk.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max rows. Default 20.' },
      },
    },
  },
  {
    name: 'list_upcoming_bookings',
    description: "Lists upcoming non-cancelled bookings. Use when the user asks what's on the calendar.",
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: { type: 'integer', description: 'Window in days. Default 7.' },
        limit: { type: 'integer', description: 'Max rows. Default 30.' },
      },
    },
  },
  {
    name: 'search_clients',
    description: "Search the workspace's clients by name or email substring. Use to find a specific person before taking an action on them.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search string — fuzzy on name + email.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'send_message_to_client',
    description: "Send a chat message to a specific client through their portal. Use after the user has approved a draft, or when they've explicitly said 'send X to Y'. The message lands in the client's THRYVE inbox immediately.",
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'The client ID. Look it up via search_clients first if you only have a name.' },
        text: { type: 'string', description: 'The message body. Must be plain text, < 4000 chars.' },
      },
      required: ['client_id', 'text'],
    },
  },
  {
    name: 'mark_invoice_paid',
    description: "Mark an invoice as paid manually (e.g., when the user took payment in cash or via wire). Use only when the user explicitly tells you a specific invoice has been paid.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string' },
        method: { type: 'string', description: "Payment method: 'cash', 'check', 'transfer', 'card', or 'other'." },
      },
      required: ['invoice_id'],
    },
  },
  {
    name: 'send_invoice',
    description: "Send an existing draft or sent invoice to its client by email. Use when the user says 'send invoice X to Y'.",
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string' },
        client_id:  { type: 'string', description: 'The recipient client. If omitted, uses the invoice\'s existing client_id.' },
      },
      required: ['invoice_id'],
    },
  },
  {
    name: 'add_client',
    description: 'Add a new client/lead to the workspace. Use when the user wants to create a client record.',
    input_schema: {
      type: 'object',
      properties: {
        name:  { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string', description: 'Optional. E.164 format if provided.' },
        stage: { type: 'string', description: "'lead' (default) or 'active'." },
      },
      required: ['name'],
    },
  },
];

// ── Executors ────────────────────────────────────────────────────────

// Single dispatch table. Each handler receives `{ workspaceId, args, userId }`
// and returns a JSON-serializable result. Errors bubble — the loop
// surfaces them to Claude as a `tool_result` with `is_error: true` so
// Claude can decide whether to retry or explain.
const HANDLERS = {
  list_quiet_clients,
  list_overdue_invoices,
  list_upcoming_bookings,
  search_clients,
  send_message_to_client,
  mark_invoice_paid,
  send_invoice,
  add_client,
};

export async function executeIvyTool(name, args, ctx) {
  const fn = HANDLERS[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  try {
    return await fn({ ...ctx, args: args || {} });
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// ── Read-only ────────────────────────────────────────────────────────

async function list_quiet_clients({ workspaceId, args }) {
  const days = clampInt(args.days_quiet, 21, 1, 365);
  const limit = clampInt(args.limit, 20, 1, 50);
  const { rows } = await sql.query(
    `SELECT c.id, c.name, c.email, c.phone, c.stage,
            c.last_seen_at,
            (SELECT MAX(t.last_message_at) FROM message_threads t
              WHERE t.workspace_id = c.workspace_id AND t.client_id = c.id) AS last_message_at
       FROM clients c
       WHERE c.workspace_id = $1
         AND c.stage = 'active'
         AND COALESCE(
           (SELECT MAX(t.last_message_at) FROM message_threads t
              WHERE t.workspace_id = c.workspace_id AND t.client_id = c.id),
           c.last_seen_at,
           c.joined_at
         ) < NOW() - ($2 || ' days')::interval
       ORDER BY COALESCE(
           (SELECT MAX(t.last_message_at) FROM message_threads t
              WHERE t.workspace_id = c.workspace_id AND t.client_id = c.id),
           c.last_seen_at,
           c.joined_at
         ) ASC
       LIMIT $3`,
    [workspaceId, String(days), limit],
  );
  return {
    days_quiet: days,
    count: rows.length,
    clients: rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone, stage: r.stage,
      last_message_at: r.last_message_at,
      last_seen_at: r.last_seen_at,
    })),
  };
}

async function list_overdue_invoices({ workspaceId, args }) {
  const limit = clampInt(args.limit, 20, 1, 100);
  const { rows } = await sql.query(
    `SELECT id, number, status, client_id, client_name, client_email,
            issue_date, due_date,
            (SELECT COALESCE(SUM(((it->>'qty')::numeric * (it->>'price')::numeric)), 0)
              FROM jsonb_array_elements(items) it) * (1 + COALESCE(tax_rate, 0))
              - COALESCE(discount, 0) AS total
       FROM invoices
       WHERE workspace_id = $1
         AND status IN ('sent', 'overdue')
         AND (due_date IS NULL OR due_date <= CURRENT_DATE)
       ORDER BY due_date ASC NULLS LAST, issue_date ASC
       LIMIT $2`,
    [workspaceId, limit],
  );
  const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);
  return {
    count: rows.length,
    total_owed: Math.round(total * 100) / 100,
    invoices: rows.map((r) => ({
      id: r.id, number: r.number, status: r.status,
      client_id: r.client_id, client_name: r.client_name, client_email: r.client_email,
      issue_date: r.issue_date, due_date: r.due_date,
      total: Math.round(Number(r.total || 0) * 100) / 100,
    })),
  };
}

async function list_upcoming_bookings({ workspaceId, args }) {
  const days = clampInt(args.days_ahead, 7, 1, 60);
  const limit = clampInt(args.limit, 30, 1, 100);
  const { rows } = await sql.query(
    `SELECT b.id, b.client_id, b.client_name, b.client_email,
            b.date, b.start_min, b.end_min, b.notes,
            s.name AS service_name
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
       WHERE b.workspace_id = $1
         AND b.cancelled_at IS NULL
         AND b.date BETWEEN CURRENT_DATE
                        AND CURRENT_DATE + ($2 || ' days')::interval
       ORDER BY b.date, b.start_min
       LIMIT $3`,
    [workspaceId, String(days), limit],
  );
  return {
    days_ahead: days,
    count: rows.length,
    bookings: rows.map((r) => ({
      id: r.id, client_id: r.client_id, client_name: r.client_name,
      service_name: r.service_name,
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
      start_min: r.start_min, end_min: r.end_min,
      notes: r.notes || null,
    })),
  };
}

async function search_clients({ workspaceId, args }) {
  const q = (args.query || '').toString().trim().toLowerCase();
  if (!q) return { count: 0, clients: [] };
  const like = `%${q}%`;
  const { rows } = await sql.query(
    `SELECT id, name, email, phone, stage, joined_at, last_seen_at
       FROM clients
       WHERE workspace_id = $1
         AND (LOWER(name) LIKE $2 OR LOWER(COALESCE(email, '')) LIKE $2)
       ORDER BY COALESCE(last_seen_at, joined_at) DESC
       LIMIT 15`,
    [workspaceId, like],
  );
  return { count: rows.length, clients: rows };
}

// ── Write ────────────────────────────────────────────────────────────

async function send_message_to_client({ workspaceId, args }) {
  const clientId = args.client_id ? String(args.client_id) : null;
  const text = (args.text || '').toString().trim();
  if (!clientId) throw new Error('client_id is required');
  if (!text) throw new Error('text is required');
  if (text.length > 4000) throw new Error('text must be < 4000 chars');

  // Verify the client belongs to this workspace.
  const cl = await sql`SELECT id, name FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
  if (cl.rows.length === 0) throw new Error('Unknown client');

  // Upsert the thread (workspace + client unique).
  const t = await sql`
    INSERT INTO message_threads (workspace_id, client_id)
    VALUES (${workspaceId}, ${clientId})
    ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
    RETURNING id
  `;
  const threadId = t.rows[0].id;

  const ins = await sql`
    INSERT INTO messages (thread_id, sender, text)
    VALUES (${threadId}, 'biz', ${text})
    RETURNING id, created_at
  `;
  const preview = text.slice(0, 200);
  await sql`
    UPDATE message_threads SET
      last_message_at = NOW(),
      last_message_preview = ${preview},
      unread_client = unread_client + 1
    WHERE id = ${threadId} AND workspace_id = ${workspaceId}
  `;
  // Best-effort push to the client.
  notifyClientSafe({
    clientId,
    type: 'messages',
    payload: {
      title: 'New message',
      body: preview,
      url: `/me/messages/${threadId}`,
      tag: `thread-${threadId}`,
    },
  });
  return {
    ok: true,
    thread_id: threadId,
    message_id: ins.rows[0].id,
    client_name: cl.rows[0].name,
  };
}

async function mark_invoice_paid({ workspaceId, args }) {
  const id = args.invoice_id ? String(args.invoice_id) : null;
  const method = args.method && /^(cash|check|transfer|card|other)$/.test(String(args.method))
    ? String(args.method) : 'other';
  if (!id) throw new Error('invoice_id is required');

  const r = await sql`
    UPDATE invoices SET
      status = 'paid', paid_at = NOW(), paid_method = ${method},
      view_token_hash = NULL, updated_at = NOW()
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND status <> 'paid'
    RETURNING id, number, status
  `;
  if (r.rows.length === 0) throw new Error('Invoice not found, not in this workspace, or already paid');
  return { ok: true, invoice: r.rows[0], method };
}

async function send_invoice({ workspaceId, args }) {
  const id = args.invoice_id ? String(args.invoice_id) : null;
  const clientId = args.client_id ? String(args.client_id) : null;
  if (!id) throw new Error('invoice_id is required');

  // Pull invoice + figure out recipient.
  const inv = await sql`
    SELECT id, status, client_id, client_name, client_email
      FROM invoices WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  if (inv.rows.length === 0) throw new Error('Invoice not found');
  const invRow = inv.rows[0];
  if (invRow.status === 'voided') throw new Error('Voided — restore first');
  if (invRow.status === 'paid') throw new Error('Already paid');

  // Resolve recipient: explicit clientId > invoice.client_id > raw email
  // already on the invoice. If we have a clientId, fetch their name+email
  // so the invoice's recipient fields stay accurate.
  let recipientName = invRow.client_name;
  let recipientEmail = invRow.client_email;
  let resolvedClientId = clientId || invRow.client_id;
  if (resolvedClientId) {
    const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${resolvedClientId} AND workspace_id = ${workspaceId}`;
    if (cl.rows.length === 0) throw new Error('Unknown client');
    recipientName = cl.rows[0].name;
    recipientEmail = cl.rows[0].email;
  }
  if (!recipientEmail) throw new Error('No client email — set one before sending');

  // Mint a view token (mirrors /api/invoices/send).
  const rawToken = generateRawToken(32);
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  await sql`
    UPDATE invoices SET
      client_id = ${resolvedClientId || null},
      client_name = ${recipientName},
      client_email = ${recipientEmail},
      status = 'sent',
      sent_at = NOW(),
      view_token_hash = ${tokenHash},
      updated_at = NOW()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;

  // Resolve workspace business name for the email subject + body.
  const cs = await sql`
    SELECT biz_name FROM calendar_settings WHERE workspace_id = ${workspaceId}
  `;
  const bizName = cs.rows[0]?.biz_name || 'Your provider';
  const link = `${appUrl()}/invoice/${encodeURIComponent(rawToken)}`;
  const inv2 = await sql`SELECT number FROM invoices WHERE id = ${id}`;

  await sendEmail({
    to: recipientEmail,
    subject: `Invoice ${inv2.rows[0].number} from ${bizName}`,
    html: emailShell({
      heading: `Invoice ${inv2.rows[0].number}`,
      body: `<p>Hi ${escapeHtml(recipientName || '')},</p>
             <p>Here's your invoice from ${escapeHtml(bizName)}. Tap below to view it and pay.</p>`,
      ctaText: 'View invoice',
      ctaUrl: link,
      footer: `Thanks for your business.`,
    }),
  });
  return { ok: true, invoice_id: id, sent_to: recipientEmail };
}

async function add_client({ workspaceId, args }) {
  const name = (args.name || '').toString().trim();
  if (!name) throw new Error('name is required');
  if (name.length > 200) throw new Error('name too long');
  const email = args.email ? String(args.email).trim().toLowerCase() : null;
  const phone = args.phone ? String(args.phone).trim() : null;
  const stage = args.stage === 'active' ? 'active' : 'lead';

  const ins = await sql`
    INSERT INTO clients (workspace_id, name, email, phone, stage, source)
    VALUES (${workspaceId}, ${name}, ${email}, ${phone}, ${stage}, 'Ivy')
    RETURNING id, name, email
  `;
  return { ok: true, client: ins.rows[0] };
}

// ── Helpers ──────────────────────────────────────────────────────────

function clampInt(v, dflt, min, max) {
  const n = Number.isFinite(Number(v)) ? Math.floor(Number(v)) : dflt;
  return Math.min(max, Math.max(min, n));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
