'use strict';
/**
 * Claude provider smoke test — proves the document-scan + answer-key compare works.
 * Needs ANTHROPIC_API_KEY in .env. Uses a real handwritten Hindi page if one exists.
 *
 *   node scripts/verify-claude.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const claude = require('../lib/claude');

function samplePage() {
  const candidates = [
    path.join(__dirname, '..', 'data', 'hindiA_p4.png'),           // real handwritten Hindi (if present)
    path.join(__dirname, '..', 'fixtures', 'samples', 'Diya_Patel.png'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return { path: p, buf: fs.readFileSync(p) };
  return null;
}

(async () => {
  console.log(`\n  Claude smoke test  (model: ${claude.MODEL})`);
  if (!claude.isReady()) { console.error('  ✗ ANTHROPIC_API_KEY not set — add it to .env and retry.'); process.exit(1); }
  const sample = samplePage();
  if (!sample) { console.error('  ✗ No sample page image found (data/hindiA_p4.png or fixtures/samples/).'); process.exit(1); }
  console.log(`  Using page: ${path.basename(sample.path)}`);

  console.log('\n[1] Document scan (vision OCR)…');
  const t0 = Date.now();
  const text = await claude.ocrImage(sample.buf, { language: 'Hindi' });
  console.log(`    OCR in ${((Date.now() - t0) / 1000).toFixed(1)}s:\n    ${text.replace(/\n/g, ' ').slice(0, 200)}`);

  console.log('\n[2] Compare booklet to answer key (one vision call)…');
  const answerKey =
`प्रश्न 1. कविता का मुख्य उद्देश्य क्या है? (5 अंक) उत्तर: कवि लोगों को जीवन की छोटी-छोटी बारीकियाँ देखने और सकारात्मकता से जीने के लिए प्रेरित करना चाहते हैं।`;
  const questions = [{ question_no: 1, max_marks: 5, concept: 'poem purpose' }];
  const t1 = Date.now();
  const graded = await claude.gradeBookletVision({ answerKeyText: answerKey, pageBuffers: [sample.buf], questions, maxPages: 1 });
  console.log(`    graded in ${((Date.now() - t1) / 1000).toFixed(1)}s → ${(graded.answers || []).length} answer(s)`);
  (graded.answers || []).forEach(a =>
    console.log(`    Q${a.question_no} ${a.awarded_marks}/${a.max_marks} [${a.concept}]${a.needs_human ? ' ⚠' : ''} — ${a.rationale}`));

  const ok = text && text.trim() && (graded.answers || []).length > 0;
  console.log(`\n  ${ok ? '✓ Claude document-scan + compare works.' : '✗ Something came back empty.'}\n`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('\n  FAILED:', e.message, '\n'); process.exit(1); });
