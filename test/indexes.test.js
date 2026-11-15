'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { oneClassPerCompany } = require('../src/indexes');

test('één aandelenklasse per bedrijf', () => {
  const out = oneClassPerCompany([{ symbol: 'GOOGL' }, { symbol: 'GOOG' }, { symbol: 'FOXA' }, { symbol: 'NWSA' }, { symbol: 'NWS' }, { symbol: 'AAPL' }]);
  assert.deepStrictEqual(out.map((r) => r.symbol), ['GOOG', 'FOX', 'NWS', 'AAPL']);
});
