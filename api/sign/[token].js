// /api/sign/:token  (public, no auth)
//   GET   → fetch the document the recipient was emailed (only if status='sent')
//   POST  → submit completed field values (signs the doc, status → completed)
//
// Token is sha256-hashed before lookup. We never persist or accept the raw
// token for any other purpose. Tokens are invalidated on completion (or by
// voiding the doc on the owner side).

import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import {
  serializeDocPublic, cleanFields, VALID_FIELD_TYPES,
} from '../_lib/documents.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { notifyOwnerSafe } from '../_lib/push.js';
import crypto from 'node:crypto';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export default async function handler(req, res) {
  if (req.method === 'GET')  return getDoc(req, res);
  if (req.method === 'POST') return signDoc(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function fetchByToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 16) return null;
  const tokenHash = hashToken(rawToken);
  const { rows } = await sql`
    SELECT * FROM documents
    WHERE sign_token_hash = ${tokenHash}
      AND status = 'sent'
    LIMIT 1
  `;
  return rows[0] || null;
}

async function getDoc(req, res) {
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `sign-get:ip:${ip}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const token = (req.query.token || '').toString();
    const doc = await fetchByToken(token);
    if (!doc) return notFound(res, 'This signing link is invalid, has expired, or the document was already signed.');

    // First view? Append a 'viewed' activity entry (best-effort, not idempotent
    // — we don't want to write on every poll, so only if last activity isn't
    // already a 'viewed' from today).
    const activity = doc.activity || [];
    const last = activity[activity.length - 1];
    const lastIsViewToday = last && last.kind === 'viewed' &&
      (Date.now() - new Date(last.ts).getTime()) < 24 * 60 * 60 * 1000;
    if (!lastIsViewToday) {
      const next = [...activity, {
        ts: new Date().toISOString(),
        kind: 'viewed',
        text: `${doc.recipient_name || 'Recipient'} opened the document`,
      }];
      await sql`UPDATE documents SET activity = ${JSON.stringify(next)}::jsonb WHERE id = ${doc.id}`;
    }

    return ok(res, { document: serializeDocPublic(doc) });
  } catch (err) {
    return serverError(res, err);
  }
}

async function signDoc(req, res) {
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `sign-post:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const token = (req.query.token || '').toString();
    const doc = await fetchByToken(token);
    if (!doc) return notFound(res, 'This signing link is invalid or has expired.');

    const body = await readBody(req);
    const submitted = cleanFields(body.fields ?? []);
    if (submitted === null) return badRequest(res, 'Invalid fields payload');

    // Merge submitted values onto stored fields, by id. Reject if any required
    // field is missing.
    const stored = doc.fields || [];
    const merged = stored.map((f) => {
      const sub = submitted.find((s) => s.id === f.id);
      const value = sub ? String(sub.value || '') : (f.value || '');
      return { ...f, value };
    });

    for (const f of merged) {
      const required = f.required !== false;
      if (required && !f.value) {
        return badRequest(res, `Please fill in "${f.label || f.type}"`);
      }
      if (!VALID_FIELD_TYPES.has(f.type)) {
        return badRequest(res, `Unknown field type: ${f.type}`);
      }
    }

    const newActivity = [
      ...(doc.activity || []),
      {
        ts: new Date().toISOString(),
        kind: 'completed',
        text: `${doc.recipient_name || 'Recipient'} signed and completed the document`,
      },
    ];

    const updated = await sql`
      UPDATE documents SET
        fields = ${JSON.stringify(merged)}::jsonb,
        status = 'completed',
        completed_at = NOW(),
        sign_token_hash = NULL,
        activity = ${JSON.stringify(newActivity)}::jsonb,
        updated_at = NOW()
      WHERE id = ${doc.id}
      RETURNING *
    `;

    // Best-effort: post a 'doc-completed' system message into the chat thread.
    try {
      if (doc.recipient_client_id) {
        const t = await sql`
          INSERT INTO message_threads (workspace_id, client_id)
          VALUES (${doc.workspace_id}, ${doc.recipient_client_id})
          ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
          RETURNING id
        `;
        const threadId = t.rows[0].id;
        const meta = { docId: doc.id, docName: doc.name };
        await sql`
          INSERT INTO messages (thread_id, sender, text, kind, meta)
          VALUES (${threadId}, 'system', ${`Document completed: ${doc.name}`}, 'doc-completed', ${JSON.stringify(meta)}::jsonb)
        `;
        const preview = `Document completed: ${doc.name}`;
        await sql`
          UPDATE message_threads SET
            last_message_at = NOW(),
            last_message_preview = ${preview},
            unread_biz = unread_biz + 1
          WHERE id = ${threadId}
        `;
      }
    } catch (msgErr) {
      // eslint-disable-next-line no-console
      console.error('[sign] thread message failed:', msgErr.message);
    }

    notifyOwnerSafe({
      workspaceId: doc.workspace_id,
      type: 'documents',
      payload: {
        title: 'Document signed',
        body: `${doc.recipient_name || 'A client'} completed "${doc.name}"`,
        url: `/documents`,
        tag: `doc-signed-${doc.id}`,
      },
    });

    return ok(res, { document: serializeDocPublic(updated.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
