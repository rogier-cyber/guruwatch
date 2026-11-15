'use strict';

// Earnings call transcripts ophalen bij FMP, opslaan en analyseren (src/lib/transcripts.js).
const db = require('./db');
const fmp = require('./lib/fmp');
const tr = require('./lib/transcripts');

const KEEP = 8; // laatste 8 kwartalen (2 jaar)
const running = new Map();

const yearOf = (r) => Number(r.fiscalYear ?? r.year);
const quarterOf = (r) => Number(r.quarter ?? String(r.period || '').replace(/\D/g, ''));

async function stored(symbol) {
  return db.many(
    'SELECT year, quarter, date::text AS date, analysis, fetched_at FROM earnings_transcripts WHERE symbol = $1 ORDER BY year DESC, quarter DESC',
    [symbol]
  );
}

async function fetchOne(symbol, year, quarter) {
  const rows = await fmp.transcriptNoCache(symbol, year, quarter);
  const r = rows[0];
  if (!r || !r.content || r.content.length < 500) return false;
  const analysis = tr.analyze(r.content);
  const date = r.date ? String(r.date).slice(0, 10) : null;
  await db.query(
    `INSERT INTO earnings_transcripts (symbol, year, quarter, date, content, analysis) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (symbol, year, quarter) DO UPDATE SET date = EXCLUDED.date, content = EXCLUDED.content, analysis = EXCLUDED.analysis, fetched_at = now()`,
    [symbol, year, quarter, date, r.content, JSON.stringify(analysis)]
  );
  return true;
}

// Zorg dat de laatste calls van een aandeel in de database staan. De lijst met calls vragen we hooguit
// eens per 12 uur op (force: direct). Gelijktijdige aanvragen voor hetzelfde aandeel delen één run.
function ensure(symbol, { force = false } = {}) {
  if (running.has(symbol)) return running.get(symbol);
  const p = (async () => {
    const sync = await db.one('SELECT transcripts_at FROM symbol_sync WHERE symbol = $1', [symbol]).catch(() => null);
    if (!force && sync && sync.transcripts_at && Date.now() - new Date(sync.transcripts_at).getTime() < 12 * 3600e3) return 0;
    const dates = (await fmp.transcriptDates(symbol))
      .map((r) => ({ year: yearOf(r), quarter: quarterOf(r) }))
      .filter((r) => r.year > 2000 && r.quarter >= 1 && r.quarter <= 4)
      .sort((a, b) => b.year - a.year || b.quarter - a.quarter)
      .slice(0, KEEP);
    const have = new Set((await stored(symbol)).map((r) => `${r.year}Q${r.quarter}`));
    let added = 0;
    for (const d of dates) {
      if (have.has(`${d.year}Q${d.quarter}`)) continue;
      if (await fetchOne(symbol, d.year, d.quarter).catch((e) => { console.warn('[transcripts]', symbol, d.year, d.quarter, e.message); return false; })) added++;
    }
    await db.query('INSERT INTO symbol_sync (symbol, transcripts_at) VALUES ($1, now()) ON CONFLICT (symbol) DO UPDATE SET transcripts_at = now()', [symbol]);
    return added;
  })().finally(() => running.delete(symbol));
  running.set(symbol, p);
  return p;
}

// Achtergrond: aandelen met recente cijfers (index of volglijst) en nog geen call daarvan, plus een
// rustige eerste vulling van indexaandelen zonder transcripts.
// Opgeslagen calls opnieuw analyseren na een verbetering van de analyse (tr.VERSION).
async function reanalyze(limit = 3000) {
  const rows = await db.many(
    "SELECT symbol, year, quarter, content FROM earnings_transcripts WHERE coalesce((analysis->>'v')::int, 1) < $1 LIMIT $2",
    [tr.VERSION, limit]
  );
  for (const r of rows) {
    await db.query('UPDATE earnings_transcripts SET analysis = $4 WHERE symbol = $1 AND year = $2 AND quarter = $3', [r.symbol, r.year, r.quarter, JSON.stringify(tr.analyze(r.content))]);
  }
  return rows.length;
}

async function runTranscripts({ max = 40 } = {}) {
  const reanalyzed = await reanalyze();
  const fresh = await db.many(
    `SELECT DISTINCT e.symbol FROM earnings e
     WHERE e.date BETWEEN current_date - 10 AND current_date
       AND (e.symbol IN (SELECT symbol FROM index_members) OR e.symbol IN (SELECT ref FROM watchlist WHERE kind = 'stock'))
       AND NOT EXISTS (SELECT 1 FROM earnings_transcripts t WHERE t.symbol = e.symbol AND t.date >= e.date - 1)
     LIMIT $1`,
    [max]
  );
  const fill = await db.many(
    `SELECT s.symbol FROM (SELECT DISTINCT symbol FROM index_members WHERE index_key IN ('sp500','nasdaq100')
                           UNION SELECT ref FROM watchlist WHERE kind = 'stock') s
     LEFT JOIN symbol_sync y ON y.symbol = s.symbol
     WHERE y.transcripts_at IS NULL ORDER BY s.symbol LIMIT $1`,
    [Math.max(0, max - fresh.length)]
  );
  let added = 0;
  const errors = [];
  for (const { symbol, force } of [...fresh.map((r) => ({ symbol: r.symbol, force: true })), ...fill]) {
    try {
      added += await ensure(symbol, { force: !!force });
    } catch (err) {
      errors.push(`${symbol}: ${err.message}`);
    }
  }
  return { reanalyzed, fresh: fresh.length, fill: fill.length, added, errors: errors.slice(0, 5) };
}

async function content(symbol, year, quarter) {
  return db.one('SELECT content, nl FROM earnings_transcripts WHERE symbol = $1 AND year = $2 AND quarter = $3', [symbol, year, quarter]);
}

// Alleen de Nederlandse samenvatting, prognose en kernpunten (zonder de vertaalde vragenronde).
async function nlSummary(symbol, year, quarter) {
  const r = await db.one("SELECT nl - 'exchanges' AS nl FROM earnings_transcripts WHERE symbol = $1 AND year = $2 AND quarter = $3", [symbol, year, quarter]);
  return (r && r.nl) || null;
}

module.exports = { ensure, stored, runTranscripts, content, nlSummary, KEEP };
