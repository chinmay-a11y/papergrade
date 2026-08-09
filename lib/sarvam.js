'use strict';
// Server-side Sarvam client. API key never leaves the server (§11).
// Five load-bearing models (rubric criterion 2):
//   Vision  -> handwriting extraction per crop     (chat/completions w/ image content)
//   105B    -> rubric compile, grading, practice Qs (chat/completions, JSON schema)
//   Bulbul  -> in-language spoken feedback          (/text-to-speech)
//   Saaras  -> spoken override transcription        (/speech-to-text)
//   Mayura  -> English rubric -> in-language text    (/translate)
//
// When SARVAM_API_KEY is absent the client runs in MOCK mode: deterministic
// synthetic output so the whole pipeline/UI runs without a key. Every real call
// is wrapped in timeout + retry so venue-wifi hiccups degrade gracefully (§13).

const crypto = require('crypto');

const CFG = {
  base:        process.env.SARVAM_BASE_URL   || 'https://api.sarvam.ai',
  key:         process.env.SARVAM_API_KEY    || '',
  chatModel:   process.env.SARVAM_CHAT_MODEL || 'sarvam-105b',
  visionModel: process.env.SARVAM_VISION_MODEL || 'sarvam-105b',
  ttsModel:    process.env.SARVAM_TTS_MODEL  || 'bulbul:v3',
  ttsSpeaker:  process.env.SARVAM_TTS_SPEAKER || 'anushka',
  sttModel:    process.env.SARVAM_STT_MODEL  || 'saaras:v3',
  timeoutMs:   Number(process.env.SARVAM_TIMEOUT_MS || 45000),
  retries:     Number(process.env.SARVAM_RETRIES || 2),
};

const MOCK = !CFG.key;
function isMock() { return MOCK; }

// --- low-level HTTP with timeout + retry ---------------------------------
async function httpJson(pathOrUrl, { method = 'POST', body, headers = {}, raw = false } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : CFG.base + pathOrUrl;
  let lastErr;
  for (let attempt = 0; attempt <= CFG.retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers: {
          'api-subscription-key': CFG.key,
          'Authorization': `Bearer ${CFG.key}`,
          ...(raw ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: raw ? body : (body ? JSON.stringify(body) : undefined),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Sarvam ${res.status}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text); } catch { return { raw: text }; }
    } catch (err) {
      lastErr = err;
      if (attempt < CFG.retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// Deterministic pseudo-randomness so MOCK output is stable across runs (demo-safe).
function seeded(str) {
  const h = crypto.createHash('sha256').update(String(str)).digest();
  return h[0] / 255;
}

// --- 1. Sarvam-105B chat (generic + JSON-schema-constrained) --------------
async function chat(messages, { schema, temperature = 0.2, model } = {}) {
  const body = { model: model || CFG.chatModel, messages, temperature };
  if (schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'out', schema } };
  }
  const res = await httpJson('/v1/chat/completions', { body });
  const content = res?.choices?.[0]?.message?.content ?? '';
  if (schema) { try { return JSON.parse(content); } catch { return safeExtractJson(content); } }
  return content;
}
function safeExtractJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// --- 2. Sarvam Vision: extract handwriting from one crop ------------------
// crop: Buffer (PNG/JPEG). Returns plain transcript string.
async function extractHandwriting(cropBuffer, { language = 'hi-IN', hint = '', pass = 'a', seedKey = '' } = {}) {
  if (MOCK) return mockExtract(hint, pass, seedKey);
  const b64 = cropBuffer.toString('base64');
  const messages = [
    { role: 'system', content:
      'You are an OCR engine for handwritten Indian-language student answer scripts. ' +
      'Transcribe the handwriting EXACTLY as written, preserving the original script and language. ' +
      'Do not translate, correct, grade, or add commentary. Output only the transcribed text.' },
    { role: 'user', content: [
      { type: 'text', text: `Transcribe the handwritten answer. Expected language: ${language}. ${hint}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
    ] },
  ];
  const out = await chat(messages, { model: CFG.visionModel, temperature: 0 });
  return String(out || '').trim();
}

// --- 3. Rubric compilation: teacher text -> structured JSON (once) --------
async function compileRubric(sourceText, { language = 'hi-IN' } = {}) {
  const schema = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question_no: { type: 'integer' },
            prompt:      { type: 'string' },
            max_marks:   { type: 'number' },
            criteria:    { type: 'array', items: { type: 'string' } },
            keywords:    { type: 'array', items: { type: 'string' } },
            concept:     { type: 'string' },
          },
          required: ['question_no', 'max_marks', 'criteria', 'keywords', 'concept'],
        },
      },
    },
    required: ['questions'],
  };
  if (MOCK) return mockCompileRubric(sourceText);
  const messages = [
    { role: 'system', content:
      'Convert a teacher\'s exam rubric into strict JSON. For each question capture max_marks, ' +
      'the marking criteria as discrete award points, the keywords a correct answer contains, ' +
      'and a short lowercase concept tag (2-4 words) naming the idea being tested. ' +
      'The concept tag drives class-level analytics, so keep tags consistent and reusable.' },
    { role: 'user', content: sourceText },
  ];
  return chat(messages, { schema, temperature: 0 });
}

// --- 4. Grade one answer against its rubric item (with abstention) --------
async function gradeAnswer({ rubricItem, extractedText, confidence, seedKey = '' }) {
  const schema = {
    type: 'object',
    properties: {
      awarded_marks: { type: 'number' },
      rationale:     { type: 'string' },
      needs_human:   { type: 'boolean' },
    },
    required: ['awarded_marks', 'rationale', 'needs_human'],
  };
  if (MOCK) return mockGrade({ rubricItem, extractedText, confidence, seedKey });
  const messages = [
    { role: 'system', content:
      'You are a fair, strict exam grader. Grade ONLY against the provided rubric item. ' +
      'Award partial marks per criterion. Give a one-line rationale. ' +
      'If the transcription is garbled/illegible or you cannot fairly judge, set needs_human=true ' +
      'and awarded_marks to your best partial estimate — do NOT guess a full score. ' +
      'Never exceed max_marks.' },
    { role: 'user', content: JSON.stringify({
        max_marks: rubricItem.max_marks,
        criteria: rubricItem.criteria,
        keywords: rubricItem.keywords,
        concept: rubricItem.concept,
        student_answer: extractedText,
        extraction_confidence: confidence,
      }) },
  ];
  return chat(messages, { schema, temperature: 0 });
}

// --- 5. Practice questions targeting a missed concept ---------------------
async function practiceQuestions({ concept, rubricItem, language = 'hi-IN' }) {
  const schema = {
    type: 'object',
    properties: { questions: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } },
    required: ['questions'],
  };
  if (MOCK) return mockPractice(concept);
  const messages = [
    { role: 'system', content:
      `Generate exactly two short practice questions in ${language} that help a Class 8 student ` +
      'master the concept they got wrong. Simple, one-sentence each. Output JSON.' },
    { role: 'user', content: JSON.stringify({ concept, criteria: rubricItem?.criteria }) },
  ];
  return chat(messages, { schema, temperature: 0.4 });
}

// --- 6. Bulbul TTS: in-language spoken feedback -> WAV buffer -------------
async function synthesizeSpeech(text, { language = 'hi-IN', speaker } = {}) {
  if (MOCK) return mockAudio(text);
  const res = await httpJson('/text-to-speech', { body: {
    text: text.slice(0, 2400),
    target_language_code: language,
    language_code: language,
    speaker: speaker || CFG.ttsSpeaker,
    model: CFG.ttsModel,
  } });
  const b64 = res?.audios?.[0];
  if (!b64) throw new Error('Bulbul returned no audio');
  return Buffer.from(b64, 'base64'); // WAV
}

// --- 7. Saaras ASR: spoken override -> text ------------------------------
async function transcribeSpeech(audioBuffer, { language = 'hi-IN', filename = 'override.webm' } = {}) {
  if (MOCK) return mockTranscript();
  const form = new FormData();
  form.append('model', CFG.sttModel);
  form.append('language_code', language);
  form.append('file', new Blob([audioBuffer]), filename);
  const res = await httpJson('/speech-to-text', { raw: true, body: form, headers: {} });
  return String(res?.transcript || '').trim();
}

// --- 8. Mayura translate --------------------------------------------------
async function translate(text, { from = 'en-IN', to = 'hi-IN' } = {}) {
  if (MOCK) return `[hi] ${text}`;
  const res = await httpJson('/translate', { body: {
    input: text, source_language_code: from, target_language_code: to,
  } });
  return String(res?.translated_text || text);
}

// =========================== MOCK implementations =========================
// Deterministic, seeded off inputs so demos are reproducible without a key.
const MOCK_ANSWERS = [
  'प्रकाश संश्लेषण में पौधे सूर्य के प्रकाश, कार्बन डाइऑक्साइड और जल से भोजन बनाते हैं।',
  'बल एक धक्का या खिंचाव है जो किसी वस्तु की गति बदल सकता है।',
  'जल का क्वथनांक सौ डिग्री सेल्सियस होता है।',
  'रक्त शरीर में ऑक्सीजन और पोषक तत्व ले जाता है।',
  'घर्षण गति का विरोध करता है और ऊष्मा उत्पन्न करता है।',
];
function mockExtract(hint, pass, seedKey) {
  // Question number drives the base transcript (Q1->photosynthesis ... Q5->friction).
  const m = String(hint).match(/(\d+)/);
  const qno = m ? Number(m[1]) : 1;
  const base = MOCK_ANSWERS[(qno - 1) % MOCK_ANSWERS.length];
  // ~20% of answers per student are "hard to read": pass B diverges a lot, driving
  // confidence below the review threshold so the queue has realistic content.
  const instability = seeded('u:' + seedKey); // stable per student+question
  if (pass !== 'b' || instability < 0.8) return base;
  const words = base.split(' ');
  // drop ~40% of words and garble one -> large edit distance -> low confidence
  const keep = words.filter((_, i) => (i % 3 !== 0));
  if (keep.length > 1) keep[1] = keep[1] + 'े';
  return keep.join(' ');
}
function mockCompileRubric() { return require('./seed-rubric').compiled; }

// Per-concept baseline difficulty so one misconception clearly dominates the
// class-failure chart (the "23 of 30 missed the same thing" demo beat).
const CONCEPT_EASE = {
  'photosynthesis': 0.80,
  'force and motion': 0.72,
  'states of matter': 0.58,
  'human circulatory system': 0.68,
  'friction': 0.34,                 // the class's weak spot
};
function mockGrade({ rubricItem, confidence, seedKey }) {
  const max = rubricItem?.max_marks ?? 5;
  const concept = rubricItem?.concept || '';
  const ease = CONCEPT_EASE[concept] ?? 0.65;
  const noise = (seeded('g:' + seedKey) - 0.5) * 0.4;   // +/-0.2 per student
  let frac = Math.max(0, Math.min(1, ease + noise));
  const low = (confidence ?? 1) < 0.7;
  if (low) frac = Math.min(frac, 0.5);                  // unreadable -> partial, abstain
  const awarded = Math.round(max * frac * 2) / 2;
  return {
    awarded_marks: Math.min(awarded, max),
    rationale: low
      ? 'Transcription unclear near the key term; partial credit pending review.'
      : frac < 0.5
        ? 'Key definition missing; only the example was credited.'
        : 'Core idea present; missing one supporting detail from the rubric.',
    needs_human: low,
  };
}
function mockPractice(concept) {
  return { questions: [
    `${concept} की एक दैनिक जीवन से जुड़ी उदाहरण दीजिए।`,
    `${concept} को अपने शब्दों में एक वाक्य में समझाइए।`,
  ] };
}
function mockAudio() {
  // Minimal valid silent WAV (0.2s @ 8kHz mono) so the <audio> player works in MOCK.
  const sampleRate = 8000, secs = 0.2, n = Math.floor(sampleRate * secs);
  const dataLen = n * 2, buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}
function mockTranscript() { return 'तीन अंक, समझ आया लेकिन सूत्र गलत लिखा।'; }

module.exports = {
  isMock, CFG,
  chat, extractHandwriting, compileRubric, gradeAnswer,
  practiceQuestions, synthesizeSpeech, transcribeSpeech, translate,
};
