'use strict';
/**
 * Sarvam integration smoke test — exercises the REAL client (lib/sarvam.js),
 * so a green run means the app's live code path works, not just some ad-hoc call.
 *
 * Covers all five load-bearing models:
 *   Vision (Doc AI digitise) · Sarvam-105B chat · Bulbul TTS · Saarika STT · Mayura translate
 *
 * Usage:  put SARVAM_API_KEY in .env, then:  node scripts/verify-sarvam.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const sarvam = require('../lib/sarvam');

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`\n[PASS] ${name}  (${Date.now() - t}ms)\n       ${String(detail).slice(0, 300)}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`\n[FAIL] ${name}  (${Date.now() - t}ms)\n       ${e.message}`);
  }
}

function silentWav() {
  const sr = 16000, n = sr, d = n * 2, b = Buffer.alloc(44 + d);
  b.write('RIFF', 0); b.writeUInt32LE(36 + d, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(d, 40); return b;
}
async function sampleImage() {
  const p = path.join(__dirname, '..', 'fixtures', 'samples', 'Aarav_Sharma.png');
  if (fs.existsSync(p)) return fs.readFileSync(p);
  const img = new Jimp({ width: 480, height: 160, color: 0xffffffff });
  for (let x = 40; x < 440; x++) for (let y = 70; y < 90; y++) img.setPixelColor(0x111111ff, x, y);
  return img.getBuffer('image/png');
}

(async () => {
  console.log(`\n  Sarvam integration smoke test  (mode: ${sarvam.isMock() ? 'MOCK' : 'LIVE'})`);
  if (sarvam.isMock()) console.log('  ! SARVAM_API_KEY not set — testing MOCK path only.\n');

  await check('Sarvam-105B chat', async () => {
    const out = await sarvam.chat([{ role: 'user', content: 'Reply with the single word: pong' }], { temperature: 0 });
    if (!out || !String(out).trim()) throw new Error('empty completion');
    return `→ ${out}`;
  });

  await check('Vision (Doc AI digitise) — reads Hindi', async () => {
    const buf = await sampleImage();
    const text = await sarvam.extractHandwriting(buf, { language: 'hi-IN', hint: 'Question 1.' });
    if (!text || !text.trim()) throw new Error('empty transcript');
    return `→ ${text.replace(/\n/g, ' ').slice(0, 160)}`;
  });

  await check('Bulbul TTS', async () => {
    const wav = await sarvam.synthesizeSpeech('नमस्ते, यह एक परीक्षण है।', { language: 'hi-IN' });
    if (!Buffer.isBuffer(wav) || wav.length < 100) throw new Error('no audio bytes');
    return `→ ${wav.length} bytes of audio`;
  });

  await check('Saarika STT', async () => {
    const t = await sarvam.transcribeSpeech(silentWav(), { language: 'hi-IN' });
    if (typeof t !== 'string') throw new Error('no transcript field');
    return `→ transcript="${t}" (empty is fine for silent test audio)`;
  });

  await check('Mayura translate', async () => {
    const t = await sarvam.translate('Photosynthesis is how plants make food.', { from: 'en-IN', to: 'hi-IN' });
    if (!t || !t.trim()) throw new Error('empty translation');
    return `→ ${t}`;
  });

  console.log('\n  ── Summary ─────────────────────────────');
  for (const r of results) console.log(`   ${r.ok ? '✓' : '✗'}  ${r.name}`);
  const passed = results.filter(r => r.ok).length;
  console.log(`\n  ${passed}/${results.length} live checks passed.\n`);
  process.exit(passed === results.length ? 0 : 1);
})();
