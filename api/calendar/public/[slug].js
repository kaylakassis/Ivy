// /api/calendar/public/:slug
//   GET  → public calendar state (settings + services + blocks + bookings,
//          client identities redacted on bookings)
//   POST → create a booking via the public link. Body:
//          { serviceId, date, startMin, endMin, clientName, clientEmail, notes? }

import { sql } from '../../_lib/db.js';
import { readBody } from '../../_lib/body.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import {
  serializeSettings, serializeService, serializeBlock, serializeBooking,
  hasConflict, withinAvailability, depositFor, mintVideoRoomUrl,
} from '../../_lib/calendar.js';
import { findActiveByCode, redeemAtomic } from '../../_lib/giftCards.js';
import { validEmail } from '../../_lib/auth.js';
import { normalizePhone } from '../../_lib/sms.js';
import { notifyNewBooking } from '../../_lib/bookingNotify.js';
import { syncOnBookingCreated } from '../../_lib/googleSync.js';
import { attachIntakeForms } from '../../_lib/intake.js';
import { createCheckoutSession } from '../../_lib/stripe.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { appUrl } from '../../_lib/tokens.js';
import { sendClientInvite } from '../../_lib/clientNotify.js';
import {
  badRequest, created, methodNotAllowed, notFound, ok, serverError,
} from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  // Public endpoint never goes through requireUser, so bootstrap the
  // schema here on cold-start to self-heal columns/tables added in
  // recent deploys (e.g. services.visibility).
  await ensureSchemaApplied();
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

    // Public booking page hides 'only_me' services entirely (they're
    // drafts the owner doesn't want anyone to see) but keeps 'private'
    // ones — clients with a direct link/share can still book those.
    const services = await sql`
      SELECT * FROM services
      WHERE workspace_id = ${s.workspace_id}
        AND visibility != 'only_me'
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

    // Reviews block — drives the on-page social proof + the JSON-LD
    // structured data we inject for SEO. Aggregate is computed across
    // every visible review; "recent" caps at 12 so the payload stays
    // small and the page renders quickly.
    const [agg, recent] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n,
                 ROUND(AVG(rating)::numeric, 2)::float AS avg
            FROM reviews
            WHERE workspace_id = ${s.workspace_id} AND status = 'visible'`,
      sql`SELECT id, reviewer_name, rating, text, owner_response, created_at
            FROM reviews
            WHERE workspace_id = ${s.workspace_id} AND status = 'visible'
            ORDER BY created_at DESC LIMIT 12`,
    ]);
    const reviewSummary = {
      count: agg.rows[0]?.n || 0,
      avg:   agg.rows[0]?.avg || null,
      recent: recent.rows.map((r) => ({
        id: r.id,
        reviewerName: r.reviewer_name,
        rating: r.rating,
        text: r.text || '',
        ownerResponse: r.owner_response || null,
        createdAt: r.created_at,
      })),
    };

    // Active membership tiers, surfaced on the public booking page so
    // visitors can join. Only active rows with a Stripe price (i.e.
    // genuinely buyable) — stripe_price_id null tiers are still in
    // the owner's draft state and shouldn't be shown to the public.
    const mships = await sql`
      SELECT id, name, description, price_cents, interval, perks, display_order
        FROM memberships
       WHERE workspace_id = ${s.workspace_id}
         AND active = TRUE
         AND stripe_price_id IS NOT NULL
       ORDER BY display_order ASC, created_at ASC
    `;
    const membershipsOut = mships.rows.map((r) => ({
      id:          r.id,
      name:        r.name,
      description: r.description || '',
      priceCents:  Number(r.price_cents || 0),
      interval:    r.interval,
      perks:       r.perks || [],
    }));

    return ok(res, {
      calendar: {
        settings: serializeSettings(s),
        services: services.rows.map(serializeService),
        blocks:   blocksOut,
        bookings: bookings.rows.map((r) => serializeBooking(r, { redactClient: true })),
        reviews:  reviewSummary,
        memberships: membershipsOut,
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
    // Reject bookings on 'only_me' services (drafts the owner shouldn't
    // be receiving bookings for); 'private' is bookable by direct link.
    const svcRows = await sql`
      SELECT id, duration_minutes, capacity, price, deposit_type, deposit_amount,
             location_type, travel_buffer_minutes,
             custom_fields, add_ons, visibility
        FROM services
       WHERE id = ${serviceId} AND workspace_id = ${workspaceId}
    `;
    if (svcRows.rows.length === 0) return badRequest(res, 'Unknown service');
    if (svcRows.rows[0].visibility === 'only_me') {
      return badRequest(res, 'This service is not available to book.');
    }
    const svc = svcRows.rows[0];
    const serviceCapacity = Math.max(1, Number(svc.capacity) || 1);
    const locationType  = svc.location_type || 'in_person';
    const travelBuffer  = Number(svc.travel_buffer_minutes || 0);

    // Add-ons: validate every requested add-on belongs to this
    // service and pull its price + duration delta. Selected add-ons
    // extend the slot duration, so the requested (end - start) must
    // equal service.duration + sum(add-on durations).
    const requestedAddOnIds = Array.isArray(body.addOnIds) ? body.addOnIds.map(String) : [];
    const availableAddOns = Array.isArray(svc.add_ons) ? svc.add_ons : [];
    const selectedAddOns = [];
    for (const id of requestedAddOnIds) {
      const found = availableAddOns.find((a) => a.id === id);
      if (!found) return badRequest(res, `Unknown add-on: ${id}`);
      selectedAddOns.push(found);
    }
    const addOnDuration = selectedAddOns.reduce((s, a) => s + Number(a.durationMinutes || 0), 0);
    const expectedDuration = svc.duration_minutes + addOnDuration;
    if ((end - start) !== expectedDuration) {
      return badRequest(res, 'Slot duration does not match service + add-ons');
    }
    const addOnTotal = selectedAddOns.reduce((s, a) => s + Number(a.price || 0), 0);
    const bookingTotal = Number(svc.price || 0) + addOnTotal;

    // Custom intake fields: validate required fields present, types ok.
    const customFields = Array.isArray(svc.custom_fields) ? svc.custom_fields : [];
    const customValues = (body.customFieldValues && typeof body.customFieldValues === 'object')
      ? body.customFieldValues : {};
    const cleanedCustomValues = {};
    for (const f of customFields) {
      const raw = customValues[f.id];
      const isEmpty = raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0);
      if (f.required && isEmpty) {
        return badRequest(res, `"${f.label || f.id}" is required`);
      }
      if (isEmpty) continue;
      let val = raw;
      if (f.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) return badRequest(res, `"${f.label || f.id}" must be a number`);
        val = n;
      } else if (f.type === 'select') {
        const opts = Array.isArray(f.options) ? f.options : [];
        if (opts.length > 0 && !opts.includes(String(raw))) {
          return badRequest(res, `"${f.label || f.id}" must be one of: ${opts.join(', ')}`);
        }
        val = String(raw);
      } else if (f.type === 'checkbox') {
        val = !!raw;
      } else {
        val = String(raw).slice(0, 4000);
      }
      cleanedCustomValues[f.id] = val;
    }

    // Recompute deposit using the booking total (service + add-ons),
    // not just service.price — owners expect a 25% deposit on a $200
    // service+add-on combo to be $50, not $50 of just the service.
    let depositRequired = depositFor(svc, bookingTotal);

    // Optional gift card application. Resolved up-front (before insert)
    // so we know how much credit to apply + how much deposit remains
    // after the credit. If the credit covers the whole deposit, we
    // skip the Stripe Checkout entirely.
    const giftCardCode = body.giftCardCode ? String(body.giftCardCode) : null;
    let giftCardRow = null;
    let giftCardCreditCents = 0;
    if (giftCardCode) {
      giftCardRow = await findActiveByCode(workspaceId, giftCardCode);
      if (!giftCardRow) return badRequest(res, "That gift card code isn't valid (or has been used up).");
      // Apply the lesser of (gift card balance, booking total) — owners
      // collect the rest from the client either at the chair (no deposit
      // required) or via a reduced deposit + balance-due-at-session.
      const totalCents = Math.round(Number(bookingTotal) * 100);
      giftCardCreditCents = Math.min(Number(giftCardRow.balance_cents), totalCents);
    }
    // Reduce the deposit by the gift card credit (never below zero).
    if (giftCardCreditCents > 0) {
      const depositCents = Math.round(Number(depositRequired) * 100);
      const reducedCents = Math.max(0, depositCents - giftCardCreditCents);
      depositRequired = reducedCents / 100;
    }

    // Mobile-service address capture. Required at booking time so the
    // owner knows where to go. Saved on the client row so subsequent
    // bookings pre-fill it.
    let locationAddress = null;
    if (locationType === 'mobile') {
      locationAddress = (body.locationAddress || '').toString().trim().slice(0, 500);
      if (!locationAddress) return badRequest(res, "Please share where we should come for this service.");
    }

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

    if (await hasConflict({
      workspaceId, dateISO: date, start, end, serviceId,
      capacity: serviceCapacity, travelBufferMin: travelBuffer,
    })) {
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
      // Persist the address from a mobile booking onto the client row so
      // the next time they book, the field pre-fills. Falls back to the
      // existing saved address if the form didn't supply one.
      const newAddress = locationAddress || null;
      await sql`
        UPDATE clients SET
          last_seen_at   = NOW(),
          phone          = ${newPhone},
          sms_consent_at = ${newConsent},
          address        = COALESCE(${newAddress}, address)
        WHERE id = ${clientId}
      `;
    } else {
      const newClient = await sql`
        INSERT INTO clients (workspace_id, name, email, phone, sms_consent_at, address, stage, source, last_seen_at)
        VALUES (${workspaceId}, ${clientName}, ${clientEmail},
                ${clientPhone}, ${smsConsent ? new Date().toISOString() : null},
                ${locationAddress},
                'lead', 'Booking', NOW())
        RETURNING id
      `;
      clientId = newClient.rows[0].id;
      // First-time booker — email a "claim your account" invite alongside
      // the booking confirmation that notifyNewBooking sends.
      sendClientInvite({ workspaceId, clientId });
    }

    // Mint a video room when the service is virtual. Per-booking
    // unique URL so a leaked link can't be reused for a future
    // session with a different client.
    const videoRoomUrl = locationType === 'virtual' ? mintVideoRoomUrl() : null;

    const insert = await sql`
      INSERT INTO bookings (
        workspace_id, service_id, client_id, client_name, client_email, client_phone,
        date, start_min, end_min, notes, deposit_required, location_address,
        video_room_url, custom_field_values, add_on_ids, booking_total,
        gift_card_credit_cents
      )
      VALUES (
        ${workspaceId}, ${serviceId}, ${clientId}, ${clientName}, ${clientEmail}, ${clientPhone},
        ${date}, ${start}, ${end}, ${notes}, ${depositRequired}, ${locationAddress},
        ${videoRoomUrl},
        ${JSON.stringify(cleanedCustomValues)}::jsonb,
        ${JSON.stringify(requestedAddOnIds)}::jsonb,
        ${bookingTotal},
        ${giftCardCreditCents}
      )
      RETURNING *
    `;
    const newBookingRow = insert.rows[0];

    // Atomically debit the gift card after the booking row exists. If
    // the redemption fails (race against another concurrent redemption),
    // roll back the gift_card_credit_cents on the booking — the booking
    // itself stays so the slot isn't lost.
    if (giftCardRow && giftCardCreditCents > 0) {
      try {
        await redeemAtomic({
          giftCardId: giftCardRow.id,
          workspaceId,
          amountCents: giftCardCreditCents,
          appliedToKind: 'booking',
          appliedToId: newBookingRow.id,
          clientId,
        });
      } catch (err) {
        await sql`UPDATE bookings SET gift_card_credit_cents = 0 WHERE id = ${newBookingRow.id}`;
        return badRequest(res, 'Gift card was just used by another transaction — please try a different code.');
      }
    }
    const b = newBookingRow;

    // If a deposit is required AND the workspace has Stripe connected,
    // mint a Checkout session for the deposit and return its URL so
    // the public booker can redirect the client to pay. Failures here
    // don't block the booking — the slot is held; owner can collect
    // the deposit manually later.
    let depositCheckoutUrl = null;
    if (depositRequired > 0) {
      try {
        // loadStripeCreds throws on no_stripe_connection; we swallow
        // (deposit becomes manual) so the booking still completes.
        let creds = null;
        try { creds = await loadStripeCreds(workspaceId); }
        catch (credsErr) {
          if (credsErr.code !== 'no_stripe_connection') throw credsErr;
        }
        if (creds) {
          const base = appUrl();
          const session = await createCheckoutSession({
            secretKey:     creds.secretKey,
            stripeAccount: creds.stripeAccount,
            invoice: {
              id: `bookdep_${b.id}`,
              number: `Deposit · ${b.id.slice(0, 8)}`,
              workspace_id: workspaceId,
            },
            currency:   creds.currency,
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
        videoRoomUrl: b.video_room_url || null,
        bookingTotal: Number(b.booking_total || 0),
        locationType,
        depositRequired,
      },
      depositCheckoutUrl,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
