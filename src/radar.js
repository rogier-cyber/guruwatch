'use strict';

// Achtergrondtaken voor de radar en screeners:
// 1. bedrijfsprofielen (sector, beurswaarde) bijhouden
// 2. dagelijkse momentopname van de winstverwachtingen
// 3. maandelijkse adviesverdeling (kopen/houden/verkopen) ophalen
// 4. contrair-backtest herberekenen
const db = require('./db');
const fmp = require('./lib/fmp');
const { summarizeBacktest } = require('./lib/radar');

const BENCH = 'SPY';
const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/;

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

const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// Veldnamen verschillen per API-versie in hoofdletters (analystRatingsBuy / analystRatingsbuy).
const pick = (obj, name) => {
  const k = Object.keys(obj).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? obj[k] : undefined;
};

// 1. Bedrijfsprofielen
async function refreshProfiles(max = 300) {
  const rows = await db.many(
    `SELECT symbol FROM symbol_sync
     WHERE symbol <> $1 AND (profile_at IS NULL OR profile_at < now() - interval '14 days')
     ORDER BY profile_at NULLS FIRST, symbol LIMIT $2`,
    [BENCH, max]
  );
  let saved = 0;
  const errors = await pool(rows.map((r) => r.symbol), 6, async (symbol) => {
    const p = SYMBOL_RE.test(symbol) ? await fmp.profileNoCache(symbol) : null;
    if (p) {
      await db.query(
        `INSERT INTO companies (symbol, name, sector, industry, exchange, country, currency, market_cap, image, is_etf, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name, sector = EXCLUDED.sector, industry = EXCLUDED.industry,
           exchange = EXCLUDED.exchange, country = EXCLUDED.country, currency = EXCLUDED.currency,
           market_cap = EXCLUDED.market_cap, image = EXCLUDED.image, is_etf = EXCLUDED.is_etf, updated_at = now()`,
        [symbol, p.companyName || null, p.sector || null, p.industry || null, p.exchange || null, p.country || null,
          p.currency || null, n(p.marketCap ?? p.mktCap), p.image || null, Boolean(p.isEtf || p.isFund)]
      );
      saved++;
    }
    await db.query('UPDATE symbol_sync SET profile_at = now() WHERE symbol = $1', [symbol]);
  });
  return { symbols: rows.length, saved, errors: errors.slice(0, 5) };
}

// 2. Winstverwachtingen: één momentopname per dag voor aandelen met recente analistenactiviteit.
async function snapshotEstimates(max = 500) {
  const rows = await db.many(
    `SELECT s.symbol FROM symbol_sync s
     WHERE s.symbol <> $1 AND (s.estimates_at IS NULL OR s.estimates_at < current_date)
       AND EXISTS (SELECT 1 FROM price_targets p WHERE p.symbol = s.symbol AND p.published_at > now() - interval '180 days')
     ORDER BY s.estimates_at NULLS FIRST, s.symbol LIMIT $2`,
    [BENCH, max]
  );
  let saved = 0;
  const today = new Date().toISOString().slice(0, 10);
  const minDate = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const errors = await pool(rows.map((r) => r.symbol), 6, async (symbol) => {
    const list = SYMBOL_RE.test(symbol) ? await fmp.estimatesNoCache(symbol) : [];
    const upcoming = list
      .filter((e) => e.date && e.date >= minDate)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(0, 3);
    for (const e of upcoming) {
      await db.query(
        `INSERT INTO estimate_snapshots (symbol, snap_date, fiscal_date, eps_avg, revenue_avg, analysts)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (symbol, snap_date, fiscal_date) DO UPDATE SET eps_avg = EXCLUDED.eps_avg, revenue_avg = EXCLUDED.revenue_avg, analysts = EXCLUDED.analysts`,
        [symbol, today, e.date, n(e.epsAvg ?? e.estimatedEpsAvg), n(e.revenueAvg ?? e.estimatedRevenueAvg), n(e.numAnalystsEps ?? e.numberAnalystsEstimatedEps)]
      );
      saved++;
    }
    await db.query('UPDATE symbol_sync SET estimates_at = now() WHERE symbol = $1', [symbol]);
  });
  return { symbols: rows.length, saved, errors: errors.slice(0, 5) };
}

// 3. Adviesverdeling per maand
async function refreshRatingHistory(max = 250) {
  const rows = await db.many(
    `SELECT symbol FROM symbol_sync
     WHERE symbol <> $1 AND (ratings_at IS NULL OR ratings_at < now() - interval '7 days')
     ORDER BY ratings_at NULLS FIRST, symbol LIMIT $2`,
    [BENCH, max]
  );
  let saved = 0;
  const errors = await pool(rows.map((r) => r.symbol), 6, async (symbol) => {
    const list = SYMBOL_RE.test(symbol) ? await fmp.ratingHistoryNoCache(symbol) : [];
    const points = list
      .filter((x) => x && x.date)
      .map((x) => [symbol, x.date, n(pick(x, 'analystRatingsStrongBuy')) || 0, n(pick(x, 'analystRatingsBuy')) || 0,
        n(pick(x, 'analystRatingsHold')) || 0, n(pick(x, 'analystRatingsSell')) || 0, n(pick(x, 'analystRatingsStrongSell')) || 0]);
    for (let i = 0; i < points.length; i += 100) {
      const chunk = points.slice(i, i + 100);
      const values = [];
      const ph = chunk.map((p, r) => `(${p.map((v, j) => { values.push(v); return `$${r * 7 + j + 1}`; }).join(',')})`);
      await db.query(
        `INSERT INTO rating_history (symbol, date, strong_buy, buy, hold, sell, strong_sell) VALUES ${ph.join(',')}
         ON CONFLICT (symbol, date) DO UPDATE SET strong_buy = EXCLUDED.strong_buy, buy = EXCLUDED.buy, hold = EXCLUDED.hold,
           sell = EXCLUDED.sell, strong_sell = EXCLUDED.strong_sell`,
        values
      );
      saved += chunk.length;
    }
    await db.query('UPDATE symbol_sync SET ratings_at = now() WHERE symbol = $1', [symbol]);
  });
  return { symbols: rows.length, saved, errors: errors.slice(0, 5) };
}

// 4. Contrair-backtest: wat deed een aandeel in de 12 maanden nadat de adviesverdeling
// een bepaald niveau bereikte, vergeleken met de S&P 500?
async function computeBacktest() {
  const obs = await db.many(
    `WITH r AS (
       SELECT symbol, date, strong_buy + buy AS bulls, strong_buy + buy + hold + sell + strong_sell AS total
       FROM rating_history
       WHERE date <= current_date - 365 AND strong_buy + buy + hold + sell + strong_sell >= 5
     )
     SELECT r.symbol, r.bulls::float8 / r.total AS bull,
            (p1.close / p0.close) - (b1.close / b0.close) AS excess
     FROM r
     CROSS JOIN LATERAL (SELECT close FROM prices WHERE symbol = r.symbol AND date <= r.date AND date > r.date - 7 ORDER BY date DESC LIMIT 1) p0
     CROSS JOIN LATERAL (SELECT close FROM prices WHERE symbol = r.symbol AND date <= r.date + 365 AND date > r.date + 358 ORDER BY date DESC LIMIT 1) p1
     CROSS JOIN LATERAL (SELECT close FROM prices WHERE symbol = $1 AND date <= r.date AND date > r.date - 7 ORDER BY date DESC LIMIT 1) b0
     CROSS JOIN LATERAL (SELECT close FROM prices WHERE symbol = $1 AND date <= r.date + 365 AND date > r.date + 358 ORDER BY date DESC LIMIT 1) b1
     WHERE p0.close > 0 AND b0.close > 0`,
    [BENCH]
  );
  const clean = obs
    .map((o) => ({ bull: Number(o.bull), excess: Number(o.excess) }))
    // Extreme uitschieters (splits zonder correctie) niet meetellen.
    .filter((o) => Number.isFinite(o.excess) && o.excess > -1.5 && o.excess < 5);
  const symbols = new Set(obs.map((o) => o.symbol)).size;
  const data = { buckets: summarizeBacktest(clean), observations: clean.length, symbols };
  await db.query(
    `INSERT INTO kv_cache (key, data, updated_at) VALUES ('contrarian_backtest', $1, now())
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [JSON.stringify(data)]
  );
  return { observations: clean.length, symbols };
}

async function runRadar({ profiles = 300, estimates = 500, ratings = 250 } = {}) {
  const t0 = Date.now();
  const p = await refreshProfiles(profiles);
  const e = await snapshotEstimates(estimates);
  const r = await refreshRatingHistory(ratings);
  const b = await computeBacktest();
  return { profiles: p, estimates: e, ratings: r, backtest: b, ms: Date.now() - t0 };
}

module.exports = { runRadar, refreshProfiles, snapshotEstimates, refreshRatingHistory, computeBacktest };
