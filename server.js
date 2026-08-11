'use strict';
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const db = require('./db');
const sarvam = require('./lib/sarvam');
const pipeline = require('./lib/pipeline');
const seed = require('./lib/seed-rubric');
const { reencode, aliasFor } = require('./lib/privacy');
const pdf = require('./lib/pdf');
const { wordDiff } = require('./lib/confidence');
const { qwk } = require('./lib/qwk');

const app = express();
const PORT = process.env.PORT || 3400;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 40 },
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const IMG_DIR = path.join(DATA_DIR, 'pages');
fs.mkdirSync(IMG_DIR, { recursive: true });

// ---- helpers -------------------------------------------------------------
function requireWorkspace(req, res, next) {
  const ws = db.getWorkspace(req.params.wid);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  if (ws.expires_at < db.now()) return res.status(410).json({ error: 'workspace expired' });
  req.workspace = ws;
  next();
}
function seedRubricInto(workspaceId) {
  return db.createRubric({
    workspace_id: workspaceId, subject: seed.subject, class_label: seed.class_label,
    language: seed.language, source_text: seed.source_text, compiled_json: seed.compiled,
  });
}

// Stable shared demo workspace. Uses a FIXED id so the capture/judge URL survives
// restarts and redeploys (free hosts wipe the DB on each cold start) — otherwise a
// pasted `?w=` link would 404 after every restart.
const SHARED_DEMO_UUID = process.env.SHARED_DEMO_ID || 'demo';
function ensureSharedDemo() {
  const existing = db.getWorkspace(SHARED_DEMO_UUID);
  if (existing) return existing.id;
  const ws = db.createWorkspace('Shared demo class', SHARED_DEMO_UUID);
  seedRubricInto(ws.id);
  return ws.id;
}
const SHARED_DEMO_ID = ensureSharedDemo();

// Self-seed the shared demo on boot when empty (free hosts have no persistent disk,
// so the DB is fresh on every cold start). Seeding runs with the key blanked so it
// uses fast, offline MOCK content — the judge's own live uploads still use the real
// models. Non-blocking: the server starts serving immediately.
(function maybeSeedSharedDemo() {
  try {
    if (db.listScripts(SHARED_DEMO_ID).length >= 4) return;
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [path.join(__dirname, 'seed-demo.js')],
      { env: { ...process.env, SARVAM_API_KEY: '' }, stdio: 'inherit' });
    child.on('exit', code => console.log('[seed] shared-demo seeding finished (exit ' + code + ')'));
  } catch (e) { console.error('[seed] failed:', e.message); }
})();

// ---- meta ----------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mock: sarvam.isMock(), shared_demo: SHARED_DEMO_ID });
});

// ---- workspace lifecycle -------------------------------------------------
// "Try it now" mints a fresh workspace seeded with the demo Hindi Science class.
app.post('/api/try-it-now', (req, res) => {
  const ws = db.createWorkspace('Demo class ' + new Date().toISOString().slice(11, 16));
  const rubric = seedRubricInto(ws.id);
  res.json({ workspace_id: ws.id, rubric_id: rubric.id, expires_at: ws.expires_at });
});

app.get('/api/w/:wid', requireWorkspace, (req, res) => {
  const rubric = db.getWorkspaceRubric(req.params.wid);
  res.json({
    workspace: req.workspace,
    rubric: rubric && {
      id: rubric.id, subject: rubric.subject, class_label: rubric.class_label,
      language: rubric.language, source_text: rubric.source_text,
      questions: rubric.compiled?.questions || [],
    },
    shared_demo: SHARED_DEMO_ID,
    mock: sarvam.isMock(),
  });
});

// Compile / recompile a rubric (one 105B call, cached). Falls back to seed on failure.
app.post('/api/w/:wid/rubric', requireWorkspace, async (req, res) => {
  const { subject = 'Science', class_label = 'Class 8', language = 'hi-IN', source_text } = req.body || {};
  if (!source_text || !source_text.trim()) return res.status(400).json({ error: 'source_text required' });
  let compiled;
  try { compiled = await sarvam.compileRubric(source_text, { language }); }
  catch (e) { console.error('[rubric compile]', e.message); }
  if (!compiled || !compiled.questions?.length) compiled = seed.compiled; // demo-safe fallback
  const rubric = db.createRubric({ workspace_id: req.params.wid, subject, class_label, language, source_text, compiled_json: compiled });
  res.json({ rubric_id: rubric.id, questions: compiled.questions, fell_back: compiled === seed.compiled });
});

// Compile a rubric from a PHOTO of the answer key: OCR (Sarvam Vision / Doc AI) -> 105B compile.
app.post('/api/w/:wid/rubric-image', requireWorkspace, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'image or PDF required' });
    const { language = 'hi-IN', subject = 'Science', class_label = 'Class 8' } = req.body || {};
    let src = req.file.buffer;
    if (pdf.isPdf(req.file.mimetype, req.file.originalname, req.file.buffer)) {
      const pages = await pdf.pdfToPngPages(req.file.buffer, { maxPages: 3 });   // first page = the key
      if (!pages.length) return res.status(400).json({ error: 'empty PDF' });
      src = pages[0];
    } else if (!/^image\//.test(req.file.mimetype)) {
      return res.status(400).json({ error: 'image or PDF required' });
    }
    const { buffer } = await reencode(src);                        // strip EXIF, sanitise
    let source_text = '';
    try { source_text = await sarvam.extractHandwriting(buffer, { language, hint: 'Answer key' }); }
    catch (e) { console.error('[rubric-image ocr]', e.message); }
    let compiled = null;
    if (source_text && source_text.trim()) {
      try { compiled = await sarvam.compileRubric(source_text, { language }); }
      catch (e) { console.error('[rubric-image compile]', e.message); }
    }
    if (!compiled || !compiled.questions?.length) compiled = seed.compiled;   // demo-safe fallback
    const rubric = db.createRubric({ workspace_id: req.params.wid, subject, class_label, language,
      source_text: source_text || seed.source_text, compiled_json: compiled });
    res.json({ rubric_id: rubric.id, questions: compiled.questions, fell_back: compiled === seed.compiled });
  } catch (e) {
    console.error('[rubric-image]', e); res.status(500).json({ error: e.message });
  }
});

// ---- capture / upload ----------------------------------------------------
app.post('/api/w/:wid/scripts', requireWorkspace, upload.array('images', 40), async (req, res) => {
  try {
    const rubric = db.getWorkspaceRubric(req.params.wid);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'no files' });
    const names = [].concat(req.body.names || []); // optional parallel array of student names
    const created = [];
    let nameIdx = 0;
    for (const f of files) {
      // Each uploaded file yields one or more page images (a PDF → one page per student).
      let pageBuffers = [];
      if (pdf.isPdf(f.mimetype, f.originalname, f.buffer)) {
        try { pageBuffers = await pdf.pdfToPngPages(f.buffer); }
        catch (e) { console.error('[pdf rasterise]', e.message); continue; }
      } else if (/^image\//.test(f.mimetype)) {
        pageBuffers = [f.buffer];
      } else { continue; }

      const singlePage = pageBuffers.length === 1;
      for (const pageBuf of pageBuffers) {
        const { buffer } = await reencode(pageBuf);          // strip EXIF, downscale, sanitise
        const realName = singlePage ? (names[nameIdx] || null) : null;   // names only align to single images
        const alias = realName ? aliasFor(realName, req.params.wid) : 'student_' + db.uid(2);
        const imgPath = path.join(IMG_DIR, `${req.params.wid}_${alias}_${Date.now()}_${db.uid(2)}.png`);
        fs.writeFileSync(imgPath, buffer);
        const script = db.createScript({
          workspace_id: req.params.wid, rubric_id: rubric?.id,
          student_alias: alias, student_name: realName, image_path: imgPath,
        });
        pipeline.enqueue(script.id);
        created.push({ id: script.id, student_alias: alias, status: 'queued' });
      }
      if (singlePage) nameIdx++;
    }
    res.json({ scripts: created });
  } catch (e) {
    console.error('[upload]', e);
    res.status(500).json({ error: e.message });
  }
});

// Polled by the capture screen for live status chips.
app.get('/api/w/:wid/scripts', requireWorkspace, (req, res) => {
  const scripts = db.listScripts(req.params.wid).map(s => ({
    id: s.id, student_alias: s.student_alias, student_name: s.student_name,
    status: s.status, total_awarded: s.total_awarded, total_max: s.total_max, error: s.error,
  }));
  res.json({ scripts });
});

// ---- review console ------------------------------------------------------
// Answers across the workspace, lowest confidence first (the default sort).
app.get('/api/w/:wid/review', requireWorkspace, (req, res) => {
  const rubric = db.getWorkspaceRubric(req.params.wid);
  const qById = {};
  (rubric?.compiled?.questions || []).forEach(q => { qById[q.question_no] = q; });
  const answers = db.listAnswersForWorkspace(req.params.wid).map(a => {
    const script = db.getScript(a.script_id);
    return {
      id: a.id, script_id: a.script_id, student_alias: script?.student_alias,
      question_no: a.question_no, concept: a.concept,
      extracted_text: a.extracted_text, rationale: a.rationale,
      awarded_marks: a.awarded_marks, max_marks: a.max_marks,
      confidence: a.confidence, edit_distance: a.edit_distance, needs_human: !!a.needs_human,
      diff: wordDiff(a.extract_pass_a, a.extract_pass_b),
      crop_url: `/api/crops/${a.id}`,
      rubric_item: qById[a.question_no] || null,
    };
  });
  res.json({ answers, threshold: pipeline.CONFIDENCE_REVIEW_THRESHOLD });
});

app.get('/api/crops/:aid', (req, res) => {
  const a = db.getAnswer(req.params.aid);
  if (!a || !a.crop_path || !fs.existsSync(a.crop_path)) return res.status(404).end();
  res.type('png').send(fs.readFileSync(a.crop_path));
});

// Inline override -> writes audit_log (old -> new, actor, timestamp).
app.post('/api/answers/:aid/override', (req, res) => {
  const a = db.getAnswer(req.params.aid);
  if (!a) return res.status(404).json({ error: 'answer not found' });
  const newMarks = Math.max(0, Math.min(Number(req.body?.new_marks), a.max_marks));
  const updated = db.updateAnswerMarks(a.id, newMarks, req.body?.rationale);
  db.addAudit({
    workspace_id: a.workspace_id, answer_id: a.id, old_marks: a.awarded_marks,
    new_marks: newMarks, actor: 'teacher', reason_text: req.body?.reason_text || null,
  });
  recomputeScriptTotals(a.script_id);
  res.json({ answer: updated });
});

// Saaras voice override: teacher speaks the reason in Hindi -> transcribed to audit log.
app.post('/api/answers/:aid/voice-override', upload.single('audio'), async (req, res) => {
  const a = db.getAnswer(req.params.aid);
  if (!a) return res.status(404).json({ error: 'answer not found' });
  let transcript = '';
  try {
    if (req.file) transcript = await sarvam.transcribeSpeech(req.file.buffer, { language: 'hi-IN' });
  } catch (e) { console.error('[saaras]', e.message); transcript = ''; }
  const newMarks = req.body?.new_marks != null
    ? Math.max(0, Math.min(Number(req.body.new_marks), a.max_marks)) : a.awarded_marks;
  db.updateAnswerMarks(a.id, newMarks, null);
  db.addAudit({
    workspace_id: a.workspace_id, answer_id: a.id, old_marks: a.awarded_marks,
    new_marks: newMarks, actor: 'teacher (voice)', reason_text: transcript,
  });
  recomputeScriptTotals(a.script_id);
  res.json({ transcript, new_marks: newMarks });
});

function recomputeScriptTotals(scriptId) {
  const answers = db.listAnswersForScript(scriptId);
  const awarded = answers.reduce((s, x) => s + (x.awarded_marks || 0), 0);
  const max = answers.reduce((s, x) => s + (x.max_marks || 0), 0);
  db.setScriptTotals(scriptId, awarded, max);
  const stillNeeds = answers.some(x => x.needs_human);
  const script = db.getScript(scriptId);
  if (script && (script.status === 'needs_review' || script.status === 'done')) {
    db.setScriptStatus(scriptId, stillNeeds ? 'needs_review' : 'done');
  }
}

app.get('/api/w/:wid/audit', requireWorkspace, (req, res) => {
  res.json({ audit: db.listAudit(req.params.wid) });
});

// ---- student card (public via unguessable script id) ---------------------
app.get('/api/scripts/:sid/card', (req, res) => {
  const script = db.getScript(req.params.sid);
  if (!script) return res.status(404).json({ error: 'not found' });
  const answers = db.listAnswersForScript(script.id).map(a => ({
    question_no: a.question_no, concept: a.concept, awarded_marks: a.awarded_marks,
    max_marks: a.max_marks, rationale: a.rationale,
  }));
  const fb = db.getFeedback(script.id);
  res.json({
    student_alias: script.student_alias,
    total_awarded: answers.reduce((s, a) => s + a.awarded_marks, 0),
    total_max: answers.reduce((s, a) => s + a.max_marks, 0),
    answers,
    audio_url: fb?.audio_path ? `/api/scripts/${script.id}/audio` : null,
    transcript: fb?.transcript || null,
    practice_questions: fb?.practice_questions || [],
  });
});

app.get('/api/scripts/:sid/audio', (req, res) => {
  const fb = db.getFeedback(req.params.sid);
  if (!fb || !fb.audio_path || !fs.existsSync(fb.audio_path)) return res.status(404).end();
  res.type('wav').send(fs.readFileSync(fb.audio_path));
});

// QR image that points at the public student card.
app.get('/api/scripts/:sid/qr.png', async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const url = `${base}/card.html?s=${req.params.sid}`;
  res.type('png').send(await QRCode.toBuffer(url, { width: 240, margin: 1 }));
});

// QR for the judge flow: lands on the shared demo capture screen on their phone.
app.get('/api/judge-qr.png', async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const url = `${base}/capture.html?w=${SHARED_DEMO_ID}`;
  res.type('png').send(await QRCode.toBuffer(url, { width: 240, margin: 1 }));
});

// ---- dashboard -----------------------------------------------------------
app.get('/api/w/:wid/dashboard', requireWorkspace, (req, res) => {
  const wid = req.params.wid;
  const scripts = db.listScripts(wid);
  const answers = db.listAnswersForWorkspace(wid);
  const audit = db.listAudit(wid);

  // Concept-failure: fraction below half marks, per concept (§7).
  const byConcept = {};
  for (const a of answers) {
    const c = a.concept || 'unknown';
    byConcept[c] = byConcept[c] || { concept: c, total: 0, failed: 0 };
    byConcept[c].total++;
    if (a.max_marks && a.awarded_marks / a.max_marks < 0.5) byConcept[c].failed++;
  }
  const concepts = Object.values(byConcept)
    .map(c => ({ ...c, fail_rate: c.total ? c.failed / c.total : 0 }))
    .sort((a, b) => b.fail_rate - a.fail_rate);

  // QWK over the hand-graded set only: model's ORIGINAL mark vs the teacher's FINAL
  // mark. audit is newest-first, so the first entry per answer is the human final and
  // the last is the model's original old_marks. Only answers a human confirmed count —
  // that is the honest sample (n) the metric reports.
  const maxByAnswer = {};
  for (const a of answers) maxByAnswer[a.id] = a.max_marks;
  const humanFinal = {}, modelOrig = {};
  for (const ev of audit) {
    if (humanFinal[ev.answer_id] == null) humanFinal[ev.answer_id] = ev.new_marks; // newest
    modelOrig[ev.answer_id] = ev.old_marks;                                        // ends oldest
  }
  const ratings = Object.keys(humanFinal).map(id => ({
    a: modelOrig[id], b: humanFinal[id], max: maxByAnswer[id],
  }));
  const overall = qwk(ratings);

  const done = scripts.filter(s => s.status === 'done' || s.status === 'needs_review').length;
  const needsReview = answers.filter(a => a.needs_human).length;

  res.json({
    scripts_total: scripts.length,
    scripts_done: done,
    answers_total: answers.length,
    low_confidence_queue: needsReview,
    minutes_saved: done * 3,                 // ~3 min/script of manual grading
    overrides: audit.length,
    qwk: overall.kappa,
    qwk_n: overall.n,
    concepts,
  });
});

// ---- clean URL for workspaces -------------------------------------------
app.get('/w/:wid', (req, res) => res.redirect(`/?w=${req.params.wid}`));

app.listen(PORT, () => {
  console.log(`\n  Vernacular Eval running  http://localhost:${PORT}`);
  console.log(`  Sarvam mode: ${sarvam.isMock() ? 'MOCK (no API key)' : 'LIVE'}`);
  console.log(`  Judge QR workspace: ${SHARED_DEMO_ID}\n`);
});
