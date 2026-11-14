'use strict';

// Leesqueries voor de pagina's.
const db = require('../db');

// Een koersdoel telt mee voor de score als het tussen 30 en 365 dagen oud is.
// Extreme uitschieters (vaak door splits) worden uitgesloten.
const SCORED = `
  SELECT pt.analyst_id, pt.symbol, pt.published_at,
         pt.price_target::float8 AS target, pt.price_when_posted::float8 AS p0, q.price::float8 AS p1,
         CASE WHEN pt.price_target >= pt.price_when_posted THEN 1 ELSE -1 END AS dir
  FROM price_targets pt
  JOIN quotes q ON q.symbol = pt.symbol
  WHERE pt.price_target > 0 AND pt.price_when_posted > 0 AND q.price > 0
    AND pt.published_at BETWEEN now() - interval '365 days' AND now() - interval '30 days'
    AND abs(q.price / pt.price_when_posted - 1) < 3
    AND abs(pt.price_target / pt.price_when_posted - 1) < 3`;

const SCORE_COLS = `
  count(*)::int AS scored,
  avg(dir * (p1 - p0) / p0) AS avg_return,
  avg(CASE WHEN dir * (p1 - p0) > 0 THEN 1 ELSE 0 END) AS success_rate,
  avg(CASE WHEN (dir = 1 AND p1 >= target) OR (dir = -1 AND p1 <= target) THEN 1 ELSE 0 END) AS hit_rate`;

async function analystLeaderboard({ minCalls = 5, limit = 50, firm } = {}) {
  const params = [minCalls, limit];
  let firmSql = '';
  if (firm) {
    params.push(firm.toLowerCase());
    firmSql = 'AND lower(a.firm) = $3';
  }
  return db.many(
    `WITH s AS (${SCORED} AND pt.analyst_id IS NOT NULL)
     SELECT a.id, a.slug, a.name, a.firm, ${SCORE_COLS},
            (SELECT count(*)::int FROM price_targets x WHERE x.analyst_id = a.id AND x.published_at > now() - interval '365 days') AS calls_year
     FROM s JOIN analysts a ON a.id = s.analyst_id
     WHERE true ${firmSql}
     GROUP BY a.id
     HAVING count(*) >= $1
     ORDER BY success_rate DESC, avg_return DESC
     LIMIT $2`,
    params
  );
}

async function analystBySlug(slug) {
  return db.one('SELECT * FROM analysts WHERE slug = $1', [slug]);
}

async function analystScore(id) {
  return db.one(`WITH s AS (${SCORED} AND pt.analyst_id = $1) SELECT ${SCORE_COLS} FROM s`, [id]);
}

async function analystTargets(id, limit = 200) {
  return db.many(
    `SELECT pt.*, q.price AS current_price
     FROM price_targets pt LEFT JOIN quotes q ON q.symbol = pt.symbol
     WHERE pt.analyst_id = $1 ORDER BY pt.published_at DESC LIMIT $2`,
    [id, limit]
  );
}

async function analystSearch(q, limit = 20) {
  return db.many(
    `SELECT a.slug, a.name, a.firm, count(pt.id)::int AS calls
     FROM analysts a LEFT JOIN price_targets pt ON pt.analyst_id = a.id
     WHERE a.name ILIKE $1 OR a.firm ILIKE $1
     GROUP BY a.id ORDER BY calls DESC LIMIT $2`,
    [`%${q}%`, limit]
  );
}

async function latestTargets(limit = 50, symbol) {
  if (symbol) {
    return db.many(
      `SELECT pt.*, a.slug AS analyst_slug FROM price_targets pt LEFT JOIN analysts a ON a.id = pt.analyst_id
       WHERE pt.symbol = $1 ORDER BY pt.published_at DESC LIMIT $2`,
      [symbol, limit]
    );
  }
  return db.many(
    `SELECT pt.*, a.slug AS analyst_slug FROM price_targets pt LEFT JOIN analysts a ON a.id = pt.analyst_id
     ORDER BY pt.published_at DESC LIMIT $1`,
    [limit]
  );
}

async function latestGrades({ limit = 50, symbol, action, firm } = {}) {
  const where = [];
  const params = [];
  if (symbol) {
    params.push(symbol);
    where.push(`symbol = $${params.length}`);
  }
  if (action) {
    params.push(action);
    where.push(`lower(action) = $${params.length}`);
  }
  if (firm) {
    params.push(firm.toLowerCase());
    where.push(`lower(grading_company) = $${params.length}`);
  }
  params.push(limit);
  return db.many(
    `SELECT * FROM grades ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY published_at DESC LIMIT $${params.length}`,
    params
  );
}

async function firmStats(limit = 40) {
  return db.many(
    `SELECT grading_company AS firm, count(*)::int AS n,
            count(*) FILTER (WHERE lower(action) = 'upgrade')::int AS upgrades,
            count(*) FILTER (WHERE lower(action) = 'downgrade')::int AS downgrades,
            max(published_at) AS last_at
     FROM grades WHERE grading_company IS NOT NULL AND published_at > now() - interval '90 days'
     GROUP BY grading_company ORDER BY n DESC LIMIT $1`,
    [limit]
  );
}

const INSIDER_TYPES = { buy: "transaction_type ILIKE 'P-%'", sell: "transaction_type ILIKE 'S-%'" };

async function latestInsiders({ limit = 100, type, symbol, cik, minValue } = {}) {
  const where = [];
  const params = [];
  if (INSIDER_TYPES[type]) where.push(INSIDER_TYPES[type]);
  if (symbol) {
    params.push(symbol);
    where.push(`symbol = $${params.length}`);
  }
  if (cik) {
    params.push(cik);
    where.push(`reporting_cik = $${params.length}`);
  }
  if (minValue) {
    params.push(minValue);
    where.push(`securities_transacted * price >= $${params.length}`);
  }
  params.push(limit);
  return db.many(
    `SELECT *, (securities_transacted * price) AS value FROM insider_trades
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY coalesce(filing_date, transaction_date::timestamptz) DESC, id DESC LIMIT $${params.length}`,
    params
  );
}

// Aandelen waar insiders de afgelopen N dagen het meest kochten (cluster buys).
async function insiderClusters(days = 30, limit = 20) {
  return db.many(
    `SELECT symbol, count(DISTINCT reporting_cik)::int AS insiders, count(*)::int AS trades,
            sum(securities_transacted * price) AS value, max(transaction_date) AS last_date
     FROM insider_trades
     WHERE transaction_type ILIKE 'P-%' AND transaction_date > current_date - $1::int AND price > 0
     GROUP BY symbol
     ORDER BY count(DISTINCT reporting_cik) DESC, sum(securities_transacted * price) DESC
     LIMIT $2`,
    [days, limit]
  );
}

async function insiderPerson(cik) {
  return db.one(
    `SELECT reporting_cik, reporting_name, array_agg(DISTINCT symbol) AS symbols, count(*)::int AS trades
     FROM insider_trades WHERE reporting_cik = $1 GROUP BY reporting_cik, reporting_name ORDER BY count(*) DESC LIMIT 1`,
    [cik]
  );
}

async function fundsList() {
  return db.many('SELECT * FROM funds WHERE featured ORDER BY latest_value DESC NULLS LAST, name');
}

async function fundBySlug(slug) {
  return db.one('SELECT * FROM funds WHERE slug = $1 OR cik = $1', [slug]);
}

async function fundPeriods(cik) {
  const rows = await db.many('SELECT DISTINCT period FROM fund_holdings WHERE cik = $1 ORDER BY period DESC', [cik]);
  return rows.map((r) => r.period);
}

async function fundHoldings(cik, period) {
  return db.many('SELECT * FROM fund_holdings WHERE cik = $1 AND period = $2 ORDER BY value DESC', [cik, period]);
}

// Welke gevolgde fondsen hebben dit aandeel in hun laatste 13F?
async function fundsHolding(symbol) {
  return db.many(
    `SELECT f.slug, f.name, f.manager, h.shares, h.value, h.weight, h.period
     FROM funds f JOIN fund_holdings h ON h.cik = f.cik AND h.period = f.latest_period
     WHERE h.symbol = $1 AND h.put_call = '' ORDER BY h.weight DESC`,
    [symbol]
  );
}

// Meest gehouden aandelen onder de gevolgde fondsen.
async function popularAmongFunds(limit = 20) {
  return db.many(
    `SELECT h.symbol, max(h.issuer) AS issuer, count(DISTINCT h.cik)::int AS funds, sum(h.value) AS value, avg(h.weight) AS avg_weight
     FROM funds f JOIN fund_holdings h ON h.cik = f.cik AND h.period = f.latest_period
     WHERE h.symbol IS NOT NULL AND h.put_call = ''
     GROUP BY h.symbol ORDER BY count(DISTINCT h.cik) DESC, sum(h.value) DESC LIMIT $1`,
    [limit]
  );
}

async function quoteFor(symbol) {
  return db.one('SELECT * FROM quotes WHERE symbol = $1', [symbol]);
}

async function jobStatus() {
  return db.many('SELECT * FROM job_runs ORDER BY job');
}

async function counts() {
  return db.one(`SELECT
    (SELECT count(*) FROM price_targets)::int AS targets,
    (SELECT count(*) FROM grades)::int AS grades,
    (SELECT count(*) FROM insider_trades)::int AS insiders,
    (SELECT count(*) FROM analysts)::int AS analysts,
    (SELECT count(*) FROM funds WHERE latest_period IS NOT NULL)::int AS funds`);
}

// Volglijst
async function watchlist(userId) {
  return db.many('SELECT kind, ref, created_at FROM watchlist WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
}
async function isWatched(userId, kind, ref) {
  if (!userId) return false;
  const r = await db.one('SELECT 1 AS x FROM watchlist WHERE user_id = $1 AND kind = $2 AND ref = $3', [userId, kind, ref]);
  return !!r;
}
async function toggleWatch(userId, kind, ref) {
  const del = await db.query('DELETE FROM watchlist WHERE user_id = $1 AND kind = $2 AND ref = $3', [userId, kind, ref]);
  if (del.rowCount === 0) await db.query('INSERT INTO watchlist (user_id, kind, ref) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, kind, ref]);
  return del.rowCount === 0;
}

module.exports = {
  analystLeaderboard,
  analystBySlug,
  analystScore,
  analystTargets,
  analystSearch,
  latestTargets,
  latestGrades,
  firmStats,
  latestInsiders,
  insiderClusters,
  insiderPerson,
  fundsList,
  fundBySlug,
  fundPeriods,
  fundHoldings,
  fundsHolding,
  popularAmongFunds,
  quoteFor,
  jobStatus,
  counts,
  watchlist,
  isWatched,
  toggleWatch,
};
