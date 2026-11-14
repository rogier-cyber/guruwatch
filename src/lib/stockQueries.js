'use strict';

// Queries voor de aandeelpagina en de pagina Aandelen (per index).
const db = require('../db');
const { TtlCache } = require('./cache');
const { benchmarks } = require('./analystView');

const cache = new TtlCache(50);
const HOUR = 3600 * 1000;

// Laatste koersdoel per analist (12 maanden), gemiddeld per aandeel.
const LATEST_TARGETS = `
  SELECT DISTINCT ON (pt.symbol, coalesce(pt.analyst_id::text, pt.analyst_firm))
         pt.symbol, pt.price_target
  FROM price_targets pt
  WHERE pt.published_at > now() - interval '365 days' AND pt.price_target > 0 AND %FILTER%
  ORDER BY pt.symbol, coalesce(pt.analyst_id::text, pt.analyst_firm), pt.published_at DESC`;

async function indexTable(indexKey) {
  return db.many(
    `WITH m AS (SELECT symbol, name, sector FROM index_members WHERE index_key = $1),
     t AS (${LATEST_TARGETS.replace('%FILTER%', 'pt.symbol IN (SELECT symbol FROM m)')}),
     ta AS (SELECT symbol, avg(price_target)::float8 AS target, count(*)::int AS targets FROM t GROUP BY symbol),
     r AS (SELECT DISTINCT ON (rh.symbol) rh.symbol, rh.strong_buy, rh.buy, rh.hold, rh.sell, rh.strong_sell
           FROM rating_history rh WHERE rh.symbol IN (SELECT symbol FROM m) AND rh.date > now() - interval '150 days'
           ORDER BY rh.symbol, rh.date DESC)
     SELECT m.symbol, coalesce(c.name, m.name) AS name, coalesce(c.sector, m.sector) AS sector,
            q.price::float8 AS price, q.change_pct::float8 AS change_pct, ta.target, ta.targets,
            r.strong_buy, r.buy, r.hold, r.sell, r.strong_sell
     FROM m LEFT JOIN quotes q USING (symbol) LEFT JOIN ta USING (symbol) LEFT JOIN r USING (symbol)
     LEFT JOIN companies c USING (symbol)`,
    [indexKey]
  );
}

// Analistenacties van de laatste dagen op aandelen uit een index.
async function indexActions(indexKey, days = 3) {
  const [grades, targets] = await Promise.all([
    db.many(
      `SELECT g.symbol, g.published_at, g.grading_company, g.previous_grade, g.new_grade, g.action
       FROM grades g WHERE g.symbol IN (SELECT symbol FROM index_members WHERE index_key = $1)
         AND g.published_at > now() - make_interval(days => $2::int)
       ORDER BY g.published_at DESC LIMIT 300`,
      [indexKey, days]
    ),
    db.many(
      `SELECT * FROM (
         SELECT pt.symbol, pt.published_at, pt.price_target, pt.analyst_name, pt.analyst_firm, a.slug AS analyst_slug, gs.score,
                lag(pt.price_target) OVER (PARTITION BY pt.symbol, coalesce(pt.analyst_id::text, pt.analyst_firm) ORDER BY pt.published_at) AS prev_target
         FROM price_targets pt LEFT JOIN analysts a ON a.id = pt.analyst_id
         LEFT JOIN guru_scores gs ON gs.kind = 'analyst' AND gs.ref = pt.analyst_id::text
         WHERE pt.symbol IN (SELECT symbol FROM index_members WHERE index_key = $1)
           AND pt.published_at > now() - interval '400 days'
       ) x WHERE published_at > now() - make_interval(days => $2::int) ORDER BY published_at DESC LIMIT 300`,
      [indexKey, days]
    ),
  ]);
  return { grades, targets };
}

async function indexCounts() {
  const rows = await db.many('SELECT index_key, count(*)::int AS n FROM index_members GROUP BY index_key');
  return Object.fromEntries(rows.map((r) => [r.index_key, r.n]));
}

// Oordeel en potentieel per aandeel, voor de vergelijking met sector en markt (1 uur gecachet).
async function benchmarkData() {
  return cache.wrap('benchmarks', HOUR, async () => {
    const rows = await db.many(
      `WITH r AS (SELECT DISTINCT ON (symbol) symbol, strong_buy, buy, hold, sell, strong_sell
                  FROM rating_history WHERE date > now() - interval '150 days' ORDER BY symbol, date DESC),
       t AS (${LATEST_TARGETS.replace('%FILTER%', 'true')}),
       u AS (SELECT t.symbol, avg(t.price_target) / max(q.price) - 1 AS upside, count(*)::int AS n
             FROM t JOIN quotes q USING (symbol) WHERE q.price > 0 GROUP BY t.symbol HAVING count(*) >= 3)
       SELECT r.*, c.sector, u.upside::float8 AS upside, u.n
       FROM r LEFT JOIN u USING (symbol) LEFT JOIN companies c USING (symbol)
       WHERE coalesce(c.is_etf, false) = false`
    );
    return benchmarks(rows);
  });
}

// Insidertransacties van de laatste N dagen, samengevat.
async function insiderSummary(symbol, days = 90) {
  const rows = await db.many(
    `SELECT reporting_name, type_of_owner, transaction_type, transaction_date, securities_transacted::float8 AS shares, price::float8 AS price
     FROM insider_trades
     WHERE symbol = $1 AND transaction_date > current_date - $2::int AND price > 0
       AND (transaction_type ILIKE 'P-%' OR transaction_type ILIKE 'S-%')
     ORDER BY transaction_date DESC`,
    [symbol, days]
  );
  const buys = rows.filter((r) => /^P-/i.test(r.transaction_type));
  const sells = rows.filter((r) => /^S-/i.test(r.transaction_type));
  const value = (a) => a.reduce((s, r) => s + r.shares * r.price, 0);
  const biggest = (a) => a.slice().sort((x, y) => y.shares * y.price - x.shares * x.price)[0] || null;
  return { days, buys: buys.length, sells: sells.length, buyValue: value(buys), sellValue: value(sells), topBuy: biggest(buys), topSell: biggest(sells) };
}

// Aandelen voor de sitemap: alles met recente koersdoelen of in een index.
async function sitemapSymbols(limit = 5000) {
  return db.many(
    `SELECT symbol, max(published_at) AS last FROM price_targets
     WHERE published_at > now() - interval '365 days' AND symbol ~ '^[A-Z0-9.\\-]{1,12}$'
     GROUP BY symbol ORDER BY count(*) DESC LIMIT $1`,
    [limit]
  );
}

module.exports = { indexActions, indexTable, indexCounts, benchmarkData, insiderSummary, sitemapSymbols };
