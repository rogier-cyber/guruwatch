'use strict';

const test = require('node:test');
const assert = require('node:assert');
const tr = require('../src/lib/transcripts');

const SAMPLE = [
  'Operator: Good day, and welcome to the Acme Fourth Quarter 2026 Earnings Conference Call. Today\'s call is being recorded.',
  'Jane Smith: Thank you. Good afternoon and thanks for joining us. Speaking first is Tim Brook, CEO, followed by Kevin Park, CFO.',
  'Tim Brook: Thank you, Jane. We delivered record revenue and strong growth in AI and cloud. Demand for our data center products remains robust and we are excited about the opportunity ahead.',
  'Our margins improved again thanks to pricing and efficiency.',
  'Kevin Park: Thanks, Tim. Gross margin was 46%. We expect some headwinds from tariffs and currency, and China remained weak. Our guidance for next quarter reflects this uncertainty.',
  'Operator: We will now begin the question-and-answer session. Our first question comes from Erik Woodring with Morgan Stanley. Please go ahead.',
  'Erik Woodring: Great, thanks for taking my question. Can you talk about AI demand and how much capex you need for new data center capacity next year?',
  'Tim Brook: Sure, Erik. AI demand is very strong and we continue to expand capacity. Capex will grow.',
  'Kevin Park: And on capex, we expect it to be roughly flat as a percentage of revenue.',
  'Erik Woodring: Thank you.',
  'Operator: Our next question comes from the line of Amit Daryanani of Evercore ISI.',
  'Amit Daryanani: Thanks a lot. On China and tariffs, how should we think about the risk to margins in the coming quarters?',
  'Kevin Park: Tariffs are a headwind, and China was soft, but we see a path to stable margins.',
  'Operator: That concludes the question-and-answer session.',
].join('\n');

test('sprekers en vervolgregels', () => {
  const t = tr.parseTurns(SAMPLE);
  assert.equal(t[0].speaker, 'Operator');
  assert.ok(t.find((x) => x.speaker === 'Tim Brook').text.includes('margins improved'));
});

test('analisten uit de introductie van de operator', () => {
  const m = tr.analystIntros(tr.parseTurns(SAMPLE));
  assert.equal(m.get('Erik Woodring'), 'Morgan Stanley');
  assert.equal(m.get('Amit Daryanani'), 'Evercore ISI');
});

test('analyse: rollen, vragen, onderwerpen en toon', () => {
  const a = tr.analyze(SAMPLE);
  assert.deepEqual(a.analysts.map((x) => x.name).sort(), ['Amit Daryanani', 'Erik Woodring']);
  assert.ok(a.management.some((m) => m.name === 'Tim Brook'));
  assert.ok(!a.management.some((m) => m.name === 'Erik Woodring'));
  assert.equal(a.exchanges.length, 2, 'bedankje telt niet als vraag');
  assert.deepEqual(a.exchanges[0].answeredBy, ['Tim Brook', 'Kevin Park']);
  assert.ok(a.topics.analysts.capex >= 2);
  assert.ok(a.topics.mgmt.ai >= 1);
  assert.ok(a.tone.prepared.net > 0);
  assert.ok(a.hasQa);
});

test('vergelijking met de vorige call', () => {
  const cur = tr.analyze(SAMPLE);
  const prev = tr.analyze(SAMPLE.replace(/AI|capex|data center/gi, 'product'));
  const c = tr.compare(cur, prev);
  assert.ok(c.anUp.some((r) => r.key === 'capex'));
  assert.equal(tr.compare(cur, null), null);
});

test('toon in woorden', () => {
  assert.equal(tr.toneWord(0.7), 'zeer positief');
  assert.equal(tr.toneWord(0), 'neutraal');
  assert.equal(tr.toneWord(null), 'onbekend');
});
