// Outbound-URL guards for anything the server fetches on a user's say-so
// (owner-configured webhooks, document PDFs, ...). A serverless function
// sits inside the platform's network, so a URL that resolves to the cloud
// metadata service, a loopback port or an RFC-1918 host would let a user
// probe or exfiltrate from the inside (SSRF).
//
//   assertPublicHttpsUrl(url)   https only, no userinfo, host must not be
//                               (or resolve to) a private / loopback /
//                               link-local / multicast address. Resolves
//                               the hostname and checks EVERY address,
//                               so a name with one public and one private
//                               A record is refused too.
//   assertPlatformBlobUrl(url)  https and the host is the platform's blob
//                               store (*.blob.vercel-storage.com). For
//                               URLs that must only ever point at files
//                               we uploaded ourselves.
//
// Both throw an Error with a short user-facing message and return the
// normalized URL string on success.
import dns from 'node:dns';
import net from 'node:net';

// ── IPv4 ────────────────────────────────────────────────────────────────
// Parses dotted-decimal plus the legacy forms some parsers still accept
// (0x7f.0.0.1, 0177.0.0.1, 2130706433, 127.1). The WHATWG URL parser
// already canonicalizes these in the hostname, but DNS answers and
// defensive callers hand us raw strings, so parse them all here.
function parseIpv4(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!p) return null;
    let n;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  // The last part absorbs the remaining octets (127.1 == 127.0.0.1).
  const last = nums.pop();
  for (const n of nums) if (n > 255) return null;
  const remaining = 4 - nums.length;
  if (last >= 256 ** remaining) return null;
  let v = 0;
  for (const n of nums) v = v * 256 + n;
  v = v * 256 ** remaining + last;
  return v >>> 0;
}

function ipv4InCidr(v, base, bits) {
  const b = parseIpv4(base);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((v & mask) >>> 0) === ((b & mask) >>> 0);
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // RFC 1918
  ['100.64.0.0', 10],    // carrier NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata lives here)
  ['172.16.0.0', 12],    // RFC 1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // RFC 1918
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
];

function ipv4IsPrivate(v) {
  return PRIVATE_V4.some(([base, bits]) => ipv4InCidr(v, base, bits));
}

// ── IPv6 ────────────────────────────────────────────────────────────────
// Expands to eight 16-bit groups. Handles "::" compression and a trailing
// embedded IPv4 (::ffff:10.0.0.1), with or without a zone id.
function parseIpv6(str) {
  let s = String(str || '').trim().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  let groups = [];
  let tail = [];
  const dc = s.indexOf('::');
  const expand = (part) => {
    if (part === '') return [];
    const out = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.includes('.')) {
        if (i !== items.length - 1) return null;
        const v4 = parseIpv4(it);
        if (v4 == null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(it)) return null;
        out.push(parseInt(it, 16));
      }
    }
    return out;
  };
  if (dc !== -1) {
    if (s.indexOf('::', dc + 1) !== -1) return null;
    groups = expand(s.slice(0, dc));
    tail = expand(s.slice(dc + 2));
    if (!groups || !tail) return null;
    const fill = 8 - groups.length - tail.length;
    if (fill < 1) return null;
    groups = [...groups, ...new Array(fill).fill(0), ...tail];
  } else {
    groups = expand(s);
    if (!groups || groups.length !== 8) return null;
  }
  return groups;
}

function ipv6IsPrivate(g) {
  const allZeroTo = (n) => g.slice(0, n).every((x) => x === 0);
  // :: (unspecified) and ::1 (loopback)
  if (allZeroTo(7) && (g[7] === 0 || g[7] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d and the deprecated IPv4-compatible ::a.b.c.d
  if (allZeroTo(5) && (g[5] === 0xffff || g[5] === 0)) {
    return ipv4IsPrivate(((g[6] << 16) | g[7]) >>> 0);
  }
  // NAT64 well-known prefix 64:ff9b::/96 carries a v4 in the last 32 bits
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return ipv4IsPrivate(((g[6] << 16) | g[7]) >>> 0);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

// True when the string is an IP literal in a range we never fetch from.
// Non-literal strings return false (they are hostnames, resolved later).
export function isPrivateAddress(addr) {
  const s = String(addr || '').trim().replace(/^\[|\]$/g, '');
  const v6 = parseIpv6(s);
  if (v6) return ipv6IsPrivate(v6);
  const v4 = parseIpv4(s);
  if (v4 != null) return ipv4IsPrivate(v4);
  return false;
}

export function isIpLiteral(host) {
  const s = String(host || '').replace(/^\[|\]$/g, '');
  return net.isIP(s) !== 0 || parseIpv4(s) != null || parseIpv6(s) != null;
}

function parseHttpsUrl(raw, what) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error(`Invalid ${what}`); }
  if (u.protocol !== 'https:') throw new Error(`${what} must use https`);
  if (u.username || u.password) throw new Error(`${what} must not contain credentials`);
  if (!u.hostname) throw new Error(`Invalid ${what}`);
  return u;
}

// `lookup` is injectable for tests: (hostname, { all: true }) → [{ address }].
export async function assertPublicHttpsUrl(raw, { lookup = dns.promises.lookup, what = 'URL' } = {}) {
  const u = parseHttpsUrl(raw, what);
  const host = u.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.internal') || bare.endsWith('.local')) {
    throw new Error(`${what} not allowed`);
  }
  if (isIpLiteral(bare)) {
    if (isPrivateAddress(bare)) throw new Error(`${what} not allowed`);
    return u.toString();
  }
  let addrs;
  try {
    addrs = await lookup(bare, { all: true });
  } catch {
    throw new Error(`${what} host could not be resolved`);
  }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  if (list.length === 0) throw new Error(`${what} host could not be resolved`);
  if (list.some((a) => isPrivateAddress(a))) throw new Error(`${what} not allowed`);
  return u.toString();
}

// Files we uploaded ourselves live on the platform blob store. Anything
// else is refused before we fetch it.
const BLOB_HOST_RE = /^[a-z0-9][a-z0-9-]*\.(?:public\.)?blob\.vercel-storage\.com$/i;
export function isPlatformBlobUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'https:' && !u.username && !u.password && BLOB_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}
export function assertPlatformBlobUrl(raw, { what = 'file URL' } = {}) {
  const u = parseHttpsUrl(raw, what);
  if (!BLOB_HOST_RE.test(u.hostname)) throw new Error(`${what} must point at an uploaded file`);
  return u.toString();
}
