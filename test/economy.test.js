'use strict';

const test = require('node:test');
const assert = require('node:assert');
const eco = require('../src/lib/economy');

test('FMP-regel wordt genormaliseerd (UTC, periode, impact)', () => {
  const e = eco.fromFmp({ date: '2026-11-06 13:30:00', country: 'US', event: 'Non Farm Payrolls (Oct)', currency: 'USD', previous: 254, estimate: 140, actual: 12, impact: 'High' });
  assert.strictEqual(e.at.toISOString(), '2026-11-06T13:30:00.000Z');
  assert.strictEqual(e.event, 'Non Farm Payrolls');
  assert.strictEqual(e.period, 'Oct');
  assert.strictEqual(e.impact, 'High');
  assert.strictEqual(e.actual, 12);
  assert.strictEqual(eco.fromFmp({ date: '', event: 'x' }), null);
});

test('EODHD-regel krijgt een geschatte impact en landcode', () => {
  const e = eco.fromEodhd({ type: 'Inflation Rate YoY', country: 'UK', date: '2026-11-19 07:00:00', actual: null, previous: 3.8, estimate: 3.6 });
  assert.strictEqual(e.country, 'GB');
  assert.strictEqual(e.impact, 'High');
  assert.strictEqual(eco.guessImpact('Some Auction'), 'Low');
});

test('Nederlandse namen, met terugval op het origineel', () => {
  assert.strictEqual(eco.dutchEvent('Inflation Rate YoY'), 'Inflatie j/j');
  assert.strictEqual(eco.dutchEvent('Core Inflation Rate MoM'), 'Kerninflatie m/m');
  assert.strictEqual(eco.dutchEvent('HCOB Manufacturing PMI Flash'), 'HCOB Inkoopmanagersindex industrie (eerste raming)');
  assert.strictEqual(eco.dutchEvent('Fed Interest Rate Decision'), 'Rentebesluit Fed');
  assert.strictEqual(eco.dutchEvent('GDP Growth Rate QoQ Adv'), 'Bbp-groei k/k (eerste raming)');
  assert.strictEqual(eco.dutchEvent('6-Month Bill Auction'), '6-Month Bill Auction');
  assert.strictEqual(eco.dutchEvent('Treasury Refunding Announcement'), 'Treasury Refunding Announcement');
});

test('waarden en uitkomst ten opzichte van de verwachting', () => {
  assert.strictEqual(eco.formatValue(2.4, '%'), '2,4%');
  assert.strictEqual(eco.formatValue(254, 'K'), '254K');
  assert.strictEqual(eco.formatValue(null, '%'), '–');
  assert.strictEqual(eco.unitFor({ event: 'Unemployment Rate' }), '%');
  assert.strictEqual(eco.unitFor({ event: 'ISM Manufacturing PMI' }), '');
  assert.deepStrictEqual(eco.vsEstimate(3.1, 3.0).dir, 1);
  assert.deepStrictEqual(eco.vsEstimate(2.9, 3.0).dir, -1);
  assert.strictEqual(eco.vsEstimate(null, 3), null);
});

test('present zet tijd om naar Amsterdam', () => {
  const p = eco.present({ at: new Date('2026-11-06T13:30:00Z'), country: 'US', event: 'Unemployment Rate', impact: 'High', previous: 4.1, estimate: 4.2, actual: 4.3 }, new Date('2026-11-07T00:00:00Z'));
  assert.strictEqual(p.day, '2026-11-06');
  assert.strictEqual(p.time, '14:30');
  assert.strictEqual(p.fmt.actual, '4,3%');
  assert.strictEqual(p.past, true);
  assert.strictEqual(p.level, 3);
});

test('periode in het Nederlands', () => {
  assert.strictEqual(eco.dutchPeriod('Oct'), 'okt');
  assert.strictEqual(eco.dutchPeriod('May'), 'mei');
  assert.strictEqual(eco.dutchPeriod('Q3'), 'Q3');
});

test('FMP-eenheden Points/Index worden niet getoond', () => {
  assert.strictEqual(eco.unitFor({ event: 'ZEW Economic Sentiment Index', unit: 'Points' }), '');
  assert.strictEqual(eco.unitFor({ event: 'CPI', unit: 'Index' }), '');
  assert.strictEqual(eco.dutchEvent('Retail Sales Control Group MoM'), 'Detailhandelsverkopen kerngroep m/m');
  assert.strictEqual(eco.dutchEvent('Jobless Claims 4-Week Average'), 'WW-aanvragen, 4-weeks gemiddelde');
});
