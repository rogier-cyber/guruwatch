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
      UNION SELECT DISTINCT symbol FROM insider_trades WHERE filing_date > now() - interval '30 days'`);
    const symbols = rows.map((r) => r.symbol).filter((s) => /^[A-Z0-9.\-]{1,12}$/.test(s));
    let saved = 0;
    for (let i = 0; i < symbols.length; i += 200) {
      const quotes = await fmp.batchQuoteShort(symbols.slice(i, i + 200));
      saved += await store.saveQuotes(quotes);
    }
    return { symbols: symbols.length, saved };
  });
}

async function refreshFund(cik) {
  const dates = await fmp.institutionalDates(cik);
  const sorted = dates
    .filter((d) => d && d.year && d.quarter)
    .sort((a, b) => b.year - a.year || b.quarter - a.quarter)
    .slice(0, 2);
  let latest = null;
  for (const d of sorted) {
    const period = d.date || quarterEnd(d.year, d.quarter);
    const have = await db.one('SELECT count(*)::int AS n FROM fund_holdings WHERE cik = $1 AND period = $2', [cik, period]);
    let res;
    if (!have.n || d === sorted[0]) {
      const rows = await fmp.institutionalExtract(cik, d.year, d.quarter);
      res = await store.saveFundQuarter(cik, period, rows);
    }
    if (d === sorted[0]) latest = { period, ...(res || {}) };
  }
  if (latest) {
    await db.query(
      'UPDATE funds SET latest_period = $2, latest_value = $3, latest_positions = $4, refreshed_at = now() WHERE cik = $1',
      [cik, latest.period, latest.total ?? null, latest.positions ?? null]
    );
  }
  return latest;
}

function quarterEnd(year, quarter) {
  return ['03-31', '06-30', '09-30', '12-31'].map((s) => `${year}-${s}`)[quarter - 1];
}

async function refreshFunds() {
  return job('funds', async () => {
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

function startScheduler() {
  const min = 60 * 1000;
  const runFeeds = async () => {
    await ingestAnalysts();
    await ingestInsiders();
  };
  // Eerste run kort na het opstarten, daarna periodiek.
  setTimeout(async () => {
    await store.syncFundList(funds).catch((e) => console.error('[ingest] fondsen', e.message));
    await runFeeds();
    await refreshQuotes();
    await refreshFunds();
  }, 5000);
  setInterval(runFeeds, 15 * min);
  setInterval(refreshQuotes, 30 * min);
  setInterval(refreshFunds, 12 * 60 * min);
}

module.exports = { ingestAnalysts, ingestInsiders, refreshQuotes, refreshFunds, refreshFund, backfillSymbol, startScheduler };

if (require.main === module) {
  (async () => {
    const { migrate } = require('./migrate');
    await migrate();
    await store.syncFundList(funds);
    await ingestAnalysts();
    await ingestInsiders();
    await refreshQuotes();
    await refreshFunds();
    await db.pool.end();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
