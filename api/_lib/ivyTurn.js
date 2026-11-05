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
import { cleanLedger } from './ivyLedger.js';

export const MAX_MESSAGE_CHARS = 4000;
// Vercel serverless caps the request body around 4.5 MB. We allow up to
// ~3.5 MB of raw file bytes (≈4.7 MB of base64) and add a server-side
// belt-and-braces check so a malformed client can't OOM us.
const MAX_ATTACHMENT_BYTES = 3.5 * 1024 * 1024;
// Photos: the app shrinks each photo on the device (src/lib/ivyImage.js) and
// may cut a tall screenshot into a few stacked pieces, so one message can
// carry several images. Cap the count and the combined size so the request
// stays under the platform's body limit.
export const MAX_PHOTO_PIECES = 12;
const MAX_PHOTO_TOTAL_BYTES = 3.2 * 1024 * 1024;
const PHOTO_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/csv', 'text/plain', 'text/tab-separated-values',
  'text/markdown',
  'application/csv', 'application/json',
  // Switching to Ivy: a calendar file (.ics) and a contacts file (.vcf)
  // reach Ivy as text (attachmentToBlock in api/_lib/ivy.js).
  'text/calendar', 'text/x-vcalendar',
  'text/vcard', 'text/x-vcard', 'text/directory',
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
  let attachment = parseAttachment(body.attachment);
  if (attachment instanceof Error) return { error: attachment.message };
  // A set of photo pieces arrives as body.attachments (newer app builds).
  const photos = parsePhotoPieces(body.attachments);
  if (photos instanceof Error) return { error: photos.message };
  const photoCount = photos ? Math.max(1, Math.min(10, Number(body.photoCount) || 1)) : 0;
  if (photos) attachment = photos;
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
  //
  // The NEWEST 40, oldest first. (Taking the first 40 in a long chat fed the
  // model turns from the start of the conversation and none of the recent
  // ones, so Ivy could not see what she had just done.) `actions` is the
  // server's record of what her tools did in each reply (see ivyLedger.js).
  const priorMsgs = await sql`
    SELECT role, text, actions FROM (
      SELECT role, text, actions, created_at FROM ivy_messages
       WHERE session_id = ${session.id}
       ORDER BY created_at DESC
       LIMIT 40
    ) recent
    ORDER BY created_at ASC
  `;
  const history = priorMsgs.rows.map((r) => ({ role: r.role, text: r.text, actions: r.actions || null }));

  // The persisted user message includes a one-line note about the
  // attachment so it shows up in chat history. The actual file
  // bytes are NOT stored - they only live in the API call.
  const note = Array.isArray(attachment)
    ? `📷 ${photoCount === 1 ? '1 photo' : `${photoCount} photos`}`
    : attachment ? `📎 ${attachment.filename || 'file'}` : '';
  const persistedText = note ? (text ? `${text}\n\n${note}` : note) : text;
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
  // What the tools did this turn, stored with the reply so the chat (and
  // Ivy's next turn) keeps the server's record, not just her words.
  const actions = cleanLedger(reply.actions);

  const ivyMsg = await sql`
    INSERT INTO ivy_messages (session_id, role, text, actions)
    VALUES (${session.id}, 'ivy', ${replyText}, ${actions.length ? JSON.stringify(actions) : null}::jsonb)
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
// Photo pieces: [{ filename, mediaType, base64 }, ...]. Images only. Returns
// null (none), an Error with an owner-readable message, or the list.
export function parsePhotoPieces(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return new Error('Photos must be a list');
  if (raw.length === 0) return null;
  if (raw.length > MAX_PHOTO_PIECES) return new Error('Too many photos in one message. Send fewer at a time.');
  let total = 0;
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') return new Error('Photo is malformed');
    const mediaType = String(p.mediaType || '').toLowerCase();
    if (!PHOTO_MIME.has(mediaType)) return new Error('Only photos can be sent this way (JPEG, PNG, WEBP or GIF).');
    const base64 = String(p.base64 || '');
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return new Error('Photo data is malformed');
    total += Math.floor(base64.length * 0.75);
    if (total > MAX_PHOTO_TOTAL_BYTES) return new Error('Those photos are too large for one message. Send fewer at a time.');
    out.push({ filename: String(p.filename || 'photo.jpg').slice(0, 200), mediaType, base64 });
  }
  return out;
}

export function parseAttachment(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'object') return new Error('Attachment must be an object');
  const filename = (raw.filename || raw.name || '').toString().slice(0, 200) || null;
  const mediaType = (raw.mediaType || raw.type || '').toString().toLowerCase();
  const base64 = (raw.base64 || raw.data || '').toString();
  if (!mediaType) return new Error('Attachment missing mediaType');
  if (!ALLOWED_MIME.has(mediaType)) {
    return new Error(`Unsupported file type: ${mediaType}. Allowed: PDF, PNG/JPEG/GIF/WEBP image, CSV, JSON, plain text, calendar (.ics) or contacts (.vcf) file.`);
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
