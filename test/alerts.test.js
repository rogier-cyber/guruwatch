'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeParams, describe, briefingDue, amsterdamParts, KINDS, DEFAULT_KINDS } = require('../src/lib/alertRules');

test('normalizeParams vult standaardwaarden aan en begrenst invoer', () => {
  assert.deepStrictEqual(normalizeParams('top_raises', {}), { min: 3, days: 7, minScore: 70, scope: 'watchlist', email: 'direct' });
  const p = normalizeParams('top_raises', { min: '50', days: '0', minScore: '99', scope: 'all', email: 'briefing' });
  assert.strictEqual(p.min, 10);
  assert.strictEqual(p.days, 1);
  assert.strictEqual(p.minScore, 95);
  assert.strictEqual(p.scope, 'all');
  assert.strictEqual(p.email, 'briefing');
  assert.strictEqual(normalizeParams('onbekend', {}), null);
});

test('smart_upside accepteert 25 en 0,25 als 25%', () => {
  assert.strictEqual(normalizeParams('smart_upside', { min: '25' }).min, 0.25);
  assert.strictEqual(normalizeParams('smart_upside', { min: '0,4' }).min, 0.4);
});

test('velden die niet bij een soort horen worden genegeerd', () => {
  const p = normalizeParams('analyst_call', { min: 5, scope: 'all' });
  assert.strictEqual(p.min, undefined);
  assert.strictEqual(p.email, 'briefing');
});

test('describe geeft leesbare tekst', () => {
  assert.match(describe('smart_upside', { min: 0.3 }), /30% potentieel/);
  assert.match(describe('top_raises', { scope: 'all' }), /alle aandelen/);
  for (const k of KINDS) assert.ok(describe(k, {}).length > 10);
  for (const k of DEFAULT_KINDS) assert.ok(KINDS.includes(k));
});

test('briefing alleen op werkdagen tussen 08:00 en 11:00 Amsterdamse tijd, één keer per dag', () => {
  // Maandag 16 november 2026, 07:30 UTC = 08:30 in Amsterdam (wintertijd).
  const mon = new Date('2026-11-16T07:30:00Z');
  assert.strictEqual(amsterdamParts(mon).hour, 8);
  assert.strictEqual(briefingDue(null, mon), true);
  assert.strictEqual(briefingDue(new Date('2026-11-13T07:05:00Z'), mon), true);
  assert.strictEqual(briefingDue(new Date('2026-11-16T07:05:00Z'), mon), false);
  assert.strictEqual(briefingDue(null, new Date('2026-11-16T06:30:00Z')), false); // 07:30 lokaal
  assert.strictEqual(briefingDue(null, new Date('2026-11-16T10:30:00Z')), false); // 11:30 lokaal
  assert.strictEqual(briefingDue(null, new Date('2026-11-14T07:30:00Z')), false); // zaterdag
  // Zomertijd: 1 juli 2026, 06:15 UTC = 08:15 lokaal.
  assert.strictEqual(briefingDue(null, new Date('2026-07-01T06:15:00Z')), true);
});
