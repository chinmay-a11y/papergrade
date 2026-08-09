'use strict';
// Quadratic Weighted Kappa (§7). Marks are ordinal, so QWK is the correct
// agreement metric — raw accuracy and unweighted kappa are not. Compares the
// pipeline's awarded marks against teacher-confirmed marks (post-override), which
// stand in as ground truth. Reported honestly with sample size.

// ratings: array of { a, b, max } — a = model marks, b = human marks, per question.
function qwk(ratings) {
  const pairs = ratings.filter(r => Number.isFinite(r.a) && Number.isFinite(r.b));
  const n = pairs.length;
  if (n === 0) return { kappa: null, n: 0 };

  // Bucket marks to a common integer scale 0..K (round to nearest 0.5 -> *2).
  const scaled = pairs.map(r => ({ a: Math.round(r.a * 2), b: Math.round(r.b * 2) }));
  const K = Math.max(1, ...scaled.map(r => Math.max(r.a, r.b)));
  const size = K + 1;

  const O = Array.from({ length: size }, () => new Array(size).fill(0));
  const histA = new Array(size).fill(0);
  const histB = new Array(size).fill(0);
  for (const { a, b } of scaled) { O[a][b]++; histA[a]++; histB[b]++; }

  let num = 0, den = 0;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const w = ((i - j) * (i - j)) / (K * K);
      const e = (histA[i] * histB[j]) / n;
      num += w * O[i][j];
      den += w * e;
    }
  }
  if (den === 0) return { kappa: 1, n }; // perfect/degenerate agreement
  return { kappa: Number((1 - num / den).toFixed(3)), n };
}

module.exports = { qwk };
