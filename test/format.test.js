'use strict';

const test = require('node:test');
const assert = require('node:assert');
const f = require('../src/lib/format');

test('money compact', () => {
  assert.match(f.money(2.5e9), /2,5 mld/);
  assert.match(f.money(340e6), /340 mln/);
  assert.equal(f.money(null), '–');
});

test('insider types', () => {
  assert.equal(f.txType('P-Purchase'), 'Aankoop');
  assert.equal(f.txTone('S-Sale'), 'neg');
});

test('grade tone', () => {
  assert.equal(f.gradeTone('Outperform'), 'pos');
  assert.equal(f.gradeTone('Underweight'), 'neg');
  assert.equal(f.gradeTone('Neutral'), 'neutral');
});

test('sparkline geeft svg', () => {
  const svg = f.sparkline([{ date: '2025-01-01', close: 1 }, { date: '2025-01-02', close: 2 }]);
  assert.match(svg, /^<svg/);
});
