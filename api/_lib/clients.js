// Shared serializer + helpers for the clients table.
import { sql } from './db.js';
import { clientOverrideFrom } from './reminderSettings.js';
import { serializeClientDetails } from './clientDetails.js';

export function serializeClient(row) {
  if (!row) return null;
  return {
    id:            row.id,
    name:          row.name,
    email:         row.email,
    phone:         row.phone || null,
    smsConsentAt:  row.sms_consent_at || null,
    // Client texted STOP: only they can turn texts back on.
    smsStoppedAt:  row.sms_stopped_at || null,
    stage:         row.stage,
    tags:          row.tags || [],
    notes:         row.notes,
    lifetimeValue: Number(row.lifetime_value || 0),
    source:        row.source,
    referredByClientId: row.referred_by_client_id,
    address:       row.address || null,
    photoUrl:      row.photo_url || null,
    attachments:   Array.isArray(row.attachments) ? row.attachments : [],
    galleryPhotos: Array.isArray(row.gallery_photos) ? row.gallery_photos : [],
    joinedAt:      row.joined_at,
    lastSeenAt:    row.last_seen_at,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
    // Portal-claim state - surfaces in the owner-side ClientDrawer so the
    // "Resend invitation" affordance only shows when the client hasn't
    // already claimed their account.
    inviteSentAt:  row.invite_sent_at || null,
    hasClaimedPortal: !!row.user_id,
    // When the owner's "I've moved to Ivy" email went to this client
    // (POST /api/clients/announce-move), so the sheet can leave them out.
    moveAnnouncedAt: row.move_announced_at || null,
    // Appointment reminders for this client: { mode: 'default' } (follow
    // the service / business schedule), { mode: 'off' } or
    // { mode: 'custom', minutes: [...] }. remindersOptedOut = the client
    // turned reminders off in their own portal, which always wins.
    reminderSettings: clientOverrideFrom(row.reminder_settings),
    remindersOptedOut: (row.notification_prefs || {}).reminders === false,
    // The richer record (api/_lib/clientDetails.js): addressParts,
    // birthday, pronouns, emergencyContact, preferredContact, occupation,
    // customFields. Added fields only; nothing above changes shape.
    ...serializeClientDetails(row),
  };
}

// What a helper WITHOUT the clients permission gets: enough to pick a
// client for a booking and greet them, nothing else (no notes, no
// lifetime value, no address, no files, no consent/referral state, and
// none of the richer record: birthday, emergency contact, pronouns,
// custom fields).
export function serializeClientMinimal(row) {
  if (!row) return null;
  return {
    id:    row.id,
    name:  row.name,
    email: row.email,
    phone: row.phone || null,
  };
}

// True when the request runs in helper mode without the clients
// permission - the client book must then be served minimal.
export function helperSeesMinimalClients(req) {
  return !!req?.helper && req.helper.permissions?.clients !== true;
}

// Fetch a single client and verify it belongs to the given workspace.
// Returns the row or null.
export async function fetchOwnedClient({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`
    SELECT * FROM clients WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  return rows[0] || null;
}

export const VALID_STAGES = new Set(['lead', 'active', 'paused']);
