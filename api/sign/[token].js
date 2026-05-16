// /api/sign/:token  (public, no auth)
//
//   GET    → fetch the document the recipient was emailed (only when their
//            signer row is awaiting / viewed, or the legacy single-signer
//            doc is in 'sent' state)
//   POST   → submit completed field values. Body: { fields: [{ id, value }, ...] }
//   DELETE → decline. Body: { reason? }
//
// Multi-signer flow (preferred): looks up document_signers by token hash.
// On a successful sign, mints + emails the NEXT signer's token. When the
// last signer completes, the document is marked 'completed' and a
// SHA-256 tamper-evident hash is computed over the body + ordered
// signer submissions.
//
// Single-signer flow (legacy): falls back to documents.sign_token_hash
// when no document_signers row matches the token. Works exactly as the
// previous version did so existing in-flight documents don't break.
//
// Tokens are sha256-hashed before lookup. We never persist or accept
// the raw token for any other purpose. Tokens are invalidated on
// completion / decline / void.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import {
  serializeDocPublic, cleanFields, VALID_FIELD_TYPES,
} from '../_lib/documents.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmail, sendEmailToClient, sendEmailToUser, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { notifyOwnerSafe, notifyClientSafe } from '../_lib/push.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { stampCompletedPdf, uploadStampedPdf } from '../_lib/pdfStamp.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import crypto from 'node:crypto';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export default async function handler(req, res) {
  // Public endpoint (no requireUser) — bootstrap schema explicitly so
  // a cold-started function instance doesn't 500 on missing tables.
  try { await ensureSchemaApplied(); } catch { /* tolerate */ }
  if (req.method === 'GET')    return getDoc(req, res);
  if (req.method === 'POST')   return signDoc(req, res);
  if (req.method === 'DELETE') return declineDoc(req, res);
  return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
}

// ───────────────────────────────────────────────────────────────────────
// Lookup: first try document_signers (multi-signer), then fall back to
// the legacy single-signer column. Returns null if no match. The
// resolved object always exposes:
//   { doc, signer (multi only), signerIndex, totalSigners, isMulti }
// so the rest of the file can branch on `isMulti` once.
// ───────────────────────────────────────────────────────────────────────
async function resolveByToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 16) return null;
  const tokenHash = hashToken(rawToken);

  // Multi-signer first.
  const ms = await sql`
    SELECT s.*, d.id AS doc_id, d.workspace_id, d.name, d.status AS doc_status,
           d.content_html, d.fields, d.activity, d.recipient_client_id,
           d.recipient_name, d.recipient_email, d.created_at, d.updated_at,
           d.kind, d.file_url, d.page_count
      FROM document_signers s
      JOIN documents d ON d.id = s.document_id
     WHERE s.sign_token_hash = ${tokenHash}
     LIMIT 1
  `;
  if (ms.rows.length > 0) {
    const row = ms.rows[0];
    if (row.doc_status !== 'sent') return null;
    if (!['awaiting', 'viewed'].includes(row.status)) return null;
    const total = await sql`SELECT COUNT(*)::int AS n FROM document_signers WHERE document_id = ${row.doc_id}`;
    return {
      isMulti: true,
      doc: {
        id: row.doc_id, workspace_id: row.workspace_id, name: row.name,
        status: row.doc_status, content_html: row.content_html,
        fields: row.fields, activity: row.activity,
        recipient_client_id: row.recipient_client_id,
        recipient_name: row.recipient_name, recipient_email: row.recipient_email,
        kind: row.kind, file_url: row.file_url, page_count: row.page_count,
      },
      signer: {
        id: row.id, document_id: row.document_id, order_index: row.order_index,
        client_id: row.client_id, name: row.name, email: row.email,
        status: row.status, field_values: row.field_values,
      },
      signerIndex: row.order_index,
      totalSigners: total.rows[0]?.n || 1,
    };
  }

  // Legacy single-signer fallback.
  const single = await sql`
    SELECT * FROM documents
     WHERE sign_token_hash = ${tokenHash}
       AND status = 'sent'
     LIMIT 1
  `;
  if (single.rows.length === 0) return null;
  return {
    isMulti: false,
    doc: single.rows[0],
    signer: null,
    signerIndex: 0,
    totalSigners: 1,
  };
}

// ───────────────────────────────────────────────────────────────────────
// GET — fetch the doc + position info, mark 'viewed'.
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
    if (!r) return notFound(res, 'This signing link is invalid, has expired, or the document was already signed.');
    const { doc, signer, signerIndex, totalSigners, isMulti } = r;

    // Mark viewed (idempotent: only fire once per signer per session).
    if (isMulti && signer.status === 'awaiting') {
      await sql`
        UPDATE document_signers
           SET status = 'viewed', updated_at = NOW(),
               ip = COALESCE(ip, ${ip}),
               user_agent = COALESCE(user_agent, ${(req.headers['user-agent'] || '').toString().slice(0, 500)})
         WHERE id = ${signer.id}
      `;
      await appendActivity(doc.id, doc.activity, {
        kind: 'viewed',
        text: `${signer.name} (signer ${signerIndex + 1} of ${totalSigners}) opened the document`,
        ip,
      });
    } else if (!isMulti) {
      const last = (doc.activity || [])[(doc.activity || []).length - 1];
      const todayish = last && last.kind === 'viewed' &&
        (Date.now() - new Date(last.ts).getTime()) < 24 * 60 * 60 * 1000;
      if (!todayish) {
        await appendActivity(doc.id, doc.activity, {
          kind: 'viewed',
          text: `${doc.recipient_name || 'Recipient'} opened the document`,
          ip,
        });
      }
    }

    return ok(res, {
      document: serializeDocPublic(doc),
      signer: isMulti ? {
        position: signerIndex + 1,
        total: totalSigners,
        name: signer.name,
        email: signer.email,
      } : null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

// ───────────────────────────────────────────────────────────────────────
// POST — submit the signed values. Multi-signer: marks this signer
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
    if (!r) return notFound(res, 'This signing link is invalid or has expired.');
    const { doc, signer, signerIndex, totalSigners, isMulti } = r;

    const body = await readBody(req);
    const submitted = cleanFields(body.fields ?? []);
    if (submitted === null) return badRequest(res, 'Invalid fields payload');

    // Merge submitted values onto stored fields by id. Required-field
    // check is scoped to fields owned by THIS signer (per signerIndex)
    // — otherwise signer 1 would trip over required fields that signer
    // 2 will only fill on their turn. For documents without
    // per-signer assignment (legacy single-signer / written multi),
    // all fields default to signerIndex 0 so the same signer fills
    // everything and the check still works.
    const stored = doc.fields || [];
    const merged = stored.map((f) => {
      const sub = submitted.find((s) => s.id === f.id);
      const value = sub ? String(sub.value || '') : (f.value || '');
      return { ...f, value };
    });
    const myIdx = isMulti ? signerIndex : 0;
    for (const f of merged) {
      if (!VALID_FIELD_TYPES.has(f.type)) {
        return badRequest(res, `Unknown field type: ${f.type}`);
      }
      const ownerIdx = Number.isInteger(f.signerIndex) ? f.signerIndex : 0;
      if (ownerIdx !== myIdx) continue;
      if (f.required !== false && !f.value) {
        return badRequest(res, `Please fill in "${f.label || f.type}"`);
      }
    }

    if (isMulti) {
      // Stamp this signer complete.
      await sql`
        UPDATE document_signers SET
          field_values    = ${JSON.stringify(merged)}::jsonb,
          status          = 'completed',
          signed_at       = NOW(),
          sign_token_hash = NULL,
          ip              = ${ip},
          user_agent      = ${ua},
          updated_at      = NOW()
        WHERE id = ${signer.id}
      `;
      // Persist the running merged values onto documents.fields so the
      // NEXT signer's resolveByToken sees prior signers' contributions
      // (otherwise the merge would lose signer 1's value when signer 2
      // submits, since stored would still show empties).
      await sql`
        UPDATE documents SET
          fields = ${JSON.stringify(merged)}::jsonb,
          updated_at = NOW()
        WHERE id = ${doc.id}
      `;
      await appendActivity(doc.id, doc.activity, {
        kind: 'signer-completed',
        text: `${signer.name} (signer ${signerIndex + 1} of ${totalSigners}) signed`,
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
            clientId: n.client_id || null,
            type: 'documents',
            to: n.email,
            subject: `Action needed: sign "${doc.name}"`,
            replyTo: branding.replyTo,
            html: emailShell({
              heading: 'A document needs your signature',
              body: `<p>Hi ${escapeHtml(n.name)},</p>
                     <p>You're up next on <b>${escapeHtml(doc.name)}</b> — signer ${n.order_index + 1} of ${totalSigners}.</p>`,
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
        return ok(res, { document: serializeDocPublic(doc), nextSigner: { name: n.name } });
      }

      // Last signer completed → finalize document with tamper-evident hash
      // and (if it's a PDF) stamp the flattened final artifact.
      const finalDoc = await finalizeCompletedDoc(doc.id);
      await maybeStampFinalPdf(finalDoc);
      await notifyOwnerOnCompletion(finalDoc);
      // Tell every signer who participated that the doc is fully
      // executed — important for long-running multi-signer flows
      // where signer 1 might have signed days before signer N
      // finally completes. Sends both a push (immediate) and an
      // email (durable record + link to their copy).
      try {
        // Exclude declined signers — they walked away. Including them
        // sends a "fully signed" email/push to someone who never agreed,
        // which is misleading and a small compliance risk.
        const { rows: allSigners } = await sql`
          SELECT client_id, name, email FROM document_signers
          WHERE document_id = ${doc.id}
            AND status <> 'declined'
        `;
        const branding = await fetchBranding(doc.workspace_id);
        const portalLink = `${appUrl()}/me/documents`;
        for (const s of allSigners) {
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
                clientId: s.client_id || null,
                type: 'documents',
                to: s.email,
                subject: `Signed: "${doc.name}" is complete`,
                replyTo: branding.replyTo,
                html: emailShell({
                  heading: 'Document fully signed',
                  body: `<p>Hi ${escapeHtml(s.name || 'there')},</p>
                    <p><strong>${escapeHtml(doc.name)}</strong> is now complete — every signer is in.</p>
                    <p>You can view a copy of the signed document any time from your portal.</p>`,
                  ctaText: 'View signed copy',
                  ctaUrl: portalLink,
                  footer: 'Keep this email for your records.',
                  branding,
                }),
              });
            } catch (mailErr) {
              console.error('[sign] completion email failed for', s.email, '::', mailErr.message);
            }
          }
        }
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
        text: `${doc.recipient_name || 'Recipient'} signed and completed the document`,
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
          contentHtml: doc.content_html,
          signers: [{ name: doc.recipient_name, email: doc.recipient_email, fields: merged, signedAt: new Date().toISOString() }],
        })},
        activity        = ${JSON.stringify(newActivity)}::jsonb,
        updated_at      = NOW()
      WHERE id = ${doc.id}
      RETURNING *
    `;
    await maybeStampFinalPdf(updated.rows[0]);
    await notifyOwnerOnCompletion(updated.rows[0]);
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
// DELETE — decline. Multi-signer: declining halts the entire document.
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
      // Invalidate any other pending signer tokens — once one declines,
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
          ? `${declinerName} (signer ${signerIndex + 1} of ${totalSigners}) declined${reason ? ` — "${reason}"` : ''}`
          : `${declinerName} declined to sign${reason ? ` — "${reason}"` : ''}`,
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
        body: `${declinerName} declined "${doc.name}"${reason ? ` — ${reason}` : ''}`,
        url: '/documents',
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

async function appendActivity(docId, current, entry) {
  const next = [...(current || []), { ts: new Date().toISOString(), ...entry }];
  await sql`UPDATE documents SET activity = ${JSON.stringify(next)}::jsonb, updated_at = NOW() WHERE id = ${docId}`;
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
    contentHtml: doc.content_html,
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
    WHERE id = ${docId}
    RETURNING *
  `;
  return updated.rows[0];
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

// If the doc is a PDF with placed fields, render the flattened final
// PDF (signatures + text drawn into the document, plus an audit page)
// and store its blob URL on documents.final_pdf_url. Best-effort: a
// stamping failure is logged but doesn't roll back completion — the
// canonical record is the document_signers rows + completion_hash.
async function maybeStampFinalPdf(doc) {
  if (!doc) return;
  if (doc.kind !== 'pdf' || !doc.file_url) return;
  try {
    const signers = await sql`
      SELECT id, order_index, name, email, signed_at, declined_at,
             decline_reason, ip, user_agent, field_values
        FROM document_signers
       WHERE document_id = ${doc.id}
       ORDER BY order_index ASC
    `;
    const bytes = await stampCompletedPdf({
      pdfUrl: doc.file_url,
      fields: doc.fields || [],
      signers: signers.rows,
      doc,
      hash: doc.completion_hash,
    });
    if (!bytes) return;
    const { url, pathname } = await uploadStampedPdf({
      workspaceId: doc.workspace_id,
      docId: doc.id,
      bytes,
    });
    await sql`
      UPDATE documents SET
        final_pdf_url = ${url},
        final_pdf_blob_pathname = ${pathname},
        updated_at = NOW()
      WHERE id = ${doc.id}
    `;
    doc.final_pdf_url = url;
    doc.final_pdf_blob_pathname = pathname;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sign] PDF stamping failed:', err.message);
  }
}

async function notifyOwnerOnCompletion(doc) {
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
      url: '/documents',
      tag: `doc-signed-${doc.id}`,
    },
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
