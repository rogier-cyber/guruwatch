'use strict';

// Opslaan van FMP-data in Postgres.
const db = require('../db');
const { mapPriceTarget, mapGrade, mapInsider, mapHoldings, slugify } = require('./normalize');

function buildInsert(table, columns, rows, conflict) {
  const values = [];
  const placeholders = rows.map((row, r) => {
    const ph = columns.map((c, j) => {
      values.push(row[c] === undefined ? null : row[c]);
      return `$${r * columns.length + j + 1}`;
    });
    return `(${ph.join(',')})`;
  });
  return { sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders.join(',')} ${conflict || ''}`, values };
}

async function bulkInsert(table, columns, rows, conflict, client = db) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { sql, values } = buildInsert(table, columns, rows.slice(i, i + 200), conflict);
    const res = await client.query(sql, values);
    inserted += res.rowCount;
  }
  return inserted;
}

async function ensureAnalysts(rows) {
  const bySlug = new Map();
  for (const r of rows) if (r.analyst_slug && !bySlug.has(r.analyst_slug)) bySlug.set(r.analyst_slug, r);
  if (!bySlug.size) return new Map();
  const list = [...bySlug.values()].map((r) => ({ slug: r.analyst_slug, name: r.analyst_name, firm: r.analyst_firm }));
  await bulkInsert('analysts', ['slug', 'name', 'firm'], list, 'ON CONFLICT (slug) DO NOTHING');
  const found = await db.many('SELECT id, slug FROM analysts WHERE slug = ANY($1)', [[...bySlug.keys()]]);
  return new Map(found.map((a) => [a.slug, a.id]));
}

async function savePriceTargets(raw) {
  const rows = raw.map(mapPriceTarget).filter(Boolean);
  const ids = await ensureAnalysts(rows);
  for (const r of rows) r.analyst_id = r.analyst_slug ? ids.get(r.analyst_slug) || null : null;
  return bulkInsert(
    'price_targets',
    ['uid', 'symbol', 'published_at', 'analyst_id', 'analyst_name', 'analyst_firm', 'price_target', 'adj_price_target', 'price_when_posted', 'news_title', 'news_url', 'news_publisher'],
    rows,
    'ON CONFLICT (uid) DO NOTHING'
  );
}

async function saveGrades(raw) {
  const rows = raw.map(mapGrade).filter(Boolean);
  return bulkInsert(
    'grades',
    ['uid', 'symbol', 'published_at', 'grading_company', 'previous_grade', 'new_grade', 'action', 'price_when_posted', 'news_title', 'news_url', 'news_publisher'],
    rows,
    'ON CONFLICT (uid) DO NOTHING'
  );
}

async function saveInsiders(raw) {
  const rows = raw.map(mapInsider).filter(Boolean);
  return bulkInsert(
    'insider_trades',
    ['uid', 'symbol', 'filing_date', 'transaction_date', 'reporting_cik', 'reporting_name', 'type_of_owner', 'transaction_type', 'acquisition_or_disposition', 'securities_transacted', 'price', 'securities_owned', 'security_name', 'form_type', 'url'],
    rows,
    'ON CONFLICT (uid) DO NOTHING'
  );
}

async function saveQuotes(quotes) {
  const seen = new Map();
  for (const q of quotes) {
    if (q && q.symbol && Number(q.price) > 0) {
      seen.set(q.symbol.toUpperCase(), { symbol: q.symbol.toUpperCase(), price: Number(q.price), change_pct: q.changePercentage ?? null });
    }
  }
  return bulkInsert(
    'quotes',
    ['symbol', 'price', 'change_pct'],
    [...seen.values()],
    'ON CONFLICT (symbol) DO UPDATE SET price = EXCLUDED.price, change_pct = COALESCE(EXCLUDED.change_pct, quotes.change_pct), updated_at = now()'
  );
}

async function syncFundList(list) {
  for (const f of list) {
    await db.query(
      `INSERT INTO funds (cik, name, manager, slug, style) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (cik) DO UPDATE SET name = EXCLUDED.name, manager = EXCLUDED.manager, style = EXCLUDED.style`,
      [f.cik, f.name, f.manager, slugify(f.manager || f.name) || f.cik, f.style || null]
    );
  }
}

const HOLDING_COLS = ['cik', 'period', 'cusip', 'put_call', 'symbol', 'issuer', 'title_of_class', 'shares', 'value', 'weight', 'filing_date'];

async function saveFundQuarter(cik, period, rawRows) {
  const { holdings, total } = mapHoldings(rawRows);
  const rows = holdings.map((h) => ({ ...h, cik, period }));
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM fund_holdings WHERE cik = $1 AND period = $2', [cik, period]);
    await bulkInsert('fund_holdings', HOLDING_COLS, rows, '', client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { positions: holdings.length, total };
}

async function markJob(job, ok, info) {
  if (ok) {
    await db.query(
      `INSERT INTO job_runs (job, last_ok_at, info) VALUES ($1, now(), $2)
       ON CONFLICT (job) DO UPDATE SET last_ok_at = now(), info = EXCLUDED.info`,
      [job, info ? JSON.stringify(info) : null]
    );
  } else {
    await db.query(
      `INSERT INTO job_runs (job, last_error, last_error_at) VALUES ($1, $2, now())
       ON CONFLICT (job) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now()`,
      [job, String(info).slice(0, 1000)]
    );
  }
}

async function savePrices(points) {
  let n = 0;
  for (let i = 0; i < points.length; i += 1000) {
    n += await bulkInsert('prices', ['symbol', 'date', 'close'], points.slice(i, i + 1000),
      'ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close');
  }
  return n;
}

const RESULT_COLS = ['price_target_id', 'analyst_id', 'analyst_firm', 'symbol', 'published_at', 'direction', 'p0', 'target', 'horizon_end', 'p_end', 'bench_ret', 'ret', 'excess', 'hit', 'days_to_hit', 'complete'];

async function saveCallResults(results) {
  const updates = RESULT_COLS.filter((c) => c !== 'price_target_id').map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  return bulkInsert('call_results', RESULT_COLS, results, `ON CONFLICT (price_target_id) DO UPDATE SET ${updates}, computed_at = now()`);
}

async function replaceGuruScores(kind, scores) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM guru_scores WHERE kind = $1', [kind]);
    const rows = scores.map((s) => ({ kind, ...s }));
    await bulkInsert('guru_scores', ['kind', 'ref', 'calls', 'hit_rate', 'avg_return', 'avg_excess', 'success_rate', 'score', 'rank'], rows, '', client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { savePrices, saveCallResults, replaceGuruScores, savePriceTargets, saveGrades, saveInsiders, saveQuotes, syncFundList, saveFundQuarter, markJob };
