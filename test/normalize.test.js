'use strict';

const test = require('node:test');
const assert = require('node:assert');
const n = require('../src/lib/normalize');

test('mapPriceTarget maakt analist-slug en uid', () => {
  const r = n.mapPriceTarget({
    symbol: 'aapl', publishedDate: '2025-01-10T12:00:00.000Z', analystName: 'Jane Doe', analystCompany: 'Big Bank',
    priceTarget: 250, priceWhenPosted: 200, newsURL: 'https://x',
  });
  assert.equal(r.symbol, 'AAPL');
  assert.equal(r.analyst_slug, 'jane-doe-big-bank');
  assert.equal(r.price_target, 250);
  assert.equal(r.uid.length, 40);
  assert.equal(n.mapPriceTarget({ symbol: 'X' }), null);
});

test('mapPriceTarget zonder analistnaam heeft geen slug', () => {
  const r = n.mapPriceTarget({ symbol: 'MSFT', publishedDate: '2025-01-10', analystName: '', analystCompany: 'Bank' });
  assert.equal(r.analyst_slug, null);
});

test('mapInsider herkent velden', () => {
  const r = n.mapInsider({ symbol: 'NVDA', transactionDate: '2025-02-01', transactionType: 'P-Purchase', securitiesTransacted: '100', price: '10.5' });
  assert.equal(r.transaction_date, '2025-02-01');
  assert.equal(r.securities_transacted, 100);
  assert.equal(r.price, 10.5);
});

test('mapHoldings voegt dubbele CUSIPs samen en berekent gewicht', () => {
  const { holdings, total } = n.mapHoldings([
    { securityCusip: 'A1', symbol: 'AAA', shares: 10, value: 300, putCallShare: 'Share' },
    { securityCusip: 'A1', symbol: 'AAA', shares: 5, value: 100, putCallShare: 'Share' },
    { securityCusip: 'B2', symbol: 'BBB', shares: 1, value: 100, putCallShare: 'Share' },
    { securityCusip: 'B2', symbol: 'BBB', shares: 1, value: 50, putCallShare: 'Put' },
  ]);
  assert.equal(total, 500);
  assert.equal(holdings.length, 3);
  assert.equal(holdings[0].symbol, 'AAA');
  assert.equal(holdings[0].shares, 15);
  assert.equal(holdings[0].weight, 0.8);
  assert.equal(holdings.find((h) => h.put_call === 'Put').weight, 0);
});

test('diffHoldings vindt nieuw, bijgekocht, verlaagd en verkocht', () => {
  const prev = [{ cusip: 'A', shares: 10 }, { cusip: 'B', shares: 10 }, { cusip: 'C', shares: 10 }, { cusip: 'D', shares: 10 }];
  const cur = [{ cusip: 'A', shares: 20 }, { cusip: 'B', shares: 5 }, { cusip: 'C', shares: 10 }, { cusip: 'E', shares: 1 }];
  const { positions, sold } = n.diffHoldings(cur, prev);
  const by = Object.fromEntries(positions.map((p) => [p.cusip, p.change]));
  assert.deepEqual(by, { A: 'added', B: 'reduced', C: 'unchanged', E: 'new' });
  assert.equal(sold.length, 1);
  assert.equal(sold[0].cusip, 'D');
});

test('scoreTarget: koopadvies en koersdoel gehaald', () => {
  const s = n.scoreTarget({ price_target: 120, price_when_posted: 100, current_price: 125 });
  assert.equal(s.correct, true);
  assert.equal(s.hit, true);
  assert.ok(Math.abs(s.realized - 0.25) < 1e-9);
});

test('scoreTarget: verkoopadvies, koers steeg = verkeerde richting', () => {
  const s = n.scoreTarget({ price_target: 80, price_when_posted: 100, current_price: 110 });
  assert.equal(s.correct, false);
  assert.equal(s.hit, false);
  assert.ok(s.directional < 0);
  assert.equal(n.scoreTarget({ price_target: 0, price_when_posted: 100, current_price: 1 }), null);
});

test('slugify verwijdert accenten', () => {
  assert.equal(n.slugify('Érik  Müller & Co.'), 'erik-muller-co');
});

test('koersdoel van voor een split op de schaal van de koers', () => {
  assert.equal(n.splitTarget(1050, 105, 88.46), 105, 'NVDA 10:1');
  assert.equal(n.splitTarget(250, 250, 200), 250, 'geen split');
  assert.equal(n.splitTarget(300, 100, 280), 300, 'origineel past beter bij de koers');
  assert.equal(n.splitTarget(1000, 100, null), 100, 'zonder koers: gecorrigeerd');
  const r = n.mapPriceTarget({ symbol: 'NVDA', publishedDate: '2024-03-18T10:00:00Z', analystName: 'A', analystCompany: 'B', priceTarget: 1050, adjPriceTarget: 105, priceWhenPosted: 88.46 });
  assert.equal(r.price_target, 105);
  assert.equal(r.raw_price_target, 1050);
});
