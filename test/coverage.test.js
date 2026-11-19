'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { summarize, latestDate } = require('../src/coverage');

test('summarize telt bruikbare regels en pakt de nieuwste datum', () => {
  const s = summarize([{ date: '2026-01-02', v: 1 }, { publishedDate: '2026-03-04T10:00:00Z', v: 2 }, {}]);
  assert.strictEqual(s.n, 2);
  assert.strictEqual(s.latest, '2026-03-04');
});

test('summarize behandelt object en leeg antwoord', () => {
  assert.deepStrictEqual(summarize({ symbol: 'X', date: '2025-12-31' }), { n: 1, latest: '2025-12-31' });
  assert.deepStrictEqual(summarize([]), { n: 0, latest: null });
  assert.strictEqual(latestDate([{ date: 'onzin' }]), null);
});
