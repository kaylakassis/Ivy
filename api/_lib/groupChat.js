// Shared serializers + ownership helpers for the group_chat tables.
// Parallel to api/_lib/messages.js (1:1 threads) — the two systems
// do not share rows.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { notifyClientSafe, notifyOwnerSafe } from './push.js';

export function serializeGroupThread(row, { memberCount, currentMember } = {}) {
  if (!row) return null;
  return {
    id:                row.id,
    name:              row.name,
    description:       row.description || '',
    mode:              row.mode,
    archived:          !!row.archived,
    unreadBiz:         Number(row.unread_biz || 0),
    lastMessageAt:     row.last_message_at,
    lastPreview:       row.last_message_preview || '',
    memberCount:       Number.isFinite(memberCount) ? memberCount : null,
    // For client-portal responses: this client's own member-row state.
    unreadClient:      currentMember ? Number(currentMember.unread_count || 0) : null,
    muted:             currentMember ? !!currentMember.muted : null,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
  };
}

export function serializeGroupMember(row) {
  if (!row) return null;
  return {
    clientId:    row.client_id,
    clientName:  row.client_name || null,
    clientEmail: row.client_email || null,
    joinedAt:    row.joined_at,
    leftAt:      row.left_at,
    muted:       !!row.muted,
  };
}

export function serializeGroupMessage(row) {
  if (!row) return null;
  return {
    id:              row.id,
    threadId:        row.thread_id,
    sender:          row.sender,
    senderClientId:  row.sender_client_id || null,
    senderName:      row.sender_name || null,    // joined client name when sender='client'
    parentMessageId: row.parent_message_id || null,
    text:            row.text,
    attachments:     row.attachments || [],
    kind:            row.kind,
    meta:            row.meta || {},
    reactions:       row.reactions || [],         // [{ emoji, count, mine }]
    mentions:        row.mentions || [],          // [{ clientId, name }]
    createdAt:       row.created_at,
  };
}

// Parses @mentions out of message text. Resolves each @Name fragment
// against the supplied active-member list (case-insensitive substring
// match against client name) AND against the literal token '@owner' /
// '@everyone'. Returns:
//   mentions    — [{ clientId, displayName, isOwner }]
//   broadcastAll — true when @everyone was used
// Resolution is best-effort: ambiguous matches are dropped (we never
// fire a notification at the wrong person). The original text is left
// unchanged — the UI renders @Name as a chip via the saved mention rows.
export function extractMentions(text, activeMembers = []) {
  const out = { mentions: [], broadcastAll: false, isOwnerMention: false };
  if (!text) return out;
  const tokens = String(text).match(/@[A-Za-z][\w\-.]{0,40}/g) || [];
  const seen = new Set();
  for (const raw of tokens) {
    const lower = raw.slice(1).toLowerCase();
    if (lower === 'everyone' || lower === 'all') { out.broadcastAll = true; continue; }
    if (lower === 'owner' || lower === 'business') { out.isOwnerMention = true; continue; }
    // Match against member first names + full names. Pick the unique winner.
    const candidates = activeMembers.filter((m) => {
      const name = String(m.client_name || m.clientName || '').toLowerCase();
      if (!name) return false;
      const first = name.split(/\s+/)[0];
      return name.startsWith(lower) || first === lower;
    });
    if (candidates.length === 1) {
      const m = candidates[0];
      const cid = m.client_id || m.clientId;
      if (cid && !seen.has(cid)) {
        seen.add(cid);
        out.mentions.push({
          clientId: cid,
          displayName: m.client_name || m.clientName || null,
          isOwner: false,
        });
      }
    }
  }
  return out;
}

// Mint a new invite token. Returns the plaintext token (to put in the
// invite URL) AND the hashed row. We only persist the hash so a leaked
// DB read can't redeem invites.
export function mintInviteToken() {
  const plaintext = crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash };
}

export function hashInviteToken(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

// Verify the named group_thread belongs to this workspace + return
// the row. Returns null on miss.
export async function fetchOwnedGroup({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`
    SELECT * FROM group_threads
     WHERE id = ${id} AND workspace_id = ${workspaceId}
     LIMIT 1
  `;
  return rows[0] || null;
}

// Verify this client is an ACTIVE member of the named group_thread in
// the named workspace. Returns the member row + thread row, or null
// if either is missing or the client has left. Used by every /api/me/groups/*
// endpoint to gate before reads/writes.
export async function fetchClientGroupMembership({ threadId, clientId, workspaceId }) {
  if (!threadId || !clientId || !workspaceId) return null;
  const { rows } = await sql`
    SELECT t.id AS thread_id, t.name, t.description, t.mode, t.archived,
           t.last_message_at, t.last_message_preview, t.created_at, t.updated_at,
           m.client_id, m.joined_at, m.left_at, m.unread_count, m.last_read_at, m.muted
      FROM group_thread_members m
      JOIN group_threads t
        ON t.id = m.thread_id AND t.workspace_id = m.workspace_id
     WHERE m.thread_id = ${threadId}
       AND m.client_id = ${clientId}
       AND m.workspace_id = ${workspaceId}
       AND m.left_at IS NULL
     LIMIT 1
  `;
  return rows[0] || null;
}

// Per-message side-effects: bump unread for every member who didn't
// send, push to them, push to the owner (if a client sent), update
// thread last_* fields. Best-effort — caller already returned the
// new message to the user; this is fire-and-forget but awaited so
// Vercel doesn't kill it.
//
// senderClientId = null when sender is the owner.
// mentionedClientIds / mentionedOwner control notification BOOSTING:
//   non-mentioned recipients get the standard "New group message" push.
//   mentioned recipients get "You were mentioned in X" with a different tag.
export async function fanoutGroupMessage({
  workspaceId, threadId, threadName, senderClientId, preview,
  mentionedClientIds = [], mentionedOwner = false,
}) {
  const mentionedSet = new Set(mentionedClientIds);
  // Bump unread for every active member who isn't the sender + isn't
  // muted. One UPDATE, atomic.
  await sql`
    UPDATE group_thread_members
       SET unread_count = unread_count + 1
     WHERE thread_id = ${threadId}
       AND workspace_id = ${workspaceId}
       AND left_at IS NULL
       AND muted = FALSE
       AND (${senderClientId}::uuid IS NULL OR client_id <> ${senderClientId}::uuid)
  `;

  // Bump biz-side unread only when a client sent (owner already saw
  // their own send).
  if (senderClientId) {
    await sql`
      UPDATE group_threads
         SET unread_biz = unread_biz + 1,
             last_message_at = NOW(),
             last_message_preview = ${preview},
             updated_at = NOW()
       WHERE id = ${threadId} AND workspace_id = ${workspaceId}
    `;
  } else {
    await sql`
      UPDATE group_threads
         SET last_message_at = NOW(),
             last_message_preview = ${preview},
             updated_at = NOW()
       WHERE id = ${threadId} AND workspace_id = ${workspaceId}
    `;
  }

  // Push to every active, unmuted member who isn't the sender.
  const recipients = await sql`
    SELECT client_id FROM group_thread_members
     WHERE thread_id = ${threadId}
       AND workspace_id = ${workspaceId}
       AND left_at IS NULL
       AND muted = FALSE
       AND (${senderClientId}::uuid IS NULL OR client_id <> ${senderClientId}::uuid)
  `;
  for (const r of recipients.rows) {
    const mentioned = mentionedSet.has(r.client_id);
    notifyClientSafe({
      clientId: r.client_id,
      type: 'messages',
      payload: {
        title: mentioned
          ? `You were mentioned · ${threadName || 'group'}`
          : (threadName ? `Group · ${threadName}` : 'New group message'),
        body: preview,
        url: `/me/messages?group=${threadId}`,
        tag: mentioned ? `group-mention-${threadId}-${r.client_id}` : `group-${threadId}`,
      },
    });
  }

  // If a client sent, ping the owner too — boost if @owner mentioned.
  if (senderClientId) {
    notifyOwnerSafe({
      workspaceId, type: 'messages',
      payload: {
        title: mentionedOwner
          ? `You were mentioned · ${threadName || 'group'}`
          : (threadName ? `Group · ${threadName}` : 'New group message'),
        body: preview,
        url: `/messages?group=${threadId}`,
        tag: mentionedOwner ? `group-owner-mention-${threadId}` : `group-${threadId}`,
      },
    });
  }
}

// Compute a sensible preview from text + attachments. Voice memos
// surface as 🎙️ Voice message, file-only as Attachment.
export function previewFor({ text, attachments }) {
  if (text && text.trim()) return text.trim().slice(0, 200);
  const audioOnly = (attachments || []).some((a) => String(a?.type || '').startsWith('audio/'));
  if (audioOnly) return '🎙️ Voice message';
  if ((attachments || []).length > 0) return 'Attachment';
  return '';
}

// Single canonical send path used by both owner and client message
// endpoints. Handles:
//   • parent_message_id validation (must be in same thread)
//   • @mention extraction + persistence
//   • reaction-counts shape on the returned message
//   • fan-out with mention-boosted notifications
//
// Returns { message } on success or { error, status } on validation
// failure. Callers wrap the call in withIdempotency.
export async function insertGroupMessage({
  workspaceId, threadId, threadName, sender, senderClientId,
  text, attachments, parentMessageId,
  activeMembers,
}) {
  if (parentMessageId) {
    const parent = await sql`
      SELECT id FROM group_messages
       WHERE id = ${parentMessageId} AND thread_id = ${threadId} AND workspace_id = ${workspaceId}
       LIMIT 1
    `;
    if (parent.rows.length === 0) {
      return { error: 'Parent message not found', status: 400 };
    }
  }

  // Resolve @mentions BEFORE insert so the mention rows + the message
  // row land in one logical send. If active-members weren't supplied,
  // skip mention extraction silently — owner-side send already loads
  // members; client-side does too.
  const { mentions, isOwnerMention } = extractMentions(text, activeMembers || []);

  const inserted = await sql`
    INSERT INTO group_messages (thread_id, workspace_id, sender, sender_client_id,
                                text, attachments, parent_message_id)
    VALUES (${threadId}, ${workspaceId}, ${sender}, ${senderClientId},
            ${text}, ${JSON.stringify(attachments || [])}::jsonb, ${parentMessageId || null})
    RETURNING *
  `;
  const msg = inserted.rows[0];

  if (mentions.length > 0) {
    // Persist as one row per mention. ON CONFLICT for safety on retried
    // sends though composite PK + insert-once flow already prevents dupes.
    for (const m of mentions) {
      await sql`
        INSERT INTO group_message_mentions (message_id, mentioned_client_id, workspace_id, display_name)
        VALUES (${msg.id}, ${m.clientId}, ${workspaceId}, ${m.displayName})
        ON CONFLICT (message_id, mentioned_client_id) DO NOTHING
      `;
    }
  }

  await fanoutGroupMessage({
    workspaceId, threadId, threadName,
    senderClientId,
    preview: previewFor({ text, attachments }),
    mentionedClientIds: mentions.map((m) => m.clientId),
    mentionedOwner: isOwnerMention,
  });

  // Return message with mentions inline for the client to render the @chips
  // immediately (without re-fetching the thread).
  return {
    message: {
      ...serializeGroupMessage(msg),
      mentions: mentions.map((m) => ({ clientId: m.clientId, name: m.displayName })),
      reactions: [],
    },
  };
}

// Aggregate reactions per emoji for a list of message ids. Returns
// { [messageId]: [{ emoji, count, mine }] }. `mineKey` is either a
// clients.id or the string 'biz' (owner reactions).
export async function loadReactionsForMessages(messageIds, mineKey) {
  if (messageIds.length === 0) return {};
  const r = await sql.query(
    `SELECT message_id, emoji,
            COUNT(*)::int AS count,
            BOOL_OR(
              CASE WHEN $2::text = 'biz' THEN is_owner = TRUE
                   ELSE reactor_client_id::text = $2::text END
            ) AS mine
       FROM group_message_reactions
      WHERE message_id = ANY($1::uuid[])
      GROUP BY message_id, emoji
      ORDER BY message_id, count DESC, emoji ASC`,
    [messageIds, mineKey],
  );
  const map = {};
  for (const row of r.rows) {
    if (!map[row.message_id]) map[row.message_id] = [];
    map[row.message_id].push({ emoji: row.emoji, count: row.count, mine: !!row.mine });
  }
  return map;
}

// Sanitize the attachments payload — same shape as messages POST.
export function cleanAttachments(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((a) => ({
      url:        String(a?.url || '').slice(0, 1000),
      type:       String(a?.type || '').slice(0, 80),
      name:       a?.name ? String(a.name).slice(0, 200) : null,
      durationMs: Number.isFinite(Number(a?.durationMs)) ? Number(a.durationMs) : null,
    }))
    .filter((a) => a.url && a.type);
}
