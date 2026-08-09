# PaperGrade — Vernacular Answer-Sheet Evaluation

Photograph a stack of handwritten Hindi answer scripts → **Sarvam Vision** reads the
handwriting per question → **Sarvam-105B** grades each answer against the teacher's rubric
with per-question confidence and forced abstention → low-confidence items route to a review
queue → **Bulbul** speaks feedback to each student in Hindi, delivered via a QR code stamped
on the paper. No student logins.

## Run it

```bash
npm install
cp .env.example .env        # add SARVAM_API_KEY (leave blank to run in MOCK mode)
node seed-demo.js           # seeds a shared demo class with graded scripts
node server.js              # http://localhost:3400
```

Open the printed workspace URL. **Try it now** on the landing page mints a fresh class.

## Sarvam is load-bearing at five points (rubric criterion 2)

| # | Model | Where | Code |
|---|-------|-------|------|
| 1 | **Sarvam Vision** | Handwriting extraction per question crop | `lib/sarvam.js` → `extractHandwriting` |
| 2 | **Sarvam-105B** | Rubric compile + grading with abstention | `compileRubric`, `gradeAnswer` |
| 3 | **Bulbul** | Spoken per-student feedback in Hindi | `synthesizeSpeech` |
| 4 | **Saaras** | Teacher speaks override reason → audit log | `transcribeSpeech`, `/voice-override` |
| 5 | **Mayura / Translate** | English rubric → Hindi feedback | `translate` |

## Technical depth (rubric criterion 5)

- **Per-question segmentation** — `lib/segment.js` crops each question region; grading is
  per-crop, never whole-page.
- **Defensible confidence** — `lib/confidence.js` extracts each crop twice (one pass on a
  rotated/rescaled copy) and measures normalised edit distance. Disagreement *is* the
  uncertainty signal — not a model self-report. Rendered as a two-pass word diff in the
  review console.
- **Rubric compilation** — one 105B call → structured JSON (`question → criteria/marks/
  keywords/concept`), cached; all grading is constrained output against it.
- **Forced abstention** — grading can return `needs_human: true` rather than guess.
- **Quadratic weighted kappa** — `lib/qwk.js`, computed over the hand-graded set (model's
  original mark vs teacher's final), reported honestly with sample size.
- **Concept analytics** — `GROUP BY concept` where score < half → "5 of 6 missed friction".

## Security (§11, all built)

Server-side API key only · student names stripped to `student_xxxx` before any prompt
(`lib/privacy.js`) · uploads re-encoded to strip EXIF + neutralise malformed images ·
`workspace_id` isolation, the unguessable `/w/{uuid}` URL is the credential · audit log on
every score change · 7-day expiry on workspaces.

## Deliberate trades (narrated honestly)

- **Free-form handwriting, band segmentation.** We split the page into horizontal bands by
  question count rather than detecting `Q1.`/`१.` markers — robust and instant; a Vision
  boundary call could refine it.
- **MOCK mode.** With no API key the client returns deterministic synthetic output so the
  whole pipeline/UI runs offline (demo survival). Drop in `SARVAM_API_KEY` and every call
  goes live.
- **QWK ground truth** comes from teacher-confirmed marks; a real ~20-script hand-graded set
  sharpens it.

## Deploy

Fly.io, Mumbai (`bom`) — see `fly.toml`. `fly secrets set SARVAM_API_KEY=…` then `fly deploy`.

## Out of scope (§9)

Auth, roles, billing, student accounts, notifications, native app, offline sync, dark mode,
settings. Roadmap slide, not code.
