'use strict';
// Demo seed: Class 8 Science, 5 short-answer questions. Rubric authored in English
// (teacher's language); student answers + feedback are in Hindi (§8 model #5, Mayura).
// Each question carries a `concept` tag that drives the class dashboard analytics.

const source_text = `Class 8 Science — Short Answer Test (25 marks)

Q1. What is photosynthesis? Name the raw materials plants use. (5)
    Award: definition of making food using sunlight (2), names CO2 + water + sunlight (2), mentions chlorophyll/leaves (1).

Q2. Define force and give one effect it can have on an object. (5)
    Award: force = push or pull (3), one valid effect e.g. change of speed/shape/direction (2).

Q3. State the boiling point of water and what happens to its state at that temperature. (5)
    Award: 100 degrees Celsius (3), water changes from liquid to gas/vapour (2).

Q4. What is the function of blood in the human body? (5)
    Award: transports oxygen (2), transports nutrients (2), carries waste/CO2 (1).

Q5. What is friction and give one everyday effect of it. (5)
    Award: force opposing motion between surfaces (3), one effect e.g. produces heat / wears surfaces / lets us walk (2).`;

const compiled = {
  questions: [
    { question_no: 1, prompt: 'What is photosynthesis? Name the raw materials.', max_marks: 5,
      criteria: ['defines making food using sunlight (2)', 'names CO2, water, sunlight (2)', 'mentions chlorophyll/leaves (1)'],
      keywords: ['photosynthesis', 'sunlight', 'carbon dioxide', 'water', 'chlorophyll', 'food'],
      concept: 'photosynthesis' },
    { question_no: 2, prompt: 'Define force and give one effect on an object.', max_marks: 5,
      criteria: ['force = push or pull (3)', 'one valid effect: speed/shape/direction (2)'],
      keywords: ['force', 'push', 'pull', 'motion', 'speed', 'shape'],
      concept: 'force and motion' },
    { question_no: 3, prompt: 'Boiling point of water and state change.', max_marks: 5,
      criteria: ['100 degrees Celsius (3)', 'liquid to gas/vapour (2)'],
      keywords: ['100', 'celsius', 'boiling', 'liquid', 'gas', 'vapour', 'steam'],
      concept: 'states of matter' },
    { question_no: 4, prompt: 'Function of blood in the human body.', max_marks: 5,
      criteria: ['transports oxygen (2)', 'transports nutrients (2)', 'carries waste/CO2 (1)'],
      keywords: ['blood', 'oxygen', 'nutrients', 'transport', 'waste', 'carbon dioxide'],
      concept: 'human circulatory system' },
    { question_no: 5, prompt: 'What is friction and one everyday effect.', max_marks: 5,
      criteria: ['force opposing motion between surfaces (3)', 'one effect: heat/wear/walking (2)'],
      keywords: ['friction', 'opposes', 'motion', 'surfaces', 'heat', 'wear'],
      concept: 'friction' },
  ],
};

module.exports = { source_text, compiled, subject: 'Science', class_label: 'Class 8', language: 'hi-IN' };
