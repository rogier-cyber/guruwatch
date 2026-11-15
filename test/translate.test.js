'use strict';

const test = require('node:test');
const assert = require('node:assert');
const tr = require('../src/lib/transcripts');
const tl = require('../src/lib/translate');

const SAMPLE = [
  'Operator: Welcome to the Acme call.',
  'Tim Brook: We delivered record revenue and strong growth in AI. We expect revenue between $10 billion and $11 billion next quarter.',
  'Operator: Our first question comes from Erik Woodring with Morgan Stanley.',
  'Erik Woodring: Can you talk about AI demand and capex next year?',
  'Tim Brook: AI demand is very strong.',
  'Kevin Park: Capex will be roughly flat.',
  'Operator: Next question from Amit Daryanani of Evercore ISI.',
  'Amit Daryanani: How about China?',
  'Kevin Park: China was soft.',
].join('\n');

test('verzoek bevat voorbereid verhaal en genummerde vragen', () => {
  const a = tr.analyze(SAMPLE, { full: true });
  const r = tl.buildRequest({ content: SAMPLE, a, name: 'Acme', label: 'Q4 2026', model: 'claude-haiku-5-5' });
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.equal(r.output_config.format.type, 'json_schema');
  const u = r.messages[0].content;
  assert.match(u, /<voorbereid_verhaal>[\s\S]*record revenue[\s\S]*<\/voorbereid_verhaal>/);
  assert.ok(!/voorbereid_verhaal>[^<]*AI demand is very strong/.test(u.split('<vragenronde>')[0]));
  assert.match(u, /precies 2 items/);
});

test('antwoord controleren en toepassen', () => {
  const a = tr.analyze(SAMPLE, { full: true });
  const out = {
    summary: 'Het ging goed.',
    outlook: [{ text: 'Omzet volgend kwartaal tussen 10 en 11 miljard dollar.', topic: 'vooruit' }],
    keyPoints: [{ text: 'Recordomzet.', topic: 'ai' }, { text: '', topic: '' }],
    exchanges: [{ i: 1, q: 'Hoe zit het met China?', a: ['Kevin Park: China was zwak.'] }, { i: 0, q: 'Kun je iets zeggen over AI?', a: ['De vraag is sterk.', 'Capex blijft gelijk.'] }],
  };
  const nl = tl.parseResult(JSON.stringify(out), a);
  assert.equal(nl.keyPoints.length, 1);
  assert.deepEqual(nl.keyPoints[0].topics, ['ai']);
  assert.equal(nl.exchanges[1].a[0], 'China was zwak.', 'sprekersnaam eraf');
  const ex = tl.applyNl(a.exchanges, nl);
  assert.equal(ex[0].question, 'Kun je iets zeggen over AI?');
  assert.equal(ex[0].answers[1].speaker, 'Kevin Park');
  assert.equal(ex[0].answers[1].text, 'Capex blijft gelijk.');
  assert.equal(tl.applyNl(a.exchanges.slice(0, 1), nl).length, 1, 'ander aantal vragen: Engels laten staan');
  assert.throws(() => tl.parseResult(JSON.stringify({ ...out, exchanges: [] }), a));
});
