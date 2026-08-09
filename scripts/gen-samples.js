'use strict';
/**
 * Sample answer-sheet generator (for LIVE testing).
 *
 * The seeded demo pages are blank ruled lines — real Sarvam Vision reads nothing on
 * them. This renders realistic Hindi answer sheets (one page per student, 5 question
 * bands) to PNG so the LIVE OCR → grade → feedback pipeline can be exercised without
 * waiting on handwritten photos.
 *
 * Rendering uses headless Chrome (reliable Devanagari shaping on Windows) with the
 * "Kalam" handwriting webfont when online, falling back to Nirmala UI / Noto.
 *   NOTE: rendered text is not truly handwritten — it validates the pipeline, not the
 *   handwriting-OCR spike. Snap a couple of real photos for the deck spike.
 *
 * Usage:
 *   node scripts/gen-samples.js                 -> writes fixtures/samples/*.png
 *   node scripts/gen-samples.js --upload        -> also uploads to the shared demo
 *                                                  workspace (server must be running)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT_DIR = path.join(__dirname, '..', 'fixtures', 'samples');
fs.mkdirSync(OUT_DIR, { recursive: true });

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge found. Set CHROME_PATH to a Chromium binary.');
}

// Five questions (mirrors lib/seed-rubric.js), each with Hindi answers at three
// quality tiers so grading produces a real spread. `bad` is weighted onto friction
// so one concept clearly dominates the class-failure chart.
const Q = [
  { no: 1, label: 'प्रश्न १', prompt: 'प्रकाश संश्लेषण क्या है? कच्चे माल बताइए। (5)',
    good: 'प्रकाश संश्लेषण वह प्रक्रिया है जिसमें पौधे सूर्य के प्रकाश, कार्बन डाइऑक्साइड और जल से क्लोरोफिल की मदद से भोजन बनाते हैं।',
    ok:   'पौधे सूर्य के प्रकाश और जल से भोजन बनाते हैं।',
    bad:  'पौधे भोजन बनाते हैं।' },
  { no: 2, label: 'प्रश्न २', prompt: 'बल की परिभाषा और एक प्रभाव लिखिए। (5)',
    good: 'बल एक धक्का या खिंचाव है जो किसी वस्तु की गति, दिशा या आकार को बदल सकता है।',
    ok:   'बल एक धक्का या खिंचाव है।',
    bad:  'बल से चीज़ें हिलती हैं।' },
  { no: 3, label: 'प्रश्न ३', prompt: 'जल का क्वथनांक और अवस्था परिवर्तन बताइए। (5)',
    good: 'जल का क्वथनांक सौ डिग्री सेल्सियस होता है और इस पर जल द्रव से वाष्प में बदल जाता है।',
    ok:   'जल का क्वथनांक सौ डिग्री सेल्सियस होता है।',
    bad:  'जल गरम होकर भाप बनता है।' },
  { no: 4, label: 'प्रश्न ४', prompt: 'मानव शरीर में रक्त का कार्य क्या है? (5)',
    good: 'रक्त शरीर में ऑक्सीजन और पोषक तत्वों को ले जाता है और अपशिष्ट कार्बन डाइऑक्साइड को बाहर लाता है।',
    ok:   'रक्त ऑक्सीजन और पोषक तत्व ले जाता है।',
    bad:  'रक्त शरीर में बहता है।' },
  { no: 5, label: 'प्रश्न ५', prompt: 'घर्षण क्या है? एक दैनिक प्रभाव लिखिए। (5)',
    good: 'घर्षण दो सतहों के बीच गति का विरोध करने वाला बल है और यह ऊष्मा उत्पन्न करता है।',
    ok:   'घर्षण गति का विरोध करता है।',
    bad:  'घर्षण से चीज़ रुक जाती है।' },
];

// Per-student answer quality. Friction (index 4) skews weak across the class.
const STUDENTS = [
  { name: 'Aarav Sharma',  tiers: ['good', 'good', 'ok',   'good', 'bad'] },
  { name: 'Diya Patel',    tiers: ['good', 'ok',   'good', 'ok',   'bad'] },
  { name: 'Kabir Singh',   tiers: ['ok',   'good', 'good', 'bad',  'bad'] },
  { name: 'Meera Nair',    tiers: ['good', 'good', 'ok',   'good', 'ok'] },
  { name: 'Rohan Das',     tiers: ['ok',   'bad',  'ok',   'ok',   'bad'] },
  { name: 'Ananya Rao',    tiers: ['good', 'ok',   'bad',  'good', 'bad'] },
];

function pageHtml(student) {
  const rows = Q.map((q, i) => {
    const ans = q[student.tiers[i]];
    return `
      <section class="q">
        <div class="qhead"><span class="qno">${q.label}.</span> <span class="qprompt">${q.prompt}</span></div>
        <div class="ans">${ans}</div>
      </section>`;
  }).join('');
  return `<!doctype html><html lang="hi"><head><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&display=swap" rel="stylesheet">
  <style>
    @page { size: 1000px 1400px; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; width: 1000px; height: 1400px; background: #fffdf7;
      font-family: 'Kalam', 'Nirmala UI', 'Noto Sans Devanagari', sans-serif; color: #14213d; }
    .sheet { padding: 46px 54px; }
    .hdr { display: flex; justify-content: space-between; align-items: flex-end;
      border-bottom: 2px solid #c7b8a1; padding-bottom: 10px; margin-bottom: 8px; }
    .hdr .t { font-size: 26px; font-weight: 700; }
    .hdr .s { font-size: 20px; }
    .q { padding: 14px 0 10px; border-bottom: 1px dashed #d9ccb5;
      background-image: repeating-linear-gradient(#fffdf7 0 39px, #eee3cf 39px 40px);
      background-position: 0 44px; }
    .qhead { font-size: 20px; margin-bottom: 6px; }
    .qno { font-weight: 700; }
    .qprompt { color: #5b6472; font-family: 'Nirmala UI','Noto Sans Devanagari',sans-serif; }
    .ans { font-size: 27px; line-height: 40px; color: #14264f; }
  </style></head>
  <body><div class="sheet">
    <div class="hdr"><div class="t">कक्षा 8 · विज्ञान</div><div class="s">नाम: ${student.name}</div></div>
    ${rows}
  </div></body></html>`;
}

function renderPng(chrome, html, outPath) {
  const tmp = path.join(os.tmpdir(), `sheet_${Date.now()}_${Math.random().toString(16).slice(2)}.html`);
  fs.writeFileSync(tmp, html);
  try {
    execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--window-size=1000,1400',
      '--virtual-time-budget=3000',
      `--screenshot=${outPath}`, 'file://' + tmp.replace(/\\/g, '/'),
    ], { stdio: 'ignore' });
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function uploadToSharedDemo(files) {
  const base = process.env.APP_URL || 'http://localhost:3400';
  const health = await fetch(base + '/api/health').then(r => r.json());
  const wid = health.shared_demo;
  const form = new FormData();
  for (const f of files) {
    form.append('images', new Blob([fs.readFileSync(f.path)], { type: 'image/png' }), path.basename(f.path));
    form.append('names', f.name);
  }
  const r = await fetch(`${base}/api/w/${wid}/scripts`, { method: 'POST', body: form });
  const body = await r.json();
  console.log(`  uploaded ${files.length} sheets to shared demo ${wid} →`, JSON.stringify(body).slice(0, 200));
  console.log(`  open:  ${base}/capture.html?w=${wid}`);
}

(async () => {
  const chrome = findChrome();
  console.log(`\n  Rendering ${STUDENTS.length} answer sheets with ${path.basename(chrome)} …`);
  const files = [];
  for (const s of STUDENTS) {
    const out = path.join(OUT_DIR, s.name.replace(/\s+/g, '_') + '.png');
    renderPng(chrome, pageHtml(s), out);
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`   ✓ ${path.basename(out)}  (${kb} KB)`);
    files.push({ name: s.name, path: out });
  }
  // Manifest records intended quality tiers — handy as a QWK reference later.
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ questions: Q.map(q => ({ no: q.no, concept: q.prompt })), students: STUDENTS }, null, 2));
  console.log(`\n  Wrote ${files.length} PNGs + manifest.json to fixtures/samples/`);

  if (process.argv.includes('--upload')) {
    try { await uploadToSharedDemo(files); }
    catch (e) { console.error('  upload failed (is the server running?):', e.message); }
  } else {
    console.log('  Tip: start the server and re-run with --upload to push them into the demo.');
  }
})();
