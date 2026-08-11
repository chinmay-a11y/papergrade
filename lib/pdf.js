'use strict';
// PDF support. Sarvam Vision (Doc AI) reads PDFs, but our per-question cropping needs
// raster pixels — so we rasterise each PDF page to a PNG with MuPDF (WASM, no native
// build; works the same on Windows dev and the Alpine Docker image).

let mupdfPromise;
function getMupdf() { return (mupdfPromise ||= import('mupdf')); }

// Detect a PDF from mimetype, filename, or the %PDF- magic bytes.
function isPdf(mimetype, filename, buffer) {
  if (mimetype && /pdf/i.test(mimetype)) return true;
  if (filename && /\.pdf$/i.test(filename)) return true;
  if (buffer && buffer.length > 4 && buffer.slice(0, 5).toString('latin1') === '%PDF-') return true;
  return false;
}

// Rasterise a PDF buffer -> array of PNG page buffers. scale 2 ≈ 144dpi (good OCR).
async function pdfToPngPages(buffer, { scale = 2, maxPages = 40 } = {}) {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(new Uint8Array(buffer), 'application/pdf');
  const n = Math.min(doc.countPages(), maxPages);
  const pages = [];
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    pages.push(Buffer.from(pix.asPNG()));
    if (pix.destroy) pix.destroy();
    if (page.destroy) page.destroy();
  }
  if (doc.destroy) doc.destroy();
  return pages;
}

module.exports = { isPdf, pdfToPngPages };
