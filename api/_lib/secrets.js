// Symmetric encryption for secrets at rest (Stripe API keys, webhook secrets).
// AES-256-GCM. The PRIMARY key is read from process.env.SECRETS_KEY; for
// rotation, set SECRETS_KEY_PREVIOUS to the OLD key so decrypt can still
// read previously-encrypted blobs.
//
// Rotation procedure:
//   1. Generate a fresh 32-byte key: `openssl rand -hex 32`.
//   2. Set SECRETS_KEY_PREVIOUS = <old key>, SECRETS_KEY = <new key>.
//      Redeploy. At this point: new writes use the new key; old reads
//      still work via the previous key.
//   3. Run /api/admin/migrate (or a one-off rewrap script) to re-encrypt
//      every existing blob under the new key. (encrypt() always uses the
//      primary; reading + writing back is enough.)
//   4. Once every blob is under the new key, unset SECRETS_KEY_PREVIOUS
//      and redeploy. Done.
//
// Key not read at import time so missing env doesn't break unrelated
// routes during local dev.
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedPrimaryKey = null;
let cachedPreviousKey = null;
let previousLoaded = false;

function parseKey(raw, name) {
  let buf;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
    buf = Buffer.from(raw, 'hex');
  } else {
    buf = Buffer.from(raw, 'base64');
  }
  if (buf.length !== 32) {
    throw new Error(`${name} must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}

function loadKey() {
  if (cachedPrimaryKey) return cachedPrimaryKey;
  const raw = process.env.SECRETS_KEY;
  if (!raw) {
    throw new Error('SECRETS_KEY is not set — required to encrypt/decrypt stored secrets');
  }
  cachedPrimaryKey = parseKey(raw, 'SECRETS_KEY');
  return cachedPrimaryKey;
}

// Loads the previous key (used during rotation windows). Returns null
// if SECRETS_KEY_PREVIOUS isn't set, which is the steady state.
function loadPreviousKey() {
  if (previousLoaded) return cachedPreviousKey;
  previousLoaded = true;
  const raw = process.env.SECRETS_KEY_PREVIOUS;
  if (!raw) return null;
  try {
    cachedPreviousKey = parseKey(raw, 'SECRETS_KEY_PREVIOUS');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[secrets] SECRETS_KEY_PREVIOUS is malformed:', err.message);
    cachedPreviousKey = null;
  }
  return cachedPreviousKey;
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
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Encrypted value has bad iv/tag length');
  }

  // Try the primary key first; if that fails (likely "Unsupported state
  // or unable to authenticate data" from GCM tag mismatch) and a previous
  // key is configured, retry with the previous key. This is the rotation
  // window: new blobs use the new key, old blobs still decrypt under the
  // old one until the rewrap migration runs.
  const tryDecrypt = (key) => {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  };

  try {
    return tryDecrypt(loadKey());
  } catch (primaryErr) {
    const prev = loadPreviousKey();
    if (!prev) throw primaryErr;
    try {
      return tryDecrypt(prev);
    } catch {
      // Neither key worked — throw the primary error (more meaningful).
      throw primaryErr;
    }
  }
}

// Mask a secret for display: shows the last 4 chars only. Used so the UI can
// confirm "this is the right key" without exposing the full value.
export function maskSecret(raw) {
  const s = String(raw || '');
  if (s.length <= 8) return '••••';
  return '••••' + s.slice(-4);
}
