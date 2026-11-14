'use strict';

const test = require('node:test');
const assert = require('node:assert');
const av = require('../src/lib/analystView');
const { buildStory } = require('../src/lib/stockStory');

test('ratingScore en ratingLabel', () => {
  assert.strictEqual(av.ratingScore({ strong_buy: 1, buy: 0, hold: 0, sell: 0, strong_sell: 0 }), 5);
  assert.ok(Math.abs(av.ratingScore({ strong_buy: 2, buy: 25, hold: 12, sell: 4, strong_sell: 0 }) - 3.581) < 0.01);
  assert.strictEqual(av.ratingScore({}), null);
  assert.strictEqual(av.ratingLabel(4.6).label, 'Sterk kopen');
  assert.strictEqual(av.ratingLabel(3.6).label, 'Licht kopen');
  assert.strictEqual(av.ratingLabel(2.8).label, 'Houden');
  assert.strictEqual(av.ratingLabel(1.2).label, 'Sterk verkopen');
});

test('consensusAt neemt het laatste doel per analist binnen 12 maanden', () => {
  const t = [
    { published_at: '2025-01-10', target: 100, firm: 'A', analyst_name: 'x' },
    { published_at: '2025-06-10', target: 120, firm: 'A', analyst_name: 'x' },
    { published_at: '2025-07-01', target: 90, firm: 'B', analyst_name: 'y' },
    { published_at: '2023-01-01', target: 500, firm: 'C', analyst_name: 'z' },
  ];
  const c = av.consensusAt(t, '2025-08-01');
  assert.strictEqual(c.count, 2);
  assert.strictEqual(c.mean, 105);
  assert.strictEqual(c.low, 90);
  assert.strictEqual(av.consensusAt(t, '2025-03-01').mean, 100);
});

test('gradeLevel herkent adviestermen', () => {
  assert.strictEqual(av.gradeLevel('Overweight'), 4);
  assert.strictEqual(av.gradeLevel('Market Perform'), 3);
  assert.strictEqual(av.gradeLevel('Underperform'), 2);
  assert.strictEqual(av.gradeLevel('Strong Buy'), 5);
  assert.strictEqual(av.gradeLevel(''), null);
});

test('mergeActions koppelt een upgrade aan het koersdoel van dezelfde bank', () => {
  const grades = [{ published_at: '2026-11-11T12:00:00Z', grading_company: 'Morgan Stanley', previous_grade: 'Hold', new_grade: 'Buy', action: 'upgrade' }];
  const targets = [
    { published_at: '2026-11-11T09:00:00Z', analyst_firm: 'Morgan Stanley', analyst_name: 'Erik', price_target: 425, prev_target: 360 },
    { published_at: '2026-11-04T09:00:00Z', analyst_firm: 'DZ Bank', analyst_name: 'Ana', price_target: 300, prev_target: 330 },
  ];
  const out = av.mergeActions(grades, targets, 350);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].action.label, 'Upgrade');
  assert.strictEqual(out[0].to_target, 425);
  assert.strictEqual(out[0].from_target, 360);
  assert.strictEqual(out[1].action.label, 'Doel omlaag');
});

test('benchmarks berekent gemiddelden per sector en markt', () => {
  const rows = ['a', 'b', 'c'].map((s, i) => ({ symbol: s, sector: 'Tech', strong_buy: 0, buy: 1 + i, hold: 1, sell: 0, strong_sell: 0, upside: 0.1 * i, n: 5 }));
  rows.push({ symbol: 'd', sector: 'Energy', strong_buy: 0, buy: 0, hold: 1, sell: 0, strong_sell: 0, upside: -0.1, n: 3 });
  const b = av.benchmarks(rows);
  assert.strictEqual(b.market.stocks, 4);
  assert.ok(b.sectors.Tech);
  assert.strictEqual(b.sectors.Energy, undefined); // minder dan 3 aandelen
  assert.ok(Math.abs(b.sectors.Tech.upside - 0.1) < 1e-9);
});

test('buildStory maakt bull en bear case uit feiten', () => {
  const s = buildStory({
    name: 'Apple', symbol: 'AAPL', sector: 'Technology', price: 300,
    consensus: { target: 345, upside: 0.15, analysts: 30, low: 200, high: 450, counts: { total: 40, strong_buy: 2, buy: 25, hold: 10, sell: 3, strong_sell: 0 }, score: 3.65, verdict: 'Licht kopen', buys: 27, holds: 10, sells: 3, buyShare: 0.675, sellShare: 0.075 },
    lastEarnings: { date: '2026-10-30', epsActual: 2.1, epsEstimated: 1.99, epsSurprise: 0.055, revSurprise: 0.01, reaction: 0.02 },
    fundamentals: { pe: 39.7, netMargin: 0.276, roe: 1.25, revenue: 1.14e11, revenueGrowth: 0.117 },
    technicals: { yearHigh: 310, yearLow: 240, avg50: 305, avg200: 280, fromHigh: -0.03 },
    actions: { upgrades: ['China Renaissance'], downgrades: ['DZ Bank'], raises: 5, cuts: 2 },
    insiders: { buys: 0, sells: 4, buyValue: 0, sellValue: 2e6, topSell: { reporting_name: 'Jane', type_of_owner: 'SVP', shares: 2399, price: 351 } },
  });
  assert.ok(s.bull.length >= 3);
  assert.ok(s.bear.length >= 3);
  assert.ok(s.bull.some((t) => t.includes('China Renaissance')));
  assert.ok(s.bear.some((t) => t.includes('DZ Bank')));
  assert.ok(s.bear.some((t) => t.includes('koers-winstverhouding')));
  assert.ok(s.faq.length >= 2);
  assert.ok(s.description.includes('AAPL'));
  assert.ok(s.forecast.text.includes('kan stijgen'));
});

test('buildStory werkt ook met weinig data', () => {
  const s = buildStory({ name: 'X', symbol: 'X', price: 10 });
  assert.deepStrictEqual(s.bull, []);
  assert.deepStrictEqual(s.bear, []);
  assert.strictEqual(s.forecast, null);
});
