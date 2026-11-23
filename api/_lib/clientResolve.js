// A client id that may belong to a record that was merged away.
//
// Payment providers hand back the client id we put in a checkout's metadata
// (Stripe session / subscription metadata, PayPal custom_id). When the owner
// merges that client into another one between the checkout starting and the
// webhook arriving, the id points at a deleted row, and the purchase (a
// package, a program, a membership, a saved card) would have nowhere to
// land. resolveMergedClientId follows client_merges to the client that holds
// that history now (chained merges included: current_client_id is kept up
// to date by every merge, and the loop also walks hop by hop).
//
// Scoped to one workspace: a merge record of another business is never
// followed, and the answer is always a live client of THIS workspace. An id
// that is not a merged-away client comes back unchanged, so callers keep
// their own "client not found" handling.
import { sql } from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_HOPS = 10;

export async function resolveMergedClientId(workspaceId, clientId) {
  if (clientId == null || clientId === '') return clientId ?? null;
  const start = String(clientId).trim().toLowerCase();
  if (!workspaceId || !UUID_RE.test(start)) return clientId;
  let cur = start;
  const seen = new Set();
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // eslint-disable-next-line no-await-in-loop
    const live = await sql`SELECT id FROM clients WHERE id = ${cur} AND workspace_id = ${workspaceId}`;
    if (live.rows.length) return live.rows[0].id;
    if (seen.has(cur)) break;
    seen.add(cur);
    // eslint-disable-next-line no-await-in-loop
    const m = await sql`
      SELECT current_client_id, kept_client_id FROM client_merges
       WHERE workspace_id = ${workspaceId} AND removed_client_id = ${cur}`;
    const next = m.rows[0]?.current_client_id || m.rows[0]?.kept_client_id || null;
    if (!next) break;
    cur = next;
  }
  return clientId;
}

// Remember the Stripe customer a purchase created, for a client that has
// none yet. A public checkout carries only the buyer's email unless the
// request proved who is asking (api/_lib/checkoutIdentity.js), so a
// subscription bought there lands on a customer Stripe made for it. A first-time buyer keeps
// that one as their customer from then on. A client who ALREADY has a
// customer keeps it untouched: their saved card and any automatic payment
// agreement hang off that id, and nothing started by an anonymous visitor
// may repoint it. Workspace-pinned like every other write to this column.
export async function rememberStripeCustomerIfNone({ workspaceId, clientId, customerId }) {
  if (!workspaceId || !clientId || !customerId || !/^cus_[A-Za-z0-9_]{1,200}$/.test(String(customerId))) return false;
  const upd = await sql`
    UPDATE clients SET stripe_customer_id = ${customerId}
     WHERE id = ${clientId} AND workspace_id = ${workspaceId}
       AND stripe_customer_id IS NULL
    RETURNING id
  `;
  return upd.rows.length > 0;
}

// A copy of provider metadata with client_id resolved (or the same object
// when there is nothing to resolve).
export async function withResolvedClientId(workspaceId, metadata) {
  if (!metadata || !metadata.client_id) return metadata;
  const id = await resolveMergedClientId(workspaceId, metadata.client_id);
  return id === metadata.client_id ? metadata : { ...metadata, client_id: id };
}
