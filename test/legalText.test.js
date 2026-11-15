'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extract, htmlToText } = require('../src/lib/legalText');

const HTML = `<html><head><title>x</title></head><body><form><header><nav>Menu</nav></header>
<div id="c"><h1>Disclaimer</h1><p>Deze website is een initiatief van IEX Media B.V. &amp; Beurs.nl.</p>\r
<p><strong>2. Gebruik van de dienst</strong><br> 2.1 Onze websites bevatten forums:</p><ul> 2.1.1. Niet spammen;<br> 2.1.2. Geen virussen</ul>
<p>Wijzigingen</p><p>Adres: Beursplein 5</p><p>Schrijf je in voor onze nieuwsbrief</p></div><footer>f</footer></form></body></html>`;

test('IEX-tekst omzetten naar alinea\'s', () => {
  assert.ok(!/Menu|<|&amp;/.test(htmlToText(HTML)));
  const p = extract(HTML, { start: 'Deze website is een initiatief', end: 'Schrijf je in', replace: [[/Beurs\.nl/g, 'Guruwatch.nl']] });
  assert.match(p[0].lines[0], /IEX Media B\.V\. & Guruwatch\.nl\./);
  assert.deepEqual(p[1].lines, ['2. Gebruik van de dienst', '2.1 Onze websites bevatten forums:']);
  assert.deepEqual(p[2].lines, ['2.1.1. Niet spammen;', '2.1.2. Geen virussen']);
  assert.equal(p.find((x) => x.lines[0] === 'Wijzigingen').head, true);
  assert.equal(p.find((x) => x.lines[0].startsWith('Adres')).head, false);
  assert.equal(extract(HTML, { start: 'bestaat niet' }), null);
});
