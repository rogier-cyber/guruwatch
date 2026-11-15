'use strict';

// Databasequeries rond kwartaalcijfers.
const db = require('../db');

const TARGET = 'coalesce(p.adj_price_target, p.price_target)';
const WHO = 'coalesce(p.analyst_id::text, lower(p.analyst_firm))';

// Komende cijfers, met het aantal analisten en het gemiddelde koersdoel.
async function upcoming({ days = 14, symbols = null } = {}) {
  return db.many(
    `WITH ev AS (
       SELECT * FROM earnings
       WHERE date >= current_date AND date <= current_date + $1::int AND ($2::text[] IS NULL OR symbol = ANY($2))
     ),
     latest AS (
       SELECT DISTINCT ON (p.symbol, ${WHO}) p.symbol, ${TARGET} AS t
       FROM price_targets p
       WHERE p.symbol IN (SELECT symbol FROM ev) AND p.published_at > now() - interval '182 days' AND ${TARGET} > 0
       ORDER BY p.symbol, ${WHO}, p.published_at DESC
     ),
     cons AS (SELECT symbol, avg(t)::float8 AS target, count(*)::int AS n FROM latest GROUP BY symbol)
     SELECT ev.symbol, ev.date::text AS date, ev.eps_estimated::float8 AS eps_estimated, ev.revenue_estimated::float8 AS revenue_estimated,
            c.name, c.sector, c.market_cap::float8 AS market_cap, q.price::float8 AS price, cons.target, coalesce(cons.n, 0) AS analysts
     FROM ev
     LEFT JOIN companies c ON c.symbol = ev.symbol
     LEFT JOIN quotes q ON q.symbol = ev.symbol
     LEFT JOIN cons ON cons.symbol = ev.symbol
     WHERE coalesce(c.is_etf, false) = false
     ORDER BY ev.date, c.market_cap DESC NULLS LAST`,
    [days, symbols]
  );
}

// Gerapporteerde cijfers met koersreactie en koersdoelherzieningen in de 10 dagen erna.
async function reactions({ days = 30, symbol = null, limit = 400 } = {}) {
  return db.many(
    `WITH ev AS (
       SELECT * FROM earnings
       WHERE eps_actual IS NOT NULL AND date <= current_date
         AND (($2::text IS NULL AND date >= current_date - $1::int) OR symbol = $2)
       ORDER BY date DESC LIMIT $3
     ),
     rev AS (
       SELECT p.symbol, p.published_at, ${TARGET} AS t,
              lag(${TARGET}) OVER (PARTITION BY p.symbol, ${WHO} ORDER BY p.published_at) AS prev
       FROM price_targets p
       WHERE p.symbol IN (SELECT symbol FROM ev) AND ${TARGET} > 0
     )
     SELECT ev.symbol, ev.date::text AS date, ev.eps_actual::float8 AS eps_actual, ev.eps_estimated::float8 AS eps_estimated,
            ev.revenue_actual::float8 AS revenue_actual, ev.revenue_estimated::float8 AS revenue_estimated,
            c.name, c.sector, c.market_cap::float8 AS market_cap,
            p0.close::float8 AS price_before, p1.close::float8 AS price_after,
            coalesce(r.raises, 0) AS raises, coalesce(r.cuts, 0) AS cuts, coalesce(r.n, 0) AS revisions, r.avg_change
     FROM ev
     LEFT JOIN companies c ON c.symbol = ev.symbol
     LEFT JOIN LATERAL (SELECT close FROM prices WHERE symbol = ev.symbol AND date < ev.date AND date >= ev.date - 7 ORDER BY date DESC LIMIT 1) p0 ON true
     LEFT JOIN LATERAL (SELECT close FROM prices WHERE symbol = ev.symbol AND date > ev.date AND date <= ev.date + 7 ORDER BY date LIMIT 1) p1 ON true
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE t > prev * 1.001)::int AS raises,
              count(*) FILTER (WHERE t < prev * 0.999)::int AS cuts,
              count(*)::int AS n,
              avg(t / prev - 1) FILTER (WHERE prev > 0)::float8 AS avg_change
       FROM rev WHERE rev.symbol = ev.symbol AND rev.published_at >= ev.date AND rev.published_at < ev.date + 10
     ) r ON true
     WHERE coalesce(c.is_etf, false) = false
     ORDER BY ev.date DESC, c.market_cap DESC NULLS LAST`,
    [days, symbol, limit]
  );
}

// Eén cijfermoment in detail: herzieningen rond de datum, met vorig doel per analist.
async function eventRevisions(symbol, date) {
  return db.many(
    `WITH rev AS (
       SELECT p.symbol, p.published_at, ${TARGET}::float8 AS t, p.price_when_posted::float8 AS pwp,
              p.analyst_id, p.analyst_name, p.analyst_firm,
              lag(${TARGET}) OVER (PARTITION BY p.symbol, ${WHO} ORDER BY p.published_at)::float8 AS prev
       FROM price_targets p
       WHERE p.symbol = $1 AND ${TARGET} > 0
     )
     SELECT rev.*, a.slug, a.name, g.score
     FROM rev
     LEFT JOIN analysts a ON a.id = rev.analyst_id
     LEFT JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = rev.analyst_id::text
     WHERE rev.published_at >= $2::date AND rev.published_at < $2::date + 10
     ORDER BY rev.published_at`,
    [symbol, date]
  );
}

async function earningsRow(symbol, date) {
  return db.one(
    `SELECT symbol, date::text AS date, eps_actual::float8 AS eps_actual, eps_estimated::float8 AS eps_estimated,
            revenue_actual::float8 AS revenue_actual, revenue_estimated::float8 AS revenue_estimated
     FROM earnings WHERE symbol = $1 AND date = $2::date`,
    [symbol, date]
  );
}

async function nextEarnings(symbol) {
  return db.one(
    `SELECT date::text AS date, eps_estimated::float8 AS eps_estimated, revenue_estimated::float8 AS revenue_estimated
     FROM earnings WHERE symbol = $1 AND date >= current_date ORDER BY date LIMIT 1`,
    [symbol]
  );
}

// Grootste herzieningen van de winstverwachting (volgend boekjaar) uit onze eigen momentopnames.
async function epsRevisions({ days = 30 } = {}) {
  return db.many(
    `WITH cur AS (
       SELECT DISTINCT ON (symbol) symbol, snap_date, fiscal_date, eps_avg, analysts
       FROM estimate_snapshots
       WHERE fiscal_date > current_date AND eps_avg IS NOT NULL AND snap_date > current_date - 4
       ORDER BY symbol, snap_date DESC, fiscal_date
     )
     SELECT cur.symbol, cur.fiscal_date::text AS fiscal_date, cur.eps_avg::float8 AS eps_now, old.eps_avg::float8 AS eps_then,
            old.snap_date::text AS since, cur.analysts, c.name, c.sector,
            (cur.eps_avg / old.eps_avg - 1)::float8 AS change
     FROM cur
     JOIN LATERAL (
       SELECT eps_avg, snap_date FROM estimate_snapshots o
       WHERE o.symbol = cur.symbol AND o.fiscal_date = cur.fiscal_date AND o.snap_date <= cur.snap_date - $1::int AND o.eps_avg > 0.05
       ORDER BY o.snap_date DESC LIMIT 1
     ) old ON true
     LEFT JOIN companies c ON c.symbol = cur.symbol
     WHERE cur.eps_avg > 0 AND coalesce(c.is_etf, false) = false`,
    [days]
  );
}

async function snapshotSpan() {
  return db.one('SELECT min(snap_date)::text AS first, max(snap_date)::text AS last, count(DISTINCT snap_date)::int AS days FROM estimate_snapshots');
}

module.exports = { upcoming, reactions, eventRevisions, earningsRow, nextEarnings, epsRevisions, snapshotSpan };
