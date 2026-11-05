// Possible duplicate clients in one business (Clients > Possible duplicates,
// Ivy's find_duplicate_clients, the count after an import).
//
// Pairs are found by blocking, never by comparing every client with every
// other one: clients are grouped by exact email, by email with Gmail dots and
// "+tags" removed, by normalised phone, and by first name and by last name.
// Only clients inside one group are compared, so a business with thousands
// of clients does a few thousand cheap comparisons, not millions.
//
// Signals, strongest first:
//   same_email     the same address, ignoring case and spaces
//   same_phone     the same number once normalised (+15552010101)
//   similar_email  the same Gmail inbox written another way (dots, +tag).
//                  Suggested only; nothing is ever merged automatically.
//   similar_name   "Jane Doe" / "jane  doe" / "Jané Doe", a nickname
//                  ("Kate" / "Katherine") with the same last name, or a one
//                  letter typo in a longer name (only when the records do not
//                  have different emails or different phones). An initial
//                  ("Jane D.") only counts next to a matching email or phone.
// A first name alone is never a match, and two clients with the same name
// whose emails AND phones both differ are treated as two people.
//
// Every query is scoped to the caller's workspace. Pairs the owner marked
// "Not the same person" (client_duplicate_dismissals) never come back.
import { sql } from './db.js';
import { normalizePhone } from './sms.js';

export const DUPLICATE_SCAN_LIMIT = 20000;   // clients read per scan
export const DUPLICATE_PAIR_LIMIT = 500;     // pairs returned
const NAME_BLOCK_MAX = 400;                  // a bigger name group is split further

export const CONFIDENCE = {
  same_email: { rank: 4, label: 'Same email' },
  same_phone: { rank: 3, label: 'Same phone' },
  similar_email: { rank: 2, label: 'Similar email' },
  similar_name: { rank: 1, label: 'Similar name' },
};

// ── normalising ────────────────────────────────────────────────────────
export function normEmail(e) {
  const s = String(e || '').trim().toLowerCase().replace(/\s+/g, '');
  return s.includes('@') ? s : '';
}

// The inbox an address really reaches: "+tag" dropped everywhere, dots
// dropped for Gmail (which ignores them). Used only to SUGGEST a pair.
export function canonicalEmail(e) {
  const s = normEmail(e);
  if (!s) return '';
  const at = s.lastIndexOf('@');
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : '';
}

export function normPhone(p) {
  if (!p) return '';
  return normalizePhone(String(p).slice(0, 40)) || '';
}

// Lower case, accents removed, punctuation to spaces, one space between words.
export function normName(n) {
  return String(n || '')
    .slice(0, 200)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common English nicknames to one key, so "Kate Doe" meets "Katherine Doe".
const NICK_GROUPS = [
  ['robert', 'rob', 'bob', 'bobby', 'robbie'], ['william', 'will', 'bill', 'billy', 'liam'],
  ['elizabeth', 'liz', 'beth', 'betty', 'eliza', 'lizzie'], ['katherine', 'kate', 'katie', 'kathy', 'catherine', 'cathy', 'kat', 'kathryn'],
  ['james', 'jim', 'jimmy', 'jamie'], ['michael', 'mike', 'mikey'], ['christopher', 'chris'],
  ['christine', 'chris', 'christina', 'tina'], ['thomas', 'tom', 'tommy'], ['david', 'dave', 'davey'],
  ['daniel', 'dan', 'danny'], ['jennifer', 'jen', 'jenny', 'jenn'], ['alexander', 'alex', 'xander'],
  ['alexandra', 'alex', 'alexa', 'sandra'], ['samuel', 'sam', 'sammy'], ['samantha', 'sam', 'sammy'],
  ['joseph', 'joe', 'joey'], ['richard', 'rich', 'rick', 'dick'], ['margaret', 'maggie', 'meg', 'peggy'],
  ['rebecca', 'becca', 'becky'], ['jessica', 'jess', 'jessie'], ['nicholas', 'nick', 'nicky'],
  ['anthony', 'tony'], ['matthew', 'matt'], ['andrew', 'andy', 'drew'], ['benjamin', 'ben', 'benny'],
  ['jonathan', 'jon', 'john', 'johnny'], ['stephanie', 'steph'], ['steven', 'steve', 'stephen'],
  ['patricia', 'pat', 'patty', 'trish'], ['victoria', 'vicky', 'tori'], ['susan', 'sue', 'susie'],
  ['deborah', 'deb', 'debbie'], ['edward', 'ed', 'eddie', 'ted'], ['gregory', 'greg'], ['timothy', 'tim'],
  ['abigail', 'abby'], ['olivia', 'liv'], ['zachary', 'zach', 'zack'], ['joshua', 'josh'],
];
const NICK = new Map();
for (const g of NICK_GROUPS) for (const n of g) if (!NICK.has(n)) NICK.set(n, g[0]);
const nickKey = (t) => NICK.get(t) || t;

// Edit distance, giving up as soon as it is over `max` (so it stays cheap).
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function tokens(n) {
  return n ? n.split(' ').filter(Boolean) : [];
}

function firstNamesMatch(a, b) {
  if (a === b) return 'same';
  if (nickKey(a) === nickKey(b)) return 'same';
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 'initial' : null;
  if (Math.min(a.length, b.length) >= 4 && a[0] === b[0] && editDistance(a, b, 1) <= 1) return 'typo';
  return null;
}

function lastNamesMatch(a, b) {
  if (a === b) return 'same';
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 'initial' : null;
  if (Math.min(a.length, b.length) >= 4 && a[0] === b[0] && editDistance(a, b, 1) <= 1) return 'typo';
  return null;
}

// How two names relate: 'exact' (same once normalised, two words or more),
// 'nickname' ("Kate" / "Katherine", same last name), 'typo' (one letter
// apart in a first or last name of 4+ letters), 'initial' ("Jane D." vs
// "Jane Doe": only counted next to another signal), or null.
export function nameRelation(nameA, nameB) {
  const a = tokens(normName(nameA));
  const b = tokens(normName(nameB));
  if (a.length < 2 || b.length < 2) return null;
  if (a.join(' ') === b.join(' ')) return 'exact';
  const f = firstNamesMatch(a[0], b[0]);
  const l = lastNamesMatch(a[a.length - 1], b[b.length - 1]);
  if (!f || !l) return null;
  if (f === 'initial' || l === 'initial') return 'initial';
  if (f === 'typo' && l === 'typo') return null; // two typos: too far apart
  if (f === 'typo' || l === 'typo') return 'typo';
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1] ? 'exact' : 'nickname';
}

// First names that clearly belong to different people ("Jane" / "Tom"),
// used to say when a shared email or phone may be a family's.
function firstNamesDiffer(nameA, nameB) {
  const a = tokens(normName(nameA))[0];
  const b = tokens(normName(nameB))[0];
  if (!a || !b) return false;
  return !firstNamesMatch(a, b);
}

// ── pair finding (pure: unit-testable without a database) ─────────────
// clients: [{ id, name, email, phone, created_at, user_id }]
// dismissed: Set of "idA|idB" (sorted). Returns pairs sorted strongest first.
export function findDuplicatePairs(clients, { dismissed = new Set(), limit = DUPLICATE_PAIR_LIMIT, onlyIds = null } = {}) {
  const prepared = clients.map((c) => ({
    c,
    email: normEmail(c.email),
    canon: canonicalEmail(c.email),
    phone: normPhone(c.phone),
    toks: tokens(normName(c.name)),
  }));
  const pairs = new Map();
  const keyOf = (x, y) => (x.c.id < y.c.id ? `${x.c.id}|${y.c.id}` : `${y.c.id}|${x.c.id}`);
  const add = (x, y, signal) => {
    if (x.c.id === y.c.id) return;
    const key = keyOf(x, y);
    if (dismissed.has(key)) return;
    if (onlyIds && !onlyIds.has(String(x.c.id)) && !onlyIds.has(String(y.c.id))) return;
    let p = pairs.get(key);
    if (!p) {
      const [a, b] = x.c.id < y.c.id ? [x, y] : [y, x];
      p = { key, a, b, signals: new Set() };
      pairs.set(key, p);
    }
    p.signals.add(signal);
  };
  const groupBy = (keyFn) => {
    const m = new Map();
    for (const x of prepared) {
      const k = keyFn(x);
      if (!k) continue;
      const arr = m.get(k);
      if (arr) arr.push(x); else m.set(k, [x]);
    }
    return m;
  };
  const eachPair = (list, fn) => {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) fn(list[i], list[j]);
  };

  // Same email / same phone: everyone in a group pairs with everyone. A
  // group bigger than 25 is a shared office line or a placeholder like
  // "none@none.com": pairing all of them would only be noise.
  for (const list of groupBy((x) => x.email).values()) if (list.length <= 25) eachPair(list, (x, y) => add(x, y, 'same_email'));
  for (const list of groupBy((x) => x.phone).values()) if (list.length <= 25) eachPair(list, (x, y) => add(x, y, 'same_phone'));
  for (const list of groupBy((x) => x.canon).values()) {
    if (list.length > 25) continue;
    eachPair(list, (x, y) => { if (x.email !== y.email) add(x, y, 'similar_email'); });
  }

  // Names: compare inside first-name and last-name groups only.
  const nameCheck = (x, y) => {
    const rel = nameRelation(x.c.name, y.c.name);
    if (!rel) return;
    if (rel === 'initial') {
      // Only alongside a stronger signal (it is then recorded as a reason).
      const key = keyOf(x, y);
      const p = pairs.get(key);
      if (p) p.signals.add('similar_name');
      return;
    }
    // Same name, but different emails AND different phones on both
    // records: two people who happen to share a name. A name one letter
    // apart ("Johnson" / "Johnston") is weaker: either a different email or
    // a different phone on both records is enough to call them two people.
    const bothEmails = !!(x.email && y.email && x.canon !== y.canon);
    const bothPhones = !!(x.phone && y.phone && x.phone !== y.phone);
    if (bothEmails && bothPhones) return;
    if (rel === 'typo' && (bothEmails || bothPhones)) return;
    add(x, y, 'similar_name');
  };
  const nameBlocks = (keyFn) => {
    for (const list of groupBy(keyFn).values()) {
      if (list.length < 2) continue;
      if (list.length <= NAME_BLOCK_MAX) { eachPair(list, nameCheck); continue; }
      // A very common name: split by the first letter of the other name.
      const sub = new Map();
      for (const x of list) {
        const k = `${x.toks[0]?.[0] || ''}${x.toks[x.toks.length - 1]?.[0] || ''}`;
        const arr = sub.get(k);
        if (arr) arr.push(x); else sub.set(k, [x]);
      }
      for (const s of sub.values()) if (s.length <= NAME_BLOCK_MAX) eachPair(s, nameCheck);
    }
  };
  nameBlocks((x) => (x.toks.length >= 2 ? `f:${nickKey(x.toks[0])}` : ''));
  nameBlocks((x) => (x.toks.length >= 2 && x.toks[x.toks.length - 1].length >= 2 ? `l:${x.toks[x.toks.length - 1]}` : ''));
  // Initials ("Jane D.") pair only with a stronger signal, already recorded
  // above when their first-name group was compared.

  const out = [];
  for (const p of pairs.values()) {
    const signals = [...p.signals].sort((s, t) => CONFIDENCE[t].rank - CONFIDENCE[s].rank);
    const top = signals[0];
    out.push({
      key: p.key,
      a: p.a.c,
      b: p.b.c,
      confidence: top,
      label: CONFIDENCE[top].label,
      rank: CONFIDENCE[top].rank,
      reasons: reasonsFor(p.a, p.b, signals),
    });
  }
  out.sort((x, y) => (y.rank - x.rank)
    || (new Date(y.a.created_at || 0) - new Date(x.a.created_at || 0))
    || (x.key < y.key ? -1 : 1));
  return { pairs: out.slice(0, limit), total: out.length };
}

function reasonsFor(a, b, signals) {
  const out = [];
  for (const s of signals) {
    if (s === 'same_email') out.push(`Same email (${a.email})`);
    if (s === 'same_phone') out.push(`Same phone number (${a.phone})`);
    if (s === 'similar_email') out.push('Same Gmail inbox written two ways (dots or a +tag)');
    if (s === 'similar_name') {
      const rel = nameRelation(a.c.name, b.c.name);
      out.push({ exact: 'Same name', initial: 'Name with an initial', nickname: 'Similar name (a nickname)' }[rel] || 'Similar name (one letter apart)');
    }
  }
  if ((signals.includes('same_email') || signals.includes('same_phone') || signals.includes('similar_email'))
      && firstNamesDiffer(a.c.name, b.c.name)) {
    out.push('Different first names: this may be family members sharing it');
  }
  return out;
}

// ── database side ─────────────────────────────────────────────────────
const pairKey = (x, y) => (String(x) < String(y) ? `${x}|${y}` : `${y}|${x}`);

async function loadForScan(workspaceId) {
  const { rows } = await sql`
    SELECT id, name, email, phone, user_id, created_at, stage
      FROM clients
     WHERE workspace_id = ${workspaceId} AND COALESCE(source, '') <> 'demo'
     ORDER BY created_at ASC, id ASC
     LIMIT ${DUPLICATE_SCAN_LIMIT}`;
  return rows;
}

async function loadDismissed(workspaceId) {
  const { rows } = await sql`
    SELECT client_a_id, client_b_id FROM client_duplicate_dismissals WHERE workspace_id = ${workspaceId}`;
  return new Set(rows.map((r) => pairKey(r.client_a_id, r.client_b_id)));
}

// Counts for the side-by-side comparison and the merge card, for a few
// clients of ONE workspace. Missing ids are simply absent from the map.
export async function clientRecordCounts(workspaceId, ids) {
  const list = [...new Set((ids || []).map((x) => String(x).toLowerCase()))]
    .filter((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x)).slice(0, 1000);
  if (!list.length) return {};
  const { rows } = await sql`
    SELECT c.id, c.name, c.email, c.phone, c.stage, c.created_at, c.user_id, c.notes, c.tags,
           c.payment_method_brand, c.payment_method_last4,
           (SELECT COUNT(*)::int FROM bookings b WHERE b.workspace_id = c.workspace_id AND b.client_id = c.id) AS bookings,
           (SELECT MAX(b.date) FROM bookings b WHERE b.workspace_id = c.workspace_id AND b.client_id = c.id
               AND b.cancelled_at IS NULL) AS last_booking,
           (SELECT COUNT(*)::int FROM invoices i WHERE i.workspace_id = c.workspace_id AND i.client_id = c.id) AS invoices,
           (SELECT COUNT(*)::int FROM messages m JOIN message_threads t ON t.id = m.thread_id
              WHERE t.workspace_id = c.workspace_id AND t.client_id = c.id) AS messages,
           (SELECT COUNT(*)::int FROM documents d WHERE d.workspace_id = c.workspace_id AND d.recipient_client_id = c.id) AS documents,
           (SELECT COUNT(*)::int FROM client_packages p WHERE p.client_id = c.id) AS packages,
           (SELECT COUNT(*)::int FROM autopay_agreements a WHERE a.workspace_id = c.workspace_id AND a.client_id = c.id AND a.status = 'active') AS autopay_active
      FROM clients c
     WHERE c.workspace_id = ${workspaceId} AND c.id = ANY(${list}::uuid[])`;
  const out = {};
  for (const r of rows) {
    const notes = String(r.notes || '').trim();
    out[r.id] = {
      id: r.id,
      name: r.name,
      email: r.email || null,
      phone: r.phone || null,
      stage: r.stage,
      createdAt: r.created_at,
      lastBooking: r.last_booking ? (r.last_booking instanceof Date ? r.last_booking.toISOString().slice(0, 10) : String(r.last_booking).slice(0, 10)) : null,
      portalClaimed: !!r.user_id,
      card: r.payment_method_last4 ? `${r.payment_method_brand || 'Card'} ending ${r.payment_method_last4}` : null,
      autopayActive: Number(r.autopay_active) > 0,
      tags: Array.isArray(r.tags) ? r.tags : [],
      counts: {
        bookings: Number(r.bookings) || 0,
        invoices: Number(r.invoices) || 0,
        messages: Number(r.messages) || 0,
        documents: Number(r.documents) || 0,
        packages: Number(r.packages) || 0,
        notes: notes ? notes.split(/\n+/).filter((l) => l.trim()).length : 0,
      },
    };
  }
  return out;
}

// Which record to keep by default: the one with a claimed portal account,
// otherwise the older one.
export function suggestedKeep(a, b) {
  if (!!a.user_id !== !!b.user_id) return a.user_id ? a.id : b.id;
  const ta = new Date(a.created_at || 0).getTime();
  const tb = new Date(b.created_at || 0).getTime();
  if (ta !== tb) return ta < tb ? a.id : b.id;
  return String(a.id) < String(b.id) ? a.id : b.id;
}

// The owner-facing list. { pairs: [{ key, confidence, label, reasons,
// keepId, a: summary, b: summary }], total }. withCounts adds the
// side-by-side record counts (one query for every client shown).
export async function listDuplicatePairs(workspaceId, { limit = DUPLICATE_PAIR_LIMIT, withCounts = true, onlyIds = null } = {}) {
  const [clients, dismissed] = await Promise.all([loadForScan(workspaceId), loadDismissed(workspaceId)]);
  const only = onlyIds ? new Set(onlyIds.map(String)) : null;
  const { pairs, total } = findDuplicatePairs(clients, { dismissed, limit, onlyIds: only });
  let counts = {};
  if (withCounts && pairs.length) {
    counts = await clientRecordCounts(workspaceId, pairs.flatMap((p) => [p.a.id, p.b.id]));
  }
  const brief = (c) => counts[c.id] || {
    id: c.id, name: c.name, email: c.email || null, phone: c.phone || null, stage: c.stage,
    createdAt: c.created_at, portalClaimed: !!c.user_id,
  };
  return {
    total,
    pairs: pairs.map((p) => ({
      key: p.key,
      confidence: p.confidence,
      label: p.label,
      reasons: p.reasons,
      keepId: suggestedKeep(p.a, p.b),
      a: brief(p.a),
      b: brief(p.b),
    })),
  };
}

// How many open pairs involve at least one of `ids` (the clients an import
// just added). Cheap: no counts.
export async function countDuplicatesInvolving(workspaceId, ids) {
  const list = (ids || []).map(String).filter(Boolean);
  if (!list.length) return 0;
  const { total } = await listDuplicatePairs(workspaceId, { limit: 0, withCounts: false, onlyIds: list });
  return total;
}

// "Not the same person": stored so the pair never comes back. Both clients
// must belong to this workspace. Idempotent.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function dismissDuplicatePair(workspaceId, idA, idB, userId = null) {
  const a = String(idA || '').trim().toLowerCase(); const b = String(idB || '').trim().toLowerCase();
  if (!UUID_RE.test(a) || !UUID_RE.test(b) || a === b) return { ok: false, error: 'Pick two different clients.' };
  const { rows } = await sql`
    SELECT id FROM clients WHERE workspace_id = ${workspaceId} AND id = ANY(${[a, b]}::uuid[])`;
  if (rows.length !== 2) return { ok: false, error: 'Client not found.' };
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await sql`
    INSERT INTO client_duplicate_dismissals (workspace_id, client_a_id, client_b_id, dismissed_by)
    VALUES (${workspaceId}, ${lo}, ${hi}, ${userId})
    ON CONFLICT DO NOTHING`;
  return { ok: true };
}
