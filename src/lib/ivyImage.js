// Photos for Ivy. Owners can pick or take photos up to 25 MB; we shrink
// them on the device before sending, because Ivy's request limit is far
// smaller and the reader works best around one to two megapixels anyway.
// Tall screenshots (a day of appointments, a long list) are cut into
// stacked pieces so the text stays sharp instead of being squeezed. The
// photo itself is never stored by Ivy; only the shrunk pieces travel with
// the one message that uses them.

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // what owners may pick
export const MAX_PHOTOS = 4;                     // per message
// Budget for everything one message sends (base64 is ~4/3 of the bytes;
// the server accepts about 4.2 MB of base64 in total).
const TOTAL_BYTES_BUDGET = 2.9 * 1024 * 1024;
const MAX_PIECES = 12;
// Pieces are encoded so the long side is at most this and the area stays
// near what the reader looks at, keeping small text legible.
const MAX_WIDTH = 1280;
const MAX_PIECE_PIXELS = 1.6 * 1024 * 1024;

function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).catch(() => loadViaImg(file));
  }
  return loadViaImg(file);
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 0); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
    img.src = url;
  });
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    else resolve(null);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// One photo → one or more JPEG pieces { filename, mediaType, base64, bytes }.
async function piecesFor(file, quality) {
  const bmp = await loadBitmap(file);
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  if (!w || !h) throw new Error('unreadable');
  const scale = Math.min(1, MAX_WIDTH / w);
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  // Height of one piece at output scale, so each stays near MAX_PIECE_PIXELS.
  const pieceH = Math.max(Math.round(outW * 0.6), Math.floor(MAX_PIECE_PIXELS / outW));
  const count = Math.max(1, Math.ceil(outH / pieceH));
  const out = [];
  for (let i = 0; i < count; i++) {
    const y0 = i * pieceH;
    // Overlap pieces slightly so a line cut at an edge appears whole in one.
    const overlap = i > 0 ? Math.round(pieceH * 0.06) : 0;
    const sy = Math.max(0, y0 - overlap);
    const sh = Math.min(outH - sy, pieceH + overlap);
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, sh);
    ctx.drawImage(bmp, 0, sy / scale, w, sh / scale, 0, 0, outW, sh);
    // eslint-disable-next-line no-await-in-loop
    const blob = await canvasToJpeg(canvas, quality);
    if (!blob) throw new Error('unreadable');
    // eslint-disable-next-line no-await-in-loop
    const base64 = await blobToBase64(blob);
    const base = (file.name || 'photo').replace(/\.[a-z0-9]+$/i, '');
    out.push({
      filename: count > 1 ? `${base} (part ${i + 1} of ${count}).jpg` : `${base}.jpg`,
      mediaType: 'image/jpeg', base64, bytes: blob.size,
    });
  }
  if (typeof bmp.close === 'function') bmp.close();
  return out;
}

// Prepares up to MAX_PHOTOS photos. Returns { pieces, photos, errors }.
// errors are short, owner-readable reasons for files that were left out.
export async function preparePhotosForIvy(files) {
  const list = Array.from(files || []);
  const errors = [];
  const accepted = [];
  for (const f of list) {
    if (accepted.length >= MAX_PHOTOS) { errors.push(`Up to ${MAX_PHOTOS} photos per message.`); break; }
    if (!/^image\//i.test(f.type || '') && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name || '')) {
      errors.push(`${f.name || 'That file'} is not a photo.`); continue;
    }
    if (f.size > MAX_PHOTO_BYTES) { errors.push(`${f.name || 'That photo'} is over 25 MB.`); continue; }
    accepted.push(f);
  }
  // Lower the quality until everything fits the per-message budget.
  for (const quality of [0.82, 0.7, 0.58, 0.48]) {
    const pieces = [];
    const photos = [];
    const failed = [];
    for (const f of accepted) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const ps = await piecesFor(f, quality);
        pieces.push(...ps);
        photos.push({ name: f.name || 'photo', pieces: ps.length });
      } catch {
        failed.push(`${f.name || 'A photo'} could not be opened here. Try a screenshot or a JPEG or PNG.`);
      }
    }
    const total = pieces.reduce((n, p) => n + p.bytes, 0);
    if ((total <= TOTAL_BYTES_BUDGET && pieces.length <= MAX_PIECES) || quality === 0.48) {
      if (pieces.length > MAX_PIECES || total > TOTAL_BYTES_BUDGET) {
        return { pieces: [], photos: [], errors: [...errors, ...failed, 'Those photos are too much for one message. Send fewer at a time.'] };
      }
      return { pieces: pieces.map(({ bytes, ...p }) => p), photos, errors: [...errors, ...failed] };
    }
  }
  return { pieces: [], photos: [], errors };
}
