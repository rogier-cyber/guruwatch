'use strict';

const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/lib/scoring');
const { targetTimeline, rollingConsensus } = require('../src/lib/charts');

// Dagelijkse reeks vanaf start met een functie voor de koers.
function series(start, days, fn) {
  const out = [];
  const t0 = new Date(start).getTime();
  for (let i = 0; i < days; i++) out.push({ date: new Date(t0 + i * 864e5).toISOString().slice(0, 10), close: fn(i) });
  return out;
}

const today = new Date('2026-06-01T00:00:00Z');

test('koopadvies dat het doel binnen 12 maanden haalt', () => {
  const px = series('2025-01-01', 500, (i) => 100 + i * 0.1); // stijgt 0,1 per dag
  const bench = series('2025-01-01', 500, () => 100);
  const r = s.evaluateCall({ published_at: '2025-01-01T12:00:00Z', price_target: 120, price_when_posted: 100 }, px, bench, today);
  assert.equal(r.direction, 1);
  assert.equal(r.hit, true);
  assert.equal(r.days_to_hit, 200);
  assert.equal(r.complete, true);
  assert.ok(Math.abs(r.ret - 0.365) < 0.01);
  assert.ok(Math.abs(r.excess - r.ret) < 1e-9); // benchmark vlak
});

test('verkoopadvies: dalende koers is winst', () => {
  const px = series('2025-01-01', 400, (i) => 100 - i * 0.05);
  const r = s.evaluateCall({ published_at: '2025-01-01', price_target: 90, price_when_posted: 100 }, px, [], today);
  assert.equal(r.direction, -1);
  assert.equal(r.hit, true);
  assert.ok(r.ret > 0);
  assert.equal(r.excess, null);
});

test('lopend advies is niet compleet en te recente adviezen tellen niet', () => {
  const px = series('2026-01-01', 150, () => 100);
  const r = s.evaluateCall({ published_at: '2026-01-02', price_target: 130, price_when_posted: 100 }, px, [], today);
  assert.equal(r.complete, false);
  assert.equal(r.hit, false);
  assert.equal(s.evaluateCall({ published_at: '2026-05-20', price_target: 130, price_when_posted: 100 }, px, [], today), null);
});

test('doel wordt omgerekend bij een split', () => {
  // Koersreeks is split-gecorrigeerd (10:1), publicatiekoers niet.
  const px = series('2025-01-01', 400, (i) => 10 + i * 0.01);
  const r = s.evaluateCall({ published_at: '2025-01-01', price_target: 120, price_when_posted: 100 }, px, [], today);
  assert.ok(Math.abs(r.target - 12) < 1e-9);
  assert.equal(r.hit, true);
});

test('neutrale en absurde doelen worden overgeslagen', () => {
  const px = series('2025-01-01', 400, () => 100);
  assert.equal(s.evaluateCall({ published_at: '2025-01-01', price_target: 100.5, price_when_posted: 100 }, px, [], today), null);
  assert.equal(s.evaluateCall({ published_at: '2025-01-01', price_target: 1000, price_when_posted: 100 }, px, [], today), null);
});

test('GuruScore: veel goede adviezen verslaan weinig gelukstreffers', () => {
  const mk = (n, hit, excess) => Array.from({ length: n }, () => ({ published_at: '2026-01-01', hit, ret: excess, excess }));
  const groups = new Map([
    ['veel-goed', [...mk(80, true, 0.12), ...mk(20, false, -0.05)]],
    ['geluk', mk(2, true, 0.5)],
    ['slecht', mk(60, false, -0.1)],
    ['middel', [...mk(30, true, 0.03), ...mk(30, false, -0.02)]],
  ]);
  const scores = s.computeScores(groups, today);
  const by = Object.fromEntries(scores.map((x) => [x.ref, x]));
  assert.equal(scores[0].ref, 'veel-goed');
  assert.ok(by['veel-goed'].score > by.geluk.score);
  assert.ok(by.slecht.score < by.middel.score);
  for (const x of scores) assert.ok(x.score >= 0 && x.score <= 100);
});

test('percentielen met midrank', () => {
  const p = s.percentileRanks([1, 2, 3, 4]);
  assert.equal(p(1), 0.125);
  assert.equal(p(4), 0.875);
  assert.equal(p(10), 1);
});

test('consensus en slimme consensus', () => {
  const c = s.consensus([
    { price_target: 100, score: 80 },
    { price_target: 140, score: 40 },
    { price_target: 120, score: 75 },
  ], 100);
  assert.equal(c.count, 3);
  assert.equal(c.mean, 120);
  assert.equal(c.median, 120);
  assert.equal(c.topCount, 2);
  assert.equal(c.topMean, 110);
  assert.ok(Math.abs(c.upside - 0.2) < 1e-9);
  assert.equal(s.consensus([], 100), null);
});

test('tijdlijn: svg, legenda en voortschrijdend gemiddelde', () => {
  const px = series('2025-01-01', 300, (i) => 100 + i * 0.1);
  const t = targetTimeline(px, [
    { published_at: '2025-02-01', target: 130, pwp: 103, firm: 'Bank A' },
    { published_at: '2025-03-01', target: 110, pwp: 106, firm: 'Bank B' },
    { published_at: '2025-05-01', target: 150, pwp: 112, firm: 'Bank A' },
  ]);
  assert.match(t.svg, /^<svg/);
  assert.equal(t.count, 3);
  assert.equal(t.legend[0].label, 'Bank A');
  const cons = rollingConsensus([
    { published_at: '2025-02-01', target: 130, firm: 'A' },
    { published_at: '2025-03-01', target: 110, firm: 'B' },
    { published_at: '2025-05-01', target: 150, firm: 'A' },
  ], ['2025-01-15', '2025-02-15', '2025-03-15', '2025-05-15']);
  assert.deepEqual(cons, [null, 130, 120, 130]);
});
