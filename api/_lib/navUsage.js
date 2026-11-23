// Which of the "More" tools an owner actually uses.
//
// The owner's menu starts with five places (Home, Calendar, Clients, Money,
// Ivy). Everything else sits under "More" until the business has something
// in it: a program, a published website, a review, a document, a
// workflow, a shop, a message. (Rewards and the birthday-type reminders
// live inside Clients, which is always in the menu.) Then it moves up into the menu
// by itself. Only ever looks at the signed-in owner's own workspace.
//
// Returns an array of menu ids (src/lib/nav.js), or null when it could not
// be worked out (the app then keeps the tool under "More", where it is still
// one tap away).
import { sql } from './db.js';

export const USAGE_NAV_IDS = ['comms', 'programs', 'automation', 'reviews', 'website', 'shops', 'docs'];

export async function usedNavFor(workspaceId) {
  if (!workspaceId) return [];
  try {
    const { rows } = await sql`
      SELECT
        EXISTS (SELECT 1 FROM message_threads WHERE workspace_id = ${workspaceId}) AS comms,
        EXISTS (SELECT 1 FROM programs WHERE workspace_id = ${workspaceId}) AS programs,
        EXISTS (SELECT 1 FROM workflows WHERE workspace_id = ${workspaceId}) AS automation,
        EXISTS (SELECT 1 FROM reviews WHERE workspace_id = ${workspaceId}) AS reviews,
        EXISTS (SELECT 1 FROM websites WHERE workspace_id = ${workspaceId}
                   AND (launched = TRUE OR published_at IS NOT NULL OR custom_domain IS NOT NULL)) AS website,
        (EXISTS (SELECT 1 FROM shops WHERE owner_workspace_id = ${workspaceId})
          OR EXISTS (SELECT 1 FROM shop_members WHERE workspace_id = ${workspaceId} AND status = 'active')) AS shops,
        EXISTS (SELECT 1 FROM documents WHERE workspace_id = ${workspaceId}) AS docs
    `;
    const r = rows[0] || {};
    return USAGE_NAV_IDS.filter((id) => r[id] === true);
  } catch {
    return null;
  }
}
