'use strict';

// Achtergrondtaak: cijferkalender bijhouden (komende weken + historie vanaf 2023).
const db = require('./db');
const fmp = require('./lib/fmp');

const HISTORY_START = '2023-01-01';
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

async function knownSymbols() {
  const rows = await db.many('SELECT symbol FROM symbol_sync');
  return new Set(rows.map((r) => r.symbol));
}

async function saveRows(items, known) {
  const rows = items
    .filter((x) => x && x.symbol && x.date && known.has(x.symbol))
    .map((x) => [x.symbol, String(x.date).slice(0, 10), n(x.epsActual ?? x.eps), n(x.epsEstimated), n(x.revenueActual ?? x.revenue), n(x.revenueEstimated)]);
  // Laatste waarde per symbool/datum (de feed kan dubbelen bevatten).
  const list = [...new Map(rows.map((r) => [`${r[0]}|${r[1]}`, r])).values()];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const values = [];
    const ph = chunk.map((r, k) => `(${r.map((v, j) => { values.push(v); return `$${k * 6 + j + 1}`; }).join(',')}, now())`);
    await db.query(
      `INSERT INTO earnings (symbol, date, eps_actual, eps_estimated, revenue_actual, revenue_estimated, updated_at) VALUES ${ph.join(',')}
       ON CONFLICT (symbol, date) DO UPDATE SET
         eps_actual = coalesce(EXCLUDED.eps_actual, earnings.eps_actual),
         eps_estimated = coalesce(EXCLUDED.eps_estimated, earnings.eps_estimated),
         revenue_actual = coalesce(EXCLUDED.revenue_actual, earnings.revenue_actual),
         revenue_estimated = coalesce(EXCLUDED.revenue_estimated, earnings.revenue_estimated),
         updated_at = now()`,
      values
    );
  }
  return list.length;
}

async function fetchRange(from, to, known) {
  let saved = 0;
  // In blokken van twee weken, zodat geen antwoord wordt afgekapt.
  const end = new Date(to).getTime();
  for (let t = new Date(from).getTime(); t <= end; t += 14 * 864e5) {
    const stop = Math.min(t + 13 * 864e5, end);
    saved += await saveRows(await fmp.earningsCalendarNoCache(iso(t), iso(stop)), known);
  }
  return saved;
}

async function refreshCalendar() {
  const known = await knownSymbols();
  return { saved: await fetchRange(Date.now() - 14 * 864e5, Date.now() + 60 * 864e5, known) };
}

// Historie per maand ophalen, een paar maanden per run (nieuwste eerst).
async function backfill(maxMonths = 12) {
  const known = await knownSymbols();
  const done = new Set((await db.many('SELECT month::text AS m FROM earnings_backfill')).map((r) => r.m));
  const months = [];
  const now = new Date();
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  for (let d = new Date(HISTORY_START); d.getTime() < thisMonth; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    if (!done.has(iso(d))) months.push(iso(d));
  }
  months.reverse();
  let saved = 0;
  for (const m of months.slice(0, maxMonths)) {
    const d = new Date(m);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const rows = await fetchRange(m, iso(last), known);
    saved += rows;
    await db.query(
      'INSERT INTO earnings_backfill (month, rows) VALUES ($1, $2) ON CONFLICT (month) DO UPDATE SET rows = EXCLUDED.rows, fetched_at = now()',
      [m, rows]
    );
  }
  return { months: Math.min(maxMonths, months.length), remaining: Math.max(0, months.length - maxMonths), saved };
}

async function runEarnings() {
  const calendar = await refreshCalendar();
  const history = await backfill();
  return { calendar, history };
}

module.exports = { runEarnings, refreshCalendar, backfill };
