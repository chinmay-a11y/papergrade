'use strict';
// Per-question segmentation (§7). We never send a whole page and ask for a grade —
// each question region is cropped and extracted independently, which is what makes
// per-question confidence meaningful.
//
// Free-form handwriting: we split the page into horizontal bands by question count.
// A small vertical overlap keeps answers that straddle a boundary intact. This is a
// deliberate trade (documented): robust and instant vs. true marker detection
// (`Q1.`/`१.`/`प्र.१`), which a Vision boundary call could refine later.

const { cropRegion } = require('./privacy');

// Returns [{ question_no, region:{x0,y0,x1,y1} }] for N questions.
function bandRegions(n) {
  const overlap = 0.03;
  const regions = [];
  for (let i = 0; i < n; i++) {
    const y0 = Math.max(0, i / n - overlap);
    const y1 = Math.min(1, (i + 1) / n + overlap);
    regions.push({ question_no: i + 1, region: { x0: 0, y0, x1: 1, y1 } });
  }
  return regions;
}

// Produce cropped buffers per question from a re-encoded page image.
async function segment(pageBuffer, questionCount) {
  const regions = bandRegions(questionCount);
  const crops = [];
  for (const r of regions) {
    const cropBuffer = await cropRegion(pageBuffer, r.region);
    crops.push({ question_no: r.question_no, region: r.region, cropBuffer });
  }
  return crops;
}

module.exports = { segment, bandRegions };
