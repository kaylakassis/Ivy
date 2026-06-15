// GET /api/search?q=
// Cross-entity quick search for the signed-in owner. Returns up to ~25
// hits across clients, services, invoices, quotes, bookings, documents,
// tasks, and messages — each with a deep-link path the Cmd+K UI uses
// to navigate.
//
// Scoped strictly to the caller's workspace; nothing leaks across
// tenants. Empty query returns an empty result set rather than the
// whole table.
import { sql } from './_lib/db.js';
import { requireUser } from './_lib/auth.js';
import { ensureActiveWorkspace } from './_lib/workspaceGate.js';
import { requireSameOrigin } from './_lib/security.js';
import { methodNotAllowed, ok, serverError } from './_lib/json.js';

const PER_GROUP = 6;

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const q = (req.query.q || '').toString().trim();
    if (q.length < 1) return ok(res, { groups: [] });
    const like = `%${q.toLowerCase()}%`;

    const [clients, services, invoices, quotes, bookings, docs, tasks, threads] = await Promise.all([
      // Client search now covers notes too — a 100-client owner relies
      // on this to surface "the woman I tagged 'sensitive scalp'" from
      // memory of the note, not the name.
      sql.query(
        `SELECT id, name, email, stage FROM clients
          WHERE workspace_id = $1
            AND (LOWER(name)                    LIKE $2
              OR LOWER(COALESCE(email,''))      LIKE $2
              OR LOWER(COALESCE(notes,''))      LIKE $2
              OR LOWER(array_to_string(COALESCE(tags, '{}'), ' ')) LIKE $2)
          ORDER BY COALESCE(last_seen_at, joined_at) DESC NULLS LAST
          LIMIT ${PER_GROUP}`,
        [workspaceId, like],
      ),
      sql.query(
        `SELECT id, name, price FROM services
          WHERE workspace_id = $1 AND LOWER(name) LIKE $2
          ORDER BY display_order, created_at LIMIT ${PER_GROUP}`,
        [workspaceId, like],
      ),
      sql.query(
        `SELECT id, number, status, client_name FROM invoices
          WHERE workspace_id = $1
            AND (LOWER(number) LIKE $2 OR LOWER(COALESCE(client_name,'')) LIKE $2)
          ORDER BY created_at DESC LIMIT ${PER_GROUP}`,
        [workspaceId, like],
      ),
      // Quotes table mirrors invoices but with its own number space.
      // Search same fields. Wrap in try/catch effectively via a
      // try-it-and-fall-back at the consumer — we use a separate query
      // and tolerate the table being missing on older schemas via the
      // outer catch.
      sql.query(
        `SELECT id, number, status, client_name FROM quotes
          WHERE workspace_id = $1
            AND (LOWER(number) LIKE $2 OR LOWER(COALESCE(client_name,'')) LIKE $2)
          ORDER BY created_at DESC LIMIT ${PER_GROUP}`,
        [workspaceId, like],
      ).catch(() => ({ rows: [] })),
      sql.query(
        `SELECT id, client_name, date, start_min, notes FROM bookings
          WHERE workspace_id = $1 AND cancelled_at IS NULL
            AND (LOWER(COALESCE(client_name,'')) LIKE $2
              OR LOWER(COALESCE(notes,''))      LIKE $2)
          ORDER BY date DESC, start_min DESC LIMIT ${PER_GROUP}`,
        [workspaceId, like],
      ),
      sql.query(
        `SELECT id, name, status FROM documents
          WHERE workspace_id = $1 AND LOWER(name) LIKE $2
          ORDER BY updated_at DESC LIMIT ${PER_GROUP}`,
        [workspaceId, like],
      ),
      // Tasks live in /goals. Search title + notes; surface done state
      // as a subtitle hint so completed-and-old tasks are visually
      // de-emphasized at glance.
      sql.query(
        `SELECT id, title, notes, done FROM tasks
          WHERE workspace_id = $1
            AND (LOWER(title) LIKE $2 OR LOWER(COALESCE(notes,'')) LIKE $2)
          ORDER BY done ASC, COALESCE(due_date, created_at) DESC
          LIMIT ${PER_GROUP}`,
        [workspaceId, like],
      ).catch(() => ({ rows: [] })),
      sql.query(
        `SELECT t.id, c.name AS client_name, t.last_message_preview
           FROM message_threads t
           JOIN clients c ON c.id = t.client_id AND c.workspace_id = t.workspace_id
          WHERE t.workspace_id = $1
            AND (LOWER(c.name) LIKE $2 OR LOWER(COALESCE(t.last_message_preview,'')) LIKE $2)
          ORDER BY COALESCE(t.last_message_at, t.created_at) DESC LIMIT ${PER_GROUP}`,
        [workspaceId, like],
      ),
    ]);

    const groups = [];
    if (clients.rows.length) {
      groups.push({
        label: 'Clients',
        items: clients.rows.map((r) => ({
          id: 'client:' + r.id,
          title: r.name,
          subtitle: [r.email, r.stage].filter(Boolean).join(' · '),
          url: `/clients?id=${r.id}`,
          icon: 'Users',
        })),
      });
    }
    if (services.rows.length) {
      groups.push({
        label: 'Services',
        items: services.rows.map((r) => ({
          id: 'service:' + r.id,
          title: r.name,
          subtitle: r.price ? `$${Number(r.price).toFixed(0)}` : '',
          // ?service=ID opens the services drawer on Calendar and
          // scrolls to / highlights that row. Without this, search hits
          // for services dumped users on /calendar with no context.
          url: `/calendar?service=${r.id}`,
          icon: 'Dollar',
        })),
      });
    }
    if (invoices.rows.length) {
      groups.push({
        label: 'Invoices',
        items: invoices.rows.map((r) => ({
          id: 'invoice:' + r.id,
          title: r.number,
          subtitle: [r.client_name, r.status].filter(Boolean).join(' · '),
          url: `/finance?invoice=${r.id}`,
          icon: 'Doc',
        })),
      });
    }
    if (quotes.rows.length) {
      groups.push({
        label: 'Quotes',
        items: quotes.rows.map((r) => ({
          id: 'quote:' + r.id,
          title: r.number,
          subtitle: [r.client_name, r.status].filter(Boolean).join(' · '),
          url: `/finance?quote=${r.id}`,
          icon: 'Doc',
        })),
      });
    }
    if (bookings.rows.length) {
      groups.push({
        label: 'Bookings',
        items: bookings.rows.map((r) => ({
          id: 'booking:' + r.id,
          title: r.client_name || 'Booking',
          subtitle: [
            r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
            fmtTime(r.start_min),
          ].filter(Boolean).join(' · '),
          // ?booking=ID opens that booking's drawer on Calendar.
          url: `/calendar?booking=${r.id}`,
          icon: 'Calendar',
        })),
      });
    }
    if (docs.rows.length) {
      groups.push({
        label: 'Documents',
        items: docs.rows.map((r) => ({
          id: 'doc:' + r.id,
          title: r.name,
          subtitle: r.status,
          // ?doc=ID opens that document's drawer in /documents.
          url: `/documents?doc=${r.id}`,
          icon: 'Doc',
        })),
      });
    }
    if (tasks.rows.length) {
      groups.push({
        label: 'Tasks',
        items: tasks.rows.map((r) => ({
          id: 'task:' + r.id,
          title: r.title,
          subtitle: r.done ? 'Completed' : (r.notes ? r.notes.slice(0, 60) : ''),
          url: `/goals?task=${r.id}`,
          icon: 'Check',
        })),
      });
    }
    if (threads.rows.length) {
      groups.push({
        label: 'Messages',
        items: threads.rows.map((r) => ({
          id: 'thread:' + r.id,
          title: r.client_name,
          subtitle: r.last_message_preview || '',
          url: `/messages?threadId=${r.id}`,
          icon: 'Chat',
        })),
      });
    }

    return ok(res, { groups });
  } catch (err) {
    return serverError(res, err);
  }
}

function fmtTime(min) {
  if (typeof min !== 'number') return '';
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}
