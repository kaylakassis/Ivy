// Shared serializer + helpers for the clients table.
import { sql } from './db.js';

export function serializeClient(row) {
  if (!row) return null;
  return {
    id:            row.id,
    name:          row.name,
    email:         row.email,
    phone:         row.phone || null,
    smsConsentAt:  row.sms_consent_at || null,
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
    // Portal-claim state — surfaces in the owner-side ClientDrawer so the
    // "Resend invitation" affordance only shows when the client hasn't
    // already claimed their account.
    inviteSentAt:  row.invite_sent_at || null,
    hasClaimedPortal: !!row.user_id,
    // Card-on-file metadata (no raw PM id leaks to the UI — only the
    // brand/last4 for display + a boolean for gating off-session
    // charges from the POS and recurring auto-charge surfaces).
    hasCardOnFile:    !!row.payment_method_id,
    cardBrand:        row.payment_method_brand || null,
    cardLast4:        row.payment_method_last4 || null,
  };
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
