// Shops: one physical location, many independent Ivy businesses.
//
// A shop is a shared public page (/shop/:slug) that presents its members
// together and lets a visitor book any of them, or the first available one.
// Nothing is pooled. Every member is its own Ivy business with its own
// workspace, payments, clients, prices and policies. A booking made from
// the shop page goes through that member's OWN public booking path
// (POST /api/calendar/public/:memberSlug with shopSlug), so the deposit,
// policy, intake and notifications are exactly what the member set up.
//
// Privacy rules this module enforces:
//   • Membership is explicit consent: a business appears on the page only
//     after accepting an invite, and disappears the moment it leaves, is
//     removed, or its plan lapses (hidden, not deleted).
//   • The shop owner sees counts only (bookings made through the page per
//     member). Never another member's clients, revenue or messages.
//   • Public payloads carry only what each member's own public booking
//     page already shows, narrowed further to the services the member
//     chose to list on the shop.
//   • Every owner/member query is scoped by the caller's workspace id.
import crypto from 'node:crypto';
import { sql } from './db.js';
import {
  VALID_HANDLE, serializeService, serializeBlock, serializeBooking, publicLocationLabel,
} from './calendar.js';
import { isWorkspaceActive } from './clientPortal.js';
import { loadWorkspaceAccess } from './businessAccess.js';
import { generateRawToken, appUrl } from './tokens.js';
import { sendEmail, sendEmailToUser, emailShell } from './email.js';
import { notifyOwnerSafe } from './push.js';
import { fetchBranding } from './branding.js';
import { normalizeAccountEmail, validEmail } from './auth.js';
import { TEMPLATES } from '../../src/features/website/templates.js';

export const SHOP_INVITE_TTL_DAYS = 14;
export const MAX_SHOP_PHOTOS = 12;
export const MAX_SHOP_MEMBERS = 40;
export const MAX_SHOPS_PER_WORKSPACE = 5;

// Fixed list of amenity tags a shop can show. Stored by id.
export const SHOP_AMENITIES = [
  { id: 'parking', label: 'Parking' },
  { id: 'street_parking', label: 'Street parking' },
  { id: 'walk_ins', label: 'Walk-ins welcome' },
  { id: 'by_appointment', label: 'By appointment only' },
  { id: 'wheelchair', label: 'Wheelchair access' },
  { id: 'kids_welcome', label: 'Kids welcome' },
  { id: 'card_payments', label: 'Card payments' },
  { id: 'wifi', label: 'Free Wi-Fi' },
  { id: 'restroom', label: 'Restroom' },
  { id: 'refreshments', label: 'Refreshments' },
  { id: 'pet_friendly', label: 'Pet friendly' },
  { id: 'transit', label: 'Near public transit' },
  { id: 'open_late', label: 'Open late' },
  { id: 'gender_neutral_pricing', label: 'Gender neutral pricing' },
];
export const SHOP_AMENITY_IDS = new Set(SHOP_AMENITIES.map((a) => a.id));
export const SHOP_AMENITY_LABELS = Object.fromEntries(SHOP_AMENITIES.map((a) => [a.id, a.label]));

// Themes come from the website builder so a shop can match a member's site.
export const SHOP_THEMES = Object.keys(TEMPLATES);
export const DEFAULT_SHOP_THEME = 'clean';

// Slugs that would collide with app routes or read badly.
export const RESERVED_SHOP_SLUGS = new Set([
  'new', 'invite', 'admin', 'api', 'me', 'book', 'site', 'shop', 'shops', 'ivy', 'app', 'sitemap',
  'robots', 'login', 'signin', 'signup', 'account', 'dashboard', 'help', 'support',
]);

export const MEMBER_STATUSES = ['invited', 'active', 'declined', 'left', 'removed'];

// What the shop page shows about a member, and what it never shows. Used
// by the invite email, the invite card and the member's listing screen so
// the promise is worded once.
export const SHARED_ON_SHOP = [
  'Your business name, photo and bio',
  'The services and prices you choose to show',
  'Your open times and next available time',
  'Your reviews, labelled as yours',
];
export const NEVER_ON_SHOP = [
  'Your clients',
  'Your money',
  'Your messages',
];
export const SHOP_PLAN_NOTE = 'A shop and each business on it need an Ivy plan, trial or complimentary access. A manager who does not take bookings can still create a business and leave services empty.';

export class ShopError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const str = (v, max) => (v == null ? null : String(v).replace(/\u0000/g, '').trim().slice(0, max) || null);
export function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── validation ───────────────────────────────────────────────────────────

export function validShopSlug(slug) {
  const s = String(slug || '').toLowerCase().trim();
  return !!s && VALID_HANDLE.test(s) && !RESERVED_SHOP_SLUGS.has(s);
}

// Opening hours: {"0":[{start,end}],...}. Returns the cleaned object or
// throws. At most 4 windows a day, whole minutes inside one day.
export function cleanHours(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ShopError(400, 'Hours must be a weekday map');
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const list = raw[String(d)];
    if (list == null) { out[String(d)] = []; continue; }
    if (!Array.isArray(list) || list.length > 4) throw new ShopError(400, 'Each day can have up to 4 open windows');
    const windows = list.map((w) => {
      const start = Number(w?.start), end = Number(w?.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 * 60 || start >= end) {
        throw new ShopError(400, 'Open windows need a start before an end, inside one day');
      }
      return { start, end };
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < windows.length; i++) {
      if (windows[i].start < windows[i - 1].end) throw new ShopError(400, 'Open windows on the same day cannot overlap');
    }
    out[String(d)] = windows;
  }
  return out;
}

export function normalizeShopSettings(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    firstAvailable: o.firstAvailable !== false,
    showPrices: o.showPrices !== false,
    showReviews: o.showReviews !== false,
    theme: SHOP_THEMES.includes(o.theme) ? o.theme : DEFAULT_SHOP_THEME,
    bookingRulesNote: str(o.bookingRulesNote, 400) || '',
  };
}

function cleanPhotos(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ShopError(400, 'Photos must be a list');
  const out = [];
  for (const p of raw) {
    const url = str(typeof p === 'string' ? p : p?.url, 600);
    if (!url) continue;
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/\S*$/.test(url)) throw new ShopError(400, 'Photo links must start with https://');
    if (!out.includes(url)) out.push(url);
    if (out.length > MAX_SHOP_PHOTOS) throw new ShopError(400, `Up to ${MAX_SHOP_PHOTOS} photos`);
  }
  return out;
}

function cleanAmenities(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ShopError(400, 'Amenities must be a list');
  const out = [];
  for (const a of raw) {
    const id = String(a || '');
    if (!SHOP_AMENITY_IDS.has(id)) throw new ShopError(400, `Unknown amenity: ${id.slice(0, 40)}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function cleanCoord(v, max) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) throw new ShopError(400, 'Map coordinates are out of range');
  return Math.round(n * 1e6) / 1e6;
}

function cleanTimezone(tz) {
  const t = str(tz, 64);
  if (!t) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t; }
  catch { throw new ShopError(400, 'Unknown time zone'); }
}

// Body → { column: value } for shops. `create` requires name + slug.
export function cleanShopPatch(body, { create = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if ('name' in b || create) {
    const v = str(b.name, 120);
    if (!v) throw new ShopError(400, 'Give the shop a name');
    out.name = v;
  }
  if ('slug' in b || create) {
    const v = String(b.slug || '').toLowerCase().trim();
    if (!validShopSlug(v)) throw new ShopError(400, 'Pick a web address with 1 to 40 lowercase letters, digits or hyphens');
    out.slug = v;
  }
  if ('tagline' in b) out.tagline = str(b.tagline, 160);
  if ('description' in b) out.description = str(b.description, 2000);
  if ('addressLabel' in b) out.address_label = str(b.addressLabel, 300);
  if ('city' in b) out.city = str(b.city, 80);
  if ('region' in b) out.region = str(b.region, 80);
  if ('country' in b) out.country = str(b.country, 80);
  if ('lat' in b) out.lat = cleanCoord(b.lat, 90);
  if ('lng' in b) out.lng = cleanCoord(b.lng, 180);
  if ('phone' in b) {
    const v = str(b.phone, 40);
    if (v && !/^[+\d][\d\s().-]{5,39}$/.test(v)) throw new ShopError(400, 'That phone number does not look right');
    out.phone = v;
  }
  if ('timezone' in b) out.timezone = cleanTimezone(b.timezone);
  if ('hours' in b) out.hours = cleanHours(b.hours);
  if ('photos' in b) out.photos = cleanPhotos(b.photos);
  if ('amenities' in b) out.amenities = cleanAmenities(b.amenities);
  if ('settings' in b) {
    if (b.settings != null && (typeof b.settings !== 'object' || Array.isArray(b.settings))) throw new ShopError(400, 'Settings must be an object');
    out.settings = normalizeShopSettings(b.settings);
  }
  return out;
}

// ── serializers ──────────────────────────────────────────────────────────

export function serializeShop(row, { owner = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline || '',
    description: row.description || '',
    addressLabel: row.address_label || '',
    city: row.city || '',
    region: row.region || '',
    country: row.country || '',
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    phone: row.phone || '',
    timezone: row.timezone || null,
    hours: row.hours || {},
    photos: Array.isArray(row.photos) ? row.photos : [],
    amenities: Array.isArray(row.amenities) ? row.amenities : [],
    settings: normalizeShopSettings(row.settings),
    status: row.status,
    publishedAt: row.published_at || null,
    url: `/shop/${row.slug}`,
  };
  if (owner) {
    base.ownerWorkspaceId = row.owner_workspace_id;
    base.pageViews = Number(row.page_views || 0);
    base.hasJoinLink = !!row.join_token_hash && (!row.join_token_expires_at || new Date(row.join_token_expires_at).getTime() > Date.now());
    base.joinLinkExpiresAt = row.join_token_expires_at || null;
    base.createdAt = row.created_at;
    base.updatedAt = row.updated_at;
  }
  return base;
}

// Roster row for the owner's screen and the member's own listing. Never
// carries another member's private data: only what the public page shows
// plus the invite state the owner needs.
export function serializeMember(row, { owner = false } = {}) {
  const out = {
    id: row.id,
    status: row.status,
    role: row.role,
    displayOrder: Number(row.display_order || 0),
    featured: !!row.featured,
    title: row.title || '',
    bio: row.bio || '',
    visibleServiceIds: Array.isArray(row.visible_service_ids) ? row.visible_service_ids : null,
    businessName: row.biz_name || null,
    bookingSlug: row.booking_slug || null,
    photoUrl: row.brand_logo_url || null,
    proName: row.pro_name || null,
    joinedAt: row.joined_at || null,
    invitedAt: row.invited_at || null,
    leftAt: row.left_at || null,
    // Whether the member's plan currently lets them show on the page.
    planActive: row.workspace_id ? isWorkspaceActive(row) : false,
  };
  if (owner) {
    out.inviteEmail = row.invite_email || null;
    out.inviteExpiresAt = row.invite_expires_at || null;
    out.inviteExpired = !!row.invite_expires_at && new Date(row.invite_expires_at).getTime() <= Date.now();
  }
  return out;
}

const MEMBER_SELECT = `
  SELECT sm.*, cs.biz_name, cs.slug AS booking_slug, cs.brand_logo_url, cs.brand_accent_color,
         cs.timezone, cs.availability, cs.slot_minutes, cs.slot_fit_service, cs.buffer_minutes,
         cs.min_notice_hours, cs.max_advance_days, cs.category, cs.address_label, cs.tagline,
         u.name AS pro_name,
         w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until
    FROM shop_members sm
    LEFT JOIN workspaces w ON w.id = sm.workspace_id
    LEFT JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
    LEFT JOIN calendar_settings cs ON cs.workspace_id = sm.workspace_id`;

export async function listMembers(shopId) {
  const { rows } = await sql.query(
    `${MEMBER_SELECT} WHERE sm.shop_id = $1 ORDER BY (sm.role = 'owner') DESC, sm.featured DESC, sm.display_order ASC, sm.created_at ASC`,
    [shopId],
  );
  return rows;
}

// ── lookups ──────────────────────────────────────────────────────────────

export async function loadOwnedShop(shopId, workspaceId) {
  if (!isUuid(shopId) || !workspaceId) return null;
  const { rows } = await sql`SELECT * FROM shops WHERE id = ${shopId} AND owner_workspace_id = ${workspaceId} LIMIT 1`;
  return rows[0] || null;
}

// A shop the workspace can see from the inside: as its owner or as a
// member (any status, so a removed member can still read "you were
// removed"). Returns { shop, member } or null.
export async function loadShopForWorkspace(shopId, workspaceId) {
  if (!isUuid(shopId) || !workspaceId) return null;
  const { rows } = await sql`
    SELECT s.*, sm.id AS member_row_id
      FROM shops s
      LEFT JOIN shop_members sm ON sm.shop_id = s.id AND sm.workspace_id = ${workspaceId}
     WHERE s.id = ${shopId} AND (s.owner_workspace_id = ${workspaceId} OR sm.id IS NOT NULL)
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const members = await listMembers(row.id);
  const member = members.find((m) => m.workspace_id === workspaceId) || null;
  return { shop: row, member, members };
}

export async function slugTaken(slug, exceptShopId = null) {
  const s = String(slug || '').toLowerCase();
  if (!validShopSlug(s)) return true;
  const { rows } = exceptShopId
    ? await sql`SELECT 1 FROM shops WHERE slug = ${s} AND id <> ${exceptShopId} LIMIT 1`
    : await sql`SELECT 1 FROM shops WHERE slug = ${s} LIMIT 1`;
  return rows.length > 0;
}

// Everything the Shops screen needs for one workspace: shops it owns,
// shops it is listed on, and invites waiting for it (by workspace or by
// the owner's email).
export async function shopsForWorkspace(workspaceId, ownerEmail = null) {
  const owned = await sql`SELECT * FROM shops WHERE owner_workspace_id = ${workspaceId} ORDER BY created_at ASC`;
  const email = ownerEmail ? normalizeAccountEmail(ownerEmail) : null;
  const { rows: memberRows } = await sql.query(
    `${MEMBER_SELECT}
      WHERE (sm.workspace_id = $1 OR (sm.workspace_id IS NULL AND sm.status = 'invited' AND $2::text IS NOT NULL AND LOWER(sm.invite_email) = $2))
        AND sm.shop_id NOT IN (SELECT id FROM shops WHERE owner_workspace_id = $1)
      ORDER BY sm.created_at DESC`,
    [workspaceId, email],
  );
  const shopIds = [...new Set(memberRows.map((m) => m.shop_id))];
  const shops = shopIds.length
    ? (await sql.query(`SELECT s.*, cs.biz_name AS owner_biz_name FROM shops s LEFT JOIN calendar_settings cs ON cs.workspace_id = s.owner_workspace_id WHERE s.id = ANY($1::uuid[])`, [shopIds])).rows
    : [];
  const byId = Object.fromEntries(shops.map((s) => [s.id, s]));
  const memberships = [];
  const invites = [];
  for (const m of memberRows) {
    const shop = byId[m.shop_id];
    if (!shop) continue;
    const entry = {
      shop: { ...serializeShop(shop), ownerBusinessName: shop.owner_biz_name || null },
      member: serializeMember(m),
    };
    if (m.status === 'invited') {
      const expired = m.invite_expires_at && new Date(m.invite_expires_at).getTime() <= Date.now();
      if (!expired) invites.push({ ...entry, inviteId: m.id });
    } else if (m.status === 'active') memberships.push(entry);
    else memberships.push(entry); // left/removed/declined: shown as history so the screen can explain
  }
  return { owned: owned.rows.map((s) => serializeShop(s, { owner: true })), memberships, invites };
}

// ── create / update ──────────────────────────────────────────────────────

export async function createShop({ workspaceId, body }) {
  const access = await loadWorkspaceAccess(workspaceId);
  if (!access.active) throw new ShopError(402, SHOP_PLAN_NOTE, 'plan_required');
  const n = await sql`SELECT COUNT(*)::int AS n FROM shops WHERE owner_workspace_id = ${workspaceId}`;
  if ((n.rows[0]?.n || 0) >= MAX_SHOPS_PER_WORKSPACE) throw new ShopError(400, `You can run up to ${MAX_SHOPS_PER_WORKSPACE} shop pages`);
  const patch = cleanShopPatch(body, { create: true });
  if (await slugTaken(patch.slug)) throw new ShopError(409, 'That web address is taken', 'slug_taken');
  // Defaults from the owner's own calendar: hours and time zone.
  const cs = (await sql`SELECT availability, timezone, address_label, lat, lng, biz_name FROM calendar_settings WHERE workspace_id = ${workspaceId}`).rows[0] || {};
  const hours = patch.hours ?? cleanHours(cs.availability || {});
  const timezone = patch.timezone ?? (cs.timezone || null);
  const settings = normalizeShopSettings(patch.settings);
  let ins;
  try {
    ins = await sql`
      INSERT INTO shops (owner_workspace_id, slug, name, tagline, description, address_label, city, region, country,
                         lat, lng, phone, timezone, hours, photos, amenities, settings)
      VALUES (${workspaceId}, ${patch.slug}, ${patch.name}, ${patch.tagline ?? null}, ${patch.description ?? null},
              ${patch.address_label ?? cs.address_label ?? null}, ${patch.city ?? null}, ${patch.region ?? null}, ${patch.country ?? null},
              ${patch.lat ?? (cs.lat == null ? null : Number(cs.lat))}, ${patch.lng ?? (cs.lng == null ? null : Number(cs.lng))},
              ${patch.phone ?? null}, ${timezone}, ${JSON.stringify(hours)}::jsonb,
              ${JSON.stringify(patch.photos || [])}::jsonb, ${JSON.stringify(patch.amenities || [])}::jsonb,
              ${JSON.stringify(settings)}::jsonb)
      RETURNING *`;
  } catch (e) {
    if (e?.code === '23505') throw new ShopError(409, 'That web address is taken', 'slug_taken');
    throw e;
  }
  const shop = ins.rows[0];
  // The owner is a member from the start, no invite needed.
  await sql`
    INSERT INTO shop_members (shop_id, workspace_id, status, role, display_order, joined_at)
    VALUES (${shop.id}, ${workspaceId}, 'active', 'owner', 0, NOW())
    ON CONFLICT DO NOTHING`;
  return shop;
}

export async function updateShop({ shop, body }) {
  const patch = cleanShopPatch(body);
  if ('slug' in patch && patch.slug !== shop.slug && await slugTaken(patch.slug, shop.id)) {
    throw new ShopError(409, 'That web address is taken', 'slug_taken');
  }
  const keys = Object.keys(patch);
  if (!keys.length) return shop;
  const values = [];
  const sets = keys.map((k) => {
    values.push(['hours', 'photos', 'amenities', 'settings'].includes(k) ? JSON.stringify(patch[k]) : patch[k]);
    return ['hours', 'photos', 'amenities', 'settings'].includes(k) ? `${k} = $${values.length}::jsonb` : `${k} = $${values.length}`;
  });
  values.push(shop.id, shop.owner_workspace_id);
  let r;
  try {
    r = await sql.query(
      `UPDATE shops SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length - 1} AND owner_workspace_id = $${values.length} RETURNING *`,
      values,
    );
  } catch (e) {
    if (e?.code === '23505') throw new ShopError(409, 'That web address is taken', 'slug_taken');
    throw e;
  }
  return r.rows[0] || shop;
}

export async function setShopStatus({ shop, status }) {
  if (status !== 'published' && status !== 'draft') throw new ShopError(400, 'Status must be published or draft');
  if (status === 'published') {
    const access = await loadWorkspaceAccess(shop.owner_workspace_id);
    if (!access.active) throw new ShopError(402, SHOP_PLAN_NOTE, 'plan_required');
  }
  const { rows } = await sql`
    UPDATE shops SET status = ${status},
           published_at = CASE WHEN ${status} = 'published' THEN COALESCE(published_at, NOW()) ELSE published_at END,
           updated_at = NOW()
     WHERE id = ${shop.id} AND owner_workspace_id = ${shop.owner_workspace_id}
     RETURNING *`;
  return rows[0] || shop;
}

export async function deleteShop({ shop }) {
  await sql`DELETE FROM shops WHERE id = ${shop.id} AND owner_workspace_id = ${shop.owner_workspace_id}`;
}

// ── invites ──────────────────────────────────────────────────────────────

async function ownerBusinessName(workspaceId) {
  const b = await fetchBranding(workspaceId).catch(() => null);
  if (b?.businessName) return b.businessName;
  const r = await sql`SELECT cs.biz_name, w.name FROM workspaces w LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id WHERE w.id = ${workspaceId}`;
  return r.rows[0]?.biz_name || r.rows[0]?.name || 'A business';
}

// The workspace a user owns (oldest), if any.
export async function ownedWorkspaceOf(userId) {
  if (!userId) return null;
  const { rows } = await sql`SELECT id FROM workspaces WHERE owner_id = ${userId} ORDER BY created_at ASC, id ASC LIMIT 1`;
  return rows[0]?.id || null;
}

function inviteLink(raw) {
  return `${appUrl()}/shops/invite/${encodeURIComponent(raw)}`;
}

export async function inviteMember({ shop, email, inviterUser }) {
  const addr = normalizeAccountEmail(email);
  if (!validEmail(addr)) throw new ShopError(400, 'Enter a valid email address');
  if (inviterUser?.email && normalizeAccountEmail(inviterUser.email) === addr) {
    throw new ShopError(400, 'That is your own email. You are already on your shop page.');
  }
  const active = await sql`SELECT COUNT(*)::int AS n FROM shop_members WHERE shop_id = ${shop.id} AND status IN ('active', 'invited')`;
  if ((active.rows[0]?.n || 0) >= MAX_SHOP_MEMBERS) throw new ShopError(400, `A shop page lists up to ${MAX_SHOP_MEMBERS} businesses`);

  // Does this email already own an Ivy business? Then the invite is bound
  // to that workspace right away (and they get a push).
  const user = (await sql`SELECT id, name FROM users WHERE LOWER(email) = ${addr} AND deleted_at IS NULL LIMIT 1`).rows[0] || null;
  const targetWs = user ? await ownedWorkspaceOf(user.id) : null;
  if (targetWs && targetWs === shop.owner_workspace_id) throw new ShopError(400, 'That is your own business. You are already on your shop page.');

  const existing = targetWs
    ? (await sql`SELECT * FROM shop_members WHERE shop_id = ${shop.id} AND workspace_id = ${targetWs} LIMIT 1`).rows[0]
    : (await sql`SELECT * FROM shop_members WHERE shop_id = ${shop.id} AND workspace_id IS NULL AND LOWER(invite_email) = ${addr} LIMIT 1`).rows[0];
  if (existing?.status === 'active') throw new ShopError(409, 'That business is already on your shop page', 'already_member');

  const raw = generateRawToken();
  const expiresAt = new Date(Date.now() + SHOP_INVITE_TTL_DAYS * 86400 * 1000).toISOString();
  let member;
  if (existing) {
    // Re-invite (declined, left, removed or a pending invite): one live link.
    member = (await sql`
      UPDATE shop_members SET status = 'invited', invite_email = ${addr}, invite_token_hash = ${hashToken(raw)},
             invite_expires_at = ${expiresAt}, invited_at = NOW(), left_at = NULL, joined_at = NULL,
             workspace_id = COALESCE(${targetWs}, workspace_id), updated_at = NOW()
       WHERE id = ${existing.id} AND shop_id = ${shop.id} RETURNING *`).rows[0];
  } else {
    const order = await sql`SELECT COALESCE(MAX(display_order), 0)::int + 1 AS n FROM shop_members WHERE shop_id = ${shop.id}`;
    member = (await sql`
      INSERT INTO shop_members (shop_id, workspace_id, status, role, display_order, invite_email, invite_token_hash, invite_expires_at, invited_at)
      VALUES (${shop.id}, ${targetWs}, 'invited', 'member', ${order.rows[0]?.n || 1}, ${addr}, ${hashToken(raw)}, ${expiresAt}, NOW())
      RETURNING *`).rows[0];
  }

  const ownerBiz = await ownerBusinessName(shop.owner_workspace_id);
  const branding = await fetchBranding(shop.owner_workspace_id).catch(() => null);
  const first = firstNameOf(user?.name);
  const link = inviteLink(raw);
  const shared = SHARED_ON_SHOP.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
  const never = NEVER_ON_SHOP.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
  const html = emailShell({
    heading: `Join ${shop.name} on Ivy`,
    branding,
    body: `<p>Hi${first ? ` ${escapeHtml(first)}` : ''},</p>
      <p><strong>${escapeHtml(ownerBiz)}</strong> runs the shop page for <strong>${escapeHtml(shop.name)}</strong> on Ivy and would like to list your business there, next to the other pros at the shop.</p>
      <p><strong>If you accept, the shop page shows:</strong></p>
      <ul>${shared}</ul>
      <p><strong>It never shows:</strong></p>
      <ul>${never}</ul>
      <p>Clients who book you from the shop page book with you directly, at your prices and under your policies. Your clients stay yours. You can leave the shop page at any time with one tap, and your listing comes off right away.</p>
      <p>This link works once and expires in ${SHOP_INVITE_TTL_DAYS} days.</p>`,
    ctaText: 'See the invite',
    ctaUrl: link,
    footer: `${SHOP_PLAN_NOTE} If you were not expecting this, you can ignore this email.`,
  });
  const subject = `${shop.name} invited you to be listed on their shop page`;
  const send = user
    ? sendEmailToUser({ userId: user.id, type: 'shops', to: addr, subject, html, replyTo: branding?.replyTo })
    : sendEmail({ to: addr, subject, html, replyTo: branding?.replyTo });
  const result = await send.catch((err) => ({ sent: false, reason: err.message }));
  if (targetWs) {
    notifyOwnerSafe({
      workspaceId: targetWs, type: 'shops',
      payload: {
        title: `${shop.name} invited you`,
        body: 'Be listed on their shop page. Accept or decline in Shops.',
        url: '/shops',
        tag: `shop-invite-${member.id}`,
      },
    });
  }
  return { member, sent: result?.sent !== false && result?.ok !== false, reason: result?.reason || null, expiresAt, hasAccount: !!user };
}

export async function cancelInvite({ shop, memberId }) {
  const { rows } = await sql`
    UPDATE shop_members SET status = 'declined', invite_token_hash = NULL, invite_expires_at = NULL, updated_at = NOW()
     WHERE id = ${memberId} AND shop_id = ${shop.id} AND status = 'invited' RETURNING id`;
  return rows.length > 0;
}

// Owner share link: anyone with it who owns an Ivy business on a plan can
// join. Regenerating kills the old one.
export async function regenerateJoinLink({ shop }) {
  const raw = generateRawToken();
  const expiresAt = new Date(Date.now() + SHOP_INVITE_TTL_DAYS * 86400 * 1000).toISOString();
  await sql`UPDATE shops SET join_token_hash = ${hashToken(raw)}, join_token_expires_at = ${expiresAt}, updated_at = NOW()
             WHERE id = ${shop.id} AND owner_workspace_id = ${shop.owner_workspace_id}`;
  return { link: inviteLink(raw), expiresAt };
}
export async function clearJoinLink({ shop }) {
  await sql`UPDATE shops SET join_token_hash = NULL, join_token_expires_at = NULL, updated_at = NOW()
             WHERE id = ${shop.id} AND owner_workspace_id = ${shop.owner_workspace_id}`;
}

// A live invite token → { kind: 'member' | 'join', shop, member } or null.
// Expired, used, cancelled and unknown tokens all read the same.
export async function findInvite(raw) {
  if (typeof raw !== 'string' || raw.length < 16 || raw.length > 200) return null;
  const h = hashToken(raw);
  const m = await sql`SELECT * FROM shop_members WHERE invite_token_hash = ${h} LIMIT 1`;
  if (m.rows[0]) {
    const member = m.rows[0];
    if (member.status !== 'invited') return null;
    if (!member.invite_expires_at || new Date(member.invite_expires_at).getTime() <= Date.now()) return null;
    const s = await sql`SELECT * FROM shops WHERE id = ${member.shop_id} LIMIT 1`;
    if (!s.rows[0]) return null;
    return { kind: 'member', shop: s.rows[0], member };
  }
  const s = await sql`SELECT * FROM shops WHERE join_token_hash = ${h} LIMIT 1`;
  if (s.rows[0]) {
    const shop = s.rows[0];
    if (!shop.join_token_expires_at || new Date(shop.join_token_expires_at).getTime() <= Date.now()) return null;
    return { kind: 'join', shop, member: null };
  }
  return null;
}

// What the accept page may show before anyone signs in. Never the token,
// never other members' private data.
export async function inviteInfo(found) {
  const { shop, member, kind } = found;
  const ownerBiz = await ownerBusinessName(shop.owner_workspace_id);
  const members = (await listMembers(shop.id)).filter((m) => m.status === 'active' && m.biz_name);
  return {
    kind,
    shop: { name: shop.name, slug: shop.slug, tagline: shop.tagline || '', addressLabel: shop.address_label || '', status: shop.status },
    ownerBusinessName: ownerBiz,
    email: kind === 'member' ? member.invite_email : null,
    expiresAt: kind === 'member' ? member.invite_expires_at : shop.join_token_expires_at,
    memberCount: members.length,
    memberNames: members.slice(0, 6).map((m) => m.biz_name),
    shared: SHARED_ON_SHOP,
    neverShared: NEVER_ON_SHOP,
    planNote: SHOP_PLAN_NOTE,
  };
}

// The signed-in user accepts an invite for the business they own.
// Returns the member row. Throws ShopError with a code the UI can read:
//   no_business      the user owns no Ivy business
//   plan_required    their plan, trial or comp is not active
//   wrong_email      an email invite accepted by a different account
//   own_shop         the shop owner cannot accept their own invite
export async function acceptInvite({ found, user }) {
  const { shop, member, kind } = found;
  const ws = await ownedWorkspaceOf(user.id);
  if (!ws) throw new ShopError(403, 'You need an Ivy business to join a shop page. Create one first, then open this link again.', 'no_business');
  if (ws === shop.owner_workspace_id) throw new ShopError(400, 'This is your own shop page. You are already on it.', 'own_shop');
  const access = await loadWorkspaceAccess(ws);
  if (!access.active) throw new ShopError(402, SHOP_PLAN_NOTE, 'plan_required');
  if (kind === 'member') {
    if (member.workspace_id && member.workspace_id !== ws) throw new ShopError(403, 'This invite was sent to a different business.', 'wrong_email');
    if (!member.workspace_id && member.invite_email && normalizeAccountEmail(member.invite_email) !== normalizeAccountEmail(user.email)) {
      throw new ShopError(403, `This invite was sent to ${member.invite_email}. Sign in with that email to accept it.`, 'wrong_email');
    }
  }
  // Does this workspace already have a row at this shop? (left earlier,
  // or two invites for the same person.) Reuse it so (shop, workspace)
  // stays unique.
  const existing = (await sql`SELECT * FROM shop_members WHERE shop_id = ${shop.id} AND workspace_id = ${ws} LIMIT 1`).rows[0] || null;
  let row;
  if (kind === 'member' && (!existing || existing.id === member.id)) {
    // Burn the token and bind the workspace in one statement: a second
    // accept of the same link finds nothing to update.
    const upd = await sql`
      UPDATE shop_members SET workspace_id = ${ws}, status = 'active', joined_at = NOW(), left_at = NULL,
             invite_token_hash = NULL, invite_expires_at = NULL, updated_at = NOW()
       WHERE id = ${member.id} AND shop_id = ${shop.id} AND status = 'invited' AND invite_token_hash IS NOT NULL
       RETURNING *`;
    row = upd.rows[0] || null;
    if (!row) throw new ShopError(410, 'This invite link was already used or is no longer valid.', 'dead');
  } else if (existing) {
    if (existing.status === 'active') return { member: existing, shop, alreadyMember: true };
    const upd = await sql`
      UPDATE shop_members SET status = 'active', joined_at = NOW(), left_at = NULL,
             invite_token_hash = NULL, invite_expires_at = NULL, updated_at = NOW()
       WHERE id = ${existing.id} AND shop_id = ${shop.id} RETURNING *`;
    row = upd.rows[0];
    if (kind === 'member') {
      // The email invite row was for the same business: fold it away.
      await sql`DELETE FROM shop_members WHERE id = ${member.id} AND shop_id = ${shop.id} AND status = 'invited'`.catch(() => {});
    }
  } else {
    const order = await sql`SELECT COALESCE(MAX(display_order), 0)::int + 1 AS n FROM shop_members WHERE shop_id = ${shop.id}`;
    try {
      row = (await sql`
        INSERT INTO shop_members (shop_id, workspace_id, status, role, display_order, joined_at)
        VALUES (${shop.id}, ${ws}, 'active', 'member', ${order.rows[0]?.n || 1}, NOW()) RETURNING *`).rows[0];
    } catch (e) {
      if (e?.code !== '23505') throw e;
      row = (await sql`SELECT * FROM shop_members WHERE shop_id = ${shop.id} AND workspace_id = ${ws} LIMIT 1`).rows[0];
    }
  }
  const biz = await ownerBusinessName(ws);
  notifyShopOwner(shop, {
    title: `${biz} joined ${shop.name}`,
    body: shop.status === 'published' ? 'Their listing is live on your shop page.' : 'They show on your shop page once you publish it.',
    url: `/shops?shop=${shop.id}`, tag: `shop-join-${row.id}`,
  }, `<p><strong>${escapeHtml(biz)}</strong> accepted your invite and is now listed on <strong>${escapeHtml(shop.name)}</strong>.</p>`);
  return { member: row, shop, alreadyMember: false };
}

export async function declineInvite({ found, user }) {
  const { shop, member, kind } = found;
  if (kind !== 'member') return { ok: true };
  const upd = await sql`
    UPDATE shop_members SET status = 'declined', invite_token_hash = NULL, invite_expires_at = NULL, updated_at = NOW()
     WHERE id = ${member.id} AND shop_id = ${shop.id} AND status = 'invited' RETURNING *`;
  if (!upd.rows[0]) return { ok: false };
  const who = member.invite_email || user?.email || 'A business';
  notifyShopOwner(shop, {
    title: `Invite declined`,
    body: `${who} declined the invite to ${shop.name}.`,
    url: `/shops?shop=${shop.id}`, tag: `shop-decline-${member.id}`,
  }, `<p><strong>${escapeHtml(who)}</strong> declined the invite to be listed on <strong>${escapeHtml(shop.name)}</strong>.</p>`);
  return { ok: true };
}

// Push (bell + device) and, for the bigger events, an email to the shop's
// owner. Both honour the owner's 'shops' preference.
function notifyShopOwner(shop, payload, emailBodyHtml = null) {
  notifyOwnerSafe({ workspaceId: shop.owner_workspace_id, type: 'shops', payload });
  if (!emailBodyHtml) return;
  (async () => {
    const r = await sql`SELECT u.id, u.email, u.name FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ${shop.owner_workspace_id} AND u.deleted_at IS NULL`;
    const u = r.rows[0];
    if (!u?.email) return;
    const branding = await fetchBranding(shop.owner_workspace_id).catch(() => null);
    await sendEmailToUser({
      userId: u.id, type: 'shops', to: u.email,
      subject: payload.title,
      html: emailShell({
        heading: payload.title, branding,
        body: `<p>Hi${firstNameOf(u.name) ? ` ${escapeHtml(firstNameOf(u.name))}` : ''},</p>${emailBodyHtml}`,
        ctaText: 'Open Shops', ctaUrl: `${appUrl()}/shops?shop=${shop.id}`,
        footer: 'You get this because you run a shop page on Ivy. Manage notification preferences from Account.',
      }),
    });
  })().catch((e) => console.warn('[shops] owner email failed:', e?.message));
}

// ── roster (owner) and listing (member) ─────────────────────────────────

export async function updateRoster({ shop, items }) {
  if (!Array.isArray(items) || items.length > MAX_SHOP_MEMBERS) throw new ShopError(400, 'Send the roster as a list');
  const members = await listMembers(shop.id);
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  for (const it of items) {
    const id = String(it?.id || '');
    if (!byId[id]) throw new ShopError(404, 'That business is not on this shop page');
    const sets = [];
    const values = [];
    if ('displayOrder' in it) {
      const n = Number(it.displayOrder);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw new ShopError(400, 'Order must be a small whole number');
      values.push(n); sets.push(`display_order = $${values.length}`);
    }
    if ('featured' in it) { values.push(!!it.featured); sets.push(`featured = $${values.length}`); }
    if ('title' in it) { values.push(str(it.title, 60)); sets.push(`title = $${values.length}`); }
    if (!sets.length) continue;
    values.push(id, shop.id);
    await sql.query(`UPDATE shop_members SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length - 1} AND shop_id = $${values.length}`, values);
  }
  return listMembers(shop.id);
}

export async function removeMember({ shop, memberId }) {
  if (!isUuid(memberId)) throw new ShopError(404, 'That business is not on this shop page');
  const m = (await sql`SELECT * FROM shop_members WHERE id = ${memberId} AND shop_id = ${shop.id} LIMIT 1`).rows[0];
  if (!m) throw new ShopError(404, 'That business is not on this shop page');
  if (m.role === 'owner') throw new ShopError(400, 'The shop owner stays on the page. Delete the shop page instead.');
  if (m.status === 'invited') { await cancelInvite({ shop, memberId }); return { cancelled: true }; }
  await sql`UPDATE shop_members SET status = 'removed', left_at = NOW(), invite_token_hash = NULL, invite_expires_at = NULL, updated_at = NOW()
             WHERE id = ${m.id} AND shop_id = ${shop.id}`;
  if (m.workspace_id) {
    notifyOwnerSafe({
      workspaceId: m.workspace_id, type: 'shops',
      payload: { title: `You were removed from ${shop.name}`, body: 'Your listing is no longer on their shop page. Your own booking page is unchanged.', url: '/shops', tag: `shop-removed-${m.id}` },
    });
  }
  return { removed: true };
}

// A member leaves in one tap. Their listing disappears at once; the
// member row is kept as history so the owner can re-invite.
export async function leaveShop({ shopId, workspaceId }) {
  if (!isUuid(shopId)) throw new ShopError(404, 'Shop page not found');
  const m = (await sql`SELECT * FROM shop_members WHERE shop_id = ${shopId} AND workspace_id = ${workspaceId} LIMIT 1`).rows[0];
  if (!m) throw new ShopError(404, 'You are not on this shop page');
  if (m.role === 'owner') throw new ShopError(400, 'You run this shop page, so you cannot leave it. You can unpublish or delete it instead.');
  if (m.status !== 'active' && m.status !== 'invited') return { left: true, already: true };
  await sql`UPDATE shop_members SET status = 'left', left_at = NOW(), invite_token_hash = NULL, invite_expires_at = NULL, updated_at = NOW()
             WHERE id = ${m.id} AND shop_id = ${shopId}`;
  const shop = (await sql`SELECT * FROM shops WHERE id = ${shopId}`).rows[0];
  if (shop) {
    const biz = await ownerBusinessName(workspaceId);
    notifyShopOwner(shop, {
      title: `${biz} left ${shop.name}`, body: 'Their listing came off your shop page.',
      url: `/shops?shop=${shop.id}`, tag: `shop-left-${m.id}`,
    }, `<p><strong>${escapeHtml(biz)}</strong> left <strong>${escapeHtml(shop.name)}</strong>. Their listing came off your shop page right away.</p>`);
  }
  return { left: true };
}

export async function updateListing({ shopId, workspaceId, body }) {
  if (!isUuid(shopId)) throw new ShopError(404, 'Shop page not found');
  const m = (await sql`SELECT * FROM shop_members WHERE shop_id = ${shopId} AND workspace_id = ${workspaceId} LIMIT 1`).rows[0];
  if (!m || (m.status !== 'active')) throw new ShopError(404, 'You are not on this shop page');
  const b = body && typeof body === 'object' ? body : {};
  const sets = [];
  const values = [];
  if ('title' in b) { values.push(str(b.title, 60)); sets.push(`title = $${values.length}`); }
  if ('bio' in b) { values.push(str(b.bio, 600)); sets.push(`bio = $${values.length}`); }
  if ('visibleServiceIds' in b) {
    let ids = null;
    if (b.visibleServiceIds != null) {
      if (!Array.isArray(b.visibleServiceIds) || b.visibleServiceIds.length > 200) throw new ShopError(400, 'Pick services as a list');
      const want = [...new Set(b.visibleServiceIds.map(String))];
      for (const id of want) if (!isUuid(id)) throw new ShopError(400, 'Unknown service');
      const own = want.length
        ? (await sql.query(`SELECT id FROM services WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, want])).rows.map((r) => r.id)
        : [];
      if (own.length !== want.length) throw new ShopError(400, 'Unknown service');
      ids = own;
    }
    values.push(ids == null ? null : JSON.stringify(ids)); sets.push(`visible_service_ids = $${values.length}::jsonb`);
  }
  if (!sets.length) return m;
  values.push(m.id, shopId, workspaceId);
  const r = await sql.query(
    `UPDATE shop_members SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length - 2} AND shop_id = $${values.length - 1} AND workspace_id = $${values.length} RETURNING *`,
    values,
  );
  return r.rows[0] || m;
}

// The hours the listed team actually takes bookings: the union of every
// active member's own weekly availability (already public on each booking
// page), merged per day and capped at 4 windows. The owner can copy this
// into the shop's door hours in one tap so "Open until" never says the
// shop is closed while a pro on it is bookable.
export function teamHoursUnion(members) {
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const all = [];
    for (const m of (members || [])) {
      if (m.status !== 'active' || !m.workspace_id || !isWorkspaceActive(m)) continue;
      const list = (m.availability && m.availability[String(d)]) || [];
      for (const w of (Array.isArray(list) ? list : [])) {
        const start = Number(w?.start), end = Number(w?.end);
        if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 1440 && start < end) all.push({ start, end });
      }
    }
    all.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const w of all) {
      const last = merged[merged.length - 1];
      if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
      else merged.push({ ...w });
    }
    // More than 4 separate windows: close the smallest gaps until 4 remain.
    while (merged.length > 4) {
      let gi = 0, best = Infinity;
      for (let i = 0; i < merged.length - 1; i++) {
        const gap = merged[i + 1].start - merged[i].end;
        if (gap < best) { best = gap; gi = i; }
      }
      merged[gi].end = merged[gi + 1].end;
      merged.splice(gi + 1, 1);
    }
    out[String(d)] = merged;
  }
  return out;
}

// ── stats (counts only) ──────────────────────────────────────────────────

// Owner view: bookings made through the shop page, per member, as counts.
export async function shopStats(shop) {
  const { rows } = await sql`
    SELECT b.workspace_id,
           COUNT(*) FILTER (WHERE b.cancelled_at IS NULL)::int AS total,
           COUNT(*) FILTER (WHERE b.cancelled_at IS NULL AND b.created_at > NOW() - INTERVAL '30 days')::int AS last30,
           COUNT(*) FILTER (WHERE b.cancelled_at IS NULL AND b.date >= CURRENT_DATE)::int AS upcoming
      FROM bookings b WHERE b.shop_id = ${shop.id}
     GROUP BY b.workspace_id`;
  return {
    pageViews: Number(shop.page_views || 0),
    byWorkspace: Object.fromEntries(rows.map((r) => [r.workspace_id, { total: r.total, last30: r.last30, upcoming: r.upcoming }])),
    total: rows.reduce((s, r) => s + r.total, 0),
    last30: rows.reduce((s, r) => s + r.last30, 0),
  };
}

// Member view: only their own numbers.
export async function memberStats(shopId, workspaceId) {
  const { rows } = await sql`
    SELECT COUNT(*) FILTER (WHERE cancelled_at IS NULL)::int AS total,
           COUNT(*) FILTER (WHERE cancelled_at IS NULL AND created_at > NOW() - INTERVAL '30 days')::int AS last30,
           COUNT(*) FILTER (WHERE cancelled_at IS NULL AND date >= CURRENT_DATE)::int AS upcoming
      FROM bookings WHERE shop_id = ${shopId} AND workspace_id = ${workspaceId}`;
  return { total: rows[0]?.total || 0, last30: rows[0]?.last30 || 0, upcoming: rows[0]?.upcoming || 0 };
}

export async function recordPageView(slug) {
  const s = String(slug || '').toLowerCase();
  if (!validShopSlug(s)) return false;
  const r = await sql`UPDATE shops SET page_views = page_views + 1 WHERE slug = ${s} AND status = 'published' RETURNING id`;
  return r.rows.length > 0;
}

// ── public page ──────────────────────────────────────────────────────────

// Published shop + members whose plan is active. Returns null when there
// is no such shop or its owner's plan lapsed (then the page goes dark
// like an archived booking page).
export async function loadPublicShop(slug) {
  const s = String(slug || '').toLowerCase().trim();
  if (!validShopSlug(s)) return null;
  const { rows } = await sql`
    SELECT s.*, w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until, u.deleted_at AS owner_deleted_at
      FROM shops s
      JOIN workspaces w ON w.id = s.owner_workspace_id
      JOIN users u ON u.id = w.owner_id
     WHERE s.slug = ${s} AND s.status = 'published' LIMIT 1`;
  const shop = rows[0];
  if (!shop || shop.owner_deleted_at) return null;
  if (!isWorkspaceActive(shop)) return { shop, archived: true, members: [] };
  const members = (await listMembers(shop.id))
    .filter((m) => m.status === 'active' && m.workspace_id && m.booking_slug && isWorkspaceActive(m));
  return { shop, archived: false, members };
}

// One payload for the whole page. Each member carries exactly what its
// own public booking page exposes (settings subset, listed services,
// blocks as "Busy", redacted bookings, reviews), so the page can compute
// live availability for everyone without another request.
export async function publicShopPayload(slug) {
  const loaded = await loadPublicShop(slug);
  if (!loaded) return null;
  const { shop, archived, members } = loaded;
  if (archived) return { archived: true, shop: { name: shop.name, slug: shop.slug } };
  const wsIds = members.map((m) => m.workspace_id);
  let services = [], blocks = [], bookings = [], external = [], agg = [], recent = [];
  if (wsIds.length) {
    [services, blocks, bookings, external, agg, recent] = await Promise.all([
      sql.query(`SELECT * FROM services WHERE workspace_id = ANY($1::uuid[]) AND visibility = 'public' ORDER BY display_order, created_at`, [wsIds]).then((r) => r.rows),
      sql.query(`SELECT * FROM calendar_blocks WHERE workspace_id = ANY($1::uuid[]) AND blocks_bookings = TRUE AND date >= CURRENT_DATE - 1 ORDER BY date, start_min`, [wsIds]).then((r) => r.rows),
      sql.query(
        `SELECT id, workspace_id, service_id, staff_id, date, start_min, end_min, cancelled_at,
                recurrence_rule, recurrence_until, cancelled_occurrences
           FROM bookings
          WHERE workspace_id = ANY($1::uuid[]) AND cancelled_at IS NULL
            AND (date >= CURRENT_DATE - 1
                 OR (recurrence_rule IS NOT NULL AND (recurrence_until IS NULL OR recurrence_until >= CURRENT_DATE - 1)))
          ORDER BY date, start_min`, [wsIds]).then((r) => r.rows),
      sql.query(`SELECT id, workspace_id, date, start_min, end_min FROM external_busy_blocks WHERE workspace_id = ANY($1::uuid[]) AND date >= CURRENT_DATE ORDER BY date, start_min`, [wsIds]).then((r) => r.rows),
      sql.query(`SELECT workspace_id, COUNT(*)::int AS n, ROUND(AVG(rating)::numeric, 2)::float AS avg FROM reviews WHERE workspace_id = ANY($1::uuid[]) AND status = 'visible' GROUP BY workspace_id`, [wsIds]).then((r) => r.rows),
      sql.query(
        `SELECT * FROM (
           SELECT id, workspace_id, reviewer_name, rating, text, owner_response, created_at,
                  ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at DESC) AS rn
             FROM reviews WHERE workspace_id = ANY($1::uuid[]) AND status = 'visible') x
          WHERE rn <= 6 ORDER BY created_at DESC`, [wsIds]).then((r) => r.rows),
    ]);
  }
  const settings = normalizeShopSettings(shop.settings);
  const by = (list) => {
    const m = {};
    for (const r of list) (m[r.workspace_id] ||= []).push(r);
    return m;
  };
  const svcBy = by(services), blockBy = by(blocks), bookBy = by(bookings), extBy = by(external), recentBy = by(recent);
  const aggBy = Object.fromEntries(agg.map((a) => [a.workspace_id, a]));

  const membersOut = members.map((m) => {
    const chosen = Array.isArray(m.visible_service_ids) ? new Set(m.visible_service_ids.map(String)) : null;
    const svcs = (svcBy[m.workspace_id] || [])
      .filter((s) => !chosen || chosen.has(String(s.id)))
      .map((r) => {
        const out = serializeService(r);
        out.locationLabel = publicLocationLabel(out.locationType, out.locationLabel);
        if (!settings.showPrices) { out.price = 0; out.hidePrice = true; }
        return out;
      });
    const blocksOut = (blockBy[m.workspace_id] || []).map((b) => serializeBlock(b, { publicView: true }));
    for (const b of (extBy[m.workspace_id] || [])) {
      blocksOut.push({ id: 'ext_' + b.id, date: isoDate(b.date), startMin: b.start_min, endMin: b.end_min, label: 'Busy' });
    }
    const a = aggBy[m.workspace_id];
    return {
      id: m.id,
      slug: m.booking_slug,
      bookUrl: `/book/${m.booking_slug}`,
      businessName: m.biz_name,
      proName: m.pro_name || m.biz_name,
      firstName: firstNameOf(m.pro_name) || m.biz_name,
      title: m.title || '',
      bio: m.bio || m.tagline || '',
      photoUrl: m.brand_logo_url || null,
      accentColor: m.brand_accent_color || null,
      featured: !!m.featured,
      role: m.role,
      settings: {
        bizName: m.biz_name,
        slug: m.booking_slug,
        timezone: m.timezone || null,
        availability: m.availability || {},
        slotMinutes: m.slot_minutes,
        slotFitService: !!m.slot_fit_service,
        bufferMinutes: m.buffer_minutes,
        minNoticeHours: m.min_notice_hours == null ? 24 : Number(m.min_notice_hours),
        maxAdvanceDays: m.max_advance_days == null ? 60 : Number(m.max_advance_days),
        category: m.category || null,
        addressLabel: m.address_label || '',
      },
      services: svcs,
      blocks: blocksOut,
      bookings: (bookBy[m.workspace_id] || []).map((r) => serializeBooking(r, { redactClient: true })),
      reviews: settings.showReviews ? {
        count: a?.n || 0,
        avg: a?.avg || null,
        recent: (recentBy[m.workspace_id] || []).map((r) => ({
          id: r.id, reviewerName: r.reviewer_name, rating: r.rating, text: r.text || '', ownerResponse: r.owner_response || null, createdAt: r.created_at,
        })),
      } : { count: 0, avg: null, recent: [] },
    };
  });
  // Honest shop rating: count-weighted across members, never inflated.
  const totalReviews = membersOut.reduce((s, m) => s + (m.reviews.count || 0), 0);
  const weighted = totalReviews
    ? membersOut.reduce((s, m) => s + (m.reviews.avg || 0) * (m.reviews.count || 0), 0) / totalReviews
    : null;
  return {
    archived: false,
    shop: { ...serializeShop(shop), settings },
    members: membersOut,
    rating: { count: totalReviews, avg: weighted == null ? null : Math.round(weighted * 100) / 100 },
  };
}

// The published shops this workspace is listed on (for "Part of {Shop}"
// on its own booking page). Only shops whose owner is active.
export async function shopsForBookingPage(workspaceId) {
  if (!workspaceId) return [];
  try {
    const { rows } = await sql`
      SELECT s.slug, s.name, w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until
        FROM shop_members sm
        JOIN shops s ON s.id = sm.shop_id AND s.status = 'published'
        JOIN workspaces w ON w.id = s.owner_workspace_id
       WHERE sm.workspace_id = ${workspaceId} AND sm.status = 'active'
       ORDER BY s.created_at ASC LIMIT 5`;
    return rows.filter(isWorkspaceActive).map((r) => ({ slug: r.slug, name: r.name, url: `/shop/${r.slug}` }));
  } catch (e) {
    console.warn('[shops] shopsForBookingPage skipped:', e?.message);
    return [];
  }
}

// A booking made from a shop page says so (body.shopSlug). Only counts
// when the shop is published and this workspace is an active member, so a
// made-up slug or a shop the pro left is simply ignored.
export async function resolveShopReferral(shopSlug, workspaceId) {
  const s = String(shopSlug || '').toLowerCase().trim();
  if (!s || !workspaceId || !validShopSlug(s)) return null;
  try {
    const { rows } = await sql`
      SELECT s.id, s.name, s.slug
        FROM shops s JOIN shop_members sm ON sm.shop_id = s.id
       WHERE s.slug = ${s} AND s.status = 'published' AND sm.workspace_id = ${workspaceId} AND sm.status = 'active'
       LIMIT 1`;
    return rows[0] || null;
  } catch (e) {
    console.warn('[shops] resolveShopReferral skipped:', e?.message);
    return null;
  }
}

// Discover: published shops (owner active), optionally narrowed by text.
export async function discoverShops({ q = null, limit = 24 } = {}) {
  const pattern = q ? `%${String(q).slice(0, 80).replace(/[%_]/g, (c) => '\\' + c)}%` : null;
  const { rows } = await sql.query(
    `SELECT s.id, s.slug, s.name, s.tagline, s.address_label, s.city, s.region, s.photos, s.lat, s.lng,
            w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until,
            (SELECT COUNT(*)::int FROM shop_members sm JOIN workspaces mw ON mw.id = sm.workspace_id
              WHERE sm.shop_id = s.id AND sm.status = 'active') AS member_count
       FROM shops s JOIN workspaces w ON w.id = s.owner_workspace_id JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
      WHERE s.status = 'published'
        AND ($1::text IS NULL OR s.name ILIKE $1 OR COALESCE(s.tagline, '') ILIKE $1 OR COALESCE(s.city, '') ILIKE $1
             OR EXISTS (SELECT 1 FROM shop_members sm JOIN services sv ON sv.workspace_id = sm.workspace_id
                         WHERE sm.shop_id = s.id AND sm.status = 'active' AND sv.visibility = 'public' AND sv.name ILIKE $1))
      ORDER BY s.published_at DESC NULLS LAST LIMIT $2`,
    [pattern, Math.min(Math.max(1, Number(limit) || 24), 50)],
  );
  return rows.filter(isWorkspaceActive).map((r) => ({
    slug: r.slug, name: r.name, tagline: r.tagline || '', addressLabel: r.address_label || '',
    city: r.city || '', region: r.region || '', photoUrl: Array.isArray(r.photos) && r.photos[0] ? r.photos[0] : null,
    memberCount: Number(r.member_count || 0), url: `/shop/${r.slug}`,
    lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng),
  }));
}

// Sitemap: every published shop whose owner is active.
export async function publishedShopSlugs() {
  const { rows } = await sql`
    SELECT s.slug, s.updated_at, w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until
      FROM shops s JOIN workspaces w ON w.id = s.owner_workspace_id JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
     WHERE s.status = 'published' ORDER BY s.updated_at DESC LIMIT 5000`;
  return rows.filter(isWorkspaceActive).map((r) => ({ slug: r.slug, updatedAt: r.updated_at }));
}

// Accountability partner: invites waiting for this business.
export async function shopInvitesWaiting(workspaceId, ownerEmail = null) {
  const email = ownerEmail ? normalizeAccountEmail(ownerEmail) : null;
  const { rows } = await sql.query(
    `SELECT sm.id, s.name FROM shop_members sm JOIN shops s ON s.id = sm.shop_id
      WHERE sm.status = 'invited' AND sm.invite_expires_at > NOW()
        AND (sm.workspace_id = $1 OR (sm.workspace_id IS NULL AND $2::text IS NOT NULL AND LOWER(sm.invite_email) = $2))
      ORDER BY sm.invited_at DESC LIMIT 5`,
    [workspaceId, email],
  );
  return rows;
}
