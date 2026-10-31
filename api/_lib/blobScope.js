// Workspace scoping for Vercel Blob objects.
//
// Every file the app uploads goes through a per-route token endpoint
// (api/**/upload-token.js, photo-token.js, branding-logo-token.js). The
// browser picks the pathname, the server signs a token for it, and the
// browser PUTs straight to Blob storage. Because the pathname is chosen
// client-side, the token routes REQUIRE it to start with the uploading
// workspace's prefix (uploadPrefix) and refuse anything else. That makes
// the prefix a proof of origin: a pathname under ws/<id>/ was uploaded
// with a token minted for workspace <id>.
//
// Delete paths (completion attachments, gallery photos, orphan prune)
// must therefore only ever del() pathnames that carry the caller's own
// prefix. blobPathnameForWorkspace() is the single check for that, and
// it derives the pathname from the stored URL rather than trusting a
// client-supplied `blobPathname` field. Legacy objects uploaded before
// the prefix existed fail the check and are simply left in storage.
export const UPLOAD_ROOT = 'ws';

// Hosts Vercel Blob serves from. Public stores use
// <store>.public.blob.vercel-storage.com; the bare host also appears.
const BLOB_HOST_RE = /^(?:[a-z0-9-]+\.)*blob\.vercel-storage\.com$/i;

export class UploadScopeError extends Error {
  constructor(message = 'Upload path must be inside your workspace') {
    super(message);
    this.status = 400;
  }
}

function validWorkspaceId(workspaceId) {
  return typeof workspaceId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(workspaceId);
}

// `ws/<workspaceId>/` - what every upload pathname must start with.
export function uploadPrefix(workspaceId) {
  if (!validWorkspaceId(workspaceId)) throw new UploadScopeError('Unknown workspace');
  return `${UPLOAD_ROOT}/${workspaceId}/`;
}

// True when `host` is a Vercel Blob host (*.blob.vercel-storage.com,
// *.public.blob.vercel-storage.com or the bare host).
export function isBlobHost(host) {
  return typeof host === 'string' && BLOB_HOST_RE.test(host);
}

// Resolve a stored URL or bare pathname to the Blob pathname IF it
// belongs to `workspaceId`; null otherwise. Accepts:
//   • an https URL on a Vercel Blob host whose path starts with the prefix
//   • a bare pathname (no scheme) that starts with the prefix
// Anything else - another host, another workspace's prefix, a legacy
// unprefixed pathname, path traversal, garbage - is null, and callers
// treat null as "do not touch this object".
export function blobPathnameForWorkspace(urlOrPathname, workspaceId) {
  if (typeof urlOrPathname !== 'string' || !urlOrPathname) return null;
  if (!validWorkspaceId(workspaceId)) return null;
  let pathname;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrPathname)) {
    let u;
    try { u = new URL(urlOrPathname); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    if (!isBlobHost(u.hostname)) return null;
    try { pathname = decodeURIComponent(u.pathname); } catch { return null; }
    pathname = pathname.replace(/^\/+/, '');
  } else {
    if (/^\/\//.test(urlOrPathname)) return null; // protocol-relative URL
    pathname = urlOrPathname.replace(/^\/+/, '');
  }
  if (!pathname || pathname.length > 1024) return null;
  if (pathname.includes('\0') || pathname.split('/').some((seg) => seg === '..' || seg === '')) return null;
  const prefix = `${UPLOAD_ROOT}/${workspaceId}/`;
  if (!pathname.startsWith(prefix)) return null;
  if (pathname.length === prefix.length) return null; // the folder itself
  return pathname;
}

// Filter a list of stored pathnames down to the ones this workspace may
// delete. Used right before del().
export function scopedBlobPathnames(pathnames, workspaceId) {
  if (!Array.isArray(pathnames)) return [];
  const out = [];
  for (const p of pathnames) {
    const ok = blobPathnameForWorkspace(p, workspaceId);
    if (ok && !out.includes(ok)) out.push(ok);
  }
  return out;
}

// Token-route guard: the browser-chosen pathname must sit under the
// uploading workspace's prefix. Throws UploadScopeError (400) otherwise.
export function assertUploadPathname(pathname, workspaceId) {
  const ok = blobPathnameForWorkspace(pathname, workspaceId);
  if (!ok || /^[a-z][a-z0-9+.-]*:\/\//i.test(String(pathname))) {
    throw new UploadScopeError();
  }
  return ok;
}
