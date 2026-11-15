'use strict';

// Grafieken voor de gurupagina's (server-side SVG, schaalt mee met de breedte).
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Vaste kleurenreeks in Guruwatch-stijl: navy en rood eerst, daarna goed te onderscheiden tinten.
const PALETTE = ['#1d2f57', '#d32f2f', '#2856d9', '#0e9f6e', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#65a30d', '#94a3b8'];

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const qLabel = (iso) => { const d = new Date(iso); return `Q${Math.floor(d.getUTCMonth() / 3) + 1} '${String(d.getUTCFullYear()).slice(2)}`; };
const money = (v) => {
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(1).replace('.', ',')} bln`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(a >= 1e11 ? 0 : 1).replace('.', ',')} mld`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(0)} mln`;
  return `$${Math.round(v / 1e3)}k`;
};
const pct = (v, d = 1) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d).replace('.', ',')}%`;

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) || mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// Waarde van de portefeuille per kwartaal: vlak met verloop, punten en de waarde bij de laatste stip.
function valueArea(series, { width = 620, height = 220 } = {}) {
  const pts = series.filter((s) => s.value > 0);
  if (pts.length < 2) return '';
  const pad = { l: 8, r: 64, t: 18, b: 26 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const hasB = pts.filter((p) => p.bench > 0).length >= 2;
  const max = Math.max(...pts.map((p) => p.value), ...(hasB ? pts.map((p) => p.bench || 0) : [])) * 1.08;
  const X = (i) => pad.l + (i / (pts.length - 1)) * W;
  const Y = (v) => pad.t + H - (v / max) * H;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${X(pts.length - 1).toFixed(1)},${pad.t + H} L${pad.l},${pad.t + H} Z`;
  const ticks = niceTicks(0, max, 3).filter((t) => t > 0);
  const every = Math.ceil(pts.length / 6);
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" class="gc gc-area" role="img" aria-label="Waarde van de portefeuille per kwartaal">
    <defs><linearGradient id="gaFill${width}x${height}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--pos)" stop-opacity=".22"/><stop offset="1" stop-color="var(--pos)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="gc-grid"/><text x="${pad.l + W + 8}" y="${(Y(t) + 4).toFixed(1)}" class="gc-ax">${money(t)}</text>`).join('')}
    <path d="${area}" fill="url(#gaFill${width}x${height})"/>
    ${hasB ? `<path d="${pts.map((p, i) => (p.bench > 0 ? `${i && pts[i - 1].bench > 0 ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.bench).toFixed(1)}` : '')).join(' ')}" class="gc-bench"/>` : ''}
    <path d="${line}" class="gc-line"/>
    ${pts.map((p, i) => `<g class="gc-pt"><circle cx="${X(i).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="${i === pts.length - 1 ? 5 : pts.length > 16 ? 2.4 : 3.2}"/><title>${qLabel(p.period)}: ${money(p.value)} · ${p.positions} posities${p.bench > 0 ? `\nS&amp;P 500 met dezelfde start: ${money(p.bench)}` : ''}</title></g>`).join('')}
    ${pts.map((p, i) => ((i % every === 0 && pts.length - 1 - i >= every * 0.6) || i === pts.length - 1 ? `<text x="${X(i).toFixed(1)}" y="${height - 6}" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}" class="gc-ax">${qLabel(p.period)}</text>` : '')).join('')}
    <text x="${(X(pts.length - 1) - 8).toFixed(1)}" y="${(Y(last.value) - 10).toFixed(1)}" text-anchor="end" class="gc-val">${money(last.value)}</text>
  </svg>`;
}

// Donut met kleuren uit het palet: [{label, value}] -> { svg, legend: [{label, weight, color}] }.
function pie(items, { size = 200, thickness = 30, center = '', sub = '' } = {}) {
  const total = items.reduce((s, x) => s + x.value, 0);
  if (!total) return { svg: '', legend: [] };
  const top = items.slice(0, 9);
  const rest = items.slice(9).reduce((s, x) => s + x.value, 0);
  const segs = rest > 0 ? [...top, { label: 'Overig', value: rest }] : top;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  const legend = [];
  // Tekst in het midden altijd binnen de ring: lettergrootte krimpt mee met de lengte.
  const inner = (size - 2 * thickness) * 0.84;
  const fit = (t, max, k) => Math.max(9, Math.min(max, inner / (Math.max(1, String(t || '').length) * k))).toFixed(1);
  const arcs = segs.map((x, i) => {
    const color = x.label === 'Overig' || /onbekend/i.test(x.label) ? '#cbd5e1' : PALETTE[i % PALETTE.length];
    const len = (c * x.value) / total;
    legend.push({ label: x.label, weight: x.value / total, color });
    const el = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}" stroke-dasharray="${Math.max(0, len - 2).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})" class="pie-seg" data-sec="${i}"><title>${esc(x.label)}: ${(100 * x.value / total).toFixed(1).replace('.', ',')}%</title></circle>`;
    off += len;
    return el;
  }).join('');
  const svg = `<svg viewBox="0 0 ${size} ${size}" class="gc pie" role="img" aria-label="Sectorverdeling">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${thickness}" class="pie-bg"/>${arcs}
    <text x="50%" y="47%" text-anchor="middle" class="pie-c" data-pie-c style="font-size:${fit(center, 26, 0.6)}px">${esc(center)}</text>
    <text x="50%" y="60%" text-anchor="middle" class="pie-s" data-pie-s style="font-size:${fit(sub, 11, 0.55)}px">${esc(sub)}</text></svg>`;
  return { svg, legend };
}

// Bubbels: x = verandering in gewicht (procentpunt), y = potentieel volgens analisten, grootte = gewicht.
function bubbles(points, { width = 920, height = 380 } = {}) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return '';
  const pad = { l: 52, r: 18, t: 18, b: 42 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const xm = Math.max(0.005, ...pts.map((p) => Math.abs(p.x))) * 1.15;
  const yv = pts.map((p) => Math.max(-0.6, Math.min(1.2, p.y)));
  const ymin = Math.min(-0.1, ...yv) - 0.05;
  const ymax = Math.max(0.2, ...yv) + 0.08;
  const M = 36; // ruimte voor de grootste bubbel binnen het vlak
  const X = (v) => pad.l + M + ((v + xm) / (2 * xm)) * (W - 2 * M);
  const Y = (v) => pad.t + M + (1 - (Math.max(-0.6, Math.min(1.2, v)) - ymin) / (ymax - ymin)) * (H - 2 * M);
  const wmax = Math.max(...pts.map((p) => p.r));
  const R = (w) => 5 + Math.sqrt(w / wmax) * 30;
  const xt = niceTicks(-xm, xm, 6);
  const yt = niceTicks(ymin, ymax, 5);
  const grid = [
    ...xt.map((t) => `<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${pad.t}" y2="${pad.t + H}" class="gc-grid${Math.abs(t) < 1e-9 ? ' zero' : ''}"/><text x="${X(t).toFixed(1)}" y="${pad.t + H + 16}" text-anchor="middle" class="gc-ax">${t > 0 ? '+' : ''}${(t * 100).toFixed(Math.abs(xm) < 0.03 ? 1 : 0).replace('.', ',')} pp</text>`),
    ...yt.map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="gc-grid${Math.abs(t) < 1e-9 ? ' zero' : ''}"/><text x="${pad.l - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="gc-ax">${pct(t, 0)}</text>`),
  ].join('');
  const narrow = width < 600;
  const q = narrow ? ['Verkocht · positief', 'Bijgekocht · positief', 'Verkocht · negatief', 'Bijgekocht · negatief'] : ['Verkocht, analisten positief', 'Bijgekocht, analisten positief', 'Verkocht, analisten negatief', 'Bijgekocht, analisten negatief'];
  const sorted = pts.slice().sort((a, b) => b.r - a.r);
  const dots = sorted.map((p) => {
    const rr = R(p.r);
    const label = rr > 15 ? `<text x="${X(p.x).toFixed(1)}" y="${(Y(p.y) + 4).toFixed(1)}" text-anchor="middle" class="bb-l">${esc(p.label)}</text>` : '';
    return `<a href="${esc(p.href || '#')}"><g class="bb bb-${p.tone || 'hold'}"><circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${rr.toFixed(1)}"/>${label}<title>${esc(p.title || p.label)}</title></g></a>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="gc gc-bubbles" role="img" aria-label="Aankopen en verkopen tegenover het potentieel volgens analisten">
    ${grid}
    <text x="${pad.l + 8}" y="${pad.t + 14}" class="bb-q">${q[0]}</text>
    <text x="${pad.l + W - 8}" y="${pad.t + 14}" text-anchor="end" class="bb-q">${q[1]}</text>
    <text x="${pad.l + 8}" y="${pad.t + H - 8}" class="bb-q">${q[2]}</text>
    <text x="${pad.l + W - 8}" y="${pad.t + H - 8}" text-anchor="end" class="bb-q">${q[3]}</text>
    ${dots}
    <text x="${pad.l + W / 2}" y="${height - 4}" text-anchor="middle" class="gc-ax gc-axt">verandering in gewicht dit kwartaal →</text>
  </svg>`;
}

// Rendement van de nagebootste portefeuille tegenover de S&P 500 (index = 100).
function perfLines(points, { width = 920, height = 280, nameA = 'Guru', nameB = 'S&P 500' } = {}) {
  if (!points || points.length < 2) return '';
  const pad = { l: 8, r: 92, t: 16, b: 26 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const vals = points.flatMap((p) => [p.value, p.bench]);
  const lo = Math.min(...vals) * 0.97;
  const hi = Math.max(...vals) * 1.03;
  const t0 = new Date(points[0].date).getTime();
  const t1 = new Date(points[points.length - 1].date).getTime();
  const X = (d) => pad.l + ((new Date(d).getTime() - t0) / (t1 - t0 || 1)) * W;
  const Y = (v) => pad.t + H - ((v - lo) / (hi - lo || 1)) * H;
  const path = (k) => points.map((p, i) => `${i ? 'L' : 'M'}${X(p.date).toFixed(1)},${Y(p[k]).toFixed(1)}`).join(' ');
  const ticks = niceTicks(lo, hi, 4);
  const last = points[points.length - 1];
  const yA = Y(last.value);
  let yB = Y(last.bench);
  if (Math.abs(yA - yB) < 16) yB = yA + (yB >= yA ? 16 : -16);
  const years = [];
  for (let y = new Date(t0).getUTCFullYear() + 1; y <= new Date(t1).getUTCFullYear(); y++) years.push(y);
  const area = `${path('value')} L${X(last.date).toFixed(1)},${pad.t + H} L${pad.l},${pad.t + H} Z`;
  return `<svg viewBox="0 0 ${width} ${height}" class="gc gc-perf" role="img" aria-label="${esc(nameA)} tegenover ${esc(nameB)}">
    <defs><linearGradient id="gpFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--pos)" stop-opacity=".16"/><stop offset="1" stop-color="var(--pos)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="gc-grid${Math.abs(t - 1) < 1e-9 ? ' zero' : ''}"/>`).join('')}
    ${years.map((y) => { const x = X(`${y}-01-01`); return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${pad.t}" y2="${pad.t + H}" class="gc-grid faint"/><text x="${x.toFixed(1)}" y="${height - 6}" text-anchor="middle" class="gc-ax">${y}</text>`; }).join('')}
    <path d="${area}" fill="url(#gpFill)"/>
    <path d="${path('bench')}" class="gc-line bench"/>
    <path d="${path('value')}" class="gc-line"/>
    ${points.map((p) => `<g class="gc-pt"><circle cx="${X(p.date).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="3"/><title>${new Date(p.date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })}: ${esc(nameA)} ${pct(p.value - 1)} · ${esc(nameB)} ${pct(p.bench - 1)}</title></g>`).join('')}
    <circle cx="${X(last.date).toFixed(1)}" cy="${yA.toFixed(1)}" r="5" class="gc-end"/>
    <text x="${(X(last.date) + 10).toFixed(1)}" y="${(yA + 4).toFixed(1)}" class="gc-tag a">${pct(last.value - 1, 0)}</text>
    <text x="${(X(last.date) + 10).toFixed(1)}" y="${(yB + 4).toFixed(1)}" class="gc-tag b">${pct(last.bench - 1, 0)}</text>
  </svg>`;
}

// Mini-sparkline voor de kaarten in het overzicht.
function spark(values, { width = 120, height = 36 } = {}) {
  const v = values.filter((x) => x > 0);
  if (v.length < 2) return '';
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const pts = v.map((y, i) => [1 + (i / (v.length - 1)) * (width - 2), height - 3 - ((y - lo) / (hi - lo || 1)) * (height - 6)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const up = v[v.length - 1] >= v[0];
  return `<svg viewBox="0 0 ${width} ${height}" class="gk-spark ${up ? 'up' : 'down'}" preserveAspectRatio="none" aria-hidden="true"><path d="${d} L${width - 1},${height} L1,${height} Z" class="a"/><path d="${d}" class="l"/></svg>`;
}

// Kleur voor een heatmapcel (gewicht 0..max): van bijna wit naar navy.
function heatCell(w, max) {
  if (!w) return '';
  const t = Math.min(1, Math.sqrt(w / (max || 1)));
  const a = 0.08 + t * 0.92;
  return `background:rgba(29,47,87,${a.toFixed(2)});color:${t > 0.45 ? '#fff' : 'var(--text)'}`;
}

module.exports = { PALETTE, qLabel, valueArea, pie, bubbles, perfLines, spark, heatCell, MONTHS };
