'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { surprise, verdict, summarizeRevisions, quarterLabel } = require('../src/lib/earnings');

test('surprise ten opzichte van de verwachting', () => {
  assert.ok(Math.abs(surprise(1.1, 1.0) - 0.1) < 1e-9);
  assert.ok(Math.abs(surprise(-0.5, -1.0) - 0.5) < 1e-9); // minder verlies dan verwacht is positief
  assert.strictEqual(surprise(0.3, 0.001), null);
  assert.strictEqual(surprise(null, 1), null);
});

test('verdict vergelijkt koersreactie met herziening', () => {
  assert.strictEqual(verdict(-0.08, 0.04).key, 'koers-omlaag-doelen-omhoog');
  assert.strictEqual(verdict(0.09, -0.03).key, 'koers-omhoog-doelen-omlaag');
  assert.strictEqual(verdict(0.12, 0.02).key, 'koers-sterker');
  assert.strictEqual(verdict(0.01, 0.08).key, 'analisten-sterker');
  assert.strictEqual(verdict(0.04, 0.03).key, 'in-lijn');
  assert.strictEqual(verdict(null, 0.03), null);
});

test('summarizeRevisions telt verhogingen en verlagingen en sorteert eerste banken', () => {
  const s = summarizeRevisions([
    { t: 110, prev: 100, published_at: '2026-01-03' },
    { t: 90, prev: 100, published_at: '2026-01-02' },
    { t: 100, prev: 100, published_at: '2026-01-04' },
    { t: 120, prev: null, published_at: '2026-01-01' },
  ]);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.raises, 1);
  assert.strictEqual(s.cuts, 1);
  assert.strictEqual(s.kept, 1);
  assert.ok(Math.abs(s.avgChange - 0) < 1e-9);
  assert.strictEqual(s.firstMovers[0].published_at, '2026-01-01');
});

test('quarterLabel noemt het kwartaal waarover gerapporteerd wordt', () => {
  assert.strictEqual(quarterLabel('2026-01-29'), "Q4 '25");
  assert.strictEqual(quarterLabel('2026-04-30'), "Q1 '26");
  assert.strictEqual(quarterLabel('2026-10-30'), "Q3 '26");
});
