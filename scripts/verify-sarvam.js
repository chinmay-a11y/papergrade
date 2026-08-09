'use strict';
/**
 * Sarvam API smoke test — the ground-truth probe.
 *
 * Hits every model we depend on with a minimal real request and prints the HTTP
 * status + a snippet of the raw response, so we can reconcile lib/sarvam.js to the
 * actual API contract (endpoints, params, field names) with certainty instead of
 * guessing. In particular it probes BOTH candidate Vision endpoints and reports
 * which one the account can actually call.
 *
 * Usage:
 *   1) put SARVAM_API_KEY=... in .env   (never paste the key in chat)
 *   2) node scripts/verify-sarvam.js
 *
 * Exit code is 0 if the chat model responds; individual model results are printed
 * as PASS/FAIL so you can see exactly what needs fixing.
 */
require('dotenv').config();
const { Jimp } = require('jimp');

const BASE = process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai';
const KEY = process.env.SARVAM_API_KEY || '';
const LANG = 'hi-IN';

if (!KEY) {
  console.error('\n  SARVAM_API_KEY is not set.');
  console.error('  Add it to .env  (echo SARVAM_API_KEY=sk_... >> .env)  and re-run.\n');
  process.exit(2);
}

// Both header styles — docs prefer api-subscription-key; Bearer is also accepted.
const AUTH = { 'api-subscription-key': KEY, 'Authorization': `Bearer ${KEY}` };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`\n[${tag}] ${name}`);
  if (detail) console.log('       ' + String(detail).replace(/\n/g, '\n       ').slice(0, 900));
}

async function req(path, { method = 'POST', json, form, headers = {} } = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  const opts = { method, headers: { ...AUTH, ...headers } };
  if (form) { opts.body = form; }
  else if (json) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  const started = Date.now();
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, ms: Date.now() - started, body, text, url };
}

function snippet(body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  return s.length > 600 ? s.slice(0, 600) + '…' : s;
}

// --- test fixtures (generated, no external files) -------------------------
async function testPngBase64() {
  // Small white image with a black bar — enough to validate the vision contract
  // (endpoint/params/response shape). Real OCR quality is the separate spike.
  const img = new Jimp({ width: 480, height: 160, color: 0xffffffff });
  for (let x = 40; x < 440; x++) for (let y = 70; y < 90; y++) img.setPixelColor(0x111111ff, x, y);
  const buf = await img.getBuffer('image/png');
  return { buf, b64: buf.toString('base64') };
}
function silentWav() {
  const sr = 8000, secs = 0.4, n = sr * secs, dataLen = n * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  return b;
}

// --- 1. Chat / Sarvam-105B (JSON schema) ----------------------------------
async function checkChat() {
  try {
    const r = await req('/v1/chat/completions', { json: {
      model: process.env.SARVAM_CHAT_MODEL || 'sarvam-105b',
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with a JSON object {"ok": true} and nothing else.' }],
      response_format: { type: 'json_schema', json_schema: { name: 'out',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } },
    }});
    const content = r.body?.choices?.[0]?.message?.content;
    record('Chat 105B  POST /v1/chat/completions', r.ok && content != null,
      `status ${r.status} · ${r.ms}ms · content=${snippet(content) ?? snippet(r.body)}`);
    return r.ok;
  } catch (e) { record('Chat 105B  POST /v1/chat/completions', false, e.message); return false; }
}

// --- 2. Vision — probe BOTH candidates ------------------------------------
async function checkVision() {
  const { b64 } = await testPngBase64();

  // Candidate A: synchronous /v1/vision (preferred for per-crop OCR). We try a
  // couple of plausible body shapes and report the first that is accepted.
  const bodiesA = [
    { model: 'sarvam-vision', image: b64, prompt: 'Transcribe any text in this image.' },
    { model: 'sarvam-vision', image_base64: b64, prompt: 'Transcribe any text in this image.' },
    { model: 'sarvam-vision', messages: [{ role: 'user', content: [
      { type: 'text', text: 'Transcribe any text.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }] },
  ];
  let hitA = false;
  for (let i = 0; i < bodiesA.length; i++) {
    try {
      const r = await req('/v1/vision', { json: bodiesA[i] });
      if (r.status !== 404) {
        record(`Vision A  POST /v1/vision  (body shape #${i + 1})`, r.ok,
          `status ${r.status} · ${r.ms}ms · ${snippet(r.body)}`);
        if (r.ok) { hitA = true; break; }
      }
    } catch (e) { record(`Vision A  POST /v1/vision  (body shape #${i + 1})`, false, e.message); }
  }
  if (!hitA) console.log('       (…/v1/vision not accepted with tried shapes — see statuses above)');

  // Candidate B: async Document AI digitise (multipart). Just confirm the job is
  // accepted; we don't poll here.
  try {
    const { buf } = await testPngBase64();
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'image/png' }), 'probe.png');
    form.append('language', LANG);
    form.append('output_format', 'md');
    const r = await req('/doc-ai/v1/job/digitise', { form });
    record('Vision B  POST /doc-ai/v1/job/digitise (multipart)', r.ok,
      `status ${r.status} · ${r.ms}ms · ${snippet(r.body)}`);
  } catch (e) { record('Vision B  POST /doc-ai/v1/job/digitise', false, e.message); }
}

// --- 3. Bulbul TTS --------------------------------------------------------
async function checkTTS() {
  try {
    const r = await req('/text-to-speech', { json: {
      text: 'नमस्ते, यह एक परीक्षण है।',
      target_language_code: LANG,
      speaker: process.env.SARVAM_TTS_SPEAKER || 'anushka',
      model: process.env.SARVAM_TTS_MODEL || 'bulbul:v2',
    }});
    const hasAudio = Array.isArray(r.body?.audios) && r.body.audios[0];
    record('Bulbul TTS  POST /text-to-speech', r.ok && !!hasAudio,
      `status ${r.status} · ${r.ms}ms · audios[0] length=${hasAudio ? r.body.audios[0].length : 'none'} · keys=${r.body && typeof r.body === 'object' ? Object.keys(r.body) : snippet(r.body)}`);
  } catch (e) { record('Bulbul TTS  POST /text-to-speech', false, e.message); }
}

// --- 4. Saaras STT --------------------------------------------------------
async function checkSTT() {
  try {
    const form = new FormData();
    form.append('file', new Blob([silentWav()], { type: 'audio/wav' }), 'probe.wav');
    form.append('model', process.env.SARVAM_STT_MODEL || 'saaras:v2');
    form.append('language_code', LANG);
    const r = await req('/speech-to-text', { form });
    const t = r.body?.transcript;
    record('Saaras STT  POST /speech-to-text', r.ok && t !== undefined,
      `status ${r.status} · ${r.ms}ms · transcript=${JSON.stringify(t)} · keys=${r.body && typeof r.body === 'object' ? Object.keys(r.body) : snippet(r.body)}`);
  } catch (e) { record('Saaras STT  POST /speech-to-text', false, e.message); }
}

// --- 5. Mayura translate --------------------------------------------------
async function checkTranslate() {
  try {
    const r = await req('/translate', { json: {
      input: 'Photosynthesis is how plants make food.',
      source_language_code: 'en-IN',
      target_language_code: LANG,
    }});
    const t = r.body?.translated_text;
    record('Mayura  POST /translate', r.ok && t !== undefined,
      `status ${r.status} · ${r.ms}ms · translated_text=${JSON.stringify(t)} · keys=${r.body && typeof r.body === 'object' ? Object.keys(r.body) : snippet(r.body)}`);
  } catch (e) { record('Mayura  POST /translate', false, e.message); }
}

(async () => {
  console.log(`\n  Sarvam smoke test → ${BASE}`);
  console.log(`  Key: ${KEY.slice(0, 6)}…${KEY.slice(-4)} (len ${KEY.length})`);
  await checkChat();
  await checkVision();
  await checkTTS();
  await checkSTT();
  await checkTranslate();

  console.log('\n  ── Summary ─────────────────────────────');
  for (const r of results) console.log(`   ${r.ok ? '✓' : '✗'}  ${r.name}`);
  const passed = results.filter(r => r.ok).length;
  console.log(`\n  ${passed}/${results.length} checks passed.\n`);
  process.exit(results.find(r => r.name.startsWith('Chat'))?.ok ? 0 : 1);
})();
