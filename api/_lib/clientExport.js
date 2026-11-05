// "Download my data" for a CLIENT of businesses on Ivy: everything the
// portal shows this person about themselves, across every business they
// are a client of, and nothing the business keeps to itself.
//
// Each table is read with an explicit column list (never SELECT *), so a
// business-private column added later (bookings.private_notes, owner-only
// completion notes, payment-processor ids, token hashes, internal activity
// logs) cannot leak into a client's download by accident. Scoped by the
// signed-in user's own client rows (myClientIds), like every /api/me read.
//
// Used by GET /api/me/export (the portal's download button) and by the
// client_portal section of the owner account export.
import { sql } from './db.js';
import { docFileUrl } from './docFiles.js';
import { myClientIds } from './clientPortal.js';
import { serializeClientDetails, formatBirthday } from './clientDetails.js';

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

// Only the completion entries the business marked as visible to the
// client, same rule as /api/me/bookings.
function visibleCompletion(log) {
  if (!log || typeof log !== 'object') return [];
  const out = [];
  for (const [date, e] of Object.entries(log)) {
    if (!e || typeof e !== 'object' || e.visibleToClient === false) continue;
    out.push({
      date,
      completedAt: e.completedAt || null,
      notes: e.notes || '',
      attachments: Array.isArray(e.attachments)
        ? e.attachments.map((a) => ({ url: a?.url || null, filename: a?.filename || null, mimeType: a?.mimeType || null }))
        : [],
    });
  }
  return out;
}

export async function buildClientPortalExport(user, { memberships } = {}) {
  const mine = memberships || await myClientIds(user);
  const myIds = mine.map((m) => m.clientId);
  const byClient = new Map(mine.map((m) => [m.clientId, m]));
  const biz = (clientId) => byClient.get(clientId)?.businessName || 'Business';

  const businesses = mine.map((m) => ({
    businessName: m.businessName,
    nameTheyHaveForYou: m.clientName,
    emailTheyHaveForYou: m.clientEmail,
  }));
  if (!myIds.length) {
    return { businesses, profile: null, bookings: [], invoices: [], documents: [], messages: [], packages: [], memberships: [], reviews: [], cancellationPolicyAcceptances: [] };
  }

  const safe = (p) => p.catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[clientExport] section failed:', e.message);
    return { rows: [] };
  });

  const [profile, bookings, invoices, documents, messages, packages, memberships2, reviews] = await Promise.all([
    safe(sql.query(
      `SELECT name, email, phone, address, photo_url, birth_month, birth_day, birth_year, pronouns,
              address_street, address_city, address_region, address_postal_code, address_country,
              emergency_name, emergency_phone, emergency_relationship, preferred_contact, occupation
         FROM clients
        WHERE id = ANY($1) ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [myIds])),
    safe(sql.query(
      `SELECT b.id, b.client_id, b.date, b.start_min, b.end_min, b.notes, b.cancelled_at,
              b.recurrence_rule, b.location_address, b.video_room_url, b.tip_amount,
              b.booking_total, b.deposit_paid, b.fee_charged_amount, b.fee_charged_kind,
              b.fee_charged_at, b.no_show_at, b.created_at, b.completion_log,
              s.name AS service_name
         FROM bookings b
         LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
        WHERE b.client_id = ANY($1)
        ORDER BY b.date DESC, b.start_min DESC
        LIMIT 5000`, [myIds])),
    safe(sql.query(
      `SELECT id, client_id, number, status, issue_date, due_date, paid_at, paid_method,
              items, tax_rate, discount, notes, total, paid_amount, refunded_amount,
              currency, created_at
         FROM invoices
        WHERE client_id = ANY($1) AND status <> 'draft'
        ORDER BY issue_date DESC
        LIMIT 5000`, [myIds])),
    safe(sql.query(
      `SELECT d.id, d.recipient_client_id AS client_id, d.name, d.kind, d.status,
              d.sent_at, d.completed_at, d.declined_at, d.final_pdf_url
         FROM documents d
        WHERE d.status <> 'draft' AND COALESCE(d.is_template, FALSE) = FALSE
          AND (d.recipient_client_id = ANY($1)
               OR EXISTS (SELECT 1 FROM document_signers ds WHERE ds.document_id = d.id AND ds.client_id = ANY($1)))
        ORDER BY d.created_at DESC
        LIMIT 2000`, [myIds])),
    safe(sql.query(
      `SELECT t.client_id, m.sender, m.text, m.kind, m.created_at
         FROM messages m
         JOIN message_threads t ON t.id = m.thread_id
        WHERE t.client_id = ANY($1)
        ORDER BY m.created_at ASC
        LIMIT 20000`, [myIds])),
    safe(sql.query(
      `SELECT client_id, name, credits_total, credits_remaining, status, expires_at, created_at
         FROM client_packages WHERE client_id = ANY($1) ORDER BY created_at DESC LIMIT 1000`, [myIds])),
    safe(sql.query(
      `SELECT client_id, membership_name, price_cents, interval, status, started_at,
              current_period_end, cancel_at_period_end
         FROM client_memberships WHERE client_id = ANY($1) ORDER BY started_at DESC LIMIT 1000`, [myIds])),
    safe(sql.query(
      `SELECT client_id, rating, text, created_at FROM reviews
        WHERE client_id = ANY($1) AND reviewer_user_id = $2 ORDER BY created_at DESC LIMIT 1000`, [myIds, user.id])),
  ]);

  // Cancellation policies this person accepted (their own client rows
  // only): the exact text, version and fees they agreed to.
  const acceptances = await safe(sql.query(
    `SELECT client_id, booking_id, status, source, accepted_at, policy_version, policy_text, policy_sha256, terms
       FROM cancellation_policy_acceptances
      WHERE client_id = ANY($1)
         OR client_id IN (SELECT removed_client_id FROM client_merges WHERE current_client_id = ANY($1))
      ORDER BY accepted_at DESC LIMIT 1000`, [myIds]));

  const p = profile.rows[0] || null;
  return {
    businesses,
    // Their own record only (myIds), the client-facing details; never the
    // business's private notes or custom fields.
    profile: p ? {
      name: p.name, email: p.email, phone: p.phone, address: p.address, photoUrl: p.photo_url,
      addressParts: serializeClientDetails(p).addressParts,
      birthday: formatBirthday(p),
      pronouns: p.pronouns || null,
      emergencyContact: serializeClientDetails(p).emergencyContact,
      preferredContact: p.preferred_contact || null,
      occupation: p.occupation || null,
    } : null,
    bookings: bookings.rows.map((r) => ({
      business: biz(r.client_id),
      service: r.service_name || null,
      date: iso(r.date), startMin: r.start_min, endMin: r.end_min,
      notes: r.notes || null,
      cancelledAt: r.cancelled_at, noShowAt: r.no_show_at,
      repeats: r.recurrence_rule || null,
      address: r.location_address || null,
      videoLink: r.video_room_url || null,
      total: r.booking_total != null ? Number(r.booking_total) : null,
      depositPaid: Number(r.deposit_paid || 0),
      tip: Number(r.tip_amount || 0),
      feeCharged: r.fee_charged_amount != null ? Number(r.fee_charged_amount) : null,
      feeKind: r.fee_charged_kind || null,
      feeChargedAt: r.fee_charged_at || null,
      sessionNotes: visibleCompletion(r.completion_log),
      bookedAt: r.created_at,
    })),
    invoices: invoices.rows.map((r) => ({
      business: biz(r.client_id),
      number: r.number, status: r.status,
      issueDate: iso(r.issue_date), dueDate: iso(r.due_date),
      paidAt: r.paid_at, paidMethod: r.paid_method || null,
      items: Array.isArray(r.items) ? r.items.map((it) => ({
        description: it?.description ?? it?.name ?? null,
        quantity: it?.quantity ?? it?.qty ?? null,
        rate: it?.rate ?? null,
      })) : [],
      taxRate: r.tax_rate != null ? Number(r.tax_rate) : null,
      discount: r.discount != null ? Number(r.discount) : null,
      notes: r.notes || null,
      total: Number(r.total || 0), paid: Number(r.paid_amount || 0),
      refunded: Number(r.refunded_amount || 0), currency: r.currency || 'USD',
    })),
    documents: documents.rows.map((r) => ({
      business: biz(r.client_id), name: r.name, kind: r.kind, status: r.status,
      sentAt: r.sent_at, completedAt: r.completed_at, declinedAt: r.declined_at,
      // A signed link valid for 30 days, not the storage address.
      signedCopy: r.final_pdf_url && r.status === 'completed' ? docFileUrl(r.id, 'final', 30 * 24 * 60 * 60) : null,
    })),
    messages: messages.rows.map((r) => ({
      business: biz(r.client_id), from: r.sender, text: r.text, kind: r.kind, at: r.created_at,
    })),
    packages: packages.rows.map((r) => ({
      business: biz(r.client_id), name: r.name, sessionsTotal: r.credits_total,
      sessionsLeft: r.credits_remaining, status: r.status, expiresAt: r.expires_at, boughtAt: r.created_at,
    })),
    memberships: memberships2.rows.map((r) => ({
      business: biz(r.client_id), name: r.membership_name, priceCents: r.price_cents,
      interval: r.interval, status: r.status, startedAt: r.started_at,
      currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: !!r.cancel_at_period_end,
    })),
    reviews: reviews.rows.map((r) => ({ business: biz(r.client_id), rating: r.rating, text: r.text, at: r.created_at })),
    cancellationPolicyAcceptances: acceptances.rows.map((r) => ({
      business: biz(r.client_id), bookingId: r.booking_id || null, status: r.status, source: r.source,
      acceptedAt: r.accepted_at, policyVersion: r.policy_version, policyText: r.policy_text,
      policySha256: r.policy_sha256, feesInEffect: r.terms || {},
    })),
  };
}
