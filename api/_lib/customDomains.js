// Custom-domain policy for the website builder.
//
// A domain an owner types in is a hostname and nothing else, it is never
// one of our own hosts, and it is held by at most one Ivy site. Detaching
// a domain from the hosting project only ever happens for a domain that
// THIS workspace verified. Together these stop an owner from pointing
// their site at another business's domain, or detaching joinivy.ai itself.
import { sql } from './db.js';

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Hosts the platform itself uses. Any subdomain of these is refused too.
function reservedRoots() {
  const extra = String(process.env.WEBSITE_RESERVED_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ['joinivy.ai', 'vercel.app', 'vercel.com', 'localhost', ...extra];
}

// Lower-cased hostname, or null when the input is not a plain domain
// (scheme, path, port, IP literal, single label, odd characters).
export function normalizeCustomDomain(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/[/.]+$/, '').replace(/\.$/, '');
  if (!s) return null;
  if (!HOST_RE.test(s)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return null;
  return s;
}

export function isReservedDomain(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  return reservedRoots().some((root) => h === root || h.endsWith(`.${root}`));
}

// True when another workspace already has this domain on its site.
export async function domainHeldByOtherWorkspace(host, workspaceId) {
  const { rows } = await sql`
    SELECT 1 FROM websites
     WHERE lower(custom_domain) = ${String(host).toLowerCase()}
       AND workspace_id <> ${workspaceId}
     LIMIT 1`;
  return rows.length > 0;
}

// Validates a domain an owner wants to save. Returns { domain } or { error }.
export async function checkCustomDomainForWorkspace(input, workspaceId) {
  const domain = normalizeCustomDomain(input);
  if (!domain) return { error: 'Enter a domain like www.yourbusiness.com (no https://, no path).' };
  if (isReservedDomain(domain)) return { error: 'That domain cannot be connected to a site.' };
  if (await domainHeldByOtherWorkspace(domain, workspaceId)) {
    return { error: 'That domain is already connected to another site on Ivy.' };
  }
  return { domain };
}
