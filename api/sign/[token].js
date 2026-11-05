// /api/sign/:token  (public, no auth)
//
//   GET    → fetch the document the recipient was emailed (only when their
//            signer row is awaiting / viewed, or the legacy single-signer
//            doc is in 'sent' state)
//   POST   → submit completed field values.
//            Body: { fields: [{ id, value }, ...], consent: true }
//   DELETE → decline. Body: { reason? }
//
// Multi-signer flow (preferred): looks up document_signers by token hash.
// On a successful sign, mints + emails the NEXT signer's token. When the
// last signer completes, the document is marked 'completed' and a
// SHA-256 tamper-evident hash is computed over the body + ordered
// signer submissions.
//
// Single-signer flow (legacy): falls back to documents.sign_token_hash
// only for documents that have NO document_signers rows (sent before the
// multi-signer flow existed). Multi-signer documents mirror the current
// token onto documents.sign_token_hash for list views, so allowing the
// fallback for them would let a replaced link (after a resend or a portal
// link) sign the whole document outside the signer chain.
//
// Tokens are sha256-hashed before lookup. We never persist or accept
// the raw token for any other purpose. Tokens are invalidated on
// completion / decline / void, and expire (document_signers
// .token_expires_at, stamped by a DB trigger whenever a link is minted).
//
// Signing is server-authoritative (api/_lib/documents.applySignerValues):
// a signer can only fill their own fields, Date signed is set here,
// required fields and dropdown choices are enforced here.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import {
  serializeDocPublic, applySignerValues, formatSignedDate, MAX_FIELDS,
} from '../_lib/documents.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmailToClient, sendEmailToUser, emailShell, redactEmail } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { notifyOwnerSafe, notifyClientSafe } from '../_lib/push.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { stampCompletedPdf, renderWrittenPdf, uploadStampedPdf } from '../_lib/pdfStamp.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import crypto from 'node:crypto';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export default async function handler(req, res) {
  // Public endpoint (no requireUser) - bootstrap schema explicitly so
  // a cold-started function instance doesn't 500 on missing tables.
  try { await ensureSchemaApplied(); } catch { /* tolerate */ }
  // Signing pages carry the token in the URL: never let it leak onward.
  try { res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store'); } catch { /* mock res */ }
  if (req.method === 'GET')    return getDoc(req, res);
  if (req.method === 'POST')   return signDoc(req, res);
  if (req.method === 'DELETE') return declineDoc(req, res);
  return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
}

const EXPIRED_MESSAGE = 'This signing link has expired. Ask the sender to send you a new one.';

// ───────────────────────────────────────────────────────────────────────
// Lookup: first try document_signers (multi-signer), then fall back to
// the legacy single-signer column. Returns null if no match, or
// { expired: true } for a link past its expiry. The resolved object
// always exposes:
//   { doc, signer (multi only), signerIndex, totalSigners, isMulti, tokenHash }
// so the rest of the file can branch on `isMulti` once.
// ───────────────────────────────────────────────────────────────────────
async function resolveByToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 16 || rawToken.length > 200) return null;
  const tokenHash = hashToken(rawToken);

  // Multi-signer first.
  const ms = await sql`
    SELECT s.*, d.id AS doc_id, d.workspace_id, d.name AS doc_name, d.status AS doc_status,
           d.content_html, d.fields, d.activity, d.recipient_client_id,
           d.recipient_name, d.recipient_email, d.created_at AS doc_created_at,
           d.kind, d.file_url, d.page_count, d.final_pdf_url, d.completed_at,
           (s.token_expires_at IS NOT NULL AND s.token_expires_at < NOW()) AS link_expired
      FROM document_signers s
      JOIN documents d ON d.id = s.document_id
     WHERE s.sign_token_hash = ${tokenHash}
     LIMIT 1
  `;
  if (ms.rows.length > 0) {
    const row = ms.rows[0];
    if (row.doc_status !== 'sent') return null;
    if (!['awaiting', 'viewed'].includes(row.status)) return null;
    if (row.link_expired) return { expired: true };
    const total = await sql`SELECT COUNT(*)::int AS n FROM document_signers WHERE document_id = ${row.doc_id}`;
    return {
      isMulti: true,
      tokenHash,
      doc: {
        id: row.doc_id, workspace_id: row.workspace_id, name: row.doc_name,
        status: row.doc_status, content_html: row.content_html,
        fields: row.fields, activity: row.activity,
        recipient_client_id: row.recipient_client_id,
        recipient_name: row.recipient_name, recipient_email: row.recipient_email,
        kind: row.kind, file_url: row.file_url, page_count: row.page_count,
        final_pdf_url: row.final_pdf_url, completed_at: row.completed_at,
      },
      signer: {
        id: row.id, document_id: row.document_id, order_index: row.order_index,
        client_id: row.client_id, name: row.name, email: row.email,
        status: row.status, field_values: row.field_values,
        is_owner: !!row.is_owner, token_expires_at: row.token_expires_at,
      },
      signerIndex: row.order_index,
      totalSigners: total.rows[0]?.n || 1,
    };
  }

  // Legacy single-signer fallback: only documents with no signer rows.
  const single = await sql`
    SELECT * FROM documents d
     WHERE d.sign_token_hash = ${tokenHash}
       AND d.status = 'sent'
       AND NOT EXISTS (SELECT 1 FROM document_signers ds WHERE ds.document_id = d.id)
     LIMIT 1
  `;
  if (single.rows.length === 0) return null;
  return {
    isMulti: false,
    tokenHash,
    doc: single.rows[0],
    signer: null,
    signerIndex: 0,
    totalSigners: 1,
  };
}

async function workspaceTimezone(workspaceId) {
  try {
    const { rows } = await sql`SELECT timezone FROM calendar_settings WHERE workspace_id = ${workspaceId} LIMIT 1`;
    return rows[0]?.timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ───────────────────────────────────────────────────────────────────────
// GET - fetch the doc + position info, mark 'viewed'.
// ───────────────────────────────────────────────────────────────────────
async function getDoc(req, res) {
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `sign-get:ip:${ip}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const token = (req.query.token || '').toString();
    const r = await resolveByToken(token);
    if (r?.expired) return res.status(410).json({ error: EXPIRED_MESSAGE, expired: true });
    if (!r) return notFound(res, 'This signing link is invalid, has expired, or the document was already signed.');
    const { doc, signer, signerIndex, totalSigners, isMulti } = r;

    // First open by this signer: record it, and tell the owner (unless
    // the owner is the one opening their own countersign link).
    if (isMulti && signer.status === 'awaiting') {
      const marked = await sql`
        UPDATE document_signers
           SET status = 'viewed', updated_at = NOW(),
               viewed_at = COALESCE(viewed_at, NOW()),
               ip = COALESCE(ip, ${ip}),
               user_agent = COALESCE(user_agent, ${(req.headers['user-agent'] || '').toString().slice(0, 500)})
         WHERE id = ${signer.id} AND status = 'awaiting'
         RETURNING id
      `;
      if (marked.rows.length > 0) {
        await appendActivity(doc.id, {
          kind: 'viewed',
          text: `${signer.name} (signer ${signerIndex + 1} of ${totalSigners}) opened the document`,
          ip,
        });
        if (!signer.is_owner) {
          notifyOwnerSafe({
            workspaceId: doc.workspace_id,
            type: 'documents',
            payload: {
              title: 'Document opened',
              body: `${signer.name} opened "${doc.name}"`,
              url: `/documents?doc=${encodeURIComponent(doc.id)}`,
              tag: `doc-viewed-${doc.id}`,
            },
          });
        }
      }
    } else if (!isMulti) {
      const last = (doc.activity || [])[(doc.activity || []).length - 1];
      const todayish = last && last.kind === 'viewed' &&
        (Date.now() - new Date(last.ts).getTime()) < 24 * 60 * 60 * 1000;
      if (!todayish) {
        await appendActivity(doc.id, {
          kind: 'viewed',
          text: `${doc.recipient_name || 'Recipient'} opened the document`,
          ip,
        });
      }
    }

    const [branding, tz] = await Promise.all([
      fetchBranding(doc.workspace_id).catch(() => ({})),
      workspaceTimezone(doc.workspace_id),
    ]);
    return ok(res, {
      document: serializeDocPublic(doc),
      signer: isMulti ? {
        position: signerIndex + 1,
        total: totalSigners,
        name: signer.name,
        email: signer.email,
        isOwner: signer.is_owner,
        linkExpiresAt: signer.token_expires_at || null,
      } : null,
      businessName: branding.businessName || null,
      // What a Date signed field will say if they sign now.
      signedDate: formatSignedDate(new Date(), tz),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

// Old iPhone app builds render this page from their own bundled code,
// which has no consent checkbox and never sends `consent`. Only for them
// is a missing consent accepted (and recorded as not captured); every
// current client must send consent: true.
function isLegacyNativeClient(req, body) {
  const platform = String(req.headers?.['x-client-platform'] || '').toLowerCase();
  return body.consent === undefined && (platform === 'ios' || platform === 'android');
}

// ───────────────────────────────────────────────────────────────────────
// POST - submit the signed values. Multi-signer: marks this signer
// complete, mints + emails the next, or completes the doc.
// ───────────────────────────────────────────────────────────────────────
async function signDoc(req, res) {
  try {
    const ip = getClientIp(req);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);
    const blocked = await enforce(req, res, [
      { key: `sign-post:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const token = (req.query.token || '').toString();
    const r = await resolveByToken(token);
    if (r?.expired) return res.status(410).json({ error: EXPIRED_MESSAGE, expired: true });
    if (!r) return notFound(res, 'This signing link is invalid or has expired.');
    const { doc, signer, signerIndex, totalSigners, isMulti, tokenHash } = r;

    const body = await readBody(req);
    if (!Array.isArray(body.fields ?? []) || (body.fields || []).length > MAX_FIELDS) {
      return badRequest(res, 'Invalid fields payload');
    }
    if (body.consent !== true && !isLegacyNativeClient(req, body)) {
      return badRequest(res, 'Please tick the box to agree to sign electronically.');
    }
    const consented = body.consent === true;

    const tz = await workspaceTimezone(doc.workspace_id);
    const signedDate = formatSignedDate(new Date(), tz);
    const myIdx = isMulti ? signerIndex : 0;
    // Merge: only THIS signer's fields take submitted values; required
    // checks, Date signed and Email are decided here, not in the browser.
    const applied = applySignerValues({
      stored: doc.fields || [],
      submitted: body.fields || [],
      myIdx,
      signer: { email: isMulti ? signer.email : doc.recipient_email, name: isMulti ? signer.name : doc.recipient_name },
      signedDate,
    });
    if (applied.error) return badRequest(res, applied.error);
    const merged = applied.merged;
    // A multi-signer must own at least one field — otherwise a recipient with
    // no assigned fields would be recorded as "signed" with no signature at
    // all. The sender should assign them a signature field instead.
    if (isMulti && !merged.some((f) => (Number.isInteger(f.signerIndex) ? f.signerIndex : 0) === myIdx)) {
      return badRequest(res, 'No fields are assigned to you to sign on this document. Please contact the sender.');
    }

    if (isMulti) {
      // Stamp this signer complete. Guarded on the token + status so two
      // submissions racing each other (double tap, two tabs) record once.
      const done = await sql`
        UPDATE document_signers SET
          field_values    = ${JSON.stringify(merged)}::jsonb,
          status          = 'completed',
          signed_at       = NOW(),
          consent_at      = ${consented ? new Date().toISOString() : null},
          viewed_at       = COALESCE(viewed_at, NOW()),
          sign_token_hash = NULL,
          ip              = ${ip},
          user_agent      = ${ua},
          updated_at      = NOW()
        WHERE id = ${signer.id}
          AND sign_token_hash = ${tokenHash}
          AND status IN ('awaiting', 'viewed')
        RETURNING id
      `;
      if (done.rows.length === 0) return badRequest(res, 'This document was already signed from this link.');
      // Persist the running merged values onto documents.fields so the
      // NEXT signer's resolveByToken sees prior signers' contributions.
      await sql`
        UPDATE documents SET
          fields = ${JSON.stringify(merged)}::jsonb,
          updated_at = NOW()
        WHERE id = ${doc.id}
      `;
      await appendActivity(doc.id, {
        kind: 'signer-completed',
        text: `${signer.name} (signer ${signerIndex + 1} of ${totalSigners}) signed${consented ? ' after agreeing to sign electronically' : ''}`,
        ip, signerId: signer.id,
      });

      // Anyone left? If yes, mint + email the next signer's token.
      const next = await sql`
        SELECT * FROM document_signers
         WHERE document_id = ${doc.id}
           AND status IN ('pending', 'awaiting', 'viewed')
         ORDER BY order_index ASC
         LIMIT 1
      `;
      if (next.rows.length > 0) {
        const n = next.rows[0];
        const nextRaw  = generateRawToken(32);
        const nextHash = hashToken(nextRaw);
        await sql`
          UPDATE document_signers
             SET sign_token_hash = ${nextHash},
                 status          = 'awaiting',
                 updated_at      = NOW()
           WHERE id = ${n.id}
        `;
        // Update legacy fields on documents to reflect "now waiting on X"
        // so the owner-side list view shows progress.
        await sql`
          UPDATE documents SET
            recipient_client_id = ${n.client_id},
            recipient_name      = ${n.name},
            recipient_email     = ${n.email},
            sign_token_hash     = ${nextHash},
            updated_at          = NOW()
          WHERE id = ${doc.id}
        `;
        try {
          const branding = await fetchBranding(doc.workspace_id);
          await sendEmailToClient({
            clientId: n.client_id || null, workspaceId: doc.workspace_id,
            type: 'documents',
            to: n.email,
            subject: `Action needed: sign "${doc.name}"`,
            replyTo: branding.replyTo,
            html: emailShell({
              heading: 'A document needs your signature',
              body: `<p>Hi ${escapeHtml(n.name)},</p>
                     <p>You're up next on <b>${escapeHtml(doc.name)}</b> - signer ${n.order_index + 1} of ${totalSigners}.</p>`,
              ctaText: 'Open and sign',
              ctaUrl: `${appUrl()}/sign/${encodeURIComponent(nextRaw)}`,
              footer: `If you weren't expecting this, you can safely ignore this email.`,
              branding,
            }),
          });
        } catch (mailErr) {
          // eslint-disable-next-line no-console
          console.error('[sign] next-signer email failed:', mailErr.message);
        }
        if (n.client_id) {
          notifyClientSafe({
            clientId: n.client_id,
            type: 'documents',
            payload: {
              title: 'Document needs your signature',
              body: doc.name,
              url: `/me/documents`,
              tag: `doc-${doc.id}`,
              requireInteraction: true,
            },
          });
        }
        // Tell the owner a client just signed (and whether it's now their
        // turn to countersign).
        if (!signer.is_owner) {
          notifyOwnerSafe({
            workspaceId: doc.workspace_id,
            type: 'documents',
            payload: {
              title: n.is_owner ? 'Your turn to sign' : 'Document signed',
              body: n.is_owner
                ? `${signer.name} signed "${doc.name}". Open it to add your signature.`
                : `${signer.name} signed "${doc.name}". Waiting on ${n.name}.`,
              url: `/documents?doc=${encodeURIComponent(doc.id)}`,
              tag: `doc-progress-${doc.id}`,
            },
          });
        }
        return ok(res, { document: serializeDocPublic(doc), nextSigner: { name: n.name } });
      }

      // Last signer completed → finalize document with tamper-evident hash
      // and (if it's a PDF) stamp the flattened final artifact.
      const finalDoc = await finalizeCompletedDoc(doc.id);
      if (!finalDoc) {
        return badRequest(res, 'This document is no longer available to sign.');
      }
      const pdfBytes = await maybeStampFinalPdf(finalDoc);
      const attachments = attachmentFor(finalDoc, pdfBytes);
      await notifyOwnerOnCompletion(finalDoc, attachments);
      // Tell every signer who participated that the doc is fully
      // executed - important for long-running multi-signer flows
      // where signer 1 might have signed days before signer N
      // finally completes. Sends both a push (immediate) and an
      // email (durable record + link to their copy).
      try {
        // Exclude declined signers - they walked away. Including them
        // sends a "fully signed" email/push to someone who never agreed,
        // which is misleading and a small compliance risk.
        // The owner already got their own completion email above (with
        // the PDF), so an owner signer row is skipped here - otherwise
        // they'd get the same attachment twice.
        const { rows: allSigners } = await sql`
          SELECT client_id, name, email FROM document_signers
          WHERE document_id = ${doc.id}
            AND status <> 'declined'
            AND is_owner = FALSE
        `;
        const branding = await fetchBranding(doc.workspace_id);
        const portalLink = `${appUrl()}/me/documents`;
        // Parallelize the per-signer fanout: previously this was a
        // sequential `for/await` loop, so a 10-signer doc held the
        // response open for ~10s while Resend round-tripped each
        // email. Promise.allSettled means one bad address can't
        // crash the rest and the wall-clock cost is one Resend
        // round-trip total.
        await Promise.allSettled(allSigners.map(async (s) => {
          if (s.client_id) {
            notifyClientSafe({
              clientId: s.client_id,
              type: 'documents',
              payload: {
                title: 'Document fully signed',
                body: `"${doc.name}" is complete. You can view your copy any time.`,
                url: '/me/documents',
                tag: `doc-completed-${doc.id}`,
              },
            });
          }
          if (s.email) {
            try {
              await sendEmailToClient({
                clientId: s.client_id || null, workspaceId: doc.workspace_id,
                type: 'documents',
                to: s.email,
                subject: `Signed: "${doc.name}" is complete`,
                replyTo: branding.replyTo,
                attachments,
                html: emailShell({
                  heading: 'Document fully signed',
                  body: `<p>Hi ${escapeHtml(s.name || 'there')},</p>
                    <p><strong>${escapeHtml(doc.name)}</strong> is now complete - every signer is in.</p>
                    ${attachments.length
                      ? '<p>Your signed copy is attached to this email as a PDF. Keep it for your records.</p>'
                      : '<p>You can view a copy of the signed document any time from your portal.</p>'}`,
                  ctaText: 'View signed copy',
                  ctaUrl: portalLink,
                  footer: 'Keep this email for your records.',
                  branding,
                }),
              });
            } catch (mailErr) {
              console.error('[sign] completion email failed for', redactEmail(s.email), '::', mailErr.message);
            }
          }
        }));
      } catch (notifyErr) {
        console.error('[sign] per-signer completion notify failed:', notifyErr.message);
      }
      return ok(res, { document: serializeDocPublic(finalDoc), completed: true });
    }

    // ── Legacy single-signer path ──
    const newActivity = [
      ...(doc.activity || []),
      {
        ts: new Date().toISOString(),
        kind: 'completed',
        text: `${doc.recipient_name || 'Recipient'} signed and completed the document${consented ? ' after agreeing to sign electronically' : ''}`,
        ip,
      },
    ];
    const updated = await sql`
      UPDATE documents SET
        fields          = ${JSON.stringify(merged)}::jsonb,
        status          = 'completed',
        completed_at    = NOW(),
        sign_token_hash = NULL,
        completion_hash = ${computeHash({
          contentHtml: hashBody(doc),
          signers: [{ name: doc.recipient_name, email: doc.recipient_email, fields: merged, signedAt: new Date().toISOString() }],
        })},
        activity        = ${JSON.stringify(newActivity)}::jsonb,
        updated_at      = NOW()
      WHERE id = ${doc.id} AND status = 'sent'
      RETURNING *
    `;
    // A void racing this in-flight signature wins - never overwrite
    // 'voided' (resolveByToken checked status at read time only).
    if (updated.rows.length === 0) {
      return badRequest(res, 'This document is no longer available to sign.');
    }
    const legacyBytes = await maybeStampFinalPdf(updated.rows[0]);
    const legacyAttachments = attachmentFor(updated.rows[0], legacyBytes);
    await notifyOwnerOnCompletion(updated.rows[0], legacyAttachments);
    // The signer gets their executed copy too - same as the multi-signer
    // path, otherwise a single-signer waiver leaves them with nothing.
    if (doc.recipient_email) {
      try {
        const branding = await fetchBranding(doc.workspace_id);
        await sendEmailToClient({
          clientId: doc.recipient_client_id || null, workspaceId: doc.workspace_id,
          type: 'documents',
          to: doc.recipient_email,
          subject: `Signed: "${doc.name}" is complete`,
          replyTo: branding.replyTo,
          attachments: legacyAttachments,
          html: emailShell({
            heading: 'Document fully signed',
            body: `<p>Hi ${escapeHtml(doc.recipient_name || 'there')},</p>
              <p><strong>${escapeHtml(doc.name)}</strong> is complete.</p>
              ${legacyAttachments.length
                ? '<p>Your signed copy is attached to this email as a PDF. Keep it for your records.</p>'
                : '<p>You can view a copy of the signed document any time from your portal.</p>'}`,
            ctaText: 'View signed copy',
            ctaUrl: `${appUrl()}/me/documents`,
            footer: 'Keep this email for your records.',
            branding,
          }),
        });
      } catch (mailErr) {
        console.error('[sign] completion email failed:', mailErr.message);
      }
    }
    // Re-read the doc after stamping so the response includes the
    // final_pdf_url, otherwise the sign-page success state can't link
    // the recipient back to a downloadable copy.
    const fresh = await sql`SELECT * FROM documents WHERE id = ${doc.id}`;
    return ok(res, { document: serializeDocPublic(fresh.rows[0] || updated.rows[0]), completed: true });
  } catch (err) {
    return serverError(res, err);
  }
}

// ───────────────────────────────────────────────────────────────────────
// DELETE - decline. Multi-signer: declining halts the entire document.
// ───────────────────────────────────────────────────────────────────────
async function declineDoc(req, res) {
  try {
    const ip = getClientIp(req);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);
    const blocked = await enforce(req, res, [
      { key: `sign-decline:ip:${ip}`, max: 5, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const token = (req.query.token || '').toString();
    const r = await resolveByToken(token);
    if (!r) return notFound(res, 'This signing link is invalid or has expired.');
    const { doc, signer, signerIndex, totalSigners, isMulti } = r;

    const body = await readBody(req);
    const reason = (body.reason || '').toString().trim().slice(0, 500) || null;
    const declinerName = isMulti ? signer.name : (doc.recipient_name || 'Recipient');

    if (isMulti) {
      await sql`
        UPDATE document_signers SET
          status          = 'declined',
          declined_at     = NOW(),
          decline_reason  = ${reason},
          sign_token_hash = NULL,
          ip              = ${ip},
          user_agent      = ${ua},
          updated_at      = NOW()
        WHERE id = ${signer.id}
      `;
      // Invalidate any other pending signer tokens - once one declines,
      // the document is dead and we don't want the next email link to
      // accidentally let someone sign anyway.
      await sql`
        UPDATE document_signers SET sign_token_hash = NULL, updated_at = NOW()
         WHERE document_id = ${doc.id}
           AND status IN ('pending', 'awaiting', 'viewed')
      `;
    }

    const newActivity = [
      ...(doc.activity || []),
      {
        ts: new Date().toISOString(),
        kind: 'declined',
        text: isMulti
          ? `${declinerName} (signer ${signerIndex + 1} of ${totalSigners}) declined${reason ? ` - "${reason}"` : ''}`
          : `${declinerName} declined to sign${reason ? ` - "${reason}"` : ''}`,
        ip,
      },
    ];
    await sql`
      UPDATE documents SET
        status          = 'declined',
        declined_at     = NOW(),
        decline_reason  = ${reason},
        sign_token_hash = NULL,
        activity        = ${JSON.stringify(newActivity)}::jsonb,
        updated_at      = NOW()
      WHERE id = ${doc.id}
    `;

    notifyOwnerSafe({
      workspaceId: doc.workspace_id,
      type: 'documents',
      payload: {
        title: 'Document declined',
        body: `${declinerName} declined "${doc.name}"${reason ? ` - ${reason}` : ''}`,
        url: `/documents?doc=${encodeURIComponent(doc.id)}`,
        tag: `doc-declined-${doc.id}`,
      },
    });
    try {
      const branding = await fetchBranding(doc.workspace_id);
      const owner = await sql`SELECT w.owner_id, u.email FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ${doc.workspace_id}`;
      const ownerEmail = owner.rows[0]?.email;
      const ownerId = owner.rows[0]?.owner_id;
      if (ownerEmail) {
        await sendEmailToUser({
          userId: ownerId, type: 'documents',
          to: ownerEmail,
          subject: `Document declined: ${doc.name}`,
          html: emailShell({
            heading: 'A document was declined',
            body: `<p><strong>${escapeHtml(declinerName)}</strong> declined to sign <b>${escapeHtml(doc.name)}</b>.</p>
                   ${reason ? `<p>Their reason: <em>${escapeHtml(reason)}</em></p>` : ''}
                   <p>The document is now marked declined. You can revise it and resend, or void it from the Documents tab.</p>`,
            ctaText: 'View document',
            ctaUrl: `${appUrl()}/documents`,
            footer: 'You can adapt the document and re-send, or follow up directly with the signer.',
            branding,
          }),
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sign] decline email failed:', err.message);
    }

    return ok(res, { ok: true, declined: true });
  } catch (err) {
    return serverError(res, err);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

// Append atomically (jsonb concat in SQL) so two events landing at the
// same moment can't overwrite each other.
async function appendActivity(docId, entry) {
  const item = JSON.stringify([{ ts: new Date().toISOString(), ...entry }]);
  await sql`UPDATE documents SET activity = COALESCE(activity, '[]'::jsonb) || ${item}::jsonb, updated_at = NOW() WHERE id = ${docId}`;
}

// Pulls the doc + every signer's submission, computes the tamper-
// evident SHA-256 over (body + ordered signer name/email/values/timestamps),
// stamps the document complete, and returns the fresh row.
async function finalizeCompletedDoc(docId) {
  const dr = await sql`SELECT * FROM documents WHERE id = ${docId}`;
  const doc = dr.rows[0];
  const signers = await sql`
    SELECT name, email, signed_at, field_values
      FROM document_signers
     WHERE document_id = ${docId}
     ORDER BY order_index ASC
  `;
  const completionHash = computeHash({
    contentHtml: hashBody(doc),
    signers: signers.rows.map((s) => ({
      name: s.name, email: s.email,
      signedAt: s.signed_at?.toISOString?.() || s.signed_at,
      fields: s.field_values,
    })),
  });
  const newActivity = [
    ...(doc.activity || []),
    {
      ts: new Date().toISOString(),
      kind: 'completed',
      text: `All signers completed. Tamper-evident hash recorded.`,
    },
  ];
  // Use the LAST signer's submission as the document's `fields` (kept
  // for backward-compat with consumers that read documents.fields).
  const last = signers.rows[signers.rows.length - 1];
  const updated = await sql`
    UPDATE documents SET
      fields          = ${JSON.stringify(last?.field_values || doc.fields || [])}::jsonb,
      status          = 'completed',
      completed_at    = NOW(),
      sign_token_hash = NULL,
      completion_hash = ${completionHash},
      activity        = ${JSON.stringify(newActivity)}::jsonb,
      updated_at      = NOW()
    WHERE id = ${docId} AND status = 'sent'
    RETURNING *
  `;
  // 0 rows = a void won the race against this in-flight signature;
  // callers bail rather than overwrite 'voided' with 'completed'.
  return updated.rows[0] || null;
}

// What the completion hash treats as "the document": the written body,
// or for an uploaded PDF the SHA-256 of the original file (so the hash
// also pins down exactly which PDF was signed).
function hashBody(doc) {
  if (doc?.content_html) return doc.content_html;
  if (doc?.kind === 'pdf' && doc.source_pdf_sha256) return `pdf-sha256:${doc.source_pdf_sha256}`;
  return '';
}

// Stable canonicalization: lowercase emails, ISO timestamps, sort
// fields by id within each signer. Anything that would silently change
// without changing the hash would defeat the point of the hash.
function computeHash({ contentHtml, signers }) {
  const canon = {
    body: (contentHtml || '').trim(),
    signers: (signers || []).map((s) => ({
      name: (s.name || '').trim(),
      email: (s.email || '').toLowerCase().trim(),
      signedAt: s.signedAt || null,
      fields: (s.fields || [])
        .slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((f) => ({ id: f.id, type: f.type, value: f.value || '' })),
    })),
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(canon))
    .digest('hex');
}

// Build the executed copy. Uploaded PDFs get the signer values drawn
// onto the original pages; written documents (templates, typed text) are
// laid out fresh. Both get the signing record appended. The bytes are
// uploaded to Blob (documents.final_pdf_url) and also returned so the
// completion emails can carry the PDF as an attachment - a signer should
// never have to log in anywhere to hold their own signed copy.
// Best-effort: a failure is logged but doesn't roll back completion -
// the canonical record is the document_signers rows + completion_hash.
async function maybeStampFinalPdf(doc) {
  if (!doc) return null;
  const isPdf = doc.kind === 'pdf' && !!doc.file_url;
  const isWritten = doc.kind === 'written' || (!doc.kind && doc.content_html);
  if (!isPdf && !isWritten) return null;
  try {
    const signerRows = await sql`
      SELECT id, order_index, name, email, signed_at, declined_at,
             decline_reason, ip, user_agent, field_values,
             is_owner, viewed_at, consent_at
        FROM document_signers
       WHERE document_id = ${doc.id}
       ORDER BY order_index ASC
    `;
    // Legacy single-signer docs have no signer rows: synthesize one from
    // the document itself so the record still names who signed and when.
    let signers = signerRows.rows;
    if (signers.length === 0) {
      const done = [...(doc.activity || [])].reverse().find((a) => a.kind === 'completed');
      signers = [{
        order_index: 0,
        name: doc.recipient_name || 'Signer',
        email: doc.recipient_email || '',
        signed_at: doc.completed_at || new Date(),
        ip: done?.ip || null,
        user_agent: null,
        field_values: doc.fields || [],
      }];
    }
    let bytes;
    const branding = await fetchBranding(doc.workspace_id).catch(() => ({}));
    if (isPdf) {
      bytes = await stampCompletedPdf({
        pdfUrl: doc.file_url,
        fields: doc.fields || [],
        signers,
        doc,
        hash: doc.completion_hash,
        business: branding.businessName || null,
      });
    } else {
      bytes = await renderWrittenPdf({
        doc,
        fields: doc.fields || [],
        signers,
        hash: doc.completion_hash,
        business: branding.businessName || null,
      });
    }
    if (!bytes) return null;
    // The "after" fingerprint: SHA-256 of the signed file itself.
    const finalSha = crypto.createHash('sha256').update(bytes).digest('hex');
    try {
      await sql`UPDATE documents SET final_pdf_sha256 = ${finalSha} WHERE id = ${doc.id}`;
      doc.final_pdf_sha256 = finalSha;
    } catch { /* column missing on an old deploy: the PDF still goes out */ }
    try {
      const { url, pathname, private: isPrivate } = await uploadStampedPdf({
        workspaceId: doc.workspace_id,
        docId: doc.id,
        bytes,
      });
      await sql`
        UPDATE documents SET
          final_pdf_url = ${url},
          final_pdf_blob_pathname = ${pathname},
          final_pdf_private = ${!!isPrivate},
          updated_at = NOW()
        WHERE id = ${doc.id}
      `;
      doc.final_pdf_url = url;
      doc.final_pdf_blob_pathname = pathname;
    } catch (upErr) {
      // No storage configured (or a Blob outage): the emails still carry
      // the PDF, only the in-app download link is missing.
      // eslint-disable-next-line no-console
      console.error('[sign] signed PDF upload failed:', upErr.message);
    }
    return bytes;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sign] signed PDF build failed:', err.message);
    return null;
  }
}

// Resend caps a message at 40MB; keep attachments well under it and fall
// back to the link-only email for anything bigger.
const MAX_ATTACH_BYTES = 12 * 1024 * 1024;
function attachmentFor(doc, bytes) {
  if (!bytes || bytes.length === 0 || bytes.length > MAX_ATTACH_BYTES) return [];
  const base = String(doc.name || 'document').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
  return [{ filename: `${base}-signed.pdf`, content: Buffer.from(bytes).toString('base64'), contentType: 'application/pdf' }];
}

async function notifyOwnerOnCompletion(doc, attachments = []) {
  // The owner gets an email with the executed copy attached - the push
  // and thread message below are nice, but the email is the record.
  try {
    const owner = await sql`
      SELECT w.owner_id, u.email, u.name
        FROM workspaces w JOIN users u ON u.id = w.owner_id
       WHERE w.id = ${doc.workspace_id}
    `;
    const o = owner.rows[0];
    if (o?.email) {
      const branding = await fetchBranding(doc.workspace_id);
      const { rows: signerRows } = await sql`
        SELECT name, email FROM document_signers
         WHERE document_id = ${doc.id} AND status = 'completed'
         ORDER BY order_index ASC
      `;
      const who = signerRows.length
        ? signerRows.map((s) => escapeHtml(s.name)).join(', ')
        : escapeHtml(doc.recipient_name || 'The signer');
      await sendEmailToUser({
        userId: o.owner_id, type: 'documents',
        to: o.email,
        subject: `Signed: "${doc.name}"`,
        attachments,
        html: emailShell({
          heading: 'Document fully signed',
          body: `<p>Hi ${escapeHtml(o.name || 'there')},</p>
                 <p><strong>${who}</strong> signed <b>${escapeHtml(doc.name)}</b>. It's complete.</p>
                 ${attachments.length
                   ? '<p>The signed PDF is attached, with a signing record on the last page (who signed, when, from where) and the tamper-evident hash.</p>'
                   : '<p>Open it in Ivy to see the signatures and the signing record.</p>'}`,
          ctaText: 'Open in Ivy',
          ctaUrl: `${appUrl()}/documents?doc=${encodeURIComponent(doc.id)}`,
          footer: 'Ivy keeps the signed copy on the document itself, under Documents.',
          branding,
        }),
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sign] owner completion email failed:', err.message);
  }
  // Best-effort: chat thread system message + push.
  try {
    if (doc.recipient_client_id) {
      const t = await sql`
        INSERT INTO message_threads (workspace_id, client_id)
        VALUES (${doc.workspace_id}, ${doc.recipient_client_id})
        ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
        RETURNING id
      `;
      const threadId = t.rows[0].id;
      const meta = { docId: doc.id, docName: doc.name };
      await sql`
        INSERT INTO messages (thread_id, sender, text, kind, meta)
        VALUES (${threadId}, 'system', ${`Document completed: ${doc.name}`}, 'doc-completed', ${JSON.stringify(meta)}::jsonb)
      `;
      await sql`
        UPDATE message_threads SET
          last_message_at      = NOW(),
          last_message_preview = ${`Document completed: ${doc.name}`},
          unread_biz           = unread_biz + 1
        WHERE id = ${threadId}
      `;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sign] thread message failed:', err.message);
  }
  notifyOwnerSafe({
    workspaceId: doc.workspace_id,
    type: 'documents',
    payload: {
      title: 'Document signed',
      body: `${doc.name} is fully signed`,
      url: `/documents?doc=${encodeURIComponent(doc.id)}`,
      tag: `doc-signed-${doc.id}`,
    },
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
