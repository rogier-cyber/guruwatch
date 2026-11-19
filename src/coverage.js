'use strict';

// Dekkingsmeting: wat levert FMP voor Nederland, België, Canada en Australië?
// Telt aandelen per land en beurs en test per datatype een reeks voorbeeldnamen.
// Het resultaat gaat als JSON naar fmp_coverage en is te zien op /status/dekking.
const db = require('./db');
const fmp = require('./lib/fmp');

const COUNTRIES = [
  { code: 'NL', name: 'Nederland', suffix: ['.AS'], large: ['ASML.AS', 'SHELL.AS', 'INGA.AS', 'ADYEN.AS', 'PHIA.AS'], small: ['BESI.AS', 'SBMO.AS', 'AMG.AS', 'FAST.AS', 'NEDAP.AS'] },
  { code: 'BE', name: 'België', suffix: ['.BR'], large: ['KBC.BR', 'ABI.BR', 'UCB.BR', 'SOLB.BR'], small: ['BEKB.BR', 'MELE.BR', 'EVS.BR', 'KIN.BR'] },
  { code: 'CA', name: 'Canada', suffix: ['.TO', '.V', '.NE', '.CN'], large: ['RY.TO', 'SHOP.TO', 'ENB.TO', 'CNR.TO'], small: ['ATZ.TO', 'GSY.TO', 'DND.TO', 'LSPD.TO'] },
  { code: 'AU', name: 'Australië', suffix: ['.AX'], large: ['BHP.AX', 'CBA.AX', 'CSL.AX', 'WES.AX'], small: ['PME.AX', 'JBH.AX', 'NHC.AX', 'CTD.AX'] },
];
// Ter vergelijking: VS-noteringen (ADR) van Europese en Canadese namen.
const REFERENCE = ['ASML', 'ING', 'SHEL', 'BUD', 'SHOP', 'RY', 'BHP'];

const year = new Date().getUTCFullYear();
const DAY = 24 * 3600 * 1000;
const iso = (d) => d.toISOString().slice(0, 10);

// Per datatype één endpoint (stable API).
const CHECKS = [
  ['Koers', 'quote', (s) => ({ symbol: s })],
  ['Koershistorie', 'historical-price-eod/light', (s) => ({ symbol: s, from: iso(new Date(Date.now() - 10 * DAY)) })],
  ['Profiel', 'profile', (s) => ({ symbol: s })],
  ['Bestuurders', 'key-executives', (s) => ({ symbol: s })],
  ['Jaarcijfers', 'income-statement', (s) => ({ symbol: s, period: 'annual', limit: 5 })],
  ['Kwartaalcijfers', 'income-statement', (s) => ({ symbol: s, period: 'quarter', limit: 8 })],
  ['Ratio\'s TTM', 'ratios-ttm', (s) => ({ symbol: s })],
  ['Winstverwachtingen', 'analyst-estimates', (s) => ({ symbol: s, period: 'annual', page: 0, limit: 10 })],
  ['Ratings (grades)', 'grades', (s) => ({ symbol: s })],
  ['Grades-historie', 'grades-historical', (s) => ({ symbol: s, limit: 24 })],
  ['Grades-consensus', 'grades-consensus', (s) => ({ symbol: s })],
  ['Ratings-snapshot', 'ratings-snapshot', (s) => ({ symbol: s })],
  ['Koersdoelen (nieuws)', 'price-target-news', (s) => ({ symbol: s, page: 0, limit: 50 })],
  ['Koersdoel-consensus', 'price-target-consensus', (s) => ({ symbol: s })],
  ['Koersdoel-samenvatting', 'price-target-summary', (s) => ({ symbol: s })],
  ['Insider trades', 'insider-trading/search', (s) => ({ symbol: s, page: 0, limit: 50 })],
  ['13F-houders', 'institutional-ownership/symbol-positions-summary', (s) => ({ symbol: s, year, quarter: 2 })],
  ['Transcripts', 'earning-call-transcript-dates', (s) => ({ symbol: s })],
  ['Cijferhistorie (EPS)', 'earnings', (s) => ({ symbol: s, limit: 8 })],
  ['Dividend', 'dividends', (s) => ({ symbol: s, limit: 8 })],
  ['Nieuws', 'news/stock', (s) => ({ symbols: s, limit: 20 })],
];

const DATE_FIELDS = ['date', 'publishedDate', 'filingDate', 'transactionDate', 'fillingDate', 'lastUpdated', 'fiscalDateEnding'];

function latestDate(rows) {
  let best = null;
  for (const r of rows) {
    for (const f of DATE_FIELDS) {
      const v = r && r[f];
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        const d = v.slice(0, 10);
        if (!best || d > best) best = d;
        break;
      }
    }
  }
  return best;
}

function summarize(data) {
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const useful = rows.filter((r) => r && Object.values(r).some((v) => v !== null && v !== '' && v !== 0));
  return { n: useful.length, latest: latestDate(useful) };
}

async function probe(path, params) {
  try {
    return summarize(await fmp.request(path, params, { ttl: 0, retries: 1 }));
  } catch (err) {
    return { n: 0, error: String(err.message || err).replace(/apikey=[^&\s]+/g, 'apikey=…').slice(0, 160) };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

const hasSuffix = (sym, list) => list.some((s) => String(sym || '').toUpperCase().endsWith(s));

async function countUniverse() {
  const out = {};
  // Alle symbolen van FMP, geteld per achtervoegsel.
  let all = [];
  try { all = await fmp.request('stock-list', {}, { ttl: 0, retries: 1 }); } catch (e) { out.stockListError = e.message; }
  let fsList = [];
  try { fsList = await fmp.request('financial-statement-symbol-list', {}, { ttl: 0, retries: 1 }); } catch (e) { out.fsListError = e.message; }
  out.totalSymbols = Array.isArray(all) ? all.length : 0;
  out.totalWithStatements = Array.isArray(fsList) ? fsList.length : 0;
  out.countries = {};
  for (const c of COUNTRIES) {
    const bySuffix = {};
    for (const s of c.suffix) bySuffix[s] = (all || []).filter((r) => hasSuffix(r.symbol, [s])).length;
    const withStatements = (fsList || []).filter((r) => hasSuffix(r.symbol, c.suffix)).length;
    // Screener: actieve aandelen (geen ETF/fonds) met land en beurs.
    let screener = [];
    let screenerError = null;
    try {
      screener = await fmp.request('company-screener', { country: c.code, isEtf: false, isFund: false, isActivelyTrading: true, limit: 10000 }, { ttl: 0, retries: 1 });
    } catch (e) { screenerError = e.message; }
    const byExchange = {};
    const capBands = { '>10 mld': 0, '1-10 mld': 0, '<1 mld': 0 };
    for (const r of screener || []) {
      const ex = r.exchangeShortName || r.exchange || '?';
      byExchange[ex] = (byExchange[ex] || 0) + 1;
      const cap = Number(r.marketCap) || 0;
      if (cap >= 1e10) capBands['>10 mld']++;
      else if (cap >= 1e9) capBands['1-10 mld']++;
      else capBands['<1 mld']++;
    }
    out.countries[c.code] = { bySuffix, withStatements, screenerTotal: (screener || []).length, byExchange, capBands, screenerError };
  }
  return out;
}

// Hoeveel niet-VS-namen zitten in de wereldwijde feeds (kalender, transcripts, analisten)?
async function countFeeds() {
  const from = iso(new Date());
  const to = iso(new Date(Date.now() + 60 * DAY));
  const feeds = {
    'Cijferkalender (60 dagen)': ['earnings-calendar', { from, to }],
    'Dividendkalender (60 dagen)': ['dividends-calendar', { from, to }],
    'Transcriptlijst': ['earnings-transcript-list', {}],
    'Laatste koersdoelen (1000)': ['price-target-latest-news', { page: 0, limit: 1000 }],
    'Laatste grades (1000)': ['grades-latest-news', { page: 0, limit: 1000 }],
    'Laatste insider trades (1000)': ['insider-trading/latest', { page: 0, limit: 1000 }],
  };
  const out = {};
  for (const [label, [path, params]] of Object.entries(feeds)) {
    try {
      const rows = await fmp.request(path, params, { ttl: 0, retries: 1 });
      const list = Array.isArray(rows) ? rows : [];
      const counts = { total: list.length };
      for (const c of COUNTRIES) counts[c.code] = list.filter((r) => hasSuffix(r.symbol, c.suffix)).length;
      out[label] = counts;
    } catch (e) {
      out[label] = { error: e.message.slice(0, 160) };
    }
  }
  return out;
}

async function lists() {
  const out = {};
  for (const [k, path] of [['exchanges', 'available-exchanges'], ['countries', 'available-countries']]) {
    try { out[k] = await fmp.request(path, {}, { ttl: 0, retries: 1 }); } catch (e) { out[k] = { error: e.message }; }
  }
  return out;
}

async function runCoverage() {
  const started = new Date().toISOString();
  const [universe, feeds, ref] = [await countUniverse(), await countFeeds(), await lists()];
  const symbols = [
    ...COUNTRIES.flatMap((c) => [...c.large.map((s) => [c.code, 'groot', s]), ...c.small.map((s) => [c.code, 'klein', s])]),
    ...REFERENCE.map((s) => ['VS', 'ADR/VS', s]),
  ];
  const tasks = symbols.flatMap(([country, size, symbol]) => CHECKS.map(([label, path, params]) => ({ country, size, symbol, label, path, params: params(symbol) })));
  const results = await mapLimit(tasks, 6, async (t) => ({ country: t.country, size: t.size, symbol: t.symbol, label: t.label, ...(await probe(t.path, t.params)) }));
  const result = {
    started,
    finished: new Date().toISOString(),
    countries: COUNTRIES.map(({ code, name, suffix }) => ({ code, name, suffix })),
    checks: CHECKS.map(([label, path]) => ({ label, path })),
    universe,
    feeds,
    available: ref,
    results,
  };
  await db.query('INSERT INTO fmp_coverage (result) VALUES ($1)', [JSON.stringify(result)]);
  return { calls: tasks.length, symbols: symbols.length };
}

async function latestCoverage() {
  return db.one('SELECT ran_at, result FROM fmp_coverage ORDER BY id DESC LIMIT 1').catch(() => null);
}

module.exports = { runCoverage, latestCoverage, summarize, latestDate, COUNTRIES, CHECKS };
