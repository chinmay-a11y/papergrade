'use strict';
/**
 * Generate a printable HTML evaluation report from a MOCK grading run.
 *   node scripts/gen-eval-report.js <output.html>
 */
require('dotenv').config();
process.env.SARVAM_API_KEY = '';            // force MOCK (deterministic, offline)
const fs = require('fs'), path = require('path');
const { Jimp } = require('jimp');
const db = require('../db');
const pipeline = require('../lib/pipeline');
const seed = require('../lib/seed-rubric');
const { aliasFor } = require('../lib/privacy');

const OUT = process.argv[2] || path.join(__dirname, '..', 'eval-report.html');
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const confColor = c => c >= 0.85 ? '#16a34a' : c >= 0.7 ? '#d97706' : '#dc2626';

(async () => {
  const ws = db.createWorkspace('Eval report');
  const rubric = db.createRubric({ workspace_id: ws.id, subject: seed.subject, class_label: seed.class_label,
    language: seed.language, source_text: seed.source_text, compiled_json: seed.compiled });

  const students = ['Aarav Sharma', 'Diya Patel', 'Kabir Singh', 'Meera Nair', 'Rohan Das', 'Ananya Rao'];
  const rows = [];
  for (const name of students) {
    const img = path.join(__dirname, '..', 'data', 'pages', `rep_${Date.now()}_${Math.random().toString(16).slice(2,6)}.png`);
    fs.mkdirSync(path.dirname(img), { recursive: true });
    fs.writeFileSync(img, await new Jimp({ width: 1000, height: 1400, color: 0xfffdf7ff }).getBuffer('image/png'));
    const s = db.createScript({ workspace_id: ws.id, rubric_id: rubric.id,
      student_alias: aliasFor(name, ws.id), student_name: name, image_path: img });
    await pipeline.processScript(s.id);
    await pipeline.generateFeedback(s.id);
    rows.push({ name, script: db.getScript(s.id), answers: db.listAnswersForScript(s.id), fb: db.getFeedback(s.id) });
  }

  // Class analytics
  let classTotal = 0, reviewCount = 0; const conceptFail = {};
  for (const r of rows) {
    classTotal += r.script.total_awarded;
    for (const a of r.answers) {
      if (a.needs_human) reviewCount++;
      if (a.max_marks && a.awarded_marks / a.max_marks < 0.5) conceptFail[a.concept] = (conceptFail[a.concept] || 0) + 1;
    }
  }
  const maxMarks = rows[0].script.total_max;
  const worst = Object.entries(conceptFail).sort((a, b) => b[1] - a[1])[0];

  const rubricRows = seed.compiled.questions.map(q =>
    `<tr><td><b>Q${q.question_no}</b></td><td>${esc(q.prompt)}</td><td>${q.max_marks}</td><td class="tag">${esc(q.concept)}</td></tr>`).join('');

  const studentCards = rows.map(r => {
    const ansRows = r.answers.map(a => {
      const pct = Math.round((a.confidence || 0) * 100);
      const flag = a.needs_human ? '<span class="chip">needs review</span>' : '';
      return `<tr>
        <td class="qn"><b>Q${a.question_no}</b><div class="tag">${esc(a.concept)}</div></td>
        <td class="dev ans">${esc(a.extracted_text)}<div class="why">${esc(a.rationale)}</div></td>
        <td class="marks">${a.awarded_marks}<span class="of">/${a.max_marks}</span></td>
        <td class="conf">
          <div class="bar"><span style="width:${pct}%;background:${confColor(a.confidence)}"></span></div>
          <div class="pct">${pct}%</div>${flag}
        </td></tr>`;
    }).join('');
    const total = r.script.total_awarded, max = r.script.total_max;
    return `<section class="card">
      <div class="chead">
        <div><h3>${esc(r.name)}</h3><div class="alias">alias sent to models: ${esc(r.script.student_alias)}</div></div>
        <div class="score">${total}<span class="of">/${max}</span></div>
      </div>
      <table class="ans"><thead><tr><th>Q</th><th>Student answer (Hindi) &amp; evaluation</th><th>Marks</th><th>Confidence</th></tr></thead>
        <tbody>${ansRows}</tbody></table>
      <div class="fb"><b>🔊 Feedback (Hindi):</b> <span class="dev">${esc(r.fb?.transcript)}</span>
        <div class="practice"><b>अभ्यास प्रश्न:</b><ol>${(r.fb?.practice_questions || []).map(q => `<li class="dev">${esc(q)}</li>`).join('')}</ol></div>
      </div>
    </section>`;
  }).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;600;700&display=swap" rel="stylesheet">
  <title>PaperGrade — Evaluation Report</title>
  <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #14213d; margin: 0; background: #fff; }
    .dev { font-family: "Noto Sans Devanagari", sans-serif; }
    header { border-bottom: 3px solid #f97316; padding-bottom: 10px; margin-bottom: 14px; }
    header h1 { margin: 0; font-size: 24px; } header .sub { color: #64748b; font-size: 13px; margin-top: 2px; }
    h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: #0f766e; margin: 18px 0 8px; }
    table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
    .rubric td, .rubric th { border-bottom: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
    .tag { display: inline-block; font-size: 10.5px; color: #0f766e; background: #ecfeff; border: 1px solid #cffafe; border-radius: 999px; padding: 1px 7px; margin-top: 3px; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 6px 0 4px; }
    .stat { border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 12px; }
    .stat .big { font-size: 22px; font-weight: 800; } .stat .k { font-size: 11px; color: #64748b; }
    .stat.warn { border-color: #fecaca; background: #fef2f2; } .stat.warn .big { color: #dc2626; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; break-inside: avoid; }
    .chead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .chead h3 { margin: 0; font-size: 16px; } .alias { font-size: 11px; color: #94a3b8; font-family: monospace; }
    .score { font-size: 22px; font-weight: 800; color: #f97316; } .of { color: #94a3b8; font-weight: 600; font-size: .7em; }
    table.ans th { text-align: left; font-size: 10.5px; text-transform: uppercase; color: #94a3b8; border-bottom: 1px solid #e5e7eb; padding: 4px 6px; }
    table.ans td { border-bottom: 1px solid #f1f5f9; padding: 7px 6px; vertical-align: top; }
    td.qn { white-space: nowrap; } td.ans { line-height: 1.5; } .why { color: #64748b; font-size: 11px; margin-top: 3px; font-style: italic; }
    td.marks { font-weight: 700; text-align: center; white-space: nowrap; }
    td.conf { width: 92px; } .bar { height: 7px; background: #eef2f7; border-radius: 4px; overflow: hidden; } .bar span { display: block; height: 100%; }
    .pct { font-size: 11px; color: #475569; margin-top: 2px; }
    .chip { display: inline-block; font-size: 10px; color: #b45309; background: #fffbeb; border: 1px solid #fde68a; border-radius: 999px; padding: 1px 6px; margin-top: 3px; }
    .fb { margin-top: 8px; font-size: 12px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 8px 10px; }
    .practice ol { margin: 4px 0 0 18px; padding: 0; } .practice li { margin: 2px 0; }
    footer { margin-top: 10px; color: #94a3b8; font-size: 10.5px; text-align: center; }
  </style></head><body>
    <header>
      <h1>PaperGrade — Evaluation Report</h1>
      <div class="sub">${esc(seed.class_label)} · ${esc(seed.subject)} · answers &amp; feedback in Hindi · graded against the teacher's rubric · ${new Date().toISOString().slice(0,10)}</div>
    </header>

    <h2>Teacher's rubric</h2>
    <table class="rubric"><thead><tr><th>#</th><th>Question</th><th>Marks</th><th>Concept</th></tr></thead><tbody>${rubricRows}</tbody></table>

    <h2>Class summary</h2>
    <div class="summary">
      <div class="stat"><div class="big">${rows.length}</div><div class="k">students graded</div></div>
      <div class="stat"><div class="big">${(classTotal / rows.length).toFixed(1)}<span class="of">/${maxMarks}</span></div><div class="k">class average</div></div>
      <div class="stat"><div class="big">${reviewCount}</div><div class="k">answers → human review</div></div>
      <div class="stat warn"><div class="big">${worst ? Math.round(worst[1] / rows.length * 100) + '%' : '—'}</div><div class="k">missed <b>${worst ? esc(worst[0]) : ''}</b> (weakest concept)</div></div>
    </div>

    <h2>Per-student evaluations</h2>
    ${studentCards}

    <footer>Confidence is the measured disagreement between two OCR passes — not a model self-report. Low-confidence answers are routed to the teacher for review. Generated by PaperGrade (MOCK demo data).</footer>
  </body></html>`;

  fs.writeFileSync(OUT, html);
  console.log('wrote', OUT, `(${rows.length} students, avg ${(classTotal/rows.length).toFixed(1)}/${maxMarks}, ${reviewCount} to review, weakest: ${worst && worst[0]})`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
