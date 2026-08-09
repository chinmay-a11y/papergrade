'use strict';
// In-process job worker. Each uploaded script advances
//   queued -> extracting -> grading -> done | needs_review
// with the frontend polling status. Runs inline (long-lived Express process),
// so there is no serverless timeout to fight (Part B of the plan).

const fs = require('fs');
const path = require('path');
const db = require('../db');
const sarvam = require('./sarvam');
const { segment } = require('./segment');
const { perturb } = require('./privacy');
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
  const crops = await segment(pageBuffer, questions.length);

  db.setScriptStatus(scriptId, 'grading');
  let totalAwarded = 0, totalMax = 0, anyReview = false;

  for (const crop of crops) {
    const item = questions[crop.question_no - 1];
    const seedKey = `${script.student_alias}:${crop.question_no}`;
    const hint = `Question ${crop.question_no}.`;
    // Dual-pass extraction: pass A on the crop, pass B on a perturbed copy.
    const passA = await sarvam.extractHandwriting(crop.cropBuffer, { language, hint, pass: 'a', seedKey });
    const perturbed = await perturb(crop.cropBuffer);
    const passB = await sarvam.extractHandwriting(perturbed, { language, hint, pass: 'b', seedKey });
    const conf = scoreConfidence(passA, passB);

    // Grade the canonical transcript against this rubric item; can abstain.
    const grade = await sarvam.gradeAnswer({
      rubricItem: item, extractedText: conf.extracted_text, confidence: conf.confidence, seedKey,
    });
    const awarded = Math.min(Number(grade.awarded_marks) || 0, item.max_marks);
    const needsHuman = !!grade.needs_human || conf.confidence < CONFIDENCE_REVIEW_THRESHOLD;
    if (needsHuman) anyReview = true;

    const cropPath = path.join(CROP_DIR, `${scriptId}_q${crop.question_no}.png`);
    fs.writeFileSync(cropPath, crop.cropBuffer);

    db.createAnswer({
      script_id: scriptId, workspace_id: script.workspace_id, question_no: crop.question_no,
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

module.exports = { enqueue, processScript, generateFeedback, CONFIDENCE_REVIEW_THRESHOLD };
