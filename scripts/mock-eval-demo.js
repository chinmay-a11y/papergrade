'use strict';
/**
 * MOCK evaluation demo: teacher-set rubric vs students' Hindi answers → evaluations.
 * Forces MOCK mode (deterministic, offline) and prints a readable per-student report.
 *
 *   node scripts/mock-eval-demo.js
 */
require('dotenv').config();
process.env.SARVAM_API_KEY = '';            // force MOCK before the client loads
const db = require('../db');
const pipeline = require('../lib/pipeline');
const seed = require('../lib/seed-rubric');
const sarvam = require('../lib/sarvam');

const line = (n = 74) => '─'.repeat(n);

(async () => {
  console.log(`\nMode: ${sarvam.isMock() ? 'MOCK (deterministic demo)' : 'LIVE'}`);

  // Teacher-set rubric --------------------------------------------------
  console.log('\n' + line());
  console.log(`TEACHER RUBRIC — ${seed.class_label} · ${seed.subject}  (feedback language: Hindi)`);
  console.log(line());
  for (const q of seed.compiled.questions) {
    console.log(`Q${q.question_no}. ${q.prompt}   [${q.max_marks} marks · concept: ${q.concept}]`);
    q.criteria.forEach(c => console.log(`     • ${c}`));
  }

  // Fresh workspace + a few students -----------------------------------
  const ws = db.createWorkspace('MOCK eval demo');
  const rubric = db.createRubric({ workspace_id: ws.id, subject: seed.subject, class_label: seed.class_label,
    language: seed.language, source_text: seed.source_text, compiled_json: seed.compiled });

  const students = ['Aarav Sharma', 'Diya Patel', 'Kabir Singh', 'Meera Nair'];
  const fs = require('fs'), path = require('path');
  const { aliasFor } = require('../lib/privacy');

  const created = [];
  for (const name of students) {
    // A synthetic page is enough — MOCK extraction supplies the Hindi answers.
    const img = path.join(__dirname, '..', 'data', 'pages', `mockdemo_${Date.now()}_${Math.random().toString(16).slice(2,6)}.png`);
    fs.mkdirSync(path.dirname(img), { recursive: true });
    const { Jimp } = require('jimp');
    fs.writeFileSync(img, await new Jimp({ width: 1000, height: 1400, color: 0xfffdf7ff }).getBuffer('image/png'));
    const s = db.createScript({ workspace_id: ws.id, rubric_id: rubric.id,
      student_alias: aliasFor(name, ws.id), student_name: name, image_path: img });
    await pipeline.processScript(s.id);
    await pipeline.generateFeedback(s.id);
    created.push({ name, id: s.id });
  }

  // Per-student evaluations --------------------------------------------
  let classTotal = 0, classMax = 0, reviewCount = 0;
  const conceptFail = {};
  for (const { name, id } of created) {
    const s = db.getScript(id);
    console.log('\n' + line());
    console.log(`STUDENT: ${name}   (alias sent to models: ${s.student_alias})`);
    console.log(line());
    for (const a of db.listAnswersForScript(id)) {
      const flag = a.needs_human ? '  ⚠ NEEDS REVIEW' : '';
      console.log(`Q${a.question_no} [${a.concept}]  ${a.awarded_marks}/${a.max_marks}  · confidence ${(a.confidence*100|0)}%${flag}`);
      console.log(`   उत्तर: ${a.extracted_text}`);
      console.log(`   मूल्यांकन: ${a.rationale}`);
      if (a.needs_human) reviewCount++;
      if (a.max_marks && a.awarded_marks / a.max_marks < 0.5) conceptFail[a.concept] = (conceptFail[a.concept] || 0) + 1;
    }
    console.log(`   ── TOTAL: ${s.total_awarded}/${s.total_max}  (status: ${s.status})`);
    const fb = db.getFeedback(id);
    console.log(`   🔊 Hindi feedback: ${fb?.transcript}`);
    console.log(`   अभ्यास प्रश्न: ${(fb?.practice_questions || []).map((q,i)=>`\n       ${i+1}. ${q}`).join('')}`);
    classTotal += s.total_awarded; classMax += s.total_max;
  }

  // Class summary -------------------------------------------------------
  console.log('\n' + line());
  console.log('CLASS SUMMARY');
  console.log(line());
  console.log(`Students graded: ${created.length}   Class average: ${(classTotal/created.length).toFixed(1)}/${classMax/created.length}`);
  console.log(`Answers routed to human review: ${reviewCount}`);
  const worst = Object.entries(conceptFail).sort((a,b)=>b[1]-a[1])[0];
  if (worst) console.log(`Weakest concept: "${worst[0]}" — ${worst[1]} of ${created.length} students scored below half.`);
  console.log('');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
