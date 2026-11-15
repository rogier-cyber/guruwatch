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
  WHERE pt.published_at > now() - interval '182 days' AND pt.price_target > 0 AND %FILTER%
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

// Vergelijkbare aandelen: eerst de echte concurrenten uit src/data/peers.json (beste eerst), dan aandelen uit
// dezelfde branche (FMP-industry, qua grootte het dichtst bij), dan dezelfde sector (grootste eerst).
// Alleen aandelen met analistenadviezen of koersdoelen.
let PEER_MAP = null;
function curatedPeers(symbol) {
  if (!PEER_MAP) {
    try { PEER_MAP = require('../data/peers.json'); } catch { PEER_MAP = {}; }
  }
  const l = PEER_MAP[symbol];
  return Array.isArray(l) ? l.filter((x) => x !== symbol) : [];
}

async function peers(symbol, sector, limit = 8, industry = null) {
  const curated = curatedPeers(symbol);
  if (!sector && !industry && !curated.length) return [];
  return db.many(
    `WITH me AS (SELECT market_cap FROM companies WHERE symbol = $2),
     cur AS (SELECT s AS symbol, o::int AS prio FROM unnest($4::text[]) WITH ORDINALITY u(s, o)),
     ind AS (SELECT symbol, 1000 + row_number() OVER (ORDER BY abs(ln(greatest(market_cap, 1)) - ln(greatest(coalesce((SELECT market_cap FROM me), market_cap), 1))))::int AS prio
             FROM companies WHERE $5::text IS NOT NULL AND industry = $5 AND NOT is_etf AND symbol <> $2 AND market_cap > 0),
     sec AS (SELECT symbol, 2000 + row_number() OVER (ORDER BY market_cap DESC NULLS LAST)::int AS prio FROM (
               SELECT DISTINCT ON (symbol) symbol, market_cap FROM (
                 SELECT symbol, market_cap FROM companies WHERE $1::text IS NOT NULL AND sector = $1 AND NOT is_etf
                 UNION ALL SELECT symbol, NULL FROM index_members WHERE $1::text IS NOT NULL AND sector = $1) x
               WHERE symbol <> $2 ORDER BY symbol, market_cap NULLS LAST) y),
     c0 AS (SELECT symbol, min(prio) AS prio FROM (SELECT * FROM cur UNION ALL SELECT * FROM ind UNION ALL SELECT * FROM sec) z
            GROUP BY symbol ORDER BY min(prio) LIMIT 60),
     t AS (${LATEST_TARGETS.replace('%FILTER%', 'pt.symbol IN (SELECT symbol FROM c0)')}),
     ta AS (SELECT symbol, avg(price_target)::float8 AS target, count(*)::int AS targets FROM t GROUP BY symbol),
     r AS (SELECT DISTINCT ON (rh.symbol) rh.symbol, rh.strong_buy, rh.buy, rh.hold, rh.sell, rh.strong_sell
           FROM rating_history rh WHERE rh.symbol IN (SELECT symbol FROM c0) AND rh.date > now() - interval '150 days'
           ORDER BY rh.symbol, rh.date DESC),
     nm AS (SELECT DISTINCT ON (symbol) symbol, name, market_cap FROM (
              SELECT symbol, name, market_cap FROM companies WHERE symbol IN (SELECT symbol FROM c0)
              UNION ALL SELECT symbol, name, NULL FROM index_members WHERE symbol IN (SELECT symbol FROM c0)) x
            ORDER BY symbol, market_cap NULLS LAST)
     SELECT c0.symbol, coalesce(nm.name, c0.symbol) AS name, nm.market_cap::float8 AS market_cap, q.price::float8 AS price, ta.target, ta.targets,
            r.strong_buy, r.buy, r.hold, r.sell, r.strong_sell, c0.prio < 1000 AS curated
     FROM c0 LEFT JOIN nm USING (symbol) LEFT JOIN r USING (symbol) LEFT JOIN ta USING (symbol) LEFT JOIN quotes q USING (symbol)
     WHERE (r.symbol IS NOT NULL OR ta.target IS NOT NULL)
     ORDER BY c0.prio LIMIT $3`,
    [sector || null, symbol, limit, curated, industry || null]
  );
}

// Indices waar een aandeel in zit (voor de broodkruimel).
async function indexesOf(symbol) {
  return (await db.many('SELECT index_key FROM index_members WHERE symbol = $1', [symbol])).map((r) => r.index_key);
}

// Winstverwachting per boekjaar uit de laatste eigen momentopname.
async function epsOutlook(symbol) {
  return db.many(
    `SELECT fiscal_date::text AS fiscal_date, eps_avg::float8 AS eps, revenue_avg::float8 AS revenue, analysts
     FROM estimate_snapshots
     WHERE symbol = $1 AND snap_date = (SELECT max(snap_date) FROM estimate_snapshots WHERE symbol = $1)
     ORDER BY fiscal_date`,
    [symbol]
  );
}

module.exports = { peers, indexesOf, epsOutlook, indexActions, indexTable, indexCounts, benchmarkData, insiderSummary, sitemapSymbols };
