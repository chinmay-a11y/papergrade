'use strict';
// Defensible confidence (§7). Not a model self-report: extract each crop twice
// under slightly different conditions, then measure normalised edit distance
// between the two transcripts. Disagreement IS the uncertainty signal.

// Levenshtein distance at the character level.
function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Normalised edit distance in [0,1]; confidence = 1 - that.
function normalisedEditDistance(a, b) {
  a = (a || '').trim(); b = (b || '').trim();
  if (!a && !b) return 0;
  const dist = levenshtein(a, b);
  return dist / Math.max(a.length, b.length, 1);
}

// Combine two extraction passes into {extracted_text, edit_distance, confidence}.
function scoreConfidence(passA, passB) {
  const ed = normalisedEditDistance(passA, passB);
  // Canonical transcript: prefer the longer, generally more complete pass.
  const extracted_text = (passA || '').length >= (passB || '').length ? passA : passB;
  return {
    extract_pass_a: passA,
    extract_pass_b: passB,
    edit_distance: Number(ed.toFixed(3)),
    confidence: Number((1 - ed).toFixed(3)),
    extracted_text,
  };
}

// Word-level diff for the review console's confidence bar. Returns tokens tagged
// same | a-only | b-only so the UI can render the disagreement visually.
function wordDiff(a, b) {
  const A = (a || '').split(/\s+/).filter(Boolean);
  const B = (b || '').split(/\s+/).filter(Boolean);
  const m = A.length, n = B.length;
  // LCS table
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ t: A[i], k: 'same' }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ t: A[i], k: 'a' }); i++; }
    else { out.push({ t: B[j], k: 'b' }); j++; }
  }
  while (i < m) out.push({ t: A[i++], k: 'a' });
  while (j < n) out.push({ t: B[j++], k: 'b' });
  return out;
}

module.exports = { levenshtein, normalisedEditDistance, scoreConfidence, wordDiff };
