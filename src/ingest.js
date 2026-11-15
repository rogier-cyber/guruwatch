'use strict';

// Achtergrond-import van FMP-data naar Postgres.
// Draait in het webproces (setInterval) of los via `npm run ingest`.
const db = require('./db');
const fmp = require('./lib/fmp');
const store = require('./lib/store');
const funds = require('./lib/funds');

const running = new Set();

async function job(name, fn) {
  if (running.has(name)) return null;
  running.add(name);
  const started = Date.now();
  try {
    const info = await fn();
    await store.markJob(name, true, { ...info, ms: Date.now() - started });
    console.log(`[ingest] ${name} ok`, JSON.stringify(info));
    return info;
  } catch (err) {
    console.error(`[ingest] ${name} mislukt:`, err.message);
    await store.markJob(name, false, err.message).catch(() => {});
    return null;
  } finally {
    running.delete(name);
  }
}

// Haal pagina's op tot er niets nieuws meer bij komt.
async function pages(fetchPage, save, { maxPages }) {
  let total = 0;
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage(page);
    if (!rows.length) break;
    const added = await save(rows);
    total += added;
    if (added === 0) break;
  }
  return total;
}

async function isEmpty(table) {
  const r = await db.one(`SELECT EXISTS (SELECT 1 FROM ${table}) AS has`);
  return !r.has;
}

async function ingestAnalysts() {
  return job('analysts', async () => {
    const backfill = await isEmpty('price_targets');
    const maxPages = backfill ? 50 : 5;
    const targets = await pages((p) => fmp.priceTargetLatest(p, 100), store.savePriceTargets, { maxPages });
    const grades = await pages((p) => fmp.gradesLatest(p, 100), store.saveGrades, { maxPages });
    return { targets, grades, backfill };
  });
}

async function ingestInsiders() {
  return job('insiders', async () => {
    const backfill = await isEmpty('insider_trades');
    const added = await pages((p) => fmp.insiderLatest(p, 100), store.saveInsiders, { maxPages: backfill ? 50 : 5 });
    return { added, backfill };
  });
}

async function refreshQuotes() {
  return job('quotes', async () => {
    const rows = await db.many(`
      SELECT DISTINCT symbol FROM price_targets WHERE published_at > now() - interval '400 days'
      UNION SELECT DISTINCT symbol FROM grades WHERE published_at > now() - interval '30 days'
      UNION SELECT DISTINCT symbol FROM insider_trades WHERE filing_date > now() - interval '30 days'
      UNION SELECT DISTINCT symbol FROM index_members`);
    const symbols = rows.map((r) => r.symbol).filter((s) => /^[A-Z0-9.\-]{1,12}$/.test(s));
    let saved = 0;
    for (let i = 0; i < symbols.length; i += 200) {
      const quotes = await fmp.batchQuoteShort(symbols.slice(i, i + 200));
      saved += await store.saveQuotes(quotes);
    }
    return { symbols: symbols.length, saved };
  });
}

// Laatste kwartalen van een fonds ophalen: tot 10 jaar (40 kwartalen) historie (quant-fondsen 4),
// de nieuwste altijd opnieuw, oudere alleen als ze nog ontbreken.
async function refreshFund(cik) {
  const meta = await db.one('SELECT quant FROM funds WHERE cik = $1', [cik]);
  const dates = await fmp.institutionalDates(cik);
  const sorted = dates
    .filter((d) => d && d.year && d.quarter)
    .sort((a, b) => b.year - a.year || b.quarter - a.quarter)
    .slice(0, meta && meta.quant ? 4 : 40);
  let latest = null;
  for (const d of sorted) {
    const period = d.date || quarterEnd(d.year, d.quarter);
    const have = await db.one('SELECT count(*)::int AS n FROM fund_holdings WHERE cik = $1 AND period = $2', [cik, period]);
    let res;
    if (!have.n || d === sorted[0] || d === sorted[1]) {
      const rows = await fmp.institutionalExtract(cik, d.year, d.quarter);
      res = await store.saveFundQuarter(cik, period, rows);
    }
    if (d === sorted[0]) latest = { period, ...(res || {}) };
  }
  if (latest) {
    await db.query(
      'UPDATE funds SET latest_period = $2, latest_value = $3, latest_positions = $4, refreshed_at = now(), last_error = NULL WHERE cik = $1',
      [cik, latest.period, latest.total ?? null, latest.positions ?? null]
    );
    // Grootste posities meenemen in koersen, profielen (sector) en koersdoelen.
    if (!(meta && meta.quant)) {
      await db.query(
        `INSERT INTO symbol_sync (symbol)
         SELECT symbol FROM fund_holdings WHERE cik = $1 AND period = $2 AND symbol IS NOT NULL AND put_call = ''
           AND symbol ~ '^[A-Z0-9.\\-]{1,12}$' ORDER BY value DESC LIMIT 25
         ON CONFLICT DO NOTHING`,
        [cik, latest.period]
      );
    }
  } else {
    await db.query("UPDATE funds SET last_error = 'geen 13F-filings gevonden', refreshed_at = now() WHERE cik = $1", [cik]);
  }
  await db.query('UPDATE funds SET quarters = (SELECT count(DISTINCT period) FROM fund_holdings WHERE cik = $1) WHERE cik = $1', [cik]);
  return latest;
}

function quarterEnd(year, quarter) {
  return ['03-31', '06-30', '09-30', '12-31'].map((s) => `${year}-${s}`)[quarter - 1];
}

// S&P 500 (SPY) ver terug, voor de vergelijking in "Waarde door de tijd" op guru-pagina's (13F gaat tot 10 jaar terug).
const SPY_LONG_START = '2014-01-01';
async function ensureLongSpy() {
  const r = await db.one("SELECT min(date)::text AS d FROM prices WHERE symbol = 'SPY'");
  if (r && r.d && r.d <= '2014-01-31') return 0;
  const to = r && r.d ? new Date(new Date(r.d).getTime() - 864e5).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const data = await fmp.historyNoCache('SPY', SPY_LONG_START, to);
  const points = data.map((d) => ({ symbol: 'SPY', date: d.date, close: Number(d.price ?? d.close) })).filter((p) => p.date && p.close > 0);
  return points.length ? store.savePrices(points) : 0;
}

async function refreshFunds() {
  return job('funds', async () => {
    try { await ensureLongSpy(); } catch (e) { /* vergelijking met de S&P 500 is optioneel */ }
    await store.syncFundList(funds);
    let ok = 0;
    const failed = [];
    for (const f of funds) {
      try {
        await refreshFund(f.cik);
        ok++;
      } catch (err) {
        failed.push(`${f.name}: ${err.message}`);
      }
    }
    return { ok, failed };
  });
}

// Bij het bekijken van een aandeel: haal de historie voor dat symbool binnen.
async function backfillSymbol(symbol) {
  const [pt, gr, ins] = await Promise.allSettled([fmp.priceTargetNews(symbol, 100), fmp.gradesNews(symbol, 100), fmp.insiderBySymbol(symbol, 100)]);
  if (pt.status === 'fulfilled') await store.savePriceTargets(pt.value);
  if (gr.status === 'fulfilled') await store.saveGrades(gr.value);
  if (ins.status === 'fulfilled') await store.saveInsiders(ins.value);
}

// Insidertrades van één aandeel tot 2 jaar terug ophalen (zoekveld op /insiders). Hooguit eens per 12 uur per aandeel.
const insiderBackfilled = new Map();
async function backfillInsiders(symbol, { years = 2, maxPages = 10 } = {}) {
  const sym = String(symbol || '').toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) return 0;
  const last = insiderBackfilled.get(sym);
  if (last && Date.now() - last < 12 * 3600e3) return 0;
  insiderBackfilled.set(sym, Date.now());
  const cutoff = new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10);
  let saved = 0;
  for (let page = 0; page < maxPages; page++) {
    const rows = await fmp.insiderSearch(sym, page, 100);
    if (!rows.length) break;
    saved += await store.saveInsiders(rows);
    const oldest = rows.reduce((m, r) => (r.transactionDate && r.transactionDate < m ? r.transactionDate : m), '9999');
    if (oldest < cutoff || rows.length < 100) break;
  }
  return saved;
}

async function refreshScores(opts) {
  // Lazy require om een circulaire import te voorkomen.
  const scores = require('./scores');
  return job('scores', () => scores.runPipeline(opts));
}

async function refreshRadar(opts) {
  const radar = require('./radar');
  return job('radar', () => radar.runRadar(opts));
}

async function refreshEarnings() {
  const earnings = require('./earnings');
  return job('earnings', () => earnings.runEarnings());
}

async function refreshTranscripts() {
  const transcripts = require('./transcripts');
  await job('transcripts', () => transcripts.runTranscripts());
  return job('translations', () => require('./translate').runTranslations());
}

async function refreshBlog() {
  return job('blog', () => require('./blog').refreshBlog());
}

async function refreshSiteTexts() {
  return job('sitetexts', () => require('./siteTexts').refreshSiteTexts());
}

async function refreshIndexes() {
  const indexes = require('./indexes');
  return job('indexes', () => indexes.refreshIndexes());
}

async function refreshAlerts() {
  const alerts = require('./alerts');
  return job('alerts', () => alerts.runAlerts());
}

async function briefings() {
  const alerts = require('./alerts');
  return job('briefing', async () => ({ weekly: await alerts.sendWeekly() }));
}

function startScheduler() {
  const min = 60 * 1000;
  const runFeeds = async () => {
    await ingestAnalysts();
    await ingestInsiders();
    await refreshAlerts();
  };
  // Eerste run kort na het opstarten, daarna periodiek.
  setTimeout(async () => {
    await store.syncFundList(funds).catch((e) => console.error('[ingest] fondsen', e.message));
    await runFeeds();
    await refreshIndexes();
    await refreshQuotes();
    await refreshFunds();
    await refreshScores();
    await refreshRadar();
    await refreshEarnings();
    await refreshTranscripts();
  }, 5000);
  setInterval(refreshTranscripts, 3 * 60 * min);
  setInterval(refreshEarnings, 3 * 60 * min);
  setInterval(refreshIndexes, 24 * 60 * min);
  setTimeout(refreshSiteTexts, 20 * 1000);
  setTimeout(refreshBlog, 35 * 1000);
  setInterval(refreshBlog, 3 * 60 * min);
  setInterval(refreshSiteTexts, 24 * 60 * min);
  setInterval(refreshRadar, 60 * min);
  // Weekoverzicht: elke 5 minuten kijken of het zaterdagochtend (Amsterdam) is.
  setInterval(briefings, 5 * min);
  setInterval(refreshScores, 30 * min);
  setInterval(runFeeds, 15 * min);
  setInterval(refreshQuotes, 30 * min);
  setInterval(refreshFunds, 12 * 60 * min);
}

module.exports = { refreshBlog, refreshSiteTexts, refreshTranscripts, refreshIndexes, refreshEarnings, refreshScores, refreshRadar, refreshAlerts, briefings, ingestAnalysts, ingestInsiders, refreshQuotes, refreshFunds, refreshFund, backfillSymbol, backfillInsiders, startScheduler };

if (require.main === module) {
  (async () => {
    const { migrate } = require('./migrate');
    await migrate();
    await store.syncFundList(funds);
    await ingestAnalysts();
    await ingestInsiders();
    await refreshQuotes();
    await refreshFunds();
    await refreshScores();
    await db.pool.end();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
