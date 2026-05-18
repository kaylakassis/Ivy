// Client-side image pre-processing for uploads.
//
// Modern phone cameras produce 12-48 MP photos at 5-15 MB each — far
// larger than any web surface needs. Uploading raw is slow on mobile
// LTE and wastes Vercel Blob storage. We resize + re-encode in the
// browser before upload, which also conveniently STRIPS EXIF metadata
// (Canvas re-encoding drops everything that isn't pixels — including
// GPS location, camera serial, focal length, the lot).
//
// Why client-side and not server-side sharp:
//   • No serverless function bandwidth cost for the raw upload.
//   • No sharp dependency (it's a 30MB native binary that needs
//     special Vercel build config).
//   • Privacy win — GPS coordinates never leave the device.
//
// What we DON'T do:
//   • Virus / malware scan. Web-browser sandboxed; not our threat
//     model for image content. If a workspace processes user-supplied
//     files in a way that could exploit a parser bug, that's a
//     separate concern (ClamAV / VirusTotal integration on the
//     server side would be the right answer; out of scope here).
//   • HEIC → JPEG conversion. Safari renders HEIC; Chrome doesn't.
//     If a Chrome user attaches a HEIC photo, the canvas read will
//     fail; we surface that as a clear error so they can re-pick.
//
// Returns a new File ready to upload — same .name, possibly different
// .type (jpeg/webp) and much smaller .size.

const DEFAULT_MAX_DIM   = 1920;     // longest edge in px
const DEFAULT_QUALITY   = 0.85;     // JPEG/WebP quality
const DEFAULT_MIME      = 'image/jpeg';
const SKIP_SIZE_BYTES   = 200 * 1024;  // files under 200 KB skip processing

export async function processImageForUpload(file, opts = {}) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    return file; // non-image — passthrough
  }
  // Small images: skip the round-trip through canvas. They're already
  // web-friendly + EXIF on tiny thumbnails isn't a privacy risk.
  if (file.size < SKIP_SIZE_BYTES) {
    return file;
  }

  const maxDim   = opts.maxDim   || DEFAULT_MAX_DIM;
  const quality  = opts.quality  || DEFAULT_QUALITY;
  const outMime  = pickOutputMime(file.type, opts.mime || DEFAULT_MIME);

  try {
    const bitmap = await loadImageBitmap(file);
    const { width, height } = scaleDown(bitmap.width, bitmap.height, maxDim);
    const canvas = drawToCanvas(bitmap, width, height);
    const blob   = await canvasToBlob(canvas, outMime, quality);

    // Preserve the original filename but swap the extension to match
    // the output mime (so the URL hint matches what's actually inside).
    const ext = mimeToExt(outMime);
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    const outFile = new File([blob], `${baseName}.${ext}`, { type: outMime });
    return outFile;
  } catch (err) {
    // HEIC on Chrome, corrupt file, blocked-by-policy canvas, etc.
    // Surface a clear error rather than silently uploading the
    // unprocessed huge file.
    throw new Error(
      `Could not process this image: ${err.message || 'unknown error'}. ` +
      `Try saving it as JPEG and re-uploading.`,
    );
  }
}

function pickOutputMime(inputMime, requested) {
  // Honor explicit request; otherwise convert PNG-with-alpha rarely
  // matters for our use cases (photos), so we always go to JPEG by
  // default to maximize compression. WebP would be smaller still but
  // not all email clients render it.
  return requested || 'image/jpeg';
}

function mimeToExt(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/png')  return 'png';
  return 'jpg';
}

async function loadImageBitmap(file) {
  // createImageBitmap respects EXIF orientation in modern browsers,
  // so when we paint to canvas the rotation is already applied.
  // imageOrientation: 'from-image' forces this on older Chromes.
  if (typeof createImageBitmap === 'function') {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  }
  // Fallback: load via Image element.
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight, _img: img });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image could not be decoded'));
    };
    img.src = url;
  });
}

function scaleDown(w, h, maxDim) {
  const longest = Math.max(w, h);
  if (longest <= maxDim) return { width: w, height: h };
  const ratio = maxDim / longest;
  return {
    width:  Math.round(w * ratio),
    height: Math.round(h * ratio),
  };
}

function drawToCanvas(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // Higher quality scaling — default 'pixelated' on Firefox at very
  // small sizes; 'high' is the modern correct setting for photos.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source._img || source, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Canvas export failed')),
      mime,
      quality,
    );
  });
}
