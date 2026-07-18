// Nightly orphan-blob cleanup. The app uploads to Vercel Blob via
// upload-token endpoints (clients/documents/messages/bookings), and
// the resulting pathname gets stored on a parent row in Postgres. When
// the parent row is deleted (a client → DELETE FROM clients, or a
// signer attachment removed in the document editor), the blob is
// orphaned in Blob storage and accumulates indefinitely. At scale
// this is real money - Vercel Blob bills on stored bytes.
//
// Strategy:
//   1. Walk every table that stores blob references; build an
//      in-memory Set of all referenced pathnames.
//   2. List blobs from Vercel Blob older than ORPHAN_GRACE_HOURS.
//      The grace period protects in-flight uploads where the row
//      write hasn't landed yet.
//   3. Delete blobs whose pathname is NOT in the referenced set.
//      Cap per-run so a fresh deploy doesn't try to delete 50K
//      blobs in one cron tick.
//
// Conservative: prefers leaving an orphan another day vs. deleting
// something a user references. Anything we can't classify (set
// build failed, list call failed) → skip, log, succeed.
import { list, del } from '@vercel/blob';
import { sql } from '../_lib/db.js';
import { reportError } from '../_lib/monitoring.js';
import { methodNotAllowed, ok, serverError, unauthorized } from '../_lib/json.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { trackCron } from '../_lib/cronMetrics.js';

const ORPHAN_GRACE_HOURS = 24;     // skip blobs uploaded in the last day
const MAX_DELETES_PER_RUN = 1000;  // cap per-tick work
const MAX_LIST_PAGES = 50;         // cap total blob walk
const COLLECT_BATCH = 2000;        // rows per keyset page when building the ref set
// Safety ceiling on ref-collection pages per source. If a source can't be
// fully drained within this many pages we ABORT the prune (return null)
// rather than diff against a partial reference set and risk deleting a
// referenced blob. 5000 * 2000 = 10M rows/source headroom.
const MAX_COLLECT_PAGES = 5000;

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  // Auth: Vercel Cron (Bearer CRON_SECRET), admin secret, or super-admin
  // session. Deletes Blob objects + DB rows, so never run unauthenticated.
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return ok(res, { ok: true, skipped: true, reason: 'no BLOB_READ_WRITE_TOKEN' });
  }
  try {
    const t0 = Date.now();

    // Step 1: collect every blob pathname referenced anywhere.
    // Build cautiously - if any source query fails, we ABORT the
    // cron rather than risk deleting referenced files.
    const refs = await collectReferencedPathnames();
    if (refs === null) {
      return ok(res, {
        ok: false, reason: 'reference-collection-failed',
        durationMs: Date.now() - t0,
      });
    }

    // Step 2 + 3: paginate Blob storage, delete orphans.
    const cutoff = new Date(Date.now() - ORPHAN_GRACE_HOURS * 3600 * 1000);
    let cursor = undefined;
    let scanned = 0;
    let deleted = 0;
    let skippedRecent = 0;
    let skippedReferenced = 0;
    const orphansToDelete = [];

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const out = await list({ cursor, limit: 1000 });
      cursor = out.cursor;
      for (const b of out.blobs || []) {
        scanned++;
        if (b.uploadedAt && new Date(b.uploadedAt) > cutoff) { skippedRecent++; continue; }
        if (refs.has(b.pathname)) { skippedReferenced++; continue; }
        orphansToDelete.push(b.pathname);
        if (orphansToDelete.length >= MAX_DELETES_PER_RUN) break;
      }
      if (orphansToDelete.length >= MAX_DELETES_PER_RUN || !cursor) break;
    }

    // Batch the deletes. @vercel/blob's del() accepts an array.
    if (orphansToDelete.length > 0) {
      try {
        await del(orphansToDelete);
        deleted = orphansToDelete.length;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[blob-prune] del() failed:', err.message);
        try { reportError(err); } catch { /* ignore */ }
      }
    }

    return ok(res, {
      ok: true,
      scanned, deleted, skippedRecent, skippedReferenced,
      refsCollected: refs.size,
      durationMs: Date.now() - t0,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

// Keyset-paginate a single ref source. queryFn(cursor) returns one page
// ordered by `cursorField` (id/workspace_id); onRow extracts pathnames.
// Returns true if the source fully drained, false if it hit the page cap
// (an incomplete walk - caller must abort rather than risk false deletes).
async function drainSource(queryFn, cursorField, onRow) {
  let cursor = null;
  for (let page = 0; page < MAX_COLLECT_PAGES; page++) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await queryFn(cursor);
    if (rows.length === 0) return true;
    for (const r of rows) onRow(r);
    cursor = rows[rows.length - 1][cursorField];
    if (rows.length < COLLECT_BATCH) return true;
  }
  return false; // page cap hit - did NOT finish draining this source
}

// Walk every table/column that stores blob pathnames. Returns a Set
// of pathname strings, OR null if any source query failed OR couldn't be
// fully drained (caller short-circuits to avoid deletions in that case).
//
// Each source is keyset-paginated so we never load an entire table (or its
// JSONB columns) into memory at once - peak memory is one COLLECT_BATCH
// page. The accumulated Set holds only pathname strings (the real working
// set), not full rows.
export async function collectReferencedPathnames() {
  const refs = new Set();
  const add = (p) => { if (p && typeof p === 'string') refs.add(p); };
  // Several columns store the full public blob URL rather than a pathname
  // (services.photo_url, clients.photo_url, calendar_settings.brand_logo_url,
  // websites.* content). Register both the encoded and decoded pathname
  // forms - extra refs are harmless (they only prevent deletions), a
  // missing ref deletes a paying customer's live image.
  const addUrl = (u) => {
    if (!u || typeof u !== 'string' || !/^https?:\/\//.test(u)) return;
    try {
      const p = new URL(u).pathname.replace(/^\//, '');
      add(p);
      add(decodeURIComponent(p));
    } catch { /* not a URL - ignore */ }
  };
  // Pull every blob-storage URL out of a JSON/text blob (website sections,
  // published pages, etc.) without caring about its exact shape.
  const addUrlsFromText = (text) => {
    if (!text || typeof text !== 'string') return;
    const m = text.match(/https?:\/\/[^"'\\\s)]+blob\.vercel-storage\.com\/[^"'\\\s)]+/g) || [];
    for (const u of m) addUrl(u);
  };

  try {
    const drained = [];

    // services + clients - single photo URL columns (Vercel Blob uploads).
    drained.push(await drainSource(
      (cur) => sql.query(
        `SELECT id, photo_url FROM services
          WHERE photo_url IS NOT NULL
            ${cur ? 'AND id > $1' : ''}
          ORDER BY id LIMIT ${COLLECT_BATCH}`,
        cur ? [cur] : [],
      ),
      'id',
      (r) => addUrl(r.photo_url),
    ));
    drained.push(await drainSource(
      (cur) => sql.query(
        `SELECT id, photo_url FROM clients
          WHERE photo_url IS NOT NULL
            ${cur ? 'AND id > $1' : ''}
          ORDER BY id LIMIT ${COLLECT_BATCH}`,
        cur ? [cur] : [],
      ),
      'id',
      (r) => addUrl(r.photo_url),
    ));

    // calendar_settings.brand_logo_url - URL twin of the pathname column.
    drained.push(await drainSource(
      (cur) => sql.query(
        `SELECT workspace_id, brand_logo_url FROM calendar_settings
          WHERE brand_logo_url IS NOT NULL
            ${cur ? 'AND workspace_id > $1' : ''}
          ORDER BY workspace_id LIMIT ${COLLECT_BATCH}`,
        cur ? [cur] : [],
      ),
      'workspace_id',
      (r) => addUrl(r.brand_logo_url),
    ));

    // websites - hero/gallery/section images, OG image, favicon live as raw
    // URLs inside JSONB (draft AND published copies). Shape-agnostic scan.
    drained.push(await drainSource(
      (cur) => sql.query(
        `SELECT id, sections::text AS s, pages::text AS p,
                published_sections::text AS ps, published_pages::text AS pp,
                seo_og_image, favicon_url
           FROM websites
          ${cur ? 'WHERE id > $1' : ''}
          ORDER BY id LIMIT ${COLLECT_BATCH}`,
        cur ? [cur] : [],
      ),
      'id',
      (r) => {
        addUrlsFromText(r.s); addUrlsFromText(r.p);
        addUrlsFromText(r.ps); addUrlsFromText(r.pp);
        addUrl(r.seo_og_image); addUrl(r.favicon_url);
      },
    ));

    // documents - scalar pathname columns.
    drained.push(await drainSource(
      (cur) => sql.query(
        `SELECT id, pdf_blob_pathname, final_pdf_blob_pathname FROM documents
          WHERE (pdf_blob_pathname IS NOT NULL OR final_pdf_blob_pathname IS NOT NULL)
            ${cur ? 'AND id > $1' : ''}
          ORDER BY id LIMIT ${COLLECT_BATCH}`,
        cur ? [cur] : [],
      ),
      'id',
      (r) => { add(r.pdf_blob_pathname); add(r.final_pdf_blob_pathname); },
    ));

    // calendar_settings - brand logo (keyed by workspace_id).
    drained.push(await drainSource(
      (cur) => sql.query(
        `SELECT workspace_id, brand_logo_blob_pathname FROM calendar_settings
          WHERE brand_logo_blob_pathname IS NOT NULL
            ${cur ? 'AND workspace_id > $1' : ''}
          ORDER BY workspace_id LIMIT ${COLLECT_BATCH}`,
        cur ? [cur] : [],
      ),
      'workspace_id',
      (r) => add(r.brand_logo_blob_pathname),
    ));

    // clients - JSONB attachments[] + gallery_photos[].
    drained.push(await drainSource(
      (cur) => sql.query(
        `SELECT id, attachments, gallery_photos FROM clients
          WHERE ((attachments IS NOT NULL AND attachments <> '[]'::jsonb)
              OR (gallery_photos IS NOT NULL AND gallery_photos <> '[]'::jsonb))
            ${cur ? 'AND id > $1' : ''}
          ORDER BY id LIMIT ${COLLECT_BATCH}`,
        cur ? [cur] : [],
      ),
      'id',
      (r) => {
        for (const a of (r.attachments || [])) add(a?.blobPathname);
        for (const p of (r.gallery_photos || [])) add(p?.blobPathname);
      },
    ));

    // messages - JSONB attachments[].
    drained.push(await drainSource(
      (cur) => sql.query(
        `SELECT id, attachments FROM messages
          WHERE attachments <> '[]'::jsonb
            ${cur ? 'AND id > $1' : ''}
          ORDER BY id LIMIT ${COLLECT_BATCH}`,
        cur ? [cur] : [],
      ),
      'id',
      (r) => { for (const a of (r.attachments || [])) add(a?.blobPathname); },
    ));

    // bookings.completion_log - JSONB OBJECT keyed by date, each value has
    // .attachments[].
    drained.push(await drainSource(
      (cur) => sql.query(
        `SELECT id, completion_log FROM bookings
          WHERE completion_log <> '{}'::jsonb
            ${cur ? 'AND id > $1' : ''}
          ORDER BY id LIMIT ${COLLECT_BATCH}`,
        cur ? [cur] : [],
      ),
      'id',
      (r) => {
        const log = r.completion_log || {};
        for (const date of Object.keys(log)) {
          for (const a of (log[date]?.attachments || [])) add(a?.blobPathname);
        }
      },
    ));

    if (drained.some((d) => d === false)) {
      // eslint-disable-next-line no-console
      console.error('[blob-prune] a ref source exceeded MAX_COLLECT_PAGES - aborting to avoid false deletes');
      return null;
    }

    return refs;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[blob-prune] reference collection failed:', err.message);
    try { reportError(err); } catch { /* ignore */ }
    return null;
  }
}

export default trackCron('blob-prune', handler);
