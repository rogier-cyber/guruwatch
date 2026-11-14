'use strict';

// Rekenwerk voor het analistenblok op de aandeelpagina:
// adviezen door de tijd, koersdoelen per maand en recente acties.

const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

const LEVELS = [
  { key: 'strong_buy', label: 'Sterk kopen', cls: 'sb', w: 5 },
  { key: 'buy', label: 'Kopen', cls: 'b', w: 4 },
  { key: 'hold', label: 'Houden', cls: 'h', w: 3 },
  { key: 'sell', label: 'Verkopen', cls: 's', w: 2 },
  { key: 'strong_sell', label: 'Sterk verkopen', cls: 'ss', w: 1 },
];

function counts(r) {
  if (!r) return null;
  const c = {};
  for (const l of LEVELS) c[l.key] = num(r[l.key]);
  c.total = LEVELS.reduce((s, l) => s + c[l.key], 0);
  return c.total ? c : null;
}

// Gemiddeld oordeel op een schaal van 1 (sterk verkopen) tot 5 (sterk kopen).
function ratingScore(r) {
  const c = counts(r);
  if (!c) return null;
  return LEVELS.reduce((s, l) => s + l.w * c[l.key], 0) / c.total;
}

function ratingLabel(score) {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  if (score >= 4.5) return { label: 'Sterk kopen', tone: 'sb' };
  if (score >= 3.75) return { label: 'Kopen', tone: 'b' };
  if (score >= 3.25) return { label: 'Licht kopen', tone: 'lb' };
  if (score >= 2.5) return { label: 'Houden', tone: 'h' };
  if (score >= 1.75) return { label: 'Verkopen', tone: 's' };
  return { label: 'Sterk verkopen', tone: 'ss' };
}

// Laatste rij op of voor een datum (rijen oplopend gesorteerd op date).
function rowAt(rows, date) {
  let out = null;
  for (const r of rows) {
    if (String(r.date).slice(0, 10) <= date) out = r;
    else break;
  }
  return out;
}

const closeAt = (series, date) => {
  const r = rowAt(series, date);
  return r ? Number(r.close) : null;
};

// Laatste koersdoel per analist (of bank) dat op `date` nog geldt: hooguit 12 maanden oud.
function activeTargets(targets, date) {
  const end = new Date(date + 'T23:59:59Z').getTime();
  const start = end - 365 * DAY;
  const latest = new Map();
  for (const t of targets) {
    const ts = new Date(t.published_at).getTime();
    if (ts > end || ts < start || !(Number(t.target) > 0)) continue;
    const k = t.analyst_name ? `${t.firm}|${t.analyst_name}` : t.firm;
    const cur = latest.get(k);
    if (!cur || ts >= cur.ts) latest.set(k, { ts, target: Number(t.target) });
  }
  return [...latest.values()].map((x) => x.target);
}

function consensusAt(targets, date) {
  const v = activeTargets(targets, date);
  if (!v.length) return null;
  return { count: v.length, mean: v.reduce((s, x) => s + x, 0) / v.length, low: Math.min(...v), high: Math.max(...v) };
}

function monthsBack(now, m) {
  const d = new Date(now);
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m, Math.min(d.getUTCDate(), 28)));
}

/**
 * Oordeel, verdeling en koersdoel nu, 1 maand, 3 maanden en 1 jaar geleden.
 * `current` (optioneel) is de actuele adviesverdeling, die wint voor 'Nu'.
 */
function ratingsOverTime({ ratingRows = [], targets = [], series = [], price = null, current = null, now = Date.now() }) {
  const periods = [
    { key: 'nu', label: 'Nu', date: iso(now) },
    { key: '1m', label: '1 maand geleden', date: monthsBack(now, 1) },
    { key: '3m', label: '3 maanden geleden', date: monthsBack(now, 3) },
    { key: '1j', label: '1 jaar geleden', date: monthsBack(now, 12) },
  ];
  return periods.map((p, i) => {
    const r = i === 0 && counts(current) ? current : rowAt(ratingRows, p.date);
    const c = counts(r);
    const cons = consensusAt(targets, p.date);
    const px = i === 0 && price > 0 ? price : closeAt(series, p.date);
    const score = ratingScore(c);
    return {
      ...p,
      counts: c,
      score,
      verdict: ratingLabel(score),
      target: cons ? cons.mean : null,
      analysts: cons ? cons.count : null,
      price: px,
      upside: cons && px > 0 ? cons.mean / px - 1 : null,
    };
  });
}

// Per maand (laatste `months`): slotkoers, gemiddeld/laagste/hoogste koersdoel en adviesverdeling.
function monthly({ ratingRows = [], targets = [], series = [], months = 24, now = Date.now() }) {
  const d = new Date(now);
  const out = [];
  for (let m = months - 1; m >= 0; m--) {
    const isNow = m === 0;
    const end = isNow ? iso(now) : iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m + 1, 0));
    const cons = consensusAt(targets, end);
    // Adviezen: de laatste stand binnen die maand.
    const monthStart = end.slice(0, 8) + '01';
    const r = rowAt(ratingRows, end);
    const inMonth = r && String(r.date).slice(0, 10) >= monthStart;
    out.push({
      month: end.slice(0, 7),
      date: end,
      close: closeAt(series, end),
      mean: cons ? cons.mean : null,
      low: cons ? cons.low : null,
      high: cons ? cons.high : null,
      analysts: cons ? cons.count : 0,
      ratings: inMonth ? counts(r) : null,
    });
  }
  return out;
}

// Adviesterm van een bank naar één van de vijf niveaus (voor kleur en richting).
function gradeLevel(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/strong buy|conviction buy|top pick/.test(t)) return 5;
  if (/strong sell/.test(t)) return 1;
  if (/underperform|underweight|sell|reduce|negative/.test(t)) return 2;
  if (/outperform|overweight|buy|accumulate|positive|add\b/.test(t)) return 4;
  if (/hold|neutral|market perform|sector perform|equal|peer perform|in-line|inline|perform|mixed/.test(t)) return 3;
  return null;
}

const firmKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7);

function actionOf(g) {
  const a = String(g.action || '').toLowerCase();
  if (a.startsWith('up')) return { label: 'Upgrade', tone: 'pos' };
  if (a.startsWith('down')) return { label: 'Downgrade', tone: 'neg' };
  if (a.startsWith('init') || a === 'initiate' || a === 'initialise') return { label: 'Gestart', tone: 'new' };
  return { label: 'Herhaald', tone: 'neutral' };
}

/**
 * Up/downgrades en koersdoelen samenvoegen tot één lijst met acties.
 * grades: [{published_at, grading_company, previous_grade, new_grade, action}]
 * targets: [{published_at, analyst_firm, analyst_name, analyst_slug, price_target, prev_target, score}]
 */
function mergeActions(grades = [], targets = [], price = null, limit = 30) {
  const used = new Set();
  const out = [];
  for (const g of grades) {
    const gt = new Date(g.published_at).getTime();
    const fk = firmKey(g.grading_company);
    let match = null;
    targets.forEach((t, i) => {
      if (used.has(i) || !fk || firmKey(t.analyst_firm) !== fk) return;
      if (g.symbol && t.symbol && g.symbol !== t.symbol) return;
      if (Math.abs(new Date(t.published_at).getTime() - gt) <= 1.5 * DAY && !match) match = { t, i };
    });
    if (match) used.add(match.i);
    const t = match && match.t;
    const target = t ? Number(t.price_target) : null;
    out.push({
      symbol: g.symbol,
      date: g.published_at,
      action: actionOf(g),
      firm: g.grading_company,
      analyst: t ? t.analyst_name : null,
      analyst_slug: t ? t.analyst_slug : null,
      score: t ? t.score : null,
      from_grade: g.previous_grade && g.previous_grade !== g.new_grade ? g.previous_grade : null,
      to_grade: g.new_grade,
      level: gradeLevel(g.new_grade),
      from_target: t && t.prev_target && Number(t.prev_target) !== target ? Number(t.prev_target) : null,
      to_target: target,
      upside: target > 0 && price > 0 ? target / price - 1 : null,
    });
  }
  targets.forEach((t, i) => {
    if (used.has(i)) return;
    const target = Number(t.price_target);
    const prev = t.prev_target ? Number(t.prev_target) : null;
    const action = !prev
      ? { label: 'Gestart', tone: 'new' }
      : target > prev
        ? { label: 'Doel omhoog', tone: 'pos-soft' }
        : target < prev
          ? { label: 'Doel omlaag', tone: 'neg-soft' }
          : { label: 'Herhaald', tone: 'neutral' };
    out.push({
      symbol: t.symbol,
      date: t.published_at,
      action,
      firm: t.analyst_firm,
      analyst: t.analyst_name,
      analyst_slug: t.analyst_slug,
      score: t.score,
      from_grade: null,
      to_grade: null,
      level: null,
      from_target: prev && prev !== target ? prev : null,
      to_target: target > 0 ? target : null,
      upside: target > 0 && price > 0 ? target / price - 1 : null,
    });
  });
  return out.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);
}

// Gemiddelden voor sector en markt uit per-aandeelrijen [{symbol, sector, strong_buy.., upside, n}].
function benchmarks(rows) {
  const agg = () => ({ scores: [], ups: [], ns: [] });
  const market = agg();
  const sectors = new Map();
  for (const r of rows) {
    const s = ratingScore(r);
    if (s === null) continue;
    const buckets = [market];
    if (r.sector) {
      if (!sectors.has(r.sector)) sectors.set(r.sector, agg());
      buckets.push(sectors.get(r.sector));
    }
    for (const b of buckets) {
      b.scores.push(s);
      if (Number.isFinite(Number(r.upside)) && r.upside !== null && Math.abs(Number(r.upside)) < 3) b.ups.push(Number(r.upside));
      if (Number(r.n) > 0) b.ns.push(Number(r.n));
    }
  }
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const sum = (b) => ({
    stocks: b.scores.length,
    score: b.scores.length ? b.scores.reduce((x, y) => x + y, 0) / b.scores.length : null,
    upside: median(b.ups),
    analysts: median(b.ns),
  });
  const out = { market: sum(market), sectors: {} };
  for (const [k, b] of sectors) if (b.scores.length >= 3) out.sectors[k] = sum(b);
  return out;
}

module.exports = { LEVELS, counts, ratingScore, ratingLabel, rowAt, closeAt, activeTargets, consensusAt, ratingsOverTime, monthly, gradeLevel, mergeActions, benchmarks };
