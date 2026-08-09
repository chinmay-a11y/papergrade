'use strict';
// Privacy + safety helpers (§11), all pure-JS (jimp — no native build).
//  - re-encode uploaded images server-side: strips EXIF geolocation and
//    neutralises malformed-image payloads in one pass.
//  - name-stripping: a stable per-name alias (student_xxxx) is the only student
//    identifier that ever reaches a Sarvam prompt.

const crypto = require('crypto');
const { Jimp } = require('jimp');

const MAX_DIM = 2000; // downscale huge phone photos; keeps Vision calls fast

// Re-encode to a clean PNG buffer. Returns { buffer, width, height }.
async function reencode(inputBuffer) {
  const img = await Jimp.read(inputBuffer);
  if (Math.max(img.bitmap.width, img.bitmap.height) > MAX_DIM) {
    img.scaleToFit({ w: MAX_DIM, h: MAX_DIM });
  }
  const buffer = await img.getBuffer('image/png'); // fresh encode => no EXIF carried over
  return { buffer, width: img.bitmap.width, height: img.bitmap.height };
}

// Crop a normalised region { x0, y0, x1, y1 } (fractions 0..1) from an image buffer.
async function cropRegion(inputBuffer, region) {
  const img = await Jimp.read(inputBuffer);
  const W = img.bitmap.width, H = img.bitmap.height;
  const x = Math.round(region.x0 * W);
  const y = Math.round(region.y0 * H);
  const w = Math.max(1, Math.round((region.x1 - region.x0) * W));
  const h = Math.max(1, Math.round((region.y1 - region.y0) * H));
  img.crop({ x, y, w, h });
  return img.getBuffer('image/png');
}

// Slightly rotate + rescale a crop for the second extraction pass (perturbation
// that surfaces OCR instability without changing the content).
async function perturb(inputBuffer, { deg = 1.5, scale = 0.85 } = {}) {
  const img = await Jimp.read(inputBuffer);
  img.rotate(deg);
  img.scale(scale);
  return img.getBuffer('image/png');
}

// Deterministic alias for a real name — same name -> same alias within a batch.
function aliasFor(name, salt = 'demo') {
  const h = crypto.createHash('sha256').update(salt + '|' + (name || '')).digest('hex');
  return 'student_' + h.slice(0, 4);
}

module.exports = { reencode, cropRegion, perturb, aliasFor, MAX_DIM };
