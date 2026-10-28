// One owner turn in an Ivy chat, shared by the two reply endpoints:
//   POST /api/ivy         (api/ivy/index.js)  - the reply arrives in one JSON body
//   POST /api/ivy/stream  (api/ivy/stream.js) - the reply streams as it is written
//
// beginTurn validates the request and records the owner's message; finishTurn
// records Ivy's reply and builds the payload both endpoints return. Keeping
// the pipeline here means the two cannot drift: same validation, same
// history window, same session bookkeeping, same response shape.
import { sql } from './db.js';
import {
  serializeSession, serializeMessage, workspaceContext, fetchOwnedSession,
  getDailyUsage, sanitizeUserText, stripInlineMarkdown,
} from './ivy.js';

export const MAX_MESSAGE_CHARS = 4000;
// Vercel serverless caps the request body around 4.5 MB. We allow up to
// ~3.5 MB of raw file bytes (≈4.7 MB of base64) and add a server-side
// belt-and-braces check so a malformed client can't OOM us.
const MAX_ATTACHMENT_BYTES = 3.5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/csv', 'text/plain', 'text/tab-separated-values',
  'text/markdown',
  'application/csv', 'application/json',
]);

// Validates the body, finds or creates the session, loads the history the
// model will see and persists the owner's message. Returns { error } with a
// user-readable message for a 400, or the turn:
//   { session, history, userMsg, text, attachment, ctx }
export async function beginTurn(body, workspaceId) {
  // Sanitize before any further processing: strips NUL, control
  // chars, zero-width chars, and bidi overrides that prompt-
  // injection attempts use to hide instructions in plain sight.
  const text = sanitizeUserText((body.text || '').toString()).trim();
  // Validate + normalize attachment if present. Allow an empty text
  // when an attachment is attached - "analyze this" is implicit.
  const attachment = parseAttachment(body.attachment);
  if (attachment instanceof Error) return { error: attachment.message };
  if (!text && !attachment) return { error: 'Message is required' };
  if (text.length > MAX_MESSAGE_CHARS) return { error: 'Message too long' };

  let session;
  if (body.sessionId) {
    session = await fetchOwnedSession({ id: body.sessionId, workspaceId });
    if (!session) return { error: 'Unknown session' };
  } else {
    const title = text.slice(0, 60).replace(/\s+/g, ' ');
    const ins = await sql`
      INSERT INTO ivy_sessions (workspace_id, title)
      VALUES (${workspaceId}, ${title})
      RETURNING *
    `;
    session = ins.rows[0];
  }

  // Fetch prior turns BEFORE inserting the new user message so the
  // history we pass to the model doesn't include the message we're about
  // to respond to (we pass it as `text` separately).
  const priorMsgs = await sql`
    SELECT role, text FROM ivy_messages
    WHERE session_id = ${session.id}
    ORDER BY created_at ASC
    LIMIT 40
  `;
  const history = priorMsgs.rows.map((r) => ({ role: r.role, text: r.text }));

  // The persisted user message includes a one-line note about the
  // attachment so it shows up in chat history. The actual file
  // bytes are NOT stored - they only live in the API call.
  const persistedText = attachment
    ? (text ? `${text}\n\n📎 ${attachment.filename || 'file'}` : `📎 ${attachment.filename || 'file'}`)
    : text;
  const userMsg = await sql`
    INSERT INTO ivy_messages (session_id, role, text)
    VALUES (${session.id}, 'me', ${persistedText})
    RETURNING *
  `;

  const ctx = await workspaceContext(workspaceId);
  return { session, history, userMsg: userMsg.rows[0], text, attachment, ctx };
}

// Persists Ivy's reply (whatever generateReply returned, live or not), bumps
// the session and returns the response body:
//   { session, messages: [owner, ivy], context, mode, modeError, usage }
export async function finishTurn({ session, userMsg, reply, ctx, workspaceId }) {
  const replyText = reply.text;

  const ivyMsg = await sql`
    INSERT INTO ivy_messages (session_id, role, text)
    VALUES (${session.id}, 'ivy', ${replyText})
    RETURNING *
  `;

  const preview = stripInlineMarkdown(replyText).slice(0, 120);
  const upd = await sql`
    UPDATE ivy_sessions
    SET last_message_at = NOW(), last_message_preview = ${preview}, updated_at = NOW()
    WHERE id = ${session.id}
    RETURNING *
  `;

  const usage = await getDailyUsage(workspaceId);
  // Surface any confirm-gated action Ivy proposed this turn on the Ivy
  // message, so the client can render one-tap Approve/Dismiss buttons.
  // Ephemeral to the live turn (not persisted) - reopening the session
  // won't re-show a stale card.
  const ivyMessage = serializeMessage(ivyMsg.rows[0]);
  if (reply.pendingActions && reply.pendingActions.length) {
    ivyMessage.pendingActions = reply.pendingActions;
  }
  return {
    session: serializeSession(upd.rows[0]),
    messages: [serializeMessage(userMsg), ivyMessage],
    context: ctx,
    mode: reply.mode,
    modeError: reply.error || null,
    usage,
  };
}

// Returns a normalized { filename, mediaType, base64 } on success, null
// when no attachment is present, or an Error with a user-readable
// message when the payload is invalid.
export function parseAttachment(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'object') return new Error('Attachment must be an object');
  const filename = (raw.filename || raw.name || '').toString().slice(0, 200) || null;
  const mediaType = (raw.mediaType || raw.type || '').toString().toLowerCase();
  const base64 = (raw.base64 || raw.data || '').toString();
  if (!mediaType) return new Error('Attachment missing mediaType');
  if (!ALLOWED_MIME.has(mediaType)) {
    return new Error(`Unsupported file type: ${mediaType}. Allowed: PDF, PNG/JPEG/GIF/WEBP image, CSV, JSON, plain text.`);
  }
  if (!base64) return new Error('Attachment missing data');
  // base64-decoded byte length ≈ ceil(len * 3 / 4) − padding, close enough.
  const approxBytes = Math.floor(base64.length * 0.75);
  if (approxBytes > MAX_ATTACHMENT_BYTES) {
    const mb = (MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(1);
    return new Error(`File is too large. Cap is ${mb} MB.`);
  }
  return { filename, mediaType, base64 };
}
