'use strict';

// Achtergrondtaken voor de GuruScore:
// 1. koersdoel-historie per aandeel aanvullen (tot ~3 jaar terug)
// 2. dagkoersen per aandeel bijhouden (plus benchmark SPY)
// 3. elk koersdoel beoordelen (call_results)
// 4. GuruScores per analist en per bank berekenen (guru_scores)
const db = require('./db');
const fmp = require('./lib/fmp');
const store = require('./lib/store');
const { evaluateCall, computeScores } = require('./lib/scoring');

const BENCH = 'SPY';
const HISTORY_START = '2022-01-01';
const BACKFILL_YEARS = 3;
const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/;

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

// Voer taken uit met beperkte gelijktijdigheid.
async function pool(items, limit, fn) {
  let i = 0;
  const errors = [];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (err) {
        errors.push(`${item}: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

async function registerSymbols() {
  await db.query(`INSERT INTO symbol_sync (symbol)
    SELECT DISTINCT symbol FROM price_targets
    UNION SELECT $1
    ON CONFLICT DO NOTHING`, [BENCH]);
}

// 1. Koersdoel-historie per aandeel aanvullen.
async function backfillTargets(maxSymbols = 150) {
  const rows = await db.many(
    `SELECT symbol FROM symbol_sync WHERE targets_backfilled_at IS NULL AND symbol <> $1 ORDER BY symbol LIMIT $2`,
    [BENCH, maxSymbols]
  );
  const cutoff = new Date(Date.now() - BACKFILL_YEARS * 365 * 864e5);
  let added = 0;
  const errors = await pool(rows.map((r) => r.symbol), 4, async (symbol) => {
    if (!SYMBOL_RE.test(symbol)) {
      await db.query('UPDATE symbol_sync SET targets_backfilled_at = now() WHERE symbol = $1', [symbol]);
      return;
    }
    let oldest = null;
    for (let page = 0; page < 25; page++) {
      const items = await fmp.priceTargetPageNoCache(symbol, page);
      if (!items.length) break;
      added += await store.savePriceTargets(items);
      const dates = items.map((x) => new Date(x.publishedDate)).filter((d) => !Number.isNaN(d.getTime()));
      if (dates.length) oldest = new Date(Math.min(...dates));
      if (items.length < 100 || (oldest && oldest < cutoff)) break;
    }
    await db.query(
      'UPDATE symbol_sync SET targets_backfilled_at = now(), targets_oldest = $2, results_dirty = true WHERE symbol = $1',
      [symbol, oldest]
    );
  });
  return { symbols: rows.length, added, errors: errors.slice(0, 5) };
}

// 2. Dagkoersen bijhouden.
async function syncPrices(maxSymbols = 400) {
  const rows = await db.many(
    `SELECT symbol, prices_through FROM symbol_sync
     WHERE prices_synced_at IS NULL OR prices_synced_at < now() - interval '20 hours'
     ORDER BY (symbol = $1) DESC, prices_synced_at NULLS FIRST LIMIT $2`,
    [BENCH, maxSymbols]
  );
  let saved = 0;
  const today = isoDay(Date.now());
  const errors = await pool(rows, 4, async ({ symbol, prices_through: through }) => {
    if (!SYMBOL_RE.test(symbol)) {
      await db.query('UPDATE symbol_sync SET prices_synced_at = now() WHERE symbol = $1', [symbol]);
      return;
    }
    const from = through ? isoDay(new Date(through).getTime() + 864e5) : HISTORY_START;
    let data = [];
    if (from <= today) data = await fmp.historyNoCache(symbol, from, today);
    const points = data
      .map((d) => ({ symbol, date: d.date, close: Number(d.price ?? d.close) }))
      .filter((p) => p.date && p.close > 0);
    if (points.length) saved += await store.savePrices(points);
    const last = points.reduce((m, p) => (p.date > m ? p.date : m), through ? isoDay(through) : '');
    await db.query(
      `UPDATE symbol_sync SET prices_synced_at = now(), prices_through = $2,
         results_dirty = results_dirty OR $3 WHERE symbol = $1`,
      [symbol, last || null, points.length > 0]
    );
  });
  return { symbols: rows.length, saved, errors: errors.slice(0, 5) };
}

async function loadSeries(symbol) {
  const rows = await db.many('SELECT date::text AS date, close::float8 AS close FROM prices WHERE symbol = $1 ORDER BY date', [symbol]);
  return rows;
}

// 3. Koersdoelen beoordelen voor aandelen met nieuwe koersen of nieuwe doelen.
async function computeResults(maxSymbols = 600) {
  const bench = await loadSeries(BENCH);
  const rows = await db.many(
    `SELECT symbol FROM symbol_sync WHERE results_dirty AND symbol <> $1 AND prices_through IS NOT NULL LIMIT $2`,
    [BENCH, maxSymbols]
  );
  let evaluated = 0;
  const now = new Date();
  for (const { symbol } of rows) {
    const series = await loadSeries(symbol);
    const calls = await db.many(
      `SELECT pt.id, pt.analyst_id, pt.analyst_firm, pt.symbol, pt.published_at, pt.price_target, pt.price_when_posted
       FROM price_targets pt LEFT JOIN call_results cr ON cr.price_target_id = pt.id
       WHERE pt.symbol = $1 AND (cr.price_target_id IS NULL OR NOT cr.complete)
         AND pt.published_at < now() - interval '30 days'`,
      [symbol]
    );
    const results = [];
    for (const c of calls) {
      const r = evaluateCall(c, series, bench, now);
      if (r) results.push({ price_target_id: c.id, analyst_id: c.analyst_id, analyst_firm: c.analyst_firm, symbol, published_at: c.published_at, ...r });
    }
    if (results.length) evaluated += await store.saveCallResults(results);
    await db.query('UPDATE symbol_sync SET results_dirty = false WHERE symbol = $1', [symbol]);
  }
  return { symbols: rows.length, evaluated };
}

// 4. GuruScores berekenen.
async function computeGuruScores() {
  const rows = await db.many(
    `SELECT analyst_id, analyst_firm, published_at, hit, ret::float8 AS ret, excess::float8 AS excess
     FROM call_results WHERE published_at > now() - interval '5 years'`
  );
  const byAnalyst = new Map();
  const byFirm = new Map();
  for (const r of rows) {
    if (r.analyst_id) {
      const k = String(r.analyst_id);
      if (!byAnalyst.has(k)) byAnalyst.set(k, []);
      byAnalyst.get(k).push(r);
    }
    if (r.analyst_firm) {
      const k = r.analyst_firm;
      if (!byFirm.has(k)) byFirm.set(k, []);
      byFirm.get(k).push(r);
    }
  }
  const analysts = computeScores(byAnalyst);
  const firms = computeScores(byFirm);
  await store.replaceGuruScores('analyst', analysts);
  await store.replaceGuruScores('firm', firms);
  return { calls: rows.length, analysts: analysts.length, firms: firms.length };
}

async function runPipeline({ backfill = 150, prices = 400, results = 600 } = {}) {
  await registerSymbols();
  const b = await backfillTargets(backfill);
  await registerSymbols();
  const p = await syncPrices(prices);
  const r = await computeResults(results);
  const s = await computeGuruScores();
  return { backfill: b, prices: p, results: r, scores: s };
}

module.exports = { runPipeline, backfillTargets, syncPrices, computeResults, computeGuruScores, registerSymbols, BENCH };
