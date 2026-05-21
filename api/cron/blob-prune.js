// Nightly orphan-blob cleanup. The app uploads to Vercel Blob via
// upload-token endpoints (clients/documents/messages/bookings), and
// the resulting pathname gets stored on a parent row in Postgres. When
// the parent row is deleted (a client → DELETE FROM clients, or a
// signer attachment removed in the document editor), the blob is
// orphaned in Blob storage and accumulates indefinitely. At scale
// this is real money — Vercel Blob bills on stored bytes.
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
    // Build cautiously — if any source query fails, we ABORT the
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

// Walk every table/column that stores blob pathnames. Returns a Set
// of pathname strings, OR null if any required source query failed
// (caller short-circuits to avoid deletions in that case).
async function collectReferencedPathnames() {
  const refs = new Set();
  const add = (p) => { if (p && typeof p === 'string') refs.add(p); };

  try {
    // Scalar columns first — single SELECT each.
    const docs = await sql`
      SELECT pdf_blob_pathname, final_pdf_blob_pathname FROM documents
    `;
    for (const r of docs.rows) {
      add(r.pdf_blob_pathname);
      add(r.final_pdf_blob_pathname);
    }

    const branding = await sql`
      SELECT brand_logo_blob_pathname FROM calendar_settings
    `;
    for (const r of branding.rows) add(r.brand_logo_blob_pathname);

    // JSONB attachments — pull just the column and walk in JS.
    // (jsonb_array_elements + jsonb_path_query could do this in SQL
    // but the JS walk is simpler + the data is small per row.)
    const clientAtt = await sql`SELECT attachments, gallery_photos FROM clients`;
    for (const r of clientAtt.rows) {
      for (const a of (r.attachments || [])) add(a?.blobPathname);
      for (const p of (r.gallery_photos || [])) add(p?.blobPathname);
    }

    const msgAtt = await sql`SELECT attachments FROM messages WHERE attachments <> '[]'::jsonb`;
    for (const r of msgAtt.rows) {
      for (const a of (r.attachments || [])) add(a?.blobPathname);
    }

    // bookings.completion_log is a JSONB OBJECT keyed by date, where
    // each value has .attachments[]. Walk the object.
    const bookAtt = await sql`SELECT completion_log FROM bookings WHERE completion_log <> '{}'::jsonb`;
    for (const r of bookAtt.rows) {
      const log = r.completion_log || {};
      for (const date of Object.keys(log)) {
        for (const a of (log[date]?.attachments || [])) add(a?.blobPathname);
      }
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
