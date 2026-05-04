// Symmetric encryption for secrets at rest (Stripe API keys, webhook secrets).
// AES-256-GCM. The key is read from process.env.SECRETS_KEY at first use —
// must be 32 bytes encoded as base64 or hex. We don't read it at import time
// so missing env doesn't break unrelated routes during local dev.
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.SECRETS_KEY;
  if (!raw) {
    throw new Error('SECRETS_KEY is not set — required to encrypt/decrypt stored secrets');
  }
  // Accept base64 or hex. 32 bytes either way.
  let buf;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
    buf = Buffer.from(raw, 'hex');
  } else {
    buf = Buffer.from(raw, 'base64');
  }
  if (buf.length !== 32) {
    throw new Error(`SECRETS_KEY must decode to 32 bytes (got ${buf.length})`);
  }
  cachedKey = buf;
  return buf;
}

// Returns "v1.<iv_b64>.<tag_b64>.<ciphertext_b64>" — version-tagged so we can
// rotate algorithms later without breaking existing rows.
export function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt expects a string');
  }
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join('.');
}

export function decrypt(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1.')) {
    throw new Error('Encrypted value is malformed or uses an unsupported version');
  }
  const [, ivB64, tagB64, ctB64] = blob.split('.');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('Encrypted value is malformed');
  }
  const key = loadKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Encrypted value has bad iv/tag length');
  }
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// Mask a secret for display: shows the last 4 chars only. Used so the UI can
// confirm "this is the right key" without exposing the full value.
export function maskSecret(raw) {
  const s = String(raw || '');
  if (s.length <= 8) return '••••';
  return '••••' + s.slice(-4);
}
