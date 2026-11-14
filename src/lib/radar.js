'use strict';

// Rekenregels voor de radar en screeners. Puur (geen database), zodat ze te testen zijn.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Beurswaarde-klassen (in dollars).
const CAPS = [
  { key: 'mega', label: 'Mega (> $200 mld)', min: 200e9, max: Infinity },
  { key: 'large', label: 'Groot ($10–200 mld)', min: 10e9, max: 200e9 },
  { key: 'mid', label: 'Middel ($2–10 mld)', min: 2e9, max: 10e9 },
  { key: 'small', label: 'Klein (< $2 mld)', min: 0, max: 2e9 },
];
const capRange = (key) => CAPS.find((c) => c.key === key) || null;

// Momentum: hoe sterk verbetert het analistensentiment?
// Koersdoelverhogingen en upgrades tellen positief, verlagingen en downgrades negatief.
// Gemiddelde koersdoelwijziging en (zodra beschikbaar) winstherzieningen geven extra gewicht.
function momentumScore(r) {
  const raises = num(r.raises) || 0;
  const cuts = num(r.cuts) || 0;
  const ups = num(r.ups) || 0;
  const downs = num(r.downs) || 0;
  const avgChange = num(r.avg_change);
  const epsRev = num(r.eps_rev);
  let s = raises - cuts + 2 * (ups - downs);
  if (avgChange !== null && Number.isFinite(avgChange)) s += clamp(avgChange * 20, -3, 3);
  if (epsRev !== null && Number.isFinite(epsRev)) s += clamp(epsRev * 50, -3, 3);
  return Math.round(s * 10) / 10;
}

// Kuddegedrag: minstens drie analisten in één week dezelfde kant op, en vrijwel niemand andersom.
function herd(r) {
  const up = num(r.h_up) || 0;
  const down = num(r.h_down) || 0;
  if (up >= 3 && up >= 3 * down) return 'up';
  if (down >= 3 && down >= 3 * up) return 'down';
  return null;
}

// Consensus surprise: koers en analistenverwachting lopen uiteen.
// priceChg en targetChg als fractie (bijv. -0.3 = -30%).
function surprise(priceChg, targetChg) {
  if (!Number.isFinite(priceChg) || !Number.isFinite(targetChg)) return null;
  if (priceChg <= -0.2 && targetChg > -0.05) return 'koers-daalt';
  if (priceChg >= 0.15 && targetChg < 0) return 'koers-stijgt';
  if (targetChg >= 0.1 && priceChg <= 0) return 'doelen-stijgen';
  if (targetChg <= -0.1 && priceChg >= 0) return 'doelen-dalen';
  return null;
}

// Aandeel kopen-adviezen in de verdeling.
function bullShare(r) {
  const sb = num(r.strong_buy) || 0;
  const b = num(r.buy) || 0;
  const h = num(r.hold) || 0;
  const s = num(r.sell) || 0;
  const ss = num(r.strong_sell) || 0;
  const total = sb + b + h + s + ss;
  if (!total) return { total: 0, bull: null, bear: null };
  return { total, bull: (sb + b) / total, bear: (s + ss) / total };
}

// Klassen voor de contrair-backtest (aandeel kopen-adviezen).
const SENTIMENT_BUCKETS = [
  { key: 'b0', label: '< 30% kopen', min: 0, max: 0.3 },
  { key: 'b1', label: '30–50%', min: 0.3, max: 0.5 },
  { key: 'b2', label: '50–70%', min: 0.5, max: 0.7 },
  { key: 'b3', label: '70–90%', min: 0.7, max: 0.9 },
  { key: 'b4', label: '≥ 90% kopen', min: 0.9, max: 1.0001 },
];
const bucketFor = (bull) => SENTIMENT_BUCKETS.find((b) => bull >= b.min && bull < b.max) || null;

// Vat de backtest samen: per klasse het gemiddelde en mediane rendement na 12 maanden
// ten opzichte van de S&P 500, en hoe vaak het aandeel de index versloeg.
// obs: [{ bull, excess }]
function summarizeBacktest(obs) {
  const groups = new Map(SENTIMENT_BUCKETS.map((b) => [b.key, []]));
  for (const o of obs) {
    if (!Number.isFinite(o.bull) || !Number.isFinite(o.excess)) continue;
    const b = bucketFor(o.bull);
    if (b) groups.get(b.key).push(o.excess);
  }
  return SENTIMENT_BUCKETS.map((b) => {
    const xs = groups.get(b.key).sort((x, y) => x - y);
    const n = xs.length;
    const mean = n ? xs.reduce((s, x) => s + x, 0) / n : null;
    const median = n ? (n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2) : null;
    const beat = n ? xs.filter((x) => x > 0).length / n : null;
    return { key: b.key, label: b.label, n, mean, median, beat };
  });
}

module.exports = { CAPS, capRange, momentumScore, herd, surprise, bullShare, SENTIMENT_BUCKETS, bucketFor, summarizeBacktest };
