'use strict';

// Databasequeries voor de radar en screeners.
const db = require('../db');
const { capRange } = require('./radar');

const TARGET = 'coalesce(adj_price_target, price_target)';
const WHO = 'coalesce(analyst_id::text, lower(analyst_firm))';

// Filters op sector en beurswaarde. Voegt parameters toe aan `params` en geeft SQL terug.
function companyFilter({ sector, cap } = {}, params, alias = 'c') {
  const parts = [];
  if (sector) {
    params.push(sector);
    parts.push(`${alias}.sector = $${params.length}`);
  }
  const range = capRange(cap);
  if (range) {
    params.push(range.min);
    parts.push(`${alias}.market_cap >= $${params.length}`);
    if (Number.isFinite(range.max)) {
      params.push(range.max);
      parts.push(`${alias}.market_cap < $${params.length}`);
    }
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

async function sectors() {
  return db.many(
    `SELECT sector, count(*)::int AS n FROM companies WHERE sector IS NOT NULL AND sector <> '' AND NOT is_etf
     GROUP BY sector ORDER BY n DESC`
  );
}

// Smart Money Radar: wie krijgt er de laatste N dagen favoriet bij analisten?
// Zware query (~1 s): draait in de achtergrond (refreshMomentum), pagina's lezen de vooraf berekende uitkomst.
async function momentumLive({ days = 30, sector, cap } = {}) {
  const params = [days];
  const filter = companyFilter({ sector, cap }, params);
  return db.many(
    `WITH rev AS (
       SELECT symbol, published_at, ${TARGET} AS t,
              lag(${TARGET}) OVER (PARTITION BY symbol, ${WHO} ORDER BY published_at) AS prev
       FROM price_targets
       WHERE published_at > now() - interval '450 days' AND ${TARGET} > 0
     ),
     r AS (
       SELECT symbol,
              count(*) FILTER (WHERE t > prev * 1.001)::int AS raises,
              count(*) FILTER (WHERE t < prev * 0.999)::int AS cuts,
              count(*) FILTER (WHERE prev IS NULL)::int AS fresh,
              avg(CASE WHEN prev > 0 THEN t / prev - 1 END)::float8 AS avg_change
       FROM rev WHERE published_at > now() - make_interval(days => $1) GROUP BY symbol
     ),
     h AS (
       SELECT symbol,
              count(*) FILTER (WHERE t > prev * 1.001)::int AS h_up,
              count(*) FILTER (WHERE t < prev * 0.999)::int AS h_down
       FROM rev WHERE published_at > now() - interval '7 days' GROUP BY symbol
     ),
     g AS (
       SELECT symbol,
              count(*) FILTER (WHERE action = 'upgrade')::int AS ups,
              count(*) FILTER (WHERE action = 'downgrade')::int AS downs
       FROM grades WHERE published_at > now() - make_interval(days => $1) GROUP BY symbol
     ),
     e AS (
       SELECT DISTINCT ON (cur.symbol) cur.symbol, (cur.eps_avg / old.eps_avg - 1)::float8 AS eps_rev
       FROM estimate_snapshots cur
       JOIN estimate_snapshots old ON old.symbol = cur.symbol AND old.fiscal_date = cur.fiscal_date
       WHERE cur.snap_date = (SELECT max(snap_date) FROM estimate_snapshots x WHERE x.symbol = cur.symbol)
         AND old.snap_date <= cur.snap_date - $1 AND old.eps_avg > 0 AND cur.eps_avg IS NOT NULL
         AND cur.fiscal_date > current_date
       ORDER BY cur.symbol, cur.fiscal_date, old.snap_date DESC
     ),
     s AS (SELECT symbol FROM r UNION SELECT symbol FROM g)
     SELECT s.symbol, c.name, c.sector, c.market_cap::float8 AS market_cap, c.image,
            coalesce(r.raises, 0) AS raises, coalesce(r.cuts, 0) AS cuts, coalesce(r.fresh, 0) AS fresh, r.avg_change,
            coalesce(g.ups, 0) AS ups, coalesce(g.downs, 0) AS downs,
            coalesce(h.h_up, 0) AS h_up, coalesce(h.h_down, 0) AS h_down,
            e.eps_rev, q.price::float8 AS price, q.change_pct::float8 AS change_pct
     FROM s
     LEFT JOIN r ON r.symbol = s.symbol
     LEFT JOIN g ON g.symbol = s.symbol
     LEFT JOIN h ON h.symbol = s.symbol
     LEFT JOIN e ON e.symbol = s.symbol
     LEFT JOIN companies c ON c.symbol = s.symbol
     LEFT JOIN quotes q ON q.symbol = s.symbol
     WHERE coalesce(c.is_etf, false) = false ${filter}`,
    params
  );
}

// Gemiddeld koersdoel per aandeel op een moment: het laatste doel van elke analist in de 12 maanden ervoor.
const consensusAt = (dateExpr) => `
  SELECT symbol, avg(t)::float8 AS target, min(t)::float8 AS low, max(t)::float8 AS high, count(*)::int AS n
  FROM (
    SELECT DISTINCT ON (symbol, ${WHO}) symbol, ${TARGET} AS t
    FROM price_targets
    WHERE published_at <= ${dateExpr} AND published_at > ${dateExpr} - interval '365 days' AND ${TARGET} > 0
    ORDER BY symbol, ${WHO}, published_at DESC
  ) x GROUP BY symbol`;

// Consensus surprise: koersverandering versus verandering van het gemiddelde koersdoel.
async function consensusShift({ days = 90, sector, cap, minAnalysts = 4 } = {}) {
  const params = [days, minAnalysts];
  const filter = companyFilter({ sector, cap }, params);
  return db.many(
    `WITH now_c AS (${consensusAt('now()')}),
          then_c AS (${consensusAt('(now() - make_interval(days => $1))')})
     SELECT n.symbol, c.name, c.sector, c.market_cap::float8 AS market_cap, c.image,
            n.target AS target_now, t.target AS target_then, n.n AS analysts,
            p1.close::float8 AS price_now, p0.close::float8 AS price_then,
            (n.target / t.target - 1)::float8 AS target_chg,
            (p1.close / p0.close - 1)::float8 AS price_chg
     FROM now_c n
     JOIN then_c t ON t.symbol = n.symbol
     LEFT JOIN companies c ON c.symbol = n.symbol
     CROSS JOIN LATERAL (SELECT close FROM prices WHERE symbol = n.symbol ORDER BY date DESC LIMIT 1) p1
     CROSS JOIN LATERAL (SELECT close FROM prices WHERE symbol = n.symbol AND date <= current_date - $1 ORDER BY date DESC LIMIT 1) p0
     WHERE n.n >= $2 AND t.n >= $2 AND p0.close > 0 AND coalesce(c.is_etf, false) = false ${filter}`,
    params
  );
}

// Koersdoelpotentieel: gewone en slimme consensus versus de actuele koers.
async function upside({ sector, cap, minAnalysts = 5, minScore = 70 } = {}) {
  const params = [minAnalysts, minScore];
  const filter = companyFilter({ sector, cap }, params);
  return db.many(
    `WITH latest AS (
       SELECT DISTINCT ON (symbol, ${WHO}) symbol, analyst_id, ${TARGET} AS t
       FROM price_targets
       WHERE published_at > now() - interval '365 days' AND ${TARGET} > 0
       ORDER BY symbol, ${WHO}, published_at DESC
     ),
     agg AS (
       SELECT l.symbol, avg(l.t)::float8 AS target, min(l.t)::float8 AS low, max(l.t)::float8 AS high, count(*)::int AS n,
              avg(l.t) FILTER (WHERE gs.score >= $2)::float8 AS smart, count(gs.score) FILTER (WHERE gs.score >= $2)::int AS smart_n
       FROM latest l
       LEFT JOIN guru_scores gs ON gs.kind = 'analyst' AND gs.ref = l.analyst_id::text
       GROUP BY l.symbol
     )
     SELECT a.*, c.name, c.sector, c.market_cap::float8 AS market_cap, c.image,
            q.price::float8 AS price, (a.target / q.price - 1)::float8 AS upside,
            CASE WHEN a.smart IS NOT NULL THEN (a.smart / q.price - 1)::float8 END AS smart_upside
     FROM agg a
     JOIN quotes q ON q.symbol = a.symbol AND q.price > 0
     LEFT JOIN companies c ON c.symbol = a.symbol
     WHERE a.n >= $1 AND coalesce(c.is_etf, false) = false ${filter}`,
    params
  );
}

// Adviesverdeling: laatste maand per aandeel (voor de contrair-lijsten).
async function ratingSnapshot({ sector, cap, minTotal = 8 } = {}) {
  const params = [minTotal];
  const filter = companyFilter({ sector, cap }, params);
  return db.many(
    `SELECT DISTINCT ON (r.symbol) r.symbol, r.date::text AS date, r.strong_buy, r.buy, r.hold, r.sell, r.strong_sell,
            (r.strong_buy + r.buy + r.hold + r.sell + r.strong_sell) AS total,
            c.name, c.sector, c.market_cap::float8 AS market_cap, c.image, q.price::float8 AS price
     FROM rating_history r
     LEFT JOIN companies c ON c.symbol = r.symbol
     LEFT JOIN quotes q ON q.symbol = r.symbol
     WHERE r.date > current_date - 120 AND (r.strong_buy + r.buy + r.hold + r.sell + r.strong_sell) >= $1
       AND coalesce(c.is_etf, false) = false ${filter}
     ORDER BY r.symbol, r.date DESC`,
    params
  );
}

async function ratingHistory(symbol) {
  return db.many(
    `SELECT date::text AS date, strong_buy, buy, hold, sell, strong_sell FROM rating_history
     WHERE symbol = $1 AND date > current_date - 3 * 365 ORDER BY date`,
    [symbol]
  );
}

async function cached(key) {
  return db.one('SELECT data, updated_at FROM kv_cache WHERE key = $1', [key]);
}

// Advies-gezondheid van gevolgde aandelen.
async function watchHealth(symbols) {
  if (!symbols.length) return [];
  return db.many(
    `WITH latest AS (
       SELECT DISTINCT ON (symbol, ${WHO}) symbol, analyst_id, ${TARGET} AS t, published_at
       FROM price_targets
       WHERE symbol = ANY($1) AND published_at > now() - interval '365 days' AND ${TARGET} > 0
       ORDER BY symbol, ${WHO}, published_at DESC
     ),
     agg AS (
       SELECT l.symbol, avg(l.t)::float8 AS target, count(*)::int AS n, max(l.published_at) AS last_at,
              avg(l.t) FILTER (WHERE gs.score >= 70)::float8 AS smart, count(gs.score) FILTER (WHERE gs.score >= 70)::int AS smart_n
       FROM latest l LEFT JOIN guru_scores gs ON gs.kind = 'analyst' AND gs.ref = l.analyst_id::text
       GROUP BY l.symbol
     ),
     rh AS (
       SELECT DISTINCT ON (symbol) symbol, strong_buy, buy, hold, sell, strong_sell
       FROM rating_history WHERE symbol = ANY($1) ORDER BY symbol, date DESC
     )
     SELECT s.symbol, c.name, c.sector, q.price::float8 AS price, q.change_pct::float8 AS change_pct,
            a.target, a.n, a.smart, a.smart_n, a.last_at,
            rh.strong_buy, rh.buy, rh.hold, rh.sell, rh.strong_sell
     FROM unnest($1::text[]) AS s(symbol)
     LEFT JOIN companies c ON c.symbol = s.symbol
     LEFT JOIN quotes q ON q.symbol = s.symbol
     LEFT JOIN agg a ON a.symbol = s.symbol
     LEFT JOIN rh ON rh.symbol = s.symbol`,
    [symbols]
  );
}

// ---------- Vooraf berekende radar ----------
// De radar wordt elke 15 minuten vooraf berekend voor 7, 30 en 90 dagen (zonder filters) en bewaard
// in het geheugen en in kv_cache (overleeft een herstart). Filters op sector en beurswaarde passen we
// daarna in JavaScript toe; dat geeft precies dezelfde uitkomst als de SQL-filters.
const MOMENTUM_DAYS = [7, 30, 90];
const MOMENTUM_MAX_AGE = 2 * 3600e3; // ouder dan 2 uur (achtergrondtaak hangt): opnieuw live berekenen
const momentumMem = new Map(); // days -> { rows, at }
const momentumInflight = new Map();

function filterMomentum(rows, { sector, cap } = {}) {
  const range = capRange(cap);
  if (!sector && !range) return rows;
  return rows.filter((r) => {
    if (sector && r.sector !== sector) return false;
    if (range) {
      const mc = r.market_cap === null || r.market_cap === undefined ? NaN : Number(r.market_cap);
      if (!Number.isFinite(mc) || mc < range.min) return false;
      if (Number.isFinite(range.max) && mc >= range.max) return false;
    }
    return true;
  });
}

async function storeMomentum(days, rows) {
  momentumMem.set(days, { rows, at: Date.now() });
  await db.query(
    `INSERT INTO kv_cache (key, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [`momentum_${days}`, JSON.stringify(rows)]
  );
}

// Achtergrondtaak: alle varianten opnieuw berekenen.
async function refreshMomentum() {
  const out = {};
  for (const days of MOMENTUM_DAYS) {
    const rows = await momentumLive({ days });
    await storeMomentum(days, rows);
    out[`d${days}`] = rows.length;
  }
  return out;
}

async function precomputed(days) {
  const mem = momentumMem.get(days);
  if (mem && Date.now() - mem.at < MOMENTUM_MAX_AGE) return mem.rows;
  if (momentumInflight.has(days)) return momentumInflight.get(days);
  const p = (async () => {
    // Na een herstart: uit kv_cache, anders eenmalig live berekenen.
    const row = await db.one('SELECT data, updated_at FROM kv_cache WHERE key = $1', [`momentum_${days}`]).catch(() => null);
    if (row && Array.isArray(row.data) && Date.now() - new Date(row.updated_at).getTime() < MOMENTUM_MAX_AGE) {
      momentumMem.set(days, { rows: row.data, at: new Date(row.updated_at).getTime() });
      return row.data;
    }
    const rows = await momentumLive({ days });
    await storeMomentum(days, rows).catch(() => {});
    return rows;
  })();
  momentumInflight.set(days, p);
  try {
    return await p;
  } finally {
    momentumInflight.delete(days);
  }
}

async function momentum({ days = 30, sector, cap } = {}) {
  if (!MOMENTUM_DAYS.includes(days)) return momentumLive({ days, sector, cap });
  return filterMomentum(await precomputed(days), { sector, cap });
}

module.exports = { watchHealth, sectors, momentum, momentumLive, refreshMomentum, filterMomentum, consensusShift, upside, ratingSnapshot, ratingHistory, cached };
