// The first win. A new owner's first session should end with something real
// in hand, so right after onboarding Ivy drafts three things from the answers
// they already gave (business name, services, hours), and the dashboard
// celebrates the first real booking and the first real payment once.
//
//   prepareFirstWin(workspaceId, answers)
//     Creates or confirms, from REAL answers only:
//       • at least one bookable service + the public booking link
//       • an unpublished website draft (hero, services, hours, booking,
//         contact, footer) with no placeholder reviews, numbers or logos
//       • a draft first invoice priced from the first service, with no
//         client attached (the owner fills in a name before sending)
//     Idempotent: re-running never duplicates. When an answer is missing it
//     creates nothing for that piece and reports it in `missing` so the UI
//     can ask inline instead of inventing a value.
//
//   recordFirstRealBooking / recordFirstRealPayment
//     Compare-and-set the workspaces.first_*_celebrated_at flag exactly once
//     for the first booking a CLIENT made (not owner-created, not sample
//     data) and the first paid invoice (not sample data), and drop an in-app
//     notification + push. The dashboard reads the pending celebration and
//     marks it shown, so the moment never repeats.
//
// Everything here is best-effort around the primary action: a failure in
// the celebration path must never break the booking or payment it follows.
import { sql } from './db.js';
import { mkSection } from '../../src/features/website/sections.js';
import { nextInvoiceNumber } from './finance.js';
import { appUrl } from './tokens.js';
import { notifyOwnerSafe } from './push.js';
import { invalidateCalendarSettings, VALID_HANDLE } from './calendar.js';
import { validateAvailability } from './settingsValidation.js';

const DEFAULT_BIZ_NAME = 'My business';
const WEEKDAYS = [
  { idx: 1, label: 'Mon' }, { idx: 2, label: 'Tue' }, { idx: 3, label: 'Wed' },
  { idx: 4, label: 'Thu' }, { idx: 5, label: 'Fri' }, { idx: 6, label: 'Sat' }, { idx: 0, label: 'Sun' },
];

export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');

function fmtClock(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
function fmtMoney(n, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n || 0));
  } catch { return `$${Number(n || 0).toFixed(2)}`; }
}
function fmtDate(d) {
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '');
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
const firstNameOf = (s) => String(s || '').trim().split(/\s+/)[0] || '';
const hasWindows = (availability) => !!availability && typeof availability === 'object'
  && Object.values(availability).some((v) => Array.isArray(v) && v.length > 0);

// ── Website draft (pure) ──────────────────────────────────────────────
// Only sections whose content comes from the owner's real answers. No
// testimonials, stats, logos or placeholder service tiers: a template
// with made-up reviews is exactly what a new owner would publish by
// accident.
export function buildFirstWebsitePages({ bizName, tagline, services = [], availability, timezone, slug, currency = 'USD' }) {
  const biz = String(bizName || '').trim();
  const sections = [];

  const hero = mkSection('hero', biz);
  hero.animate = 'rise';
  hero.data.headline = biz;
  hero.data.sub = (tagline || '').trim() || 'Book a session or get in touch.';
  hero.data.cta = 'Book a session';
  hero.data.ctaLink = '#book';
  sections.push(hero);

  if (services.length > 0) {
    const svc = mkSection('services', biz);
    svc.variant = services.length === 1 ? 'list' : 'grid';
    svc.animate = 'rise';
    svc.data.headline = 'Services';
    svc.data.sub = '';
    svc.data.items = services.slice(0, 12).map((s, i) => ({
      id: `i_${String(s.id || i).replace(/-/g, '').slice(0, 10)}`,
      name: String(s.name || '').slice(0, 120),
      desc: String(s.description || '').slice(0, 500),
      price: fmtMoney(s.price, currency),
      duration: `${Number(s.durationMinutes ?? s.duration_minutes) || 0} min`,
      imgUrl: s.photoUrl || s.photo_url || '',
    }));
    sections.push(svc);
  }

  if (hasWindows(availability)) {
    const hrs = mkSection('hours', biz);
    hrs.animate = 'fade';
    hrs.data.headline = 'Hours';
    hrs.data.timezone = timezone || '';
    hrs.data.days = WEEKDAYS.map((d, i) => {
      const windows = Array.isArray(availability[d.idx]) ? availability[d.idx] : (Array.isArray(availability[String(d.idx)]) ? availability[String(d.idx)] : []);
      const text = windows.length
        ? windows.map((w) => `${fmtClock(Number(w.start))} to ${fmtClock(Number(w.end))}`).join(', ')
        : 'Closed';
      return { id: `d${i + 1}`, label: d.label, hours: text };
    });
    sections.push(hrs);
  }

  const book = mkSection('booking', biz);
  book.animate = 'rise';
  book.data.headline = 'Book a session';
  book.data.sub = 'Pick a time that works for you.';
  book.data.handle = slug || '';
  sections.push(book);

  const contact = mkSection('contact', biz);
  contact.animate = 'fade';
  contact.data.headline = 'Get in touch';
  contact.data.sub = '';
  sections.push(contact);

  const footer = mkSection('footer', biz);
  footer.data.businessName = biz;
  footer.data.tagline = (tagline || '').trim();
  sections.push(footer);

  return [{
    id: `pg_${Date.now().toString(36)}_${Math.floor(Math.random() * 9999)}`,
    slug: '', title: 'Home', inNav: true, sections,
  }];
}

// ── Reads ─────────────────────────────────────────────────────────────
async function loadPieces(workspaceId) {
  const [ws, cs, sv, web, inv, fs, bk] = await Promise.all([
    sql`SELECT id, owner_id, onboarded_at, created_at, first_win_prepared_at, first_win_seen_at, first_win_invoice_id,
                booking_link_shared_at, first_booking_celebrated_at
           FROM workspaces WHERE id = ${workspaceId}`,
    sql`SELECT biz_name, slug, tagline, availability, timezone FROM calendar_settings WHERE workspace_id = ${workspaceId}`,
    sql`SELECT id, name, duration_minutes, price, description, photo_url FROM services
          WHERE workspace_id = ${workspaceId} ORDER BY display_order, created_at LIMIT 50`,
    sql`SELECT id, handle, business_name, pages, sections, launched, published_at, custom_domain, domain_status
           FROM websites WHERE workspace_id = ${workspaceId}`,
    sql`SELECT i.id, i.number, i.status, i.client_id, i.client_name, i.items, i.currency, i.total, i.created_at
           FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
          WHERE i.workspace_id = ${workspaceId} AND (c.source IS DISTINCT FROM 'demo')
          ORDER BY i.created_at ASC`,
    sql`SELECT currency FROM finance_settings WHERE workspace_id = ${workspaceId}`,
    sql`SELECT COUNT(*)::int AS n FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
          WHERE b.workspace_id = ${workspaceId} AND b.cancelled_at IS NULL AND (c.source IS DISTINCT FROM 'demo')`,
  ]);
  return {
    ws: ws.rows[0] || null,
    settings: cs.rows[0] || null,
    services: sv.rows,
    website: web.rows[0] || null,
    invoices: inv.rows,
    currency: fs.rows[0]?.currency || 'USD',
    realBookings: Number(bk.rows[0]?.n || 0),
  };
}

function websiteHasContent(row) {
  if (!row) return false;
  const pages = Array.isArray(row.pages) ? row.pages : [];
  if (pages.some((p) => Array.isArray(p.sections) && p.sections.length > 0)) return true;
  return Array.isArray(row.sections) && row.sections.length > 0;
}

function siteUrl(row) {
  if (!row) return null;
  if (row.custom_domain && row.domain_status === 'verified') return `https://${row.custom_domain}`;
  return row.handle ? `${appUrl()}/site/${row.handle}` : null;
}

function statusFrom(p) {
  const { ws, settings, services, website, invoices, currency, realBookings } = p;
  const bizName = settings?.biz_name && settings.biz_name.trim() && settings.biz_name.trim() !== DEFAULT_BIZ_NAME
    ? settings.biz_name.trim() : null;
  const slug = settings?.slug || null;
  const missing = [];
  if (!bizName) missing.push('businessName');
  if (services.length === 0) missing.push('service');

  const draft = ws?.first_win_invoice_id ? invoices.find((i) => i.id === ws.first_win_invoice_id) : null;
  const sentCount = invoices.filter((i) => i.status !== 'draft').length;
  const firstItem = draft && Array.isArray(draft.items) ? draft.items[0] : null;

  return {
    preparedAt: ws?.first_win_prepared_at || null,
    seenAt: ws?.first_win_seen_at || null,
    businessName: bizName,
    missing,
    booking: {
      ready: !!(bizName && slug && services.length > 0),
      slug,
      url: slug ? `${appUrl()}/book/${slug}` : null,
      services: services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.duration_minutes, price: Number(s.price) })),
      sharedAt: ws?.booking_link_shared_at || null,
      realBookings,
      firstBookingAt: ws?.first_booking_celebrated_at || null,
    },
    website: {
      ready: websiteHasContent(website),
      handle: website?.handle || null,
      url: siteUrl(website),
      editorPath: '/website',
      launched: !!website?.launched && !!website?.published_at,
      publishedAt: website?.published_at || null,
      sectionCount: websiteHasContent(website)
        ? ((Array.isArray(website.pages) && website.pages.length ? website.pages[0].sections : website.sections) || []).length
        : 0,
    },
    invoice: {
      ready: !!draft && draft.status === 'draft',
      id: draft?.id || null,
      number: draft?.number || null,
      status: draft?.status || null,
      description: firstItem?.description || null,
      amount: draft ? Number(draft.total || 0) : null,
      currency: draft?.currency || currency,
      sentCount,
    },
  };
}

export async function firstWinStatus(workspaceId) {
  return statusFrom(await loadPieces(workspaceId));
}

// ── Prepare ───────────────────────────────────────────────────────────
async function freeSlug(base, workspaceId) {
  const root = slugify(base);
  if (!root || !VALID_HANDLE.test(root)) return null;
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? root : `${root.slice(0, 36)}-${i + 1}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await sql`SELECT 1 FROM calendar_settings WHERE slug = ${candidate} AND workspace_id <> ${workspaceId} LIMIT 1`;
    if (clash.rows.length === 0) return candidate;
  }
  return null;
}
async function freeHandle(base, workspaceId) {
  const root = slugify(base);
  if (!root || !VALID_HANDLE.test(root)) return null;
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? root : `${root.slice(0, 36)}-${i + 1}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await sql`SELECT 1 FROM websites WHERE handle = ${candidate} AND workspace_id <> ${workspaceId} LIMIT 1`;
    if (clash.rows.length === 0) return candidate;
  }
  return null;
}

// `answers` is optional and mirrors what the wizard collects:
//   { bizName, tagline, service: { name, durationMinutes, price }, availability, timezone }
// Anything supplied is written to its real table first (same validation
// rules as the wizard endpoints); then the three pieces are built from
// whatever the workspace really has.
export async function prepareFirstWin(workspaceId, answers = {}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  await sql`INSERT INTO calendar_settings (workspace_id) VALUES (${workspaceId}) ON CONFLICT (workspace_id) DO NOTHING`;

  const a = answers && typeof answers === 'object' ? answers : {};
  const bizAnswer = typeof a.bizName === 'string' ? a.bizName.trim().slice(0, 120) : '';
  if (bizAnswer) {
    await sql`UPDATE calendar_settings SET biz_name = ${bizAnswer}, updated_at = NOW() WHERE workspace_id = ${workspaceId}`;
  }
  if (typeof a.tagline === 'string' && a.tagline.trim()) {
    await sql`UPDATE calendar_settings SET tagline = ${a.tagline.trim().slice(0, 200)}, updated_at = NOW() WHERE workspace_id = ${workspaceId}`;
  }
  if (a.availability) {
    const v = validateAvailability(a.availability);
    if (!v.error) {
      await sql`UPDATE calendar_settings SET availability = ${JSON.stringify(v.value)}::jsonb, updated_at = NOW() WHERE workspace_id = ${workspaceId}`;
    }
  }
  if (typeof a.timezone === 'string' && a.timezone.trim()) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: a.timezone.trim() });
      await sql`UPDATE calendar_settings SET timezone = ${a.timezone.trim()}, updated_at = NOW() WHERE workspace_id = ${workspaceId}`;
    } catch { /* not a real zone: leave it */ }
  }
  const svcAnswer = a.service && typeof a.service === 'object' ? a.service : null;
  if (svcAnswer && String(svcAnswer.name || '').trim()) {
    const existing = await sql`SELECT COUNT(*)::int AS n FROM services WHERE workspace_id = ${workspaceId}`;
    if (Number(existing.rows[0]?.n) === 0) {
      const dur = Math.max(5, Math.min(24 * 60, Math.round(Number(svcAnswer.durationMinutes) || 60)));
      const price = Math.max(0, Math.round((Number(svcAnswer.price) || 0) * 100) / 100);
      await sql`
        INSERT INTO services (workspace_id, name, duration_minutes, price, display_order, visibility)
        VALUES (${workspaceId}, ${String(svcAnswer.name).trim().slice(0, 120)}, ${dur}, ${price}, 0, 'public')
      `;
    }
  }
  invalidateCalendarSettings(workspaceId);

  let p = await loadPieces(workspaceId);
  const bizName = p.settings?.biz_name && p.settings.biz_name.trim() !== DEFAULT_BIZ_NAME ? p.settings.biz_name.trim() : null;

  // Booking link: only derive a handle from a REAL business name.
  if (bizName && !p.settings?.slug) {
    const slug = await freeSlug(bizName, workspaceId);
    if (slug) {
      await sql`UPDATE calendar_settings SET slug = ${slug}, updated_at = NOW() WHERE workspace_id = ${workspaceId}`;
      invalidateCalendarSettings(workspaceId);
      p = await loadPieces(workspaceId);
    }
  }

  // Website draft: built once, never over an owner's own content, never published.
  if (bizName && !websiteHasContent(p.website)) {
    const handle = p.website?.handle || await freeHandle(p.settings?.slug || bizName, workspaceId);
    const pages = buildFirstWebsitePages({
      bizName,
      tagline: p.settings?.tagline || '',
      services: p.services.map((s) => ({ ...s, durationMinutes: s.duration_minutes })),
      availability: p.settings?.availability,
      timezone: p.settings?.timezone || '',
      slug: p.settings?.slug || '',
      currency: p.currency,
    });
    const seoDesc = (p.settings?.tagline || '').trim() || null;
    if (p.website) {
      await sql`
        UPDATE websites SET
          business_name = ${bizName}, handle = COALESCE(handle, ${handle}),
          template = COALESCE(template, 'clean'), font_pair = COALESCE(font_pair, 'fraunces_inter'),
          pages = ${JSON.stringify(pages)}::jsonb, sections = ${JSON.stringify(pages[0].sections)}::jsonb,
          seo_title = COALESCE(seo_title, ${bizName}), seo_description = COALESCE(seo_description, ${seoDesc}),
          updated_at = NOW()
        WHERE workspace_id = ${workspaceId}
      `;
    } else {
      await sql`
        INSERT INTO websites (workspace_id, handle, business_name, template, font_pair, pages, sections, seo_title, seo_description)
        VALUES (${workspaceId}, ${handle}, ${bizName}, 'clean', 'fraunces_inter',
                ${JSON.stringify(pages)}::jsonb, ${JSON.stringify(pages[0].sections)}::jsonb, ${bizName}, ${seoDesc})
        ON CONFLICT (workspace_id) DO NOTHING
      `;
    }
  }

  // First invoice draft: priced from the first real service, no client.
  // Only when the workspace has never had an invoice of its own.
  if (p.services.length > 0 && !p.ws?.first_win_invoice_id && p.invoices.length === 0) {
    const s = p.services[0];
    const num = await nextInvoiceNumber(workspaceId);
    const items = [{ id: 'li1', description: String(s.name).slice(0, 500), quantity: 1, rate: Math.round(Number(s.price || 0) * 100) / 100 }];
    const fs = await sql`SELECT default_tax_rate FROM finance_settings WHERE workspace_id = ${workspaceId}`;
    const taxRate = Number(fs.rows[0]?.default_tax_rate || 0);
    const ins = await sql`
      INSERT INTO invoices (workspace_id, number, client_id, client_name, client_email, items, tax_rate, discount, status, currency)
      VALUES (${workspaceId}, ${`INV-${num}`}, NULL, NULL, NULL, ${JSON.stringify(items)}::jsonb, ${taxRate}, 0, 'draft', ${p.currency})
      RETURNING id
    `;
    await sql`UPDATE workspaces SET first_win_invoice_id = ${ins.rows[0].id} WHERE id = ${workspaceId} AND first_win_invoice_id IS NULL`;
  }

  await sql`UPDATE workspaces SET first_win_prepared_at = COALESCE(first_win_prepared_at, NOW()) WHERE id = ${workspaceId}`;
  return statusFrom(await loadPieces(workspaceId));
}

export async function markBookingLinkShared(workspaceId) {
  await sql`UPDATE workspaces SET booking_link_shared_at = COALESCE(booking_link_shared_at, NOW()) WHERE id = ${workspaceId}`;
}
export async function markFirstWinSeen(workspaceId) {
  await sql`UPDATE workspaces SET first_win_seen_at = COALESCE(first_win_seen_at, NOW()) WHERE id = ${workspaceId}`;
}

// Should the dashboard show the ready cards? Only for a workspace that
// finished onboarding recently and has not continued past them yet. An
// established owner never sees drafts appear unasked, and a product-only
// business (no bookable services) skips them, as the wizard does.
export async function shouldShowReady(workspaceId) {
  const { rows } = await sql`
    SELECT 1 FROM workspaces
     WHERE id = ${workspaceId}
       AND onboarded_at IS NOT NULL
       AND first_win_seen_at IS NULL
       AND created_at > NOW() - INTERVAL '30 days'
       AND COALESCE(business_type, 'both') <> 'product'
  `;
  return rows.length > 0;
}

// ── Celebrations ──────────────────────────────────────────────────────
// `source` is the same value bookingNotify receives: 'public' (booking
// link), 'client-portal', 'waitlist' are client-made; 'owner' is the
// owner adding a booking by hand and never counts as the first win.
export async function recordFirstRealBooking({ workspaceId, bookingId, source }) {
  try {
    if (!workspaceId || !bookingId) return false;
    if (source === 'owner') return false;
    const { rows } = await sql`
      SELECT b.client_name, b.date, b.start_min, b.cancelled_at, b.notes,
             s.name AS service_name, c.source AS client_source
        FROM bookings b
        LEFT JOIN services s ON s.id = b.service_id
        LEFT JOIN clients c ON c.id = b.client_id
       WHERE b.id = ${bookingId} AND b.workspace_id = ${workspaceId}
    `;
    const b = rows[0];
    if (!b || b.cancelled_at) return false;
    if (b.client_source === 'demo' || /^\[Sample\]/.test(b.notes || '')) return false;

    const dateISO = b.date instanceof Date ? b.date.toISOString().slice(0, 10) : String(b.date);
    const celebration = {
      kind: 'booking',
      clientFirstName: firstNameOf(b.client_name),
      serviceName: b.service_name || null,
      date: dateISO,
      dateLabel: fmtDate(dateISO),
      timeLabel: fmtClock(Number(b.start_min)),
    };
    const upd = await sql`
      UPDATE workspaces
         SET first_booking_celebrated_at = NOW(), first_booking_celebration = ${JSON.stringify(celebration)}::jsonb
       WHERE id = ${workspaceId} AND first_booking_celebrated_at IS NULL
       RETURNING id
    `;
    if (upd.rowCount === 0) return false;

    const who = celebration.clientFirstName || 'A client';
    const what = celebration.serviceName ? ` for ${celebration.serviceName}` : '';
    await notifyOwnerSafe({
      workspaceId, type: 'bookings',
      payload: {
        title: 'Your first booking is in.',
        body: `${who} booked${what} on ${celebration.dateLabel} at ${celebration.timeLabel}.`,
        url: '/dashboard',
        tag: 'first-win-booking',
      },
    });
    return true;
  } catch (e) {
    console.warn('[firstWin] recordFirstRealBooking failed:', e?.message);
    return false;
  }
}

export async function recordFirstRealPayment({ workspaceId, invoiceId }) {
  try {
    if (!workspaceId || !invoiceId) return false;
    const { rows } = await sql`
      SELECT i.number, i.client_name, i.status, i.paid_amount, i.total, i.currency, i.notes,
             c.source AS client_source
        FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.id = ${invoiceId} AND i.workspace_id = ${workspaceId}
    `;
    const inv = rows[0];
    if (!inv || inv.status !== 'paid') return false;
    if (inv.client_source === 'demo' || /^SAMPLE-/.test(inv.number || '') || /^\[Sample\]/.test(inv.notes || '')) return false;

    const amount = Number(inv.paid_amount ?? inv.total ?? 0);
    const celebration = {
      kind: 'payment',
      clientFirstName: firstNameOf(inv.client_name),
      amount,
      amountLabel: fmtMoney(amount, inv.currency || 'USD'),
      number: inv.number,
    };
    const upd = await sql`
      UPDATE workspaces
         SET first_payment_celebrated_at = NOW(), first_payment_celebration = ${JSON.stringify(celebration)}::jsonb
       WHERE id = ${workspaceId} AND first_payment_celebrated_at IS NULL
       RETURNING id
    `;
    if (upd.rowCount === 0) return false;

    const who = celebration.clientFirstName || 'A client';
    await notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: {
        title: 'Your first payment is in.',
        body: `${who} paid ${celebration.amountLabel} on invoice ${inv.number}.`,
        url: '/dashboard',
        tag: 'first-win-payment',
      },
    });
    return true;
  } catch (e) {
    console.warn('[firstWin] recordFirstRealPayment failed:', e?.message);
    return false;
  }
}

// Celebrations fired but not yet shown on the dashboard.
export async function pendingCelebrations(workspaceId) {
  const { rows } = await sql`
    SELECT first_booking_celebrated_at, first_booking_celebration, first_booking_celebration_shown_at,
           first_payment_celebrated_at, first_payment_celebration, first_payment_celebration_shown_at
      FROM workspaces WHERE id = ${workspaceId}
  `;
  const r = rows[0];
  if (!r) return [];
  const out = [];
  if (r.first_booking_celebrated_at && !r.first_booking_celebration_shown_at) {
    out.push({ ...(r.first_booking_celebration || {}), kind: 'booking', at: r.first_booking_celebrated_at });
  }
  if (r.first_payment_celebrated_at && !r.first_payment_celebration_shown_at) {
    out.push({ ...(r.first_payment_celebration || {}), kind: 'payment', at: r.first_payment_celebrated_at });
  }
  return out;
}

export async function markCelebrationShown(workspaceId, kind) {
  if (kind === 'booking') {
    await sql`UPDATE workspaces SET first_booking_celebration_shown_at = COALESCE(first_booking_celebration_shown_at, NOW())
               WHERE id = ${workspaceId} AND first_booking_celebrated_at IS NOT NULL`;
  } else if (kind === 'payment') {
    await sql`UPDATE workspaces SET first_payment_celebration_shown_at = COALESCE(first_payment_celebration_shown_at, NOW())
               WHERE id = ${workspaceId} AND first_payment_celebrated_at IS NOT NULL`;
  }
}

// Dashboard rollup. Never throws: the dashboard must render without it.
export async function firstWinForDashboard(workspaceId) {
  try {
    const [showReady, celebrations] = await Promise.all([shouldShowReady(workspaceId), pendingCelebrations(workspaceId)]);
    return { showReady, celebrations };
  } catch {
    return { showReady: false, celebrations: [] };
  }
}
