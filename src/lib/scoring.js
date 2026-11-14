'use strict';

// GuruScore: open en uitlegbare methode om analisten te beoordelen.
//
// Per koersdoel ("call"):
//   - startkoers p0 = slotkoers op de publicatiedag (zelfde koersreeks als de eindkoers)
//   - verwacht potentieel u = koersdoel / koers bij publicatie - 1
//   - richting = omhoog als u > 0, omlaag als u < 0 (doelen binnen ±1% tellen niet mee)
//   - horizon = 12 maanden na publicatie (of tot vandaag als die nog loopt)
//   - trefkans: heeft de slotkoers het koersdoel binnen de horizon geraakt?
//   - rendement: koersverandering in de richting van het advies
//   - overrendement: rendement minus dat van de benchmark (S&P 500, via SPY)
//
// Per analist of bank:
//   - recente calls wegen zwaarder (halfwaardetijd ~1,4 jaar)
//   - kleine aantallen worden naar het gemiddelde getrokken (Bayesiaans), zodat iemand
//     met 3 gelukkige calls niet boven iemand met 200 goede calls eindigt
//   - GuruScore = 40% trefkans + 40% overrendement (beide als percentiel t.o.v. alle
//     analisten) + 20% betrouwbaarheid (aantal calls, vol bij 50+)

const DAY = 864e5;
const HORIZON_DAYS = 365;
const MIN_AGE_DAYS = 30;
const NEUTRAL_BAND = 0.01;
const MAX_ABS_UPSIDE = 3;
const SHRINK_K = 5;
const RECENCY_HALF_LIFE_YEARS = 1.4;

const toDate = (d) => (d instanceof Date ? d : new Date(d));
const iso = (d) => toDate(d).toISOString().slice(0, 10);

// Binaire zoektocht: eerste index met date >= d.
function indexOnOrAfter(series, d) {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Laatste index met date <= d.
function indexOnOrBefore(series, d) {
  return indexOnOrAfter(series, d + '￿') - 1;
}

/**
 * Beoordeel één koersdoel.
 * @param call {published_at, price_target, price_when_posted}
 * @param series gesorteerde [{date:'YYYY-MM-DD', close:number}] voor het aandeel
 * @param bench idem voor de benchmark (mag leeg zijn)
 * @param today Date
 */
function evaluateCall(call, series, bench, today = new Date()) {
  if (!series || series.length < 2) return null;
  const pub = toDate(call.published_at);
  if ((today - pub) / DAY < MIN_AGE_DAYS) return null;

  const pubDay = iso(pub);
  const i0 = indexOnOrAfter(series, pubDay);
  if (i0 >= series.length) return null;
  // Startkoers mag hooguit 5 dagen na publicatie liggen (weekend/feestdag).
  if ((new Date(series[i0].date) - new Date(pubDay)) / DAY > 5) return null;
  const p0 = Number(series[i0].close);
  if (!(p0 > 0)) return null;

  const target = Number(call.price_target);
  const pwp = Number(call.price_when_posted);
  if (!(target > 0)) return null;
  const upside = pwp > 0 ? target / pwp - 1 : target / p0 - 1;
  if (!Number.isFinite(upside) || Math.abs(upside) > MAX_ABS_UPSIDE || Math.abs(upside) < NEUTRAL_BAND) return null;
  const direction = upside > 0 ? 1 : -1;
  // Doel omrekenen naar de koersreeks (vangt splits en afwijkende publicatiekoersen op).
  const targetAdj = p0 * (1 + upside);

  const horizonDay = iso(new Date(pub.getTime() + HORIZON_DAYS * DAY));
  const lastDay = series[series.length - 1].date;
  const complete = horizonDay <= lastDay;
  const iEnd = complete ? indexOnOrBefore(series, horizonDay) : series.length - 1;
  if (iEnd <= i0) return null;

  let hit = false;
  let daysToHit = null;
  for (let i = i0 + 1; i <= iEnd; i++) {
    const c = Number(series[i].close);
    if ((direction > 0 && c >= targetAdj) || (direction < 0 && c <= targetAdj)) {
      hit = true;
      daysToHit = Math.round((new Date(series[i].date) - new Date(series[i0].date)) / DAY);
      break;
    }
  }

  const pEnd = Number(series[iEnd].close);
  const rawRet = pEnd / p0 - 1;
  const ret = direction * rawRet;

  let benchRet = null;
  let excess = null;
  if (bench && bench.length) {
    const b0i = indexOnOrAfter(bench, series[i0].date);
    const b1i = indexOnOrBefore(bench, series[iEnd].date);
    if (b0i < bench.length && b1i > b0i) {
      benchRet = Number(bench[b1i].close) / Number(bench[b0i].close) - 1;
      excess = direction * (rawRet - benchRet);
    }
  }

  return {
    direction,
    p0,
    target: targetAdj,
    horizon_end: series[iEnd].date,
    p_end: pEnd,
    bench_ret: benchRet,
    ret,
    excess,
    hit,
    days_to_hit: daysToHit,
    complete,
  };
}

// Gewogen statistieken voor een groep calls (één analist of bank).
function aggregate(results, today = new Date()) {
  let sw = 0;
  let hit = 0;
  let ret = 0;
  let exc = 0;
  let excW = 0;
  let succ = 0;
  for (const r of results) {
    const ageYears = (today - toDate(r.published_at)) / DAY / 365;
    const w = Math.pow(0.5, ageYears / RECENCY_HALF_LIFE_YEARS);
    sw += w;
    hit += w * (r.hit ? 1 : 0);
    ret += w * Number(r.ret);
    if (r.excess !== null && r.excess !== undefined) {
      exc += w * Number(r.excess);
      excW += w;
    }
    succ += w * ((r.excess ?? r.ret) > 0 ? 1 : 0);
  }
  return {
    calls: results.length,
    weight: sw,
    hit_rate: sw ? hit / sw : null,
    avg_return: sw ? ret / sw : null,
    avg_excess: excW ? exc / excW : null,
    success_rate: sw ? succ / sw : null,
  };
}

// Percentiel (0..1) van een waarde binnen een verzameling, met midrank bij gelijke waarden.
function percentileRanks(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const lowerBound = (v) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (v) => {
    if (n === 0) return 0.5;
    const less = lowerBound(v);
    let eq = less;
    while (eq < n && sorted[eq] === v) eq++;
    return (less + (eq - less) / 2) / n;
  };
}

/**
 * Bereken GuruScores voor groepen.
 * @param groups Map<ref, results[]>
 * @returns [{ref, calls, hit_rate, avg_return, avg_excess, success_rate, score, rank}]
 */
function computeScores(groups, today = new Date()) {
  const stats = [];
  for (const [ref, results] of groups) {
    if (!results.length) continue;
    stats.push({ ref, ...aggregate(results, today) });
  }
  if (!stats.length) return [];

  // Prior: gewogen gemiddelde over iedereen.
  const totW = stats.reduce((s, x) => s + x.weight, 0);
  const prior = {
    hit: stats.reduce((s, x) => s + (x.hit_rate ?? 0) * x.weight, 0) / totW,
    exc: stats.reduce((s, x) => s + (x.avg_excess ?? x.avg_return ?? 0) * x.weight, 0) / totW,
  };
  for (const s of stats) {
    s.hit_adj = (s.weight * (s.hit_rate ?? 0) + SHRINK_K * prior.hit) / (s.weight + SHRINK_K);
    s.exc_adj = (s.weight * (s.avg_excess ?? s.avg_return ?? 0) + SHRINK_K * prior.exc) / (s.weight + SHRINK_K);
  }
  const basis = stats.filter((s) => s.calls >= 3);
  const ref = basis.length >= 2 ? basis : stats;
  const pHit = percentileRanks(ref.map((s) => s.hit_adj));
  const pExc = percentileRanks(ref.map((s) => s.exc_adj));

  for (const s of stats) {
    const reliability = Math.min(1, Math.log(1 + s.calls) / Math.log(1 + 50));
    s.score = Math.round(100 * (0.4 * clamp01(pHit(s.hit_adj)) + 0.4 * clamp01(pExc(s.exc_adj)) + 0.2 * reliability));
  }
  stats.sort((a, b) => b.score - a.score || b.calls - a.calls);
  stats.forEach((s, i) => (s.rank = i + 1));
  return stats.map(({ ref: r, calls, hit_rate, avg_return, avg_excess, success_rate, score, rank }) => ({
    ref: r,
    calls,
    hit_rate,
    avg_return,
    avg_excess,
    success_rate,
    score,
    rank,
  }));
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Consensus over het laatste koersdoel per analist (binnen 12 maanden).
function consensus(latestTargets, price, { topScore = 70 } = {}) {
  const vals = latestTargets.map((t) => Number(t.price_target)).filter((v) => v > 0).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const median = (a) => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
  const top = latestTargets.filter((t) => Number(t.score) >= topScore && Number(t.price_target) > 0).map((t) => Number(t.price_target));
  const out = {
    count: vals.length,
    mean: mean(vals),
    median: median(vals),
    low: vals[0],
    high: vals[vals.length - 1],
    topCount: top.length,
    topMean: top.length ? mean(top) : null,
  };
  if (price > 0) {
    out.upside = out.mean / price - 1;
    out.topUpside = out.topMean ? out.topMean / price - 1 : null;
  }
  return out;
}

module.exports = { evaluateCall, aggregate, computeScores, consensus, percentileRanks, HORIZON_DAYS, MIN_AGE_DAYS };
