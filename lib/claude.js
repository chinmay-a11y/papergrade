'use strict';
// Claude (Anthropic) provider — document scan (vision OCR) + answer-key comparison grading.
// Used as an alternative grading engine to Sarvam (e.g. when Sarvam has no credits, or when
// AI_PROVIDER=claude). Reads ANTHROPIC_API_KEY from the environment. Server-side only.
//
// Claude reads the handwritten page images directly (vision), so one call can BOTH scan the
// student's booklet AND compare it to the teacher's answer key, returning per-question marks.

const AnthropicMod = require('@anthropic-ai/sdk');
const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

let client = null;
function getClient() {
  if (client) return client;
  try { client = new Anthropic(); } catch (e) { console.error('[claude] init', e.message); client = null; }
  return client;
}
function isReady() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function imageBlock(buffer, mediaType = 'image/png') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(buffer).toString('base64') } };
}
function textOf(res) {
  return (res?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
function safeJson(s) { const m = String(s).match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch {} } return null; }

// --- 1. Document scan: OCR one handwritten page image -> plain transcript ---
async function ocrImage(buffer, { language = 'Hindi' } = {}) {
  const c = getClient();
  const res = await c.messages.create({
    model: MODEL, max_tokens: 4000,
    messages: [{ role: 'user', content: [
      imageBlock(buffer),
      { type: 'text', text:
        `Transcribe the handwriting in this ${language} answer sheet EXACTLY as written, ` +
        `preserving the original script and line breaks. Output only the transcribed text — no commentary.` },
    ] }],
  });
  return textOf(res).trim();
}

const BOOKLET_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          question_no:    { type: 'integer' },
          max_marks:      { type: 'number' },
          awarded_marks:  { type: 'number' },
          student_answer: { type: 'string' },
          rationale:      { type: 'string' },
          concept:        { type: 'string' },
          needs_human:    { type: 'boolean' },
        },
        required: ['question_no', 'max_marks', 'awarded_marks', 'student_answer', 'rationale', 'concept', 'needs_human'],
      },
    },
  },
  required: ['answers'],
};

// --- 2. Scan a whole student booklet (page images) AND compare to the answer key ---
// Returns { answers: [...] } in the same shape as sarvam.gradeBooklet.
async function gradeBookletVision({ answerKeyText, pageBuffers, questions = [], maxPages = 20 }) {
  const c = getClient();
  const pages = (pageBuffers || []).slice(0, maxPages);
  const content = [];
  pages.forEach((b, i) => {
    content.push({ type: 'text', text: `--- Student booklet page ${i + 1} ---` });
    content.push(imageBlock(b));
  });
  content.push({ type: 'text', text:
    'You are a fair, strict exam evaluator.\n\n' +
    'ANSWER KEY (the teacher\'s model answers, with the marks for each question):\n' +
    String(answerKeyText || '').slice(0, 12000) + '\n\n' +
    'Question marks: ' + JSON.stringify(questions.map(q => ({ question_no: q.question_no, max_marks: q.max_marks }))) + '\n\n' +
    'Read the student\'s handwritten answers from the page images above. For EACH question in the ' +
    'answer key: find the student\'s corresponding answer, compare it to the model answer, and award ' +
    'marks out of that question\'s maximum. Give a one-line rationale and a short lowercase concept tag. ' +
    'Put the student\'s exact matched answer text in student_answer (empty string if unattempted — award 0). ' +
    'If the handwriting is illegible for a question, set needs_human=true. Never exceed a question\'s max. ' +
    'Return JSON only.' });

  const res = await c.messages.create({
    model: MODEL, max_tokens: 16000,
    output_config: { format: { type: 'json_schema', schema: BOOKLET_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  const parsed = safeJson(textOf(res));
  return parsed && Array.isArray(parsed.answers) ? parsed : { answers: [] };
}

// --- 3. Text-only compare (parity with sarvam.gradeBooklet) for pre-OCR'd text ---
async function gradeBooklet({ answerKeyText, studentText, questions = [] }) {
  const c = getClient();
  const res = await c.messages.create({
    model: MODEL, max_tokens: 16000,
    output_config: { format: { type: 'json_schema', schema: BOOKLET_SCHEMA } },
    messages: [{ role: 'user', content:
      'You are a fair, strict exam evaluator. Compare the STUDENT answers to the ANSWER KEY and award ' +
      'per-question marks (student_answer = the student\'s matched text; 0 if unattempted; never exceed max).\n\n' +
      'ANSWER KEY:\n' + String(answerKeyText || '').slice(0, 12000) + '\n\n' +
      'Question marks: ' + JSON.stringify(questions.map(q => ({ question_no: q.question_no, max_marks: q.max_marks }))) + '\n\n' +
      'STUDENT ANSWERS:\n' + String(studentText || '').slice(0, 16000) + '\n\nReturn JSON only.' }],
  });
  const parsed = safeJson(textOf(res));
  return parsed && Array.isArray(parsed.answers) ? parsed : { answers: [] };
}

module.exports = { isReady, MODEL, ocrImage, gradeBookletVision, gradeBooklet };
