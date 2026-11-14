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
  // Alleen echte transacties: geen Form 3-standen (aantal 0) en geen datums na de melding.
  const where = ['securities_transacted > 0', '(filing_date IS NULL OR transaction_date <= filing_date::date + 3)', 'transaction_date <= current_date'];
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
     ORDER BY transaction_date DESC, filing_date DESC NULLS LAST, id DESC LIMIT $${params.length}`,
    params
  );
}

// Aandelen waar insiders de afgelopen N dagen het meest kochten (cluster buys).
async function insiderClusters(days = 30, limit = 20) {
  return db.many(
    `SELECT symbol, (SELECT c.name FROM companies c WHERE c.symbol = insider_trades.symbol) AS name,
            count(DISTINCT reporting_cik)::int AS insiders, count(*)::int AS trades,
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
    `SELECT h.symbol, max(h.issuer) AS issuer, coalesce((SELECT c.name FROM companies c WHERE c.symbol = h.symbol), initcap(max(h.issuer))) AS name, count(DISTINCT h.cik)::int AS funds, sum(h.value) AS value, avg(h.weight) AS avg_weight
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

// ---------- GuruScore ----------

async function guruLeaderboard({ kind = 'analyst', minCalls = 5, limit = 100, firm } = {}) {
  if (kind === 'firm') {
    return db.many(
      `SELECT g.ref AS firm, g.* FROM guru_scores g WHERE kind = 'firm' AND calls >= $1 ORDER BY score DESC, calls DESC LIMIT $2`,
      [minCalls, limit]
    );
  }
  const params = [minCalls, limit];
  let firmSql = '';
  if (firm) {
    params.push(firm.toLowerCase());
    firmSql = `AND lower(a.firm) = $3`;
  }
  return db.many(
    `SELECT a.id, a.slug, a.name, a.firm, g.calls, g.hit_rate, g.avg_return, g.avg_excess, g.success_rate, g.score, g.rank
     FROM guru_scores g JOIN analysts a ON a.id = g.ref::bigint
     WHERE g.kind = 'analyst' AND g.calls >= $1 ${firmSql}
     ORDER BY g.score DESC, g.calls DESC LIMIT $2`,
    params
  );
}

async function guruScore(kind, ref) {
  return db.one('SELECT * FROM guru_scores WHERE kind = $1 AND ref = $2', [kind, String(ref)]);
}

async function hasGuruScores() {
  const r = await db.one("SELECT EXISTS (SELECT 1 FROM guru_scores WHERE kind = 'analyst') AS has");
  return r.has;
}

// Koersdoelen van een analist met uitkomst en vorig doel op hetzelfde aandeel.
async function analystCalls(analystId, limit = 300) {
  return db.many(
    `SELECT pt.id, pt.symbol, pt.published_at, pt.price_target, pt.price_when_posted, pt.news_url, pt.news_title,
            lag(pt.price_target) OVER (PARTITION BY pt.symbol ORDER BY pt.published_at) AS prev_target,
            cr.direction, cr.hit, cr.ret, cr.excess, cr.complete, cr.days_to_hit, cr.horizon_end,
            q.price AS current_price
     FROM price_targets pt
     LEFT JOIN call_results cr ON cr.price_target_id = pt.id
     LEFT JOIN quotes q ON q.symbol = pt.symbol
     WHERE pt.analyst_id = $1
     ORDER BY pt.published_at DESC LIMIT $2`,
    [analystId, limit]
  );
}

// Prestaties van een analist per aandeel.
async function analystBySymbol(analystId) {
  return db.many(
    `SELECT symbol, count(*)::int AS calls, avg(hit::int) AS hit_rate, avg(ret) AS avg_return, avg(excess) AS avg_excess,
            max(published_at) AS last_at
     FROM call_results WHERE analyst_id = $1 GROUP BY symbol ORDER BY count(*) DESC, avg(excess) DESC NULLS LAST LIMIT 40`,
    [analystId]
  );
}

// Laatste koersdoel per analist op een aandeel (12 maanden), met score en vorig doel.
async function latestTargetPerAnalyst(symbol) {
  return db.many(
    `WITH t AS (
       SELECT pt.*, lag(pt.price_target) OVER (PARTITION BY coalesce(pt.analyst_id::text, pt.analyst_firm) ORDER BY pt.published_at) AS prev_target,
              row_number() OVER (PARTITION BY coalesce(pt.analyst_id::text, pt.analyst_firm) ORDER BY pt.published_at DESC) AS rn
       FROM price_targets pt WHERE pt.symbol = $1 AND pt.price_target > 0
     )
     SELECT t.id, t.symbol, t.published_at, t.price_target, t.prev_target, t.price_when_posted, t.analyst_name, t.analyst_firm,
            a.slug AS analyst_slug, g.score, g.calls AS score_calls
     FROM t LEFT JOIN analysts a ON a.id = t.analyst_id
     LEFT JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = t.analyst_id::text
     WHERE t.rn = 1 AND t.published_at > now() - interval '365 days'
     ORDER BY t.published_at DESC`,
    [symbol]
  );
}

// Recente activiteit op een aandeel: elk koersdoel met het vorige doel van dezelfde analist/bank.
async function targetActivity(symbol, limit = 40) {
  return db.many(
    `SELECT * FROM (
       SELECT pt.id, pt.published_at, pt.price_target, pt.price_when_posted, pt.analyst_name, pt.analyst_firm, pt.news_url,
              a.slug AS analyst_slug, g.score,
              lag(pt.price_target) OVER (PARTITION BY coalesce(pt.analyst_id::text, pt.analyst_firm) ORDER BY pt.published_at) AS prev_target
       FROM price_targets pt LEFT JOIN analysts a ON a.id = pt.analyst_id
       LEFT JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = pt.analyst_id::text
       WHERE pt.symbol = $1
     ) x ORDER BY published_at DESC LIMIT $2`,
    [symbol, limit]
  );
}

// Wie kent dit aandeel het best? Prestaties per analist op dit aandeel.
async function symbolAnalystStats(symbol) {
  return db.many(
    `SELECT cr.analyst_id, a.slug, a.name, a.firm, cr.published_at, cr.hit, cr.ret::float8 AS ret, cr.excess::float8 AS excess
     FROM call_results cr JOIN analysts a ON a.id = cr.analyst_id WHERE cr.symbol = $1`,
    [symbol]
  );
}

// Alle koersdoelen op een aandeel voor de tijdlijn.
async function targetTimeline(symbol, since) {
  return db.many(
    `SELECT published_at, price_target::float8 AS target, price_when_posted::float8 AS pwp, coalesce(analyst_firm, 'Onbekend') AS firm, analyst_name
     FROM price_targets WHERE symbol = $1 AND published_at >= $2 AND price_target > 0 ORDER BY published_at`,
    [symbol, since]
  );
}

async function priceSeries(symbol, since) {
  return db.many(
    'SELECT date::text AS date, close::float8 AS close FROM prices WHERE symbol = $1 AND date >= $2 ORDER BY date',
    [symbol, since]
  );
}

// Up- en downgrades per dag (laatste N dagen), aangevuld met lege dagen.
async function dailyGradeCounts(days = 30) {
  return db.many(
    `SELECT d::date::text AS date,
            count(g.*) FILTER (WHERE lower(g.action) = 'upgrade')::int AS pos,
            count(g.*) FILTER (WHERE lower(g.action) = 'downgrade')::int AS neg
     FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
     LEFT JOIN grades g ON g.published_at >= d AND g.published_at < d + interval '1 day'
     GROUP BY d ORDER BY d`,
    [days]
  );
}

// Insider-aankopen en -verkopen (waarde) per dag.
async function dailyInsiderFlows(days = 30) {
  return db.many(
    `SELECT d::date::text AS date,
            coalesce(sum(t.securities_transacted * t.price) FILTER (WHERE t.transaction_type ILIKE 'P-%'), 0)::float8 AS pos,
            coalesce(sum(t.securities_transacted * t.price) FILTER (WHERE t.transaction_type ILIKE 'S-%'), 0)::float8 AS neg
     FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
     LEFT JOIN insider_trades t ON t.transaction_date = d::date AND t.price > 0
     GROUP BY d ORDER BY d`,
    [days]
  );
}

// Koersdoelen per dag: verhoogd vs verlaagd t.o.v. vorig doel van dezelfde analist/bank.
async function dailyTargetRevisions(days = 30) {
  return db.many(
    `WITH t AS (
       SELECT published_at, price_target,
              lag(price_target) OVER (PARTITION BY symbol, coalesce(analyst_id::text, analyst_firm) ORDER BY published_at) AS prev
       FROM price_targets WHERE published_at > now() - interval '2 years'
     )
     SELECT d::date::text AS date,
            count(t.*) FILTER (WHERE t.price_target > t.prev)::int AS pos,
            count(t.*) FILTER (WHERE t.price_target < t.prev)::int AS neg
     FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
     LEFT JOIN t ON t.published_at >= d AND t.published_at < d + interval '1 day'
     GROUP BY d ORDER BY d`,
    [days]
  );
}

async function scoreDistribution() {
  return db.many(
    `SELECT width_bucket(score, 0, 100.0001, 10) AS b, count(*)::int AS n FROM guru_scores WHERE kind = 'analyst' AND calls >= 5 GROUP BY 1 ORDER BY 1`
  );
}

module.exports = {
  dailyGradeCounts,
  dailyInsiderFlows,
  dailyTargetRevisions,
  scoreDistribution,
  guruLeaderboard,
  guruScore,
  hasGuruScores,
  analystCalls,
  analystBySymbol,
  latestTargetPerAnalyst,
  targetActivity,
  symbolAnalystStats,
  targetTimeline,
  priceSeries,
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
