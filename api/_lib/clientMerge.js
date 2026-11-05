// Merging two client records of one business into one (Clients > Possible
// duplicates > Merge, "Merge with..." on a client, Ivy's merge_clients).
//
// The work happens in ONE database statement, the ivy_merge_clients()
// function in api/_lib/schema.js, so it is one transaction: either every
// booking, invoice, message, document, package, enrollment, card and
// consent moves to the kept client and the other record is removed, or
// nothing changes. The function finds every table that points at a client
// from the database catalog, so a table added later is moved too.
//
// Rules (also in docs/ivy-capabilities.md):
//   • Both clients must belong to the caller's workspace. Nothing in another
//     business is read or changed.
//   • If both records have a client portal account belonging to two
//     different people, the merge is refused.
//   • If both have automatic payments running on two different cards, the
//     merge is refused (one card per client per business); the owner turns
//     one off first. An active autopay agreement is never lost.
//   • Opt-outs win: if either record unsubscribed from a kind of email or
//     texted STOP, the merged client keeps it.
//   • Exactly once: a second call for the same removed client (a double tap,
//     a retry, Ivy's approval and a button at the same time) answers
//     "already merged" and changes nothing.
//   • A payment started by the removed client (checkout, subscription,
//     card setup) still lands on the kept client: webhooks and fulfilment
//     resolve the client id in provider metadata through client_merges
//     (api/_lib/clientResolve.js).
//   • There is no undo. The merge record keeps a snapshot of the removed
//     record, so support can see exactly what it held, but splitting a
//     client again cannot know which later bookings or messages belong to
//     whom, so it is not offered.
import { sql } from './db.js';
import { CLIENT_EMAIL_TYPES } from './notificationPrefs.js';
import { clientRecordCounts, suggestedKeep } from './clientDuplicates.js';
import { recordWorkspaceAudit } from './audit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MERGE_FIELDS = ['name', 'email', 'phone', 'address', 'birthday', 'stage'];

export class MergeError extends Error {
  constructor(message, code = 'refused', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const REFUSALS = {
  same_client: 'Pick two different clients to merge.',
  not_found: 'One of these clients was not found.',
  keep_merged: 'The client you chose to keep was already merged into another record.',
  both_claimed: 'Both records have their own client portal account, signed up by two different people, so they cannot be merged. If they really are the same person, ask them which account to keep and remove the other client first.',
  autopay_cards: 'Both records have automatic payments running on two different cards. Turn off automatic payments for one of them first (Finance > Recurring), then merge.',
};

export function cleanId(v) {
  const s = String(v || '').trim().toLowerCase();
  return UUID_RE.test(s) ? s : null;
}

// Owner choices: which record's value wins for each field. Anything not
// listed (or not 'keep' / 'remove') falls back to the defaults: the kept
// record's value, or the other one's when the kept record has none; the
// more active stage. Custom fields: { [fieldId]: 'keep' | 'remove' }.
export function cleanFieldChoices(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const f of MERGE_FIELDS) {
    if (input[f] === 'keep' || input[f] === 'remove') out[f] = input[f];
  }
  const cf = input.custom_fields || input.customFields;
  if (cf && typeof cf === 'object' && !Array.isArray(cf)) {
    const m = {};
    for (const [k, v] of Object.entries(cf).slice(0, 100)) {
      if ((v === 'keep' || v === 'remove') && /^[0-9a-f-]{36}$/i.test(k)) m[k.toLowerCase()] = v;
    }
    if (Object.keys(m).length) out.custom_fields = m;
  }
  return out;
}

async function loadPair(workspaceId, keepId, removeId) {
  const { rows } = await sql`
    SELECT id, name, email, phone, stage, user_id, created_at, notes, tags, custom_fields,
           address, address_street, address_city, address_region, address_postal_code, address_country,
           birth_month, birth_day, birth_year, payment_method_id, stripe_customer_id,
           payment_method_brand, payment_method_last4, sms_stopped_at, notification_prefs
      FROM clients WHERE workspace_id = ${workspaceId} AND id = ANY(${[keepId, removeId]}::uuid[])`;
  return { keep: rows.find((r) => r.id === keepId) || null, remove: rows.find((r) => r.id === removeId) || null };
}

// Why this pair cannot be merged right now, or null. Same checks the
// database function makes (it re-checks under a lock).
export async function mergeRefusal(workspaceId, keepId, removeId) {
  const k = cleanId(keepId); const r = cleanId(removeId);
  if (!k || !r || k === r) return { code: 'same_client', message: REFUSALS.same_client };
  const { keep, remove } = await loadPair(workspaceId, k, r);
  if (!remove) {
    const prior = await sql`SELECT current_client_id FROM client_merges WHERE workspace_id = ${workspaceId} AND removed_client_id = ${r}`;
    if (prior.rows.length) return { code: 'already_merged', message: 'These records were already merged.', keptClientId: prior.rows[0].current_client_id };
    return { code: 'not_found', message: REFUSALS.not_found };
  }
  if (!keep) return { code: 'not_found', message: REFUSALS.not_found };
  if (keep.user_id && remove.user_id && keep.user_id !== remove.user_id) return { code: 'both_claimed', message: REFUSALS.both_claimed };
  const ap = await sql`
    SELECT client_id, payment_method_id, stripe_customer_id FROM autopay_agreements
     WHERE workspace_id = ${workspaceId} AND client_id = ANY(${[k, r]}::uuid[]) AND status = 'active'`;
  const ka = ap.rows.filter((x) => x.client_id === k);
  const ra = ap.rows.filter((x) => x.client_id === r);
  if (ka.length && ra.length && ra.some((x) => ka.some((y) => y.payment_method_id !== x.payment_method_id || y.stripe_customer_id !== x.stripe_customer_id))) {
    return { code: 'autopay_cards', message: REFUSALS.autopay_cards };
  }
  return null;
}

const addrLine = (c) => [c.address_street, c.address_city, c.address_region, c.address_postal_code, c.address_country]
  .map((x) => String(x || '').trim()).filter(Boolean).join(', ') || String(c.address || '').trim();
const bdayLine = (c) => (c.birth_month ? `${c.birth_month}/${c.birth_day || '?'}${c.birth_year ? `/${c.birth_year}` : ''}` : '');

// Everything the merge sheet and Ivy's card need: both records with counts,
// the fields that differ, the suggested record to keep, and a refusal when
// the merge cannot run. Throws MergeError(404) for unknown ids.
export async function mergePreview(workspaceId, keepId, removeId) {
  const k = cleanId(keepId); const r = cleanId(removeId);
  if (!k || !r || k === r) throw new MergeError(REFUSALS.same_client, 'same_client');
  const { keep, remove } = await loadPair(workspaceId, k, r);
  if (!keep || !remove) throw new MergeError(REFUSALS.not_found, 'not_found', 404);
  const counts = await clientRecordCounts(workspaceId, [k, r]);
  const refusal = await mergeRefusal(workspaceId, k, r);
  const defs = (await sql`SELECT id, label FROM client_field_definitions WHERE workspace_id = ${workspaceId} ORDER BY position, created_at`).rows;
  const fields = [];
  const pushField = (field, label, a, b) => {
    const av = String(a ?? '').trim(); const bv = String(b ?? '').trim();
    if (!av && !bv) return;
    fields.push({ field, label, keep: av || null, remove: bv || null, differs: av.toLowerCase() !== bv.toLowerCase() && !!av && !!bv });
  };
  pushField('name', 'Name', keep.name, remove.name);
  pushField('email', 'Email', keep.email, remove.email);
  pushField('phone', 'Phone', keep.phone, remove.phone);
  pushField('address', 'Address', addrLine(keep), addrLine(remove));
  pushField('birthday', 'Birthday', bdayLine(keep), bdayLine(remove));
  pushField('stage', 'Stage', keep.stage, remove.stage);
  const customFields = [];
  for (const d of defs) {
    const a = keep.custom_fields?.[d.id]; const b = remove.custom_fields?.[d.id];
    const av = a == null ? '' : String(a).trim(); const bv = b == null ? '' : String(b).trim();
    if (!av && !bv) continue;
    customFields.push({ id: d.id, label: d.label, keep: av || null, remove: bv || null, differs: !!av && !!bv && av !== bv });
  }
  const optOuts = {
    email: Object.values(keep.notification_prefs || {}).some((v) => v === false) || Object.values(remove.notification_prefs || {}).some((v) => v === false),
    sms: !!(keep.sms_stopped_at || remove.sms_stopped_at),
  };
  return {
    keep: counts[k],
    remove: counts[r],
    suggestedKeepId: suggestedKeep(keep, remove),
    fields,
    customFields,
    tags: [...new Set([...(keep.tags || []), ...(remove.tags || [])])],
    optOuts,
    refusal: refusal ? refusal.message : null,
    refusalCode: refusal ? refusal.code : null,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function joinWords(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// "3 bookings, 2 invoices and 14 messages" from a client's counts (only
// the ones that are not zero), or '' when there is nothing.
export function movesPhrase(counts) {
  const c = counts || {};
  const parts = [];
  if (c.bookings) parts.push(plural(c.bookings, 'booking'));
  if (c.invoices) parts.push(plural(c.invoices, 'invoice'));
  if (c.messages) parts.push(plural(c.messages, 'message'));
  if (c.documents) parts.push(plural(c.documents, 'document'));
  if (c.packages) parts.push(plural(c.packages, 'package'));
  return joinWords(parts);
}

// The one-line description used by Ivy's approval card:
// "Merge Jane D. into Jane Doe: 3 bookings, 2 invoices and 14 messages move
// to Jane Doe. Jane D. is removed."
// Two records with the same name are told apart by their email or phone.
export function mergeNames(preview) {
  const k = preview.keep || {}; const r = preview.remove || {};
  let from = r.name || 'the other record';
  let into = k.name || 'the kept record';
  if (String(r.name || '').trim().toLowerCase() === String(k.name || '').trim().toLowerCase()) {
    from = `${from} (${r.email || r.phone || 'no email'})`;
    into = `${into} (${k.email || k.phone || 'no email'})`;
  }
  return { from, into };
}

export function mergeSentence(preview) {
  const { from, into } = mergeNames(preview);
  const moves = movesPhrase(preview.remove?.counts);
  if (!moves) return `Merge ${from} into ${into}. ${from} has no bookings, invoices or messages yet and is removed.`;
  return `Merge ${from} into ${into}: ${moves} move to ${into}. ${from} is removed.`;
}

function mapDbError(err) {
  const m = /merge_refused:([a-z_]+)/.exec(String(err?.message || ''));
  if (!m) return null;
  const code = m[1];
  return new MergeError(REFUSALS[code] || 'These clients cannot be merged.', code, code === 'not_found' ? 404 : 409);
}

// Runs the merge. Returns { merged: true, alreadyMerged, keptClientId,
// moved, dropped }. Throws MergeError when it is refused.
export async function mergeClients({ workspaceId, keepId, removeId, fieldChoices, actor = null, via = 'app', req = null }) {
  const k = cleanId(keepId); const r = cleanId(removeId);
  if (!workspaceId) throw new MergeError('No workspace', 'no_workspace', 400);
  if (!k || !r || k === r) throw new MergeError(REFUSALS.same_client, 'same_client');
  const choices = cleanFieldChoices(fieldChoices);
  let out;
  try {
    const { rows } = await sql`
      SELECT ivy_merge_clients(${workspaceId}::uuid, ${k}::uuid, ${r}::uuid, ${actor?.id || null}::uuid,
                               ${String(via).slice(0, 20)}, ${JSON.stringify(choices)}::jsonb,
                               ${CLIENT_EMAIL_TYPES}::text[]) AS result`;
    out = rows[0]?.result || {};
  } catch (err) {
    const mapped = mapDbError(err);
    if (mapped) throw mapped;
    throw err;
  }
  const alreadyMerged = out.status === 'already_merged';
  if (!alreadyMerged) {
    await recordWorkspaceAudit(req, {
      workspaceId,
      actor,
      action: 'client.merge',
      target: { kind: 'client', id: k },
      meta: { removed_client_id: r, merge_id: out.merge_id, via, moved: out.moved || {}, dropped: out.dropped || 0 },
    });
  }
  return {
    merged: true,
    alreadyMerged,
    mergeId: out.merge_id || null,
    keptClientId: out.kept_client_id || k,
    moved: out.moved || {},
    dropped: Number(out.dropped) || 0,
  };
}

// The ids whose permanent records (cancellation policy acceptances) now
// belong to `clientId`: itself plus every record merged into it.
export async function clientIdsWithMerged(workspaceId, clientId) {
  const id = cleanId(clientId);
  if (!id) return [];
  const { rows } = await sql`
    SELECT removed_client_id FROM client_merges
     WHERE workspace_id = ${workspaceId} AND current_client_id = ${id}
     LIMIT 500`;
  return [id, ...rows.map((x) => x.removed_client_id)];
}
