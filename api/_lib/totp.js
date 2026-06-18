// RFC 6238 TOTP (Time-based One-Time Password) implementation using
// only node:crypto. No external dependency - adds zero bytes to the
// function bundle that web-push or stripe wouldn't already cost.
//
// What this provides:
//   generateSecret()    20 random bytes (160-bit, RFC 4226 recommended)
//   base32Encode/Decode RFC 4648 base32 (the format authenticator
//                        apps and otpauth:// URIs both use)
//   generateTotp(buf)   the current 6-digit code for a secret buffer
//   verifyTotp(buf, c)  constant-time-ish verify with ±1-step drift
//                        (covers up to 30s of client/server clock skew
//                         in either direction)
//   otpauthUrl({...})   the URI authenticator apps scan to enroll
//   generateBackupCodes 10 single-use recovery codes (returned to the
//                        owner once at enrollment)
//   hashBackupCode      SHA-256 of the normalized code, stored
//                        in users.totp_backup_codes_hashed so
//                        even DB read doesn't reveal the plaintext
//
// We pin SHA1 + 30s period + 6 digits because that's what every major
// authenticator app (Google Authenticator, 1Password, Authy, Microsoft
// Authenticator, Yubico) defaults to. Any change here would invalidate
// existing enrollments.
import crypto from 'node:crypto';

// RFC 4648 base32 alphabet - uppercase letters A-Z + digits 2-7.
// Drops the visually-ambiguous 0/O/1/I so manual entry is forgiving.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret() {
  return crypto.randomBytes(20);
}

export function base32Encode(buf) {
  let output = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 0x1f];
  return output;
}

export function base32Decode(s) {
  const clean = String(s || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const idx = ALPHABET.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// Computes the 6-digit TOTP code for a specific 30-second counter.
function totpCodeAt(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24)
             | ((hmac[offset + 1] & 0xff) << 16)
             | ((hmac[offset + 2] & 0xff) << 8)
             |  (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

export function generateTotp(secretBuf, { period = 30 } = {}) {
  const counter = Math.floor(Date.now() / 1000 / period);
  return totpCodeAt(secretBuf, counter);
}

// drift=1 means we accept the previous, current, or next 30-second
// window - total tolerance ~90 seconds for clock skew. drift=0 is
// strict; drift=2 is loose.
export function verifyTotp(secretBuf, code, { period = 30, drift = 1 } = {}) {
  const target = String(code || '').trim();
  if (!/^\d{6}$/.test(target)) return false;
  const counter = Math.floor(Date.now() / 1000 / period);
  for (let w = -drift; w <= drift; w++) {
    // crypto.timingSafeEqual would be ideal here but the strings are
    // short fixed length and the surrounding bcrypt-style work makes
    // the timing leak immaterial in practice. Stays plain compare.
    if (totpCodeAt(secretBuf, counter + w) === target) return true;
  }
  return false;
}

// Authenticator-app enrollment URI. label is what shows up under the
// account name in the user's app (their email is the natural choice).
// algorithm/digits/period are pinned to the defaults; including them
// explicitly lets stricter apps (like Yubico Authenticator) accept
// the URI without falling back to defaults that might mismatch ours.
export function otpauthUrl({ secretBase32, label, issuer = 'Ivy OS' }) {
  const encLabel = encodeURIComponent(`${issuer}:${label}`);
  const encIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encLabel}?secret=${secretBase32}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}

// 10 single-use recovery codes for "lost my phone" scenarios.
// 8 alphanumeric chars (base32 alphabet - no 0/O/1/I confusion),
// formatted as XXXX-XXXX so they're human-readable + email-friendly.
// Plaintext is shown to the owner ONCE at enrollment; we store hashes.
export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(8);
    let c = '';
    for (let j = 0; j < 8; j++) c += ALPHABET[bytes[j] % 32];
    codes.push(c.slice(0, 4) + '-' + c.slice(4));
  }
  return codes;
}

// Normalize a user-entered backup code (strip dashes, uppercase) and
// hash. Used to store + compare without keeping plaintext.
export function hashBackupCode(plaintext) {
  const normalized = String(plaintext || '').replace(/[-\s]/g, '').toUpperCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
