// Short-lived signed links to a document's PDF files.
//
// The raw Vercel Blob address of a document's PDF (the uploaded original
// or the signed copy) is never handed to a browser any more. Instead every
// API response that needs to show a PDF carries a link to
// /api/documents/file?t=<token>, where the token is an HS256 JWT naming
// exactly one document and one file ('source' or 'final') with an expiry.
// The file endpoint (api/documents/file.js) checks the token, re-reads the
// document row and only then serves or redirects to the bytes.
//
// Why a signed link and not a session check: the owner's iPhone app talks
// to the API with a Bearer token (no cookie), signers have no account at
// all, and the completed-copy links have to work when opened from an email
// or a new browser tab. A signed, expiring, single-document link works in
// every one of those places and leaks nothing durable if it is forwarded.
import jwt from 'jsonwebtoken';
import { appUrl } from './tokens.js';

const KINDS = new Set(['source', 'final']);
const TYP = 'docfile';

// Owner and portal views refresh their data often; a day is plenty and a
// forwarded link stops working soon after.
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set');
  return s;
}

export function signDocFileToken(documentId, kind, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!documentId || !KINDS.has(kind)) throw new Error('bad doc file token args');
  return jwt.sign({ typ: TYP, d: String(documentId), k: kind }, secret(), {
    algorithm: 'HS256',
    expiresIn: Math.max(60, Math.min(Number(ttlSeconds) || DEFAULT_TTL_SECONDS, 30 * 24 * 60 * 60)),
  });
}

// Returns { documentId, kind } or null (bad signature, expired, wrong
// shape). Never throws.
export function verifyDocFileToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 2000) return null;
  try {
    const p = jwt.verify(token, secret(), { algorithms: ['HS256'] });
    if (!p || p.typ !== TYP || typeof p.d !== 'string' || !KINDS.has(p.k)) return null;
    return { documentId: p.d, kind: p.k };
  } catch {
    return null;
  }
}

// Absolute URL (the iPhone app and emails need the real host).
export function docFileUrl(documentId, kind, ttlSeconds) {
  if (!documentId) return null;
  try {
    return `${appUrl()}/api/documents/file?t=${encodeURIComponent(signDocFileToken(documentId, kind, ttlSeconds))}`;
  } catch {
    return null;
  }
}
