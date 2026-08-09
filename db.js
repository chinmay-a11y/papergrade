'use strict';
// SQLite storage layer (Node 24 built-in node:sqlite — no native build).
// Every domain table carries workspace_id for tenant isolation (§4 of the brief):
// the unguessable /w/{uuid} URL is the credential.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'app.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL DEFAULT 'Untitled class',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL          -- 7-day auto-delete window (§11), surfaced in UI
);

CREATE TABLE IF NOT EXISTS rubrics (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject       TEXT NOT NULL,
  class_label   TEXT NOT NULL,
  language      TEXT NOT NULL,           -- output/feedback language, e.g. 'hi-IN'
  source_text   TEXT NOT NULL,           -- teacher's raw rubric (may be English)
  compiled_json TEXT,                    -- one-shot 105B compile: question -> criteria/marks/keywords/concept
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rubric_id      TEXT REFERENCES rubrics(id) ON DELETE SET NULL,
  student_alias  TEXT NOT NULL,          -- e.g. student_a1b2 — the only id Sarvam ever sees
  student_name   TEXT,                   -- real name, never sent upstream (§11)
  image_path     TEXT NOT NULL,          -- re-encoded (EXIF stripped) original page
  status         TEXT NOT NULL DEFAULT 'queued', -- queued|extracting|grading|done|needs_review|error
  error          TEXT,
  total_awarded  REAL,
  total_max      REAL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS answers (
  id             TEXT PRIMARY KEY,
  script_id      TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL,
  question_no    INTEGER NOT NULL,
  crop_path      TEXT,
  extract_pass_a TEXT,                    -- dual-pass extraction (confidence signal)
  extract_pass_b TEXT,
  edit_distance  REAL,                    -- normalised Levenshtein between passes
  confidence     REAL,                    -- 1 - edit_distance (measured, not self-reported)
  extracted_text TEXT,                    -- canonical transcript used for grading
  awarded_marks  REAL,
  max_marks      REAL,
  rationale      TEXT,                    -- one-line model rationale
  needs_human    INTEGER NOT NULL DEFAULT 0, -- forced abstention flag
  concept        TEXT,                    -- rubric concept tag for analytics
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  answer_id         TEXT NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  old_marks         REAL,
  new_marks         REAL,
  actor             TEXT NOT NULL DEFAULT 'teacher',
  reason_text       TEXT,
  reason_audio_path TEXT,                 -- Saaras-transcribed spoken override
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id                     TEXT PRIMARY KEY,
  script_id              TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  workspace_id           TEXT NOT NULL,
  audio_path             TEXT,            -- Bulbul in-language audio
  transcript             TEXT,            -- what the audio says
  practice_questions_json TEXT,           -- 2 questions targeting missed concept
  created_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scripts_ws ON scripts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_answers_script ON answers(script_id);
CREATE INDEX IF NOT EXISTS idx_answers_ws ON answers(workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_log(workspace_id);
`);

const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

// --- workspaces -----------------------------------------------------------
function createWorkspace(label = 'Demo class', id = crypto.randomUUID()) {
  db.prepare(
    'INSERT INTO workspaces (id, label, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, label, now(), now() + SEVEN_DAYS);
  return getWorkspace(id);
}
function getWorkspace(id) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) || null;
}

// --- rubrics --------------------------------------------------------------
function createRubric({ workspace_id, subject, class_label, language, source_text, compiled_json }) {
  const id = uid();
  db.prepare(
    `INSERT INTO rubrics (id, workspace_id, subject, class_label, language, source_text, compiled_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspace_id, subject, class_label, language, source_text,
        compiled_json ? JSON.stringify(compiled_json) : null, now());
  return getRubric(id);
}
function getRubric(id) {
  const r = db.prepare('SELECT * FROM rubrics WHERE id = ?').get(id);
  if (r && r.compiled_json) r.compiled = JSON.parse(r.compiled_json);
  return r || null;
}
function getWorkspaceRubric(workspace_id) {
  const r = db.prepare(
    'SELECT * FROM rubrics WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(workspace_id);
  if (r && r.compiled_json) r.compiled = JSON.parse(r.compiled_json);
  return r || null;
}

// --- scripts --------------------------------------------------------------
function createScript({ workspace_id, rubric_id, student_alias, student_name, image_path }) {
  const id = uid();
  db.prepare(
    `INSERT INTO scripts (id, workspace_id, rubric_id, student_alias, student_name, image_path, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
  ).run(id, workspace_id, rubric_id, student_alias, student_name || null, image_path, now());
  return getScript(id);
}
function getScript(id) {
  return db.prepare('SELECT * FROM scripts WHERE id = ?').get(id) || null;
}
function listScripts(workspace_id) {
  return db.prepare(
    'SELECT * FROM scripts WHERE workspace_id = ? ORDER BY created_at ASC'
  ).all(workspace_id);
}
function setScriptStatus(id, status, error = null) {
  db.prepare('UPDATE scripts SET status = ?, error = ? WHERE id = ?').run(status, error, id);
}
function setScriptTotals(id, awarded, max) {
  db.prepare('UPDATE scripts SET total_awarded = ?, total_max = ? WHERE id = ?').run(awarded, max, id);
}

// --- answers --------------------------------------------------------------
function createAnswer(a) {
  const id = uid();
  db.prepare(
    `INSERT INTO answers
      (id, script_id, workspace_id, question_no, crop_path, extract_pass_a, extract_pass_b,
       edit_distance, confidence, extracted_text, awarded_marks, max_marks, rationale,
       needs_human, concept, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, a.script_id, a.workspace_id, a.question_no, a.crop_path || null,
        a.extract_pass_a || null, a.extract_pass_b || null, a.edit_distance ?? null,
        a.confidence ?? null, a.extracted_text || null, a.awarded_marks ?? null,
        a.max_marks ?? null, a.rationale || null, a.needs_human ? 1 : 0,
        a.concept || null, now());
  return getAnswer(id);
}
function getAnswer(id) {
  return db.prepare('SELECT * FROM answers WHERE id = ?').get(id) || null;
}
function listAnswersForScript(script_id) {
  return db.prepare(
    'SELECT * FROM answers WHERE script_id = ? ORDER BY question_no ASC'
  ).all(script_id);
}
function listAnswersForWorkspace(workspace_id) {
  return db.prepare(
    'SELECT * FROM answers WHERE workspace_id = ? ORDER BY confidence ASC'
  ).all(workspace_id);
}
function updateAnswerMarks(id, awarded, rationale) {
  db.prepare('UPDATE answers SET awarded_marks = ?, rationale = COALESCE(?, rationale), needs_human = 0 WHERE id = ?')
    .run(awarded, rationale || null, id);
  return getAnswer(id);
}

// --- audit log ------------------------------------------------------------
function addAudit({ workspace_id, answer_id, old_marks, new_marks, actor, reason_text, reason_audio_path }) {
  const id = uid();
  db.prepare(
    `INSERT INTO audit_log (id, workspace_id, answer_id, old_marks, new_marks, actor, reason_text, reason_audio_path, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, workspace_id, answer_id, old_marks ?? null, new_marks ?? null,
        actor || 'teacher', reason_text || null, reason_audio_path || null, now());
  return id;
}
function listAudit(workspace_id) {
  return db.prepare(
    'SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY created_at DESC'
  ).all(workspace_id);
}

// --- feedback -------------------------------------------------------------
function upsertFeedback({ script_id, workspace_id, audio_path, transcript, practice_questions_json }) {
  const existing = db.prepare('SELECT id FROM feedback WHERE script_id = ?').get(script_id);
  if (existing) {
    db.prepare(
      'UPDATE feedback SET audio_path = ?, transcript = ?, practice_questions_json = ? WHERE id = ?'
    ).run(audio_path || null, transcript || null,
          practice_questions_json ? JSON.stringify(practice_questions_json) : null, existing.id);
    return existing.id;
  }
  const id = uid();
  db.prepare(
    `INSERT INTO feedback (id, script_id, workspace_id, audio_path, transcript, practice_questions_json, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, script_id, workspace_id, audio_path || null, transcript || null,
        practice_questions_json ? JSON.stringify(practice_questions_json) : null, now());
  return id;
}
function getFeedback(script_id) {
  const f = db.prepare('SELECT * FROM feedback WHERE script_id = ?').get(script_id);
  if (f && f.practice_questions_json) f.practice_questions = JSON.parse(f.practice_questions_json);
  return f || null;
}

module.exports = {
  db, uid, now,
  createWorkspace, getWorkspace,
  createRubric, getRubric, getWorkspaceRubric,
  createScript, getScript, listScripts, setScriptStatus, setScriptTotals,
  createAnswer, getAnswer, listAnswersForScript, listAnswersForWorkspace, updateAnswerMarks,
  addAudit, listAudit,
  upsertFeedback, getFeedback,
};
