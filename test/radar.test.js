'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { momentumScore, herd, surprise, bullShare, bucketFor, summarizeBacktest, capRange } = require('../src/lib/radar');

test('momentumScore weegt upgrades zwaarder dan koersdoelverhogingen', () => {
  assert.strictEqual(momentumScore({ raises: 3, cuts: 1, ups: 0, downs: 0 }), 2);
  assert.strictEqual(momentumScore({ raises: 0, cuts: 0, ups: 1, downs: 0 }), 2);
  assert.ok(momentumScore({ raises: 1, cuts: 0, ups: 0, downs: 0, avg_change: 0.1 }) > 1);
  // Bonus voor gemiddelde wijziging is begrensd.
  assert.strictEqual(momentumScore({ raises: 0, cuts: 0, avg_change: 5 }), 3);
  assert.strictEqual(momentumScore({ raises: 0, cuts: 0, eps_rev: -1 }), -3);
});

test('herd vraagt minstens drie analisten in dezelfde richting', () => {
  assert.strictEqual(herd({ h_up: 3, h_down: 0 }), 'up');
  assert.strictEqual(herd({ h_up: 3, h_down: 2 }), null);
  assert.strictEqual(herd({ h_up: 0, h_down: 4 }), 'down');
  assert.strictEqual(herd({ h_up: 2, h_down: 0 }), null);
});

test('surprise herkent uiteenlopende koers en koersdoel', () => {
  assert.strictEqual(surprise(-0.3, -0.02), 'koers-daalt');
  assert.strictEqual(surprise(0.2, -0.03), 'koers-stijgt');
  assert.strictEqual(surprise(-0.01, 0.12), 'doelen-stijgen');
  assert.strictEqual(surprise(0.02, -0.15), 'doelen-dalen');
  assert.strictEqual(surprise(0.1, 0.1), null);
  assert.strictEqual(surprise(NaN, 0.1), null);
});

test('bullShare en klassen', () => {
  const r = bullShare({ strong_buy: 2, buy: 6, hold: 1, sell: 1, strong_sell: 0 });
  assert.strictEqual(r.total, 10);
  assert.strictEqual(r.bull, 0.8);
  assert.strictEqual(r.bear, 0.1);
  assert.strictEqual(bullShare({}).bull, null);
  assert.strictEqual(bucketFor(0.95).key, 'b4');
  assert.strictEqual(bucketFor(1).key, 'b4');
  assert.strictEqual(bucketFor(0).key, 'b0');
});

test('summarizeBacktest geeft gemiddelde, mediaan en winkans per klasse', () => {
  const out = summarizeBacktest([
    { bull: 0.1, excess: 0.2 }, { bull: 0.2, excess: -0.1 }, { bull: 0.25, excess: 0.3 },
    { bull: 0.95, excess: -0.05 }, { bull: NaN, excess: 1 },
  ]);
  const b0 = out.find((b) => b.key === 'b0');
  assert.strictEqual(b0.n, 3);
  assert.ok(Math.abs(b0.mean - 0.4 / 3) < 1e-9);
  assert.strictEqual(b0.median, 0.2);
  assert.ok(Math.abs(b0.beat - 2 / 3) < 1e-9);
  assert.strictEqual(out.find((b) => b.key === 'b2').n, 0);
  assert.strictEqual(out.find((b) => b.key === 'b4').beat, 0);
});

test('capRange', () => {
  assert.strictEqual(capRange('mega').min, 200e9);
  assert.strictEqual(capRange('nope'), null);
});

test('filterMomentum filtert vooraf berekende radar zoals de SQL-filters', () => {
  const { filterMomentum } = require('../src/lib/radarQueries');
  const rows = [
    { symbol: 'A', sector: 'Technology', market_cap: 300e9 },
    { symbol: 'B', sector: 'Technology', market_cap: 5e9 },
    { symbol: 'C', sector: 'Energy', market_cap: 50e9 },
    { symbol: 'D', sector: null, market_cap: null },
  ];
  assert.strictEqual(filterMomentum(rows, {}), rows);
  assert.deepStrictEqual(filterMomentum(rows, { sector: 'Technology' }).map((r) => r.symbol), ['A', 'B']);
  assert.deepStrictEqual(filterMomentum(rows, { cap: 'mega' }).map((r) => r.symbol), ['A']);
  assert.deepStrictEqual(filterMomentum(rows, { cap: 'large' }).map((r) => r.symbol), ['C']);
  assert.deepStrictEqual(filterMomentum(rows, { cap: 'small' }).map((r) => r.symbol), []);
  assert.deepStrictEqual(filterMomentum(rows, { sector: 'Technology', cap: 'mid' }).map((r) => r.symbol), ['B']);
});
