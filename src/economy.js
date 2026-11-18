'use strict';

// Achtergrondtaak: economische kalender bijhouden (afgelopen week + komende twee weken).
// Bron: FMP /economic-calendar; valt FMP uit of is het leeg, dan EODHD /economic-events.
const db = require('./db');
const config = require('./config');
const fmp = require('./lib/fmp');
const eco = require('./lib/economy');

const DAY = 24 * 60 * 60 * 1000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const KEEP = new Set(eco.COUNTRIES.map((c) => c.code));

async function fromFmp(from, to) {
  const rows = await fmp.request('economic-calendar', { from, to }, { ttl: 0 });
  return (Array.isArray(rows) ? rows : []).map(eco.fromFmp).filter(Boolean);
}

async function fromEodhd(from, to) {
  if (!config.eodhdKey) return [];
  const out = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const url = `https://eodhd.com/api/economic-events?from=${from}&to=${to}&limit=1000&offset=${offset}&fmt=json&api_token=${config.eodhdKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`EODHD economic-events: HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    out.push(...data.map(eco.fromEodhd).filter(Boolean));
    if (data.length < 1000) break;
  }
  return out;
}

async function save(events) {
  const rows = events.filter((e) => KEEP.has(e.country));
  const list = [...new Map(rows.map((e) => [`${e.at.toISOString()}|${e.country}|${e.event}`, e])).values()];
  const cols = (e) => [e.at, e.country, e.event, e.period || '', e.currency, e.impact, e.previous, e.estimate, e.actual, e.unit, e.source];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const values = [];
    const ph = chunk.map((e, k) => `(${cols(e).map((v, j) => { values.push(v); return `$${k * 11 + j + 1}`; }).join(',')}, now())`);
    await db.query(
      `INSERT INTO economic_events (at, country, event, period, currency, impact, previous, estimate, actual, unit, source, updated_at)
       VALUES ${ph.join(',')}
       ON CONFLICT (at, country, event) DO UPDATE SET
         period = EXCLUDED.period, currency = coalesce(EXCLUDED.currency, economic_events.currency), impact = EXCLUDED.impact,
         previous = coalesce(EXCLUDED.previous, economic_events.previous),
         estimate = coalesce(EXCLUDED.estimate, economic_events.estimate),
         actual = coalesce(EXCLUDED.actual, economic_events.actual),
         unit = coalesce(EXCLUDED.unit, economic_events.unit), source = EXCLUDED.source, updated_at = now()`,
      values
    );
  }
  return list.length;
}

async function runEconomy() {
  const from = iso(Date.now() - 7 * DAY);
  const to = iso(Date.now() + 14 * DAY);
  let source = 'fmp';
  let events = [];
  let fmpError = null;
  try {
    events = await fromFmp(from, to);
  } catch (err) {
    fmpError = err.message;
  }
  if (!events.some((e) => KEEP.has(e.country))) {
    let alt = [];
    try {
      alt = await fromEodhd(from, to);
    } catch (err) {
      if (fmpError) throw new Error(`${fmpError}; ${err.message}`);
    }
    if (alt.length) {
      events = alt;
      source = 'eodhd';
    } else if (fmpError) {
      throw new Error(fmpError);
    }
  }
  const saved = await save(events);
  // Oude regels opruimen: we tonen alleen recente en komende publicaties.
  const old = await db.query("DELETE FROM economic_events WHERE at < now() - interval '45 days'");
  return { source, fetched: events.length, saved, removed: old.rowCount, fmpError };
}

// Voor de pagina.
async function events({ from, to }) {
  return db.many(
    `SELECT at, country, event, period, currency, impact, previous, estimate, actual, unit, source
       FROM economic_events WHERE at >= $1 AND at < $2 ORDER BY at, country, event`,
    [from, to]
  );
}

module.exports = { runEconomy, events, save };
