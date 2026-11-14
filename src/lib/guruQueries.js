'use strict';

// Queries voor de gurupagina's (13F-historie, sectoren, koersen, analistendoelen).
const db = require('../db');

// Alle longposities van een fonds over de laatste kwartalen (per kwartaal de grootste `perPeriod`).
async function fundHistory(cik, { periods = 12, perPeriod = 150 } = {}) {
  return db.many(
    `WITH p AS (SELECT DISTINCT period FROM fund_holdings WHERE cik = $1 ORDER BY period DESC LIMIT $2),
     h AS (SELECT h.*, row_number() OVER (PARTITION BY h.period ORDER BY h.value DESC) AS rn
           FROM fund_holdings h WHERE h.cik = $1 AND h.period IN (SELECT period FROM p) AND h.put_call = '')
     SELECT period::text AS period, cusip, symbol, issuer, put_call, shares::float8 AS shares, value::float8 AS value, weight::float8 AS weight
     FROM h WHERE rn <= $3 ORDER BY period, value DESC`,
    [cik, periods, perPeriod]
  );
}

// Totale waarde en aantal posities per kwartaal (alle posities, ook bij quant-fondsen).
async function fundTotals(cik) {
  return db.many(
    `SELECT period::text AS period, sum(value)::float8 AS value, count(*)::int AS positions
     FROM fund_holdings WHERE cik = $1 AND put_call = '' GROUP BY period ORDER BY period`,
    [cik]
  );
}

// Sector en naam per aandeel.
async function companiesFor(symbols) {
  if (!symbols.length) return [];
  return db.many('SELECT symbol, name, sector FROM companies WHERE symbol = ANY($1)', [symbols]);
}

// Dagkoersen voor een set aandelen (plus SPY als benchmark).
async function pricesFor(symbols, since) {
  if (!symbols.length) return [];
  return db.many(
    'SELECT symbol, date::text AS date, close::float8 AS close FROM prices WHERE symbol = ANY($1) AND date >= $2 ORDER BY symbol, date',
    [symbols, since]
  );
}

// Koers en gemiddeld koersdoel (laatste doel per analist, 12 maanden).
async function quotesAndTargets(symbols) {
  if (!symbols.length) return [];
  return db.many(
    `WITH t AS (SELECT DISTINCT ON (pt.symbol, coalesce(pt.analyst_id::text, pt.analyst_firm)) pt.symbol, pt.price_target
                FROM price_targets pt
                WHERE pt.symbol = ANY($1) AND pt.published_at > now() - interval '365 days' AND pt.price_target > 0
                ORDER BY pt.symbol, coalesce(pt.analyst_id::text, pt.analyst_firm), pt.published_at DESC),
     ta AS (SELECT symbol, avg(price_target)::float8 AS target, count(*)::int AS targets FROM t GROUP BY symbol)
     SELECT s.symbol, q.price::float8 AS price, q.change_pct::float8 AS change_pct, ta.target, ta.targets
     FROM unnest($1::text[]) AS s(symbol) LEFT JOIN quotes q USING (symbol) LEFT JOIN ta USING (symbol)`,
    [symbols]
  );
}

// Overzicht: per guru de waarde per kwartaal en de top 3 van het laatste kwartaal.
async function overview() {
  const [series, tops] = await Promise.all([
    db.many(
      `SELECT h.cik, h.period::text AS period, sum(h.value)::float8 AS value, count(*)::int AS positions
       FROM fund_holdings h JOIN funds f ON f.cik = h.cik AND f.featured
       WHERE h.put_call = '' AND h.period > now() - interval '3 years 2 months'
       GROUP BY h.cik, h.period ORDER BY h.cik, h.period`
    ),
    db.many(
      `SELECT * FROM (
         SELECT h.cik, h.symbol, h.issuer, h.weight::float8 AS weight,
                row_number() OVER (PARTITION BY h.cik ORDER BY h.value DESC) AS rn
         FROM fund_holdings h JOIN funds f ON f.cik = h.cik AND h.period = f.latest_period AND f.featured
         WHERE h.put_call = '') x WHERE rn <= 5`
    ),
  ]);
  return { series, tops };
}

// Wat kochten de guru's samen het laatste kwartaal? (nieuwe posities en bijkopen, aantal guru's)
async function consensusMoves(limit = 12) {
  return db.many(
    `WITH last2 AS (
       SELECT f.cik, f.latest_period AS cur,
              (SELECT max(period) FROM fund_holdings x WHERE x.cik = f.cik AND x.period < f.latest_period) AS prev
       FROM funds f WHERE f.featured AND NOT f.quant AND f.latest_period > now() - interval '9 months'),
     cur AS (SELECT l.cik, h.symbol, h.shares, h.weight FROM last2 l JOIN fund_holdings h ON h.cik = l.cik AND h.period = l.cur AND h.put_call = '' AND h.symbol IS NOT NULL),
     prev AS (SELECT l.cik, h.symbol, h.shares FROM last2 l JOIN fund_holdings h ON h.cik = l.cik AND h.period = l.prev AND h.put_call = '' AND h.symbol IS NOT NULL),
     mv AS (SELECT c.cik, c.symbol, c.weight, CASE WHEN p.symbol IS NULL THEN 'new' WHEN c.shares > p.shares * 1.05 THEN 'added' END AS kind
            FROM cur c LEFT JOIN prev p ON p.cik = c.cik AND p.symbol = c.symbol
            WHERE (SELECT prev FROM last2 WHERE last2.cik = c.cik) IS NOT NULL)
     SELECT mv.symbol, (SELECT name FROM companies co WHERE co.symbol = mv.symbol) AS name,
            count(*)::int AS gurus, count(*) FILTER (WHERE kind = 'new')::int AS new_positions,
            array_agg(f.manager ORDER BY mv.weight DESC) AS managers
     FROM mv JOIN funds f ON f.cik = mv.cik
     WHERE kind IS NOT NULL
     GROUP BY mv.symbol HAVING count(*) >= 2
     ORDER BY count(*) DESC, sum(mv.weight) DESC LIMIT $1`,
    [limit]
  );
}

module.exports = { fundTotals, fundHistory, companiesFor, pricesFor, quotesAndTargets, overview, consensusMoves };
