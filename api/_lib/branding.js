// Per-workspace email branding. Owners pick a logo, accent color,
// and email signature in /account → Branding; we apply them to every
// client-facing email so the invoice/document/booking notification
// the client receives feels like it came from the OWNER'S brand,
// not from a generic Ivy template.
//
// Falls back to "Ivy" defaults whenever a workspace hasn't
// customized - meaning existing accounts get the same email shell
// they had pre-branding until they deliberately set values.
import { sql } from './db.js';
import { isInvoiceFont, isInvoiceLayout, fontEmailStack, DEFAULT_DESIGN } from '../../src/lib/invoiceDesign.js';
import { getOrSet, invalidate as cacheInvalidate } from './hotCache.js';

const DEFAULT_ACCENT = '#2E3168';
// 60 seconds is long enough to absorb hot-path bursts (each email send
// hits this) and short enough that a branding change is visible in
// well under a minute. The owner-facing branding editor calls
// invalidateBranding() right after a write so changes appear instantly.
const BRANDING_TTL_MS = 60_000;

// Returns { businessName, logoUrl, accentColor, emailSignature, replyTo }.
// `replyTo` is the workspace owner's email so client replies route
// to the right inbox without exposing the owner's address in the
// From header. Served from the hot cache (60s TTL); the cache is
// per-function-invocation so first-hit on a cold instance pays the
// real DB cost but subsequent reads inside the same warm window
// (typically several minutes on Vercel) are free.
export async function fetchBranding(workspaceId) {
  if (!workspaceId) return defaults();
  return getOrSet(`branding:${workspaceId}`, BRANDING_TTL_MS, () => fetchBrandingFromDb(workspaceId));
}

async function fetchBrandingFromDb(workspaceId) {
  const r = await sql`
    SELECT cs.biz_name, cs.brand_logo_url, cs.brand_accent_color,
           cs.brand_email_signature, cs.brand_font, cs.invoice_layout,
           cs.invoice_footer, cs.biz_contact, cs.slug, u.email AS owner_email
      FROM workspaces w
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
      LEFT JOIN users u ON u.id = w.owner_id
     WHERE w.id = ${workspaceId}
     LIMIT 1
  `;
  const row = r.rows[0] || {};
  return {
    businessName:   row.biz_name || null,
    logoUrl:        row.brand_logo_url || null,
    accentColor:    sanitizeColor(row.brand_accent_color) || DEFAULT_ACCENT,
    emailSignature: row.brand_email_signature || null,
    replyTo:        row.owner_email || null,
    slug:           row.slug || null,
    // Invoice design. Fonts: a key from the shared catalog; the email
    // stack is what mail clients get (they rarely load web fonts).
    font:           isInvoiceFont(row.brand_font) ? row.brand_font : DEFAULT_DESIGN.font,
    fontStack:      fontEmailStack(isInvoiceFont(row.brand_font) ? row.brand_font : DEFAULT_DESIGN.font),
    invoiceLayout:  isInvoiceLayout(row.invoice_layout) ? row.invoice_layout : DEFAULT_DESIGN.layout,
    invoiceFooter:  row.invoice_footer == null ? DEFAULT_DESIGN.footer : row.invoice_footer,
    contact:        row.biz_contact || '',
  };
}

// The business block a client-facing invoice carries: name, logo and the
// design the owner chose. No ids, no owner email.
export async function invoiceBusinessMeta(workspaceId) {
  const b = await fetchBranding(workspaceId);
  if (!b.businessName && !b.slug) return null;
  return {
    name: b.businessName, slug: b.slug, logoUrl: b.logoUrl, accentColor: b.accentColor,
    font: b.font, layout: b.invoiceLayout, footer: b.invoiceFooter, contact: b.contact,
  };
}

// Call from any write path that mutates branding fields (logo, color,
// signature, biz_name) so the next read picks up the change without
// waiting for the TTL.
export function invalidateBranding(workspaceId) {
  if (workspaceId) cacheInvalidate(`branding:${workspaceId}`);
}

// Per-invocation memo for crons that loop over many rows belonging to a
// handful of workspaces (booking-reminders, review-requests, recurring-
// invoices, doc-reminders). Calling fetchBranding once per row is a 3-
// table JOIN per row - at 1000 reminders for the same 10 workspaces
// that's 1000 queries instead of 10. Instantiate ONE cache at the top of
// the cron run (NOT module scope - that would go stale across warm
// invocations) and call it inside the loop.
export function makeBrandingCache() {
  const cache = new Map();
  return (workspaceId) => {
    if (!workspaceId) return fetchBranding(workspaceId);
    if (cache.has(workspaceId)) return cache.get(workspaceId);
    const p = fetchBranding(workspaceId);
    cache.set(workspaceId, p);
    return p;
  };
}

function defaults() {
  return {
    businessName: null,
    logoUrl: null,
    accentColor: DEFAULT_ACCENT,
    emailSignature: null,
    replyTo: null,
    slug: null,
    font: DEFAULT_DESIGN.font,
    fontStack: fontEmailStack(DEFAULT_DESIGN.font),
    invoiceLayout: DEFAULT_DESIGN.layout,
    invoiceFooter: DEFAULT_DESIGN.footer,
    contact: '',
  };
}

// #RGB / #RRGGBB only. Anything else falls back to the default so a
// malformed value can't smuggle CSS into our inline styles.
function sanitizeColor(c) {
  if (!c || typeof c !== 'string') return null;
  const v = c.trim();
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? v : null;
}

export function isValidAccent(c) {
  return !c || /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(String(c).trim());
}
