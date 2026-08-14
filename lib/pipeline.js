'use strict';
// In-process job worker. Each uploaded script advances
//   queued -> extracting -> grading -> done | needs_review
// with the frontend polling status. Runs inline (long-lived Express process),
// so there is no serverless timeout to fight (Part B of the plan).

const fs = require('fs');
const path = require('path');
const db = require('../db');
const sarvam = require('./sarvam');
const { bandRegions } = require('./segment');
const { perturb, cropRegion } = require('./privacy');
const { scoreConfidence } = require('./confidence');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CROP_DIR = path.join(DATA_DIR, 'crops');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
fs.mkdirSync(CROP_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const CONFIDENCE_REVIEW_THRESHOLD = 0.7;

const queue = [];
let running = false;

function enqueue(scriptId) {
  queue.push(scriptId);
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try { await processScript(id); }
    catch (err) {
      console.error('[pipeline] script failed', id, err.message);
      db.setScriptStatus(id, 'error', err.message);
    }
  }
  running = false;
}

async function processScript(scriptId) {
  const script = db.getScript(scriptId);
  if (!script) return;
  const rubric = db.getRubric(script.rubric_id) || db.getWorkspaceRubric(script.workspace_id);
  const compiled = rubric?.compiled || require('./seed-rubric').compiled;
  const language = rubric?.language || 'hi-IN';
  const questions = compiled.questions;

  db.setScriptStatus(scriptId, 'extracting');
  const pageBuffer = fs.readFileSync(script.image_path);
  const regions = bandRegions(questions.length);

  // Dual-pass extraction at the PAGE level: digitise the whole page once, and again
  // on a perturbed copy, then split each into per-question answers. Doc AI handles
  // full pages reliably (narrow band crops fail), and disagreement between the two
  // splits is the per-question confidence signal — with just two Vision jobs.
  const seedKeyBase = script.student_alias;
  const passA = await sarvam.extractPageAnswers(pageBuffer, questions, { language, pass: 'a', seedKeyBase });
  const perturbedPage = await perturb(pageBuffer);
  const passB = await sarvam.extractPageAnswers(perturbedPage, questions, { language, pass: 'b', seedKeyBase });

  db.setScriptStatus(scriptId, 'grading');
  let totalAwarded = 0, totalMax = 0, anyReview = false;

  for (const item of questions) {
    const qno = item.question_no;
    const seedKey = `${script.student_alias}:${qno}`;
    const conf = scoreConfidence(passA[qno], passB[qno]);

    // Grade the canonical transcript against this rubric item; can abstain.
    const grade = await sarvam.gradeAnswer({
      rubricItem: item, extractedText: conf.extracted_text, confidence: conf.confidence, seedKey,
    });
    const awarded = Math.min(Number(grade.awarded_marks) || 0, item.max_marks);
    const needsHuman = !!grade.needs_human || conf.confidence < CONFIDENCE_REVIEW_THRESHOLD;
    if (needsHuman) anyReview = true;

    // Crop the question's band from the page purely for the review-console thumbnail.
    const region = (regions.find(r => r.question_no === qno) || {}).region || { x0: 0, y0: 0, x1: 1, y1: 1 };
    const cropPath = path.join(CROP_DIR, `${scriptId}_q${qno}.png`);
    fs.writeFileSync(cropPath, await cropRegion(pageBuffer, region));

    db.createAnswer({
      script_id: scriptId, workspace_id: script.workspace_id, question_no: qno,
      crop_path: cropPath, extract_pass_a: conf.extract_pass_a, extract_pass_b: conf.extract_pass_b,
      edit_distance: conf.edit_distance, confidence: conf.confidence,
      extracted_text: conf.extracted_text, awarded_marks: awarded, max_marks: item.max_marks,
      rationale: grade.rationale, needs_human: needsHuman, concept: item.concept,
    });
    totalAwarded += awarded; totalMax += item.max_marks;
  }

  db.setScriptTotals(scriptId, totalAwarded, totalMax);
  db.setScriptStatus(scriptId, anyReview ? 'needs_review' : 'done');

  // Fire-and-forget in-language feedback so the student card is ready on first view.
  generateFeedback(scriptId).catch(e => console.error('[feedback]', e.message));
}

// Grade a whole student booklet by COMPARING it to the answer key (essay / long-answer
// exams, where fixed per-question band cropping doesn't apply). pageBuffers = the
// student's booklet pages. Runs off the queue (called directly by the endpoint).
async function processBooklet(scriptId, pageBuffers, { maxPages = Number(process.env.BOOKLET_MAX_PAGES || 12) } = {}) {
  const script = db.getScript(scriptId);
  if (!script) return;
  const rubric = db.getRubric(script.rubric_id) || db.getWorkspaceRubric(script.workspace_id);
  const seed = require('./seed-rubric');
  const compiled = rubric?.compiled || seed.compiled;
  const answerKeyText = rubric?.source_text || seed.source_text;   // the model answers
  const language = rubric?.language || 'hi-IN';

  // 1. OCR each booklet page and concatenate into the full student text.
  db.setScriptStatus(scriptId, 'extracting');
  const pages = pageBuffers.slice(0, maxPages);
  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    let t = '';
    try { t = await sarvam.extractHandwriting(pages[i], { language, hint: `Booklet page ${i + 1}` }); }
    catch (e) { console.error('[booklet ocr]', e.message); }
    if (t && t.trim()) parts.push(`--- page ${i + 1} ---\n${t.trim()}`);
  }
  const studentText = parts.join('\n');

  // 2. One 105B call comparing the booklet to the answer key.
  db.setScriptStatus(scriptId, 'grading');
  let graded;
  try { graded = await sarvam.gradeBooklet({ answerKeyText, studentText, questions: compiled.questions }); }
  catch (e) { console.error('[booklet grade]', e.message); graded = { answers: [] }; }
  const answers = (graded.answers && graded.answers.length) ? graded.answers
    : compiled.questions.map(q => ({ question_no: q.question_no, max_marks: q.max_marks, awarded_marks: 0,
        rationale: 'Automatic grading unavailable — routed for review.', concept: q.concept,
        needs_human: true, student_answer: '' }));

  // 3. Persist one answer row per question (no crop — this is a whole-booklet compare).
  const qById = {}; compiled.questions.forEach(q => { qById[q.question_no] = q; });
  let totalAwarded = 0, totalMax = 0, anyReview = false;
  for (const a of answers) {
    const item = qById[a.question_no] || {};
    const max = Number(a.max_marks) || item.max_marks || 0;
    const awarded = Math.max(0, Math.min(Number(a.awarded_marks) || 0, max));
    const needsHuman = !!a.needs_human;
    if (needsHuman) anyReview = true;
    const stAns = a.student_answer || '';
    db.createAnswer({
      script_id: scriptId, workspace_id: script.workspace_id, question_no: a.question_no,
      crop_path: null, extract_pass_a: stAns, extract_pass_b: stAns, edit_distance: 0,
      confidence: needsHuman ? 0.5 : 1, extracted_text: stAns, awarded_marks: awarded, max_marks: max,
      rationale: a.rationale || '', needs_human: needsHuman, concept: a.concept || item.concept || 'general',
    });
    totalAwarded += awarded; totalMax += max;
  }
  db.setScriptTotals(scriptId, totalAwarded, totalMax);
  db.setScriptStatus(scriptId, anyReview ? 'needs_review' : 'done');
  generateFeedback(scriptId).catch(e => console.error('[feedback]', e.message));
}

// Bulbul spoken feedback + two concept-targeted practice questions per student.
async function generateFeedback(scriptId) {
  const script = db.getScript(scriptId);
  if (!script) return;
  const rubric = db.getRubric(script.rubric_id) || db.getWorkspaceRubric(script.workspace_id);
  const language = rubric?.language || 'hi-IN';
  const compiled = rubric?.compiled || require('./seed-rubric').compiled;
  const answers = db.listAnswersForScript(scriptId);

  // Weakest concept = lowest awarded/max ratio.
  const weakest = answers.slice().sort(
    (a, b) => (a.awarded_marks / a.max_marks) - (b.awarded_marks / b.max_marks)
  )[0];
  const item = compiled.questions.find(q => q.concept === weakest?.concept);

  const total = answers.reduce((s, a) => s + a.awarded_marks, 0);
  const max = answers.reduce((s, a) => s + a.max_marks, 0);

  // Compose a short Hindi feedback message (Mayura would render this if authored in English).
  const lostQ = weakest ? `प्रश्न ${weakest.question_no}` : '';
  const transcript =
    `नमस्ते! आपको ${max} में से ${total} अंक मिले। ` +
    (weakest && weakest.awarded_marks < weakest.max_marks
      ? `${lostQ} में "${weakest.concept}" वाले भाग पर थोड़ा और ध्यान दें। ` +
        `${weakest.rationale ? '' : ''}नीचे दो अभ्यास प्रश्न दिए गए हैं।`
      : `बहुत बढ़िया! अभ्यास जारी रखें।`);

  const practice = await sarvam.practiceQuestions({
    concept: weakest?.concept || compiled.questions[0].concept, rubricItem: item, language,
  });

  let audioPath = null;
  try {
    const wav = await sarvam.synthesizeSpeech(transcript, { language });
    audioPath = path.join(AUDIO_DIR, `${scriptId}.wav`);
    fs.writeFileSync(audioPath, wav);
  } catch (e) { console.error('[bulbul]', e.message); }

  db.upsertFeedback({
    script_id: scriptId, workspace_id: script.workspace_id,
    audio_path: audioPath, transcript,
    practice_questions_json: practice?.questions || [],
  });
}

module.exports = { enqueue, processScript, processBooklet, generateFeedback, CONFIDENCE_REVIEW_THRESHOLD };
