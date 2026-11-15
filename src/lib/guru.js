'use strict';

// Rekenwerk voor de gurupagina's op basis van 13F-kwartalen.
// holdings: [{period:'YYYY-MM-DD', cusip, symbol, issuer, put_call, shares, value, weight}]

const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const keyOf = (h) => h.symbol || h.cusip;

const { canonical } = require('./shareClasses');

// Groepeer per kwartaal (oplopend), alleen longposities in aandelen; klassen van hetzelfde bedrijf samengevoegd.
function byPeriod(holdings) {
  const map = new Map();
  for (const h of holdings) {
    if (h.put_call) continue;
    const p = iso(h.period);
    if (!map.has(p)) map.set(p, new Map());
    const rows = map.get(p);
    const c = canonical(h.symbol);
    const r = { ...h, value: Number(h.value) || 0, weight: Number(h.weight) || 0, shares: Number(h.shares) || 0 };
    if (c) { r.symbol = c.symbol; r.shares *= c.ratio; }
    const k = keyOf(r);
    const prev = rows.get(k);
    if (!prev) rows.set(k, r);
    else {
      // Hoofdklasse houdt naam/cusip; waarde, gewicht en aantal tellen op.
      const main = c ? { ...prev } : { ...r };
      main.value = prev.value + r.value;
      main.weight = prev.weight + r.weight;
      main.shares = prev.shares + r.shares;
      rows.set(k, main);
    }
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([period, rows]) => ({ period, rows: [...rows.values()].sort((a, b) => b.value - a.value) }));
}

// Waarde en aantal posities per kwartaal (uit de tabel funds/fund_holdings).
function valueSeries(quarters) {
  return quarters.map((q) => ({ period: q.period, value: q.rows.reduce((s, r) => s + r.value, 0), positions: q.rows.length }));
}

// Heatmap: gewicht van de grootste posities door de kwartalen heen.
function heatmap(quarters, { top = 15, last = 8 } = {}) {
  const qs = quarters.slice(-last);
  if (!qs.length) return { periods: [], rows: [] };
  const latest = qs[qs.length - 1].rows;
  // Grootste huidige posities, aangevuld met posities die eerder groot waren.
  const score = new Map();
  qs.forEach((q, i) => q.rows.forEach((r) => {
    const k = keyOf(r);
    score.set(k, Math.max(score.get(k) || 0, r.weight * (i === qs.length - 1 ? 1.5 : 1)));
  }));
  const keys = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map((x) => x[0]);
  const meta = new Map();
  for (const q of qs) for (const r of q.rows) if (!meta.has(keyOf(r))) meta.set(keyOf(r), { symbol: r.symbol, issuer: r.issuer });
  for (const r of latest) meta.set(keyOf(r), { symbol: r.symbol, issuer: r.issuer });
  const rows = keys.map((k) => ({
    key: k,
    ...meta.get(k),
    cells: qs.map((q) => {
      const r = q.rows.find((x) => keyOf(x) === k);
      return r ? r.weight : 0;
    }),
  }));
  return { periods: qs.map((q) => q.period), rows };
}

// Aankopen en verkopen van het laatste kwartaal met hun impact op de portefeuille.
function moves(quarters) {
  if (quarters.length < 2) return { buys: [], sells: [], turnover: null };
  const cur = quarters[quarters.length - 1].rows;
  const prev = quarters[quarters.length - 2].rows;
  const pm = new Map(prev.map((r) => [keyOf(r), r]));
  const cm = new Map(cur.map((r) => [keyOf(r), r]));
  const out = [];
  for (const r of cur) {
    const p = pm.get(keyOf(r));
    const ps = p ? p.shares : 0;
    if (!p) out.push({ ...r, kind: 'new', change_pct: null, impact: r.weight, prev_weight: 0 });
    else if (r.shares > ps * 1.001) out.push({ ...r, kind: 'added', change_pct: r.shares / ps - 1, impact: r.weight * (1 - ps / r.shares), prev_weight: p.weight });
    else if (r.shares < ps * 0.999) out.push({ ...r, kind: 'reduced', change_pct: r.shares / ps - 1, impact: -(p.weight * (1 - r.shares / ps)), prev_weight: p.weight });
  }
  for (const p of prev) {
    if (!cm.has(keyOf(p))) out.push({ ...p, kind: 'sold', change_pct: -1, impact: -p.weight, prev_weight: p.weight, weight: 0, value: 0 });
  }
  const buys = out.filter((m) => m.impact > 0).sort((a, b) => b.impact - a.impact);
  const sells = out.filter((m) => m.impact < 0).sort((a, b) => a.impact - b.impact);
  const turnover = out.reduce((s, m) => s + Math.abs(m.impact), 0) / 2;
  return { buys, sells, turnover };
}

// Sectorverdeling van een kwartaal: [{label, value, weight}].
function sectors(rows, sectorOf) {
  const map = new Map();
  let total = 0;
  for (const r of rows) {
    const s = (r.symbol && sectorOf.get(r.symbol)) || 'Overig / onbekend';
    map.set(s, (map.get(s) || 0) + r.value);
    total += r.value;
  }
  return [...map.entries()].map(([label, value]) => ({ label, value, weight: total ? value / total : 0 })).sort((a, b) => b.value - a.value);
}

function closeOn(series, date) {
  if (!series || !series.length) return null;
  let lo = 0;
  let hi = series.length - 1;
  if (series[0].date > date) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid].date <= date) lo = mid;
    else hi = mid - 1;
  }
  return Number(series[lo].close);
}

/**
 * Hypothetisch rendement: koop elk kwartaal de 13F-portefeuille na op de dag dat die openbaar
 * wordt (45 dagen na het kwartaaleinde) en houd die vast tot de volgende filing.
 * prices: Map(symbol -> [{date, close}] oplopend); bench: [{date, close}] (SPY).
 * Alleen posities met koersdata tellen mee (gewichten opnieuw verdeeld).
 */
function hypothetical(quarters, prices, bench, { today = new Date(), top = 25 } = {}) {
  const points = [];
  let v = 1;
  let b = 1;
  let coveredSum = 0;
  let steps = 0;
  for (let i = 0; i < quarters.length; i++) {
    const start = iso(new Date(quarters[i].period).getTime() + 45 * DAY);
    const end = i + 1 < quarters.length ? iso(new Date(quarters[i + 1].period).getTime() + 45 * DAY) : iso(today);
    if (start >= end) continue;
    const rows = quarters[i].rows.filter((r) => r.symbol).slice(0, top);
    let wsum = 0;
    let ret = 0;
    for (const r of rows) {
      const s = prices.get(r.symbol);
      const p0 = closeOn(s, start);
      const p1 = closeOn(s, end);
      if (!(p0 > 0 && p1 > 0)) continue;
      wsum += r.weight;
      ret += r.weight * (p1 / p0 - 1);
    }
    const b0 = closeOn(bench, start);
    const b1 = closeOn(bench, end);
    if (!wsum || !(b0 > 0 && b1 > 0)) continue;
    if (!points.length) points.push({ date: start, value: 1, bench: 1 });
    v *= 1 + ret / wsum;
    b *= b1 / b0;
    coveredSum += wsum / rows.reduce((s, r) => s + r.weight, 0 || 1);
    steps++;
    points.push({ date: end, value: v, bench: b });
  }
  if (points.length < 2) return null;
  const years = (new Date(points[points.length - 1].date) - new Date(points[0].date)) / DAY / 365;
  return {
    points,
    total: v - 1,
    benchTotal: b - 1,
    annual: years > 0.5 ? Math.pow(v, 1 / years) - 1 : null,
    benchAnnual: years > 0.5 ? Math.pow(b, 1 / years) - 1 : null,
    since: points[0].date,
    coverage: steps ? coveredSum / steps : null,
  };
}

module.exports = { canonical, byPeriod, valueSeries, heatmap, moves, sectors, hypothetical, closeOn };
