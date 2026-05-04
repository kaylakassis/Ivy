// /api/calendar/public/:slug
//   GET  → public calendar state (settings + services + blocks + bookings,
//          client identities redacted on bookings)
//   POST → create a booking via the public link. Body:
//          { serviceId, date, startMin, endMin, clientName, clientEmail, notes? }

import { sql } from '../../_lib/db.js';
import { readBody } from '../../_lib/body.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { requireSameOrigin } from '../../_lib/security.js';
import {
  serializeSettings, serializeService, serializeBlock, serializeBooking,
  hasConflict, withinAvailability, depositFor,
} from '../../_lib/calendar.js';
import { validEmail } from '../../_lib/auth.js';
import { normalizePhone } from '../../_lib/sms.js';
import { notifyNewBooking } from '../../_lib/bookingNotify.js';
import { syncOnBookingCreated } from '../../_lib/googleSync.js';
import { attachIntakeForms } from '../../_lib/intake.js';
import { decrypt } from '../../_lib/secrets.js';
import { createCheckoutSession } from '../../_lib/stripe.js';
import { appUrl } from '../../_lib/tokens.js';
import { sendClientInvite } from '../../_lib/clientNotify.js';
import {
  badRequest, created, methodNotAllowed, notFound, ok, serverError,
} from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method === 'GET')  return getCalendar(req, res);
  if (req.method === 'POST') return createBooking(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function getCalendar(req, res) {
  try {
    const slug = (req.query.slug || '').toString().toLowerCase();
    if (!slug) return notFound(res);

    const settings = await sql`
      SELECT * FROM calendar_settings WHERE slug = ${slug}
    `;
    if (settings.rows.length === 0) return notFound(res, 'No booking page for that handle');
    const s = settings.rows[0];

    const services = await sql`
      SELECT * FROM services WHERE workspace_id = ${s.workspace_id}
      ORDER BY display_order, created_at
    `;
    const blocks = await sql`
      SELECT * FROM calendar_blocks WHERE workspace_id = ${s.workspace_id}
      ORDER BY date, start_min
    `;
    const bookings = await sql`
      SELECT * FROM bookings WHERE workspace_id = ${s.workspace_id} AND cancelled_at IS NULL
      ORDER BY date, start_min
    `;
    // External busy times (e.g. Google Cal personal events) are merged
    // into the blocks list with a label of "Busy" so the slot picker
    // greys them out without leaking the real event title. Server-side
    // hasConflict() already checks external_busy_blocks, so the UI
    // rendering is just for honesty in the slot grid.
    const external = await sql`
      SELECT id, date, start_min, end_min FROM external_busy_blocks
      WHERE workspace_id = ${s.workspace_id} AND date >= CURRENT_DATE
      ORDER BY date, start_min
    `;
    const blocksOut = blocks.rows.map(serializeBlock);
    for (const b of external.rows) {
      blocksOut.push({
        id: 'ext_' + b.id,
        date: b.date instanceof Date ? b.date.toISOString().slice(0, 10) : b.date,
        startMin: b.start_min,
        endMin: b.end_min,
        label: 'Busy',
      });
    }

    return ok(res, {
      calendar: {
        settings: serializeSettings(s),
        services: services.rows.map(serializeService),
        blocks:   blocksOut,
        bookings: bookings.rows.map((r) => serializeBooking(r, { redactClient: true })),
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}

async function createBooking(req, res) {
  try {
    const slug = (req.query.slug || '').toString().toLowerCase();
    const body = await readBody(req);

    // Light rate limit: anyone can hit this without auth.
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `book:ip:${ip}`,    max: 10, windowSeconds: 60 * 60 },
      { key: `book:slug:${slug}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    // Resolve workspace by slug.
    const settingsRows = await sql`
      SELECT workspace_id, availability, slot_minutes FROM calendar_settings WHERE slug = ${slug}
    `;
    if (settingsRows.rows.length === 0) return notFound(res, 'Booking page not found');
    const { workspace_id: workspaceId, availability, slot_minutes: slotMinutes } = settingsRows.rows[0];

    // Validate inputs.
    const date = (body.date || '').toString();
    const start = Number(body.startMin);
    const end = Number(body.endMin);
    const serviceId = (body.serviceId || '').toString();
    const clientName = (body.clientName || '').toString().trim().slice(0, 120);
    const clientEmail = (body.clientEmail || '').toString().trim().toLowerCase();
    const notes = body.notes ? String(body.notes).slice(0, 1000) : null;
    // Phone is optional — only normalized if the field was non-empty so
    // bookings without phones still succeed.
    let clientPhone = null;
    if (body.clientPhone) {
      clientPhone = normalizePhone(body.clientPhone);
      if (!clientPhone) return badRequest(res, 'Phone number is not a valid format');
    }
    const smsConsent = !!body.smsConsent && !!clientPhone;
    // Waitlist branch: client wants to queue for this slot instead of
    // (or after) failing a booking attempt against a full slot.
    const joinWaitlist = !!body.joinWaitlist;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'date must be YYYY-MM-DD');
    if (!Number.isInteger(start) || start < 0 || start >= 24 * 60) return badRequest(res, 'invalid startMin');
    if (!Number.isInteger(end) || end <= start || end > 24 * 60) return badRequest(res, 'invalid endMin');
    if ((end - start) % slotMinutes !== 0) return badRequest(res, `Slot must align to ${slotMinutes}-minute increments`);
    if (!clientName) return badRequest(res, 'Your name is required');
    if (!validEmail(clientEmail)) return badRequest(res, 'A valid email is required');
    if (!serviceId) return badRequest(res, 'Pick a service');

    // Verify service belongs to this workspace and duration matches.
    const svcRows = await sql`
      SELECT id, duration_minutes, capacity, price, deposit_type, deposit_amount FROM services
      WHERE id = ${serviceId} AND workspace_id = ${workspaceId}
    `;
    if (svcRows.rows.length === 0) return badRequest(res, 'Unknown service');
    if ((end - start) !== svcRows.rows[0].duration_minutes) {
      return badRequest(res, 'Slot duration does not match service');
    }
    const serviceCapacity = Math.max(1, Number(svcRows.rows[0].capacity) || 1);
    const depositRequired = depositFor(svcRows.rows[0]);

    // Don't allow booking in the past.
    const now = new Date();
    const slotStart = new Date(date + 'T00:00:00Z');
    slotStart.setUTCMinutes(slotStart.getUTCMinutes() + start);
    if (slotStart.getTime() < now.getTime() - 60 * 1000) {
      return badRequest(res, 'That time has passed');
    }

    // Availability + conflict check.
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    if (!withinAvailability(availability, weekday, start, end)) {
      return badRequest(res, 'That slot is outside booking hours');
    }

    if (joinWaitlist) {
      // Insert a waitlist entry instead of a booking. Allowed even when
      // the slot is currently free — the client may want to be notified
      // if the time changes; just no-op if there's already an entry
      // from this email for the exact slot.
      const existing = await sql`
        SELECT id FROM waitlist_entries
        WHERE workspace_id = ${workspaceId}
          AND service_id = ${serviceId}
          AND date = ${date} AND start_min = ${start} AND end_min = ${end}
          AND client_email = ${clientEmail}
          AND status = 'waiting'
        LIMIT 1
      `;
      if (existing.rows.length > 0) {
        return created(res, { waitlist: { id: existing.rows[0].id, alreadyJoined: true } });
      }
      const w = await sql`
        INSERT INTO waitlist_entries (
          workspace_id, service_id, client_id,
          client_name, client_email, client_phone,
          date, start_min, end_min, notes
        ) VALUES (
          ${workspaceId}, ${serviceId}, NULL,
          ${clientName}, ${clientEmail}, ${clientPhone},
          ${date}, ${start}, ${end}, ${notes}
        )
        RETURNING id
      `;
      return created(res, { waitlist: { id: w.rows[0].id, alreadyJoined: false } });
    }

    if (await hasConflict({ workspaceId, dateISO: date, start, end, serviceId, capacity: serviceCapacity })) {
      return badRequest(res, serviceCapacity > 1
        ? 'That class just filled up — please pick another time'
        : 'That slot was just taken — please pick another time');
    }

    // Attach to an existing client by email; create a lead if missing.
    // When the form provided a phone, store / refresh it on the client
    // row so future bookings + reminders pick it up by default. Same
    // for SMS consent — never silently flip to TRUE; only stamp the
    // timestamp if the form explicitly opted in.
    let clientId = null;
    const existing = await sql`
      SELECT id, phone, sms_consent_at FROM clients
      WHERE workspace_id = ${workspaceId} AND email = ${clientEmail} LIMIT 1
    `;
    if (existing.rows.length > 0) {
      const ec = existing.rows[0];
      clientId = ec.id;
      const newPhone   = clientPhone || ec.phone;
      const newConsent = smsConsent ? (ec.sms_consent_at || new Date().toISOString()) : ec.sms_consent_at;
      await sql`
        UPDATE clients SET
          last_seen_at   = NOW(),
          phone          = ${newPhone},
          sms_consent_at = ${newConsent}
        WHERE id = ${clientId}
      `;
    } else {
      const newClient = await sql`
        INSERT INTO clients (workspace_id, name, email, phone, sms_consent_at, stage, source, last_seen_at)
        VALUES (${workspaceId}, ${clientName}, ${clientEmail},
                ${clientPhone}, ${smsConsent ? new Date().toISOString() : null},
                'lead', 'Booking', NOW())
        RETURNING id
      `;
      clientId = newClient.rows[0].id;
      // First-time booker — email a "claim your account" invite alongside
      // the booking confirmation that notifyNewBooking sends.
      sendClientInvite({ workspaceId, clientId });
    }

    const insert = await sql`
      INSERT INTO bookings (
        workspace_id, service_id, client_id, client_name, client_email, client_phone,
        date, start_min, end_min, notes, deposit_required
      )
      VALUES (
        ${workspaceId}, ${serviceId}, ${clientId}, ${clientName}, ${clientEmail}, ${clientPhone},
        ${date}, ${start}, ${end}, ${notes}, ${depositRequired}
      )
      RETURNING *
    `;
    const b = insert.rows[0];

    // If a deposit is required AND the workspace has Stripe connected,
    // mint a Checkout session for the deposit and return its URL so
    // the public booker can redirect the client to pay. Failures here
    // don't block the booking — the slot is held; owner can collect
    // the deposit manually later.
    let depositCheckoutUrl = null;
    if (depositRequired > 0) {
      try {
        const fs = await sql`
          SELECT stripe_secret_encrypted, currency
          FROM finance_settings WHERE workspace_id = ${workspaceId}
        `;
        const enc = fs.rows[0]?.stripe_secret_encrypted;
        if (enc) {
          const secretKey = decrypt(enc);
          const base = appUrl();
          const session = await createCheckoutSession({
            secretKey,
            invoice: {
              id: `bookdep_${b.id}`,
              number: `Deposit · ${b.id.slice(0, 8)}`,
              workspace_id: workspaceId,
            },
            currency: (fs.rows[0]?.currency || 'USD').toUpperCase(),
            totalCents: Math.round(depositRequired * 100),
            successUrl: `${base}/book/${encodeURIComponent(slug)}?deposit=paid`,
            cancelUrl:  `${base}/book/${encodeURIComponent(slug)}?deposit=cancelled`,
            customerEmail: clientEmail,
          });
          depositCheckoutUrl = session.url;
          // Persist the session_id so the webhook can match it back to
          // the booking. Reuse the bookings.deposit_payment_intent slot
          // post-payment; for now stash the session id there as the
          // forward pointer (webhook overwrites with the PI).
          await sql`
            UPDATE bookings SET deposit_payment_intent = ${session.id}
            WHERE id = ${b.id}
          `;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[deposit] checkout session failed:', err.message);
      }
    }
    // Side effects (thread + emails). Don't await — the public booker
    // should see "confirmed!" without waiting on Resend round-trips.
    notifyNewBooking({ workspaceId, bookingId: b.id, source: 'public' });
    syncOnBookingCreated({ workspaceId: b.workspace_id, bookingId: b.id });
    attachIntakeForms({ workspaceId, bookingId: b.id });
    return created(res, {
      booking: {
        id: b.id,
        date: b.date instanceof Date ? b.date.toISOString().slice(0, 10) : b.date,
        startMin: b.start_min,
        endMin: b.end_min,
        depositRequired,
      },
      depositCheckoutUrl,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
