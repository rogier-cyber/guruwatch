// Queries voor de visualisaties op de analisten-, insider- en homepagina.
'use strict';

const db = require('../db');

// Waar kochten insiders de laatste dagen het meest (in dollars)?
async function insiderBuyMap(days = 30, limit = 40) {
  return db.many(
    `SELECT symbol, (SELECT c.name FROM companies c WHERE c.symbol = t.symbol) AS name,
            sum(securities_transacted * price)::float8 AS value,
            count(DISTINCT reporting_cik)::int AS insiders
     FROM insider_trades t
     WHERE transaction_type ILIKE 'P-%' AND transaction_date > current_date - $1::int AND price > 0
     GROUP BY symbol ORDER BY value DESC LIMIT $2`,
    [days, limit]
  );
}

// Waarde per functie (type_of_owner) en per richting.
async function insiderByRole(days = 30) {
  return db.many(
    `SELECT type_of_owner,
            coalesce(sum(securities_transacted * price) FILTER (WHERE transaction_type ILIKE 'P-%'), 0)::float8 AS buy,
            coalesce(sum(securities_transacted * price) FILTER (WHERE transaction_type ILIKE 'S-%'), 0)::float8 AS sell,
            count(*) FILTER (WHERE transaction_type ILIKE 'P-%')::int AS buys
     FROM insider_trades
     WHERE transaction_date > current_date - $1::int AND price > 0
     GROUP BY type_of_owner`,
    [days]
  );
}

// Beste en slechtste banken op GuruScore (minstens `minCalls` adviezen).
async function firmExtremes(minCalls = 30, limit = 5) {
  const [best, worst] = await Promise.all([
    db.many(`SELECT ref AS firm, score, calls, hit_rate, avg_excess FROM guru_scores WHERE kind = 'firm' AND calls >= $1 ORDER BY score DESC, calls DESC LIMIT $2`, [minCalls, limit]),
    db.many(`SELECT ref AS firm, score, calls, hit_rate, avg_excess FROM guru_scores WHERE kind = 'firm' AND calls >= $1 ORDER BY score ASC, calls DESC LIMIT $2`, [minCalls, limit]),
  ]);
  return { best, worst };
}

module.exports = { insiderBuyMap, insiderByRole, firmExtremes };
