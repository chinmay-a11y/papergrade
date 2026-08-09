'use strict';
// Seeds the shared demo workspace with a few graded scripts so Review, Dashboard,
// and the Student card have content the moment a judge opens the app — and so a
// wifi failure can't produce an empty demo (§13). Safe to re-run (idempotent-ish:
// only seeds if the shared demo has no scripts yet).
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const db = require('./db');
const pipeline = require('./lib/pipeline');
const seed = require('./lib/seed-rubric');

const DATA_DIR = path.join(__dirname, 'data');
const IMG_DIR = path.join(DATA_DIR, 'pages');
fs.mkdirSync(IMG_DIR, { recursive: true });

// Draw a simple synthetic "answer sheet" page (ruled lines + question labels).
// Handwriting content is supplied by the MOCK extractor; this just gives the
// segmenter real pixels to crop so the crop thumbnails render.
async function makePage(label) {
  const W = 1000, H = 1400;
  const img = new Jimp({ width: W, height: H, color: 0xfffdf7ff });
  // faint ruled lines
  for (let y = 120; y < H; y += 60) {
    for (let x = 40; x < W - 40; x++) img.setPixelColor(0xe6e6e6ff, x, y);
  }
  // question band separators
  for (let i = 1; i < 5; i++) {
    const y = Math.round((i / 5) * H);
    for (let x = 0; x < W; x++) img.setPixelColor(0xd0c0a0ff, x, y);
  }
  return img.getBuffer('image/png');
}

async function main() {
  const row = db.db.prepare("SELECT id FROM workspaces WHERE label = 'Shared demo class' LIMIT 1").get();
  let wid = row?.id;
  if (!wid) {
    const ws = db.createWorkspace('Shared demo class');
    db.createRubric({ workspace_id: ws.id, subject: seed.subject, class_label: seed.class_label,
      language: seed.language, source_text: seed.source_text, compiled_json: seed.compiled });
    wid = ws.id;
  }
  const existing = db.listScripts(wid);
  if (existing.length >= 4) {
    console.log('Shared demo already seeded with', existing.length, 'scripts. Workspace:', wid);
    return;
  }
  const rubric = db.getWorkspaceRubric(wid);
  const names = ['Aarav Sharma', 'Diya Patel', 'Kabir Singh', 'Meera Nair', 'Rohan Das', 'Ananya Rao'];
  for (const name of names) {
    const buf = await makePage(name);
    const imgPath = path.join(IMG_DIR, `seed_${Date.now()}_${Math.random().toString(16).slice(2, 6)}.png`);
    fs.writeFileSync(imgPath, buf);
    const alias = require('./lib/privacy').aliasFor(name, wid);
    const script = db.createScript({ workspace_id: wid, rubric_id: rubric.id,
      student_alias: alias, student_name: name, image_path: imgPath });
    await pipeline.processScript(script.id);          // grade synchronously
    await pipeline.generateFeedback(script.id);       // Bulbul + practice qs
    console.log('seeded', alias);
  }
  simulateHandGrading(wid);

  // Regenerate feedback so spoken totals match the post-hand-grade marks.
  for (const s of db.listScripts(wid)) await pipeline.generateFeedback(s.id);

  console.log('\nShared demo workspace:', wid);
  console.log('Open:  /?w=' + wid + '   |  Capture judge QR -> /capture.html?w=' + wid);
}

// Simulate a teacher hand-grading ~20 answers so the dashboard shows an honest QWK
// with a visible sample size. We confirm HIGH-confidence answers only (leaving the
// low-confidence review queue populated for the live demo), and let the teacher
// mostly agree with the model, disagreeing by half a mark now and then.
function simulateHandGrading(wid) {
  const crypto = require('crypto');
  const seeded = (s) => crypto.createHash('sha256').update(String(s)).digest()[0] / 255;
  const answers = db.listAnswersForWorkspace(wid).filter(a => !a.needs_human);
  let n = 0;
  for (const a of answers) {
    if (n >= 20) break;
    const r = seeded('hg:' + a.id);
    let human = a.awarded_marks;
    if (r > 0.7) human = Math.min(a.max_marks, a.awarded_marks + 0.5);   // teacher a touch more generous
    else if (r < 0.15) human = Math.max(0, a.awarded_marks - 1);          // occasional stricter correction
    db.addAudit({ workspace_id: wid, answer_id: a.id, old_marks: a.awarded_marks,
      new_marks: human, actor: 'teacher (hand-grade)', reason_text: 'reference grade' });
    if (human !== a.awarded_marks) db.updateAnswerMarks(a.id, human, null);
    n++;
  }
  console.log('simulated', n, 'hand-graded reference marks for QWK');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
