// Extra visualisaties voor analisten, insiders en de homepage (server-side SVG).
'use strict';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, d = 0) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d).replace('.', ',')}%`;

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) || mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// Kleur bij een GuruScore: rood (laag) via amber naar groen (hoog).
function scoreColor(s) {
  const v = Math.max(0, Math.min(100, Number(s) || 0)) / 100;
  const stops = [[0, [211, 47, 47]], [0.45, [217, 119, 6]], [0.7, [40, 86, 217]], [1, [14, 159, 110]]];
  let i = 0;
  while (i < stops.length - 2 && v > stops[i + 1][0]) i++;
  const [a, ca] = stops[i];
  const [b, cb] = stops[i + 1];
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  const c = ca.map((x, k) => Math.round(x + (cb[k] - x) * t));
  return `rgb(${c.join(',')})`;
}

const median = (arr) => {
  const s = arr.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Analistenkaart: trefkans (x) tegen rendement boven de S&P 500 (y).
 * points: [{x, y, calls, score, label, sub, href}]; de beste `labels` krijgen een naam.
 */
function analystMap(points, { width = 920, height = 420, labels = 8 } = {}) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 5) return '';
  const narrow = width < 600;
  const pad = { l: narrow ? 40 : 50, r: 14, t: 14, b: 40 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const ycl = (v) => Math.max(-0.4, Math.min(0.6, v));
  const ys = pts.map((p) => ycl(p.y));
  const ymin = Math.min(-0.05, ...ys) - 0.03;
  const ymax = Math.max(0.1, ...ys) + 0.03;
  const xmin = Math.max(0, Math.min(...pts.map((p) => p.x)) - 0.04);
  const xmax = Math.min(1, Math.max(...pts.map((p) => p.x)) + 0.04);
  const X = (v) => pad.l + ((v - xmin) / (xmax - xmin || 1)) * W;
  const Y = (v) => pad.t + (1 - (ycl(v) - ymin) / (ymax - ymin)) * H;
  const cmax = Math.max(...pts.map((p) => p.calls || 1));
  const R = (c) => (narrow ? 2.5 : 3) + Math.sqrt((c || 1) / cmax) * (narrow ? 7 : 11);
  const mx = median(pts.map((p) => p.x));
  const my = median(pts.map((p) => p.y));
  const xt = niceTicks(xmin, xmax, narrow ? 4 : 6);
  const yt = niceTicks(ymin, ymax, 5);
  const grid = [
    ...xt.map((t) => `<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${pad.t}" y2="${pad.t + H}" class="gc-grid faint"/><text x="${X(t).toFixed(1)}" y="${pad.t + H + 16}" text-anchor="middle" class="gc-ax">${Math.round(t * 100)}%</text>`),
    ...yt.map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="gc-grid${Math.abs(t) < 1e-9 ? ' zero' : ' faint'}"/><text x="${pad.l - 7}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="gc-ax">${pct(t)}</text>`),
  ].join('');
  // Kwadrant "vaak raak én beter dan de markt" licht gekleurd.
  const best = `<rect x="${X(mx).toFixed(1)}" y="${pad.t}" width="${(pad.l + W - X(mx)).toFixed(1)}" height="${Math.max(0, Y(Math.max(my, 0)) - pad.t).toFixed(1)}" class="am-best" rx="6"/>`;
  const med = `<line x1="${X(mx).toFixed(1)}" x2="${X(mx).toFixed(1)}" y1="${pad.t}" y2="${pad.t + H}" class="am-med"/>`;
  const sorted = pts.slice().sort((a, b) => (a.score || 0) - (b.score || 0));
  const top = new Set(pts.slice().sort((a, b) => (b.score || 0) - (a.score || 0) || (b.calls || 0) - (a.calls || 0)).slice(0, labels));
  const dots = sorted.map((p) => {
    const r = R(p.calls);
    const fill = scoreColor(p.score);
    const t = `${p.label}${p.sub ? ' · ' + p.sub : ''} — GuruScore ${Math.round(p.score || 0)}, trefkans ${Math.round(p.x * 100)}%, ${pct(p.y, 1)} vs S&P, ${p.calls} adviezen`;
    return `<a href="${esc(p.href || '#')}"><circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${r.toFixed(1)}" class="am-dot${top.has(p) ? ' top' : ''}" style="fill:${fill}"><title>${esc(t)}</title></circle></a>`;
  }).join('');
  // Namen bij de beste analisten, maar alleen waar ze niet over een ander label vallen.
  const placed = [];
  const lbls = narrow ? '' : [...top].map((p) => {
    const r = R(p.calls);
    const right = X(p.x) > pad.l + W * 0.8;
    const w = String(p.label).length * 6.2;
    const x = X(p.x) + (right ? -(r + 4) : r + 4);
    const box = { x0: right ? x - w : x, x1: right ? x : x + w, y0: Y(p.y) - 8, y1: Y(p.y) + 6 };
    if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) return '';
    placed.push(box);
    return `<text x="${x.toFixed(1)}" y="${(Y(p.y) + 4).toFixed(1)}" class="am-l"${right ? ' text-anchor="end"' : ''}>${esc(p.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="gc am" role="img" aria-label="Analisten: trefkans tegenover rendement boven de S&amp;P 500">
    ${best}${grid}${med}
    <text x="${pad.l + W - 8}" y="${pad.t + 16}" text-anchor="end" class="bb-q">Vaak raak · verslaat de markt</text>
    <text x="${pad.l + 8}" y="${pad.t + H - 8}" class="bb-q">Zelden raak · blijft achter</text>
    ${dots}${lbls}
    <text x="${pad.l + W / 2}" y="${height - 4}" text-anchor="middle" class="gc-ax gc-axt">trefkans (koersdoel gehaald binnen 12 maanden) →</text>
  </svg>`;
}

// Histogram van GuruScores: 10 kolommen met kleur per score en aantallen erboven.
function scoreHistogram(buckets, { width = 460, height = 190 } = {}) {
  if (!buckets.some((n) => n > 0)) return '';
  const pad = { l: 4, r: 4, t: 18, b: 22 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const max = Math.max(...buckets);
  const bw = W / buckets.length;
  const cols = buckets.map((n, i) => {
    const h = max ? (n / max) * H : 0;
    const x = pad.l + i * bw + 3;
    const y = pad.t + H - h;
    return `<g><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${Math.max(2, h).toFixed(1)}" rx="5" style="fill:${scoreColor(i * 10 + 5)}" class="sh-col"><title>GuruScore ${i * 10}–${i * 10 + 10}: ${n} analisten</title></rect>${n ? `<text x="${(x + (bw - 6) / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" class="sh-n">${n}</text>` : ''}</g>`;
  }).join('');
  const ax = [0, 25, 50, 75, 100].map((t) => `<text x="${(pad.l + (t / 100) * W).toFixed(1)}" y="${height - 5}" text-anchor="${t === 0 ? 'start' : t === 100 ? 'end' : 'middle'}" class="gc-ax">${t}</text>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="gc sh" role="img" aria-label="Verdeling van GuruScores">${cols}${ax}</svg>`;
}

// Halve meter voor de marktstemming: share = aandeel positief (0..1).
function moodGauge(share, { width = 200, label = '' } = {}) {
  const v = Math.max(0, Math.min(1, Number(share) || 0));
  const cx = width / 2;
  const r = width / 2 - 12;
  const h = r + 22;
  const arc = (a0, a1) => {
    const p = (a) => [cx + r * Math.cos(Math.PI * (1 - a)), r + 10 - r * Math.sin(Math.PI * (1 - a))];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const segs = [[0, 0.35, 'mg-neg'], [0.35, 0.5, 'mg-lneg'], [0.5, 0.65, 'mg-lpos'], [0.65, 1, 'mg-pos']]
    .map(([a, b, c]) => `<path d="${arc(a + 0.006, b - 0.006)}" class="mg-seg ${c}"/>`).join('');
  const ang = Math.PI * (1 - v);
  const nx = cx + (r - 4) * Math.cos(ang);
  const ny = r + 10 - (r - 4) * Math.sin(ang);
  return `<svg viewBox="0 0 ${width} ${h}" class="mg" role="img" aria-label="${esc(label)}">
    ${segs}
    <line x1="${cx}" y1="${r + 10}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" class="mg-needle"/>
    <circle cx="${cx}" cy="${r + 10}" r="5" class="mg-hub"/>
  </svg>`;
}

module.exports = { analystMap, scoreHistogram, moodGauge, scoreColor };
