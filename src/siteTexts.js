'use strict';

// De disclaimer en privacyverklaring van IEX Media (ook gebruikt door Beurs.nl) overnemen op Guruwatch.
// Dagelijks opgehaald en in de database bewaard; lukt ophalen niet, dan blijft de vorige versie staan.
const db = require('./db');
const { extract } = require('./lib/legalText');

const REPLACE = [[/Beurs\.nl/g, 'Guruwatch.nl'], [/beurs\.nl/g, 'guruwatch.nl']];
const SOURCES = {
  disclaimer: { url: 'https://www.iexmedia.nl/misc/disclaimer.aspx', start: 'Deze website is een initiatief', end: 'Schrijf je in' },
  privacy: { url: 'https://www.iexmedia.nl/misc/privacy.aspx', start: 'Algemeen', end: 'Lees ook onze Algemene Voorwaarden' },
};
const cache = new Map();

async function refreshOne(key) {
  const s = SOURCES[key];
  const res = await fetch(s.url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Guruwatch)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
  const paras = extract(await res.text(), { start: s.start, end: s.end, replace: REPLACE });
  const chars = paras ? paras.reduce((n, p) => n + p.lines.join(' ').length, 0) : 0;
  if (!paras || chars < 3000) throw new Error(`${key}: tekst niet gevonden (${chars} tekens)`);
  await db.query(
    'INSERT INTO site_texts (key, paras, source) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET paras = EXCLUDED.paras, source = EXCLUDED.source, fetched_at = now()',
    [key, JSON.stringify(paras), s.url]
  );
  cache.delete(key);
  return chars;
}

async function refreshSiteTexts() {
  const out = {};
  for (const key of Object.keys(SOURCES)) out[key] = await refreshOne(key).catch((e) => `fout: ${e.message}`);
  return out;
}

// Voor de pagina: alinea's of null (dan toont de pagina onze eigen korte tekst).
async function get(key) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < 10 * 60e3) return c.row;
  const row = await db.one('SELECT paras, source, fetched_at FROM site_texts WHERE key = $1', [key]).catch(() => null);
  cache.set(key, { at: Date.now(), row });
  return row;
}

module.exports = { refreshSiteTexts, get, SOURCES };
