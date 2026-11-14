'use strict';

// Server-side SVG-grafieken (geen externe libraries nodig).

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

const fmtPrice = (v) => (v >= 1000 ? `$${Math.round(v).toLocaleString('nl-NL')}` : `$${v.toFixed(v < 10 ? 2 : 0)}`);
const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

// Gemiddeld koersdoel door de tijd: laatste doel per bank, doelen ouder dan 12 maanden vervallen.
function rollingConsensus(targets, dates) {
  const sorted = [...targets].sort((a, b) => new Date(a.published_at) - new Date(b.published_at));
  const latest = new Map();
  const out = [];
  let j = 0;
  for (const d of dates) {
    const t = new Date(d).getTime();
    while (j < sorted.length && new Date(sorted[j].published_at).getTime() <= t) {
      latest.set(sorted[j].firm, { v: Number(sorted[j].target_adj ?? sorted[j].target), at: new Date(sorted[j].published_at).getTime() });
      j++;
    }
    const vals = [...latest.values()].filter((x) => t - x.at <= 365 * DAY).map((x) => x.v);
    out.push(vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null);
  }
  return out;
}

/**
 * Koersgrafiek met alle koersdoelen als stippen, per bank aan/uit te zetten.
 * @param prices [{date, close}] gesorteerd
 * @param targets [{published_at, target, pwp, firm}]
 */
function targetTimeline(prices, targets, { width = 920, height = 320, markers = [] } = {}) {
  const pts = (prices || []).filter((p) => p.close > 0);
  if (pts.length < 2) return null;
  const pad = { l: 56, r: 12, t: 12, b: 26 };
  const x0 = new Date(pts[0].date).getTime();
  const x1 = new Date(pts[pts.length - 1].date).getTime();

  // Doelen omrekenen naar dezelfde koersreeks als de grafiek (splits).
  const priceAt = (t) => {
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (new Date(pts[mid].date).getTime() <= t) lo = mid;
      else hi = mid - 1;
    }
    return pts[lo].close;
  };
  const tg = (targets || [])
    .map((t) => {
      const at = new Date(t.published_at).getTime();
      if (at < x0 || at > x1 + DAY) return null;
      const p = priceAt(at);
      const ratio = t.pwp > 0 ? p / t.pwp : 1;
      const adj = ratio > 0.6 && ratio < 1.6 ? t.target : t.target * ratio;
      return { ...t, at, target_adj: adj };
    })
    .filter(Boolean);

  // Banken met de meeste doelen krijgen een eigen kleur.
  const counts = new Map();
  for (const t of tg) counts.set(t.firm, (counts.get(t.firm) || 0) + 1);
  const firms = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const colored = firms.slice(0, PALETTE.length);
  const colorOf = (f) => {
    const i = colored.indexOf(f);
    return i >= 0 ? PALETTE[i] : '#94a3b8';
  };
  const firmKey = (f) => {
    const i = colored.indexOf(f);
    return i >= 0 ? `f${i}` : 'fo';
  };

  const cons = rollingConsensus(tg, pts.map((p) => p.date));
  const ys = [...pts.map((p) => p.close), ...tg.map((t) => t.target_adj), ...cons.filter((v) => v)];
  const sortedYs = [...ys].sort((a, b) => a - b);
  // Uitschieters niet de schaal laten bepalen.
  const yMin = sortedYs[Math.floor(sortedYs.length * 0.01)] * 0.95;
  const yMax = sortedYs[Math.ceil(sortedYs.length * 0.99) - 1] * 1.05;
  const sx = (t) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (width - pad.l - pad.r);
  const sy = (v) => pad.t + (1 - (Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin || 1)) * (height - pad.t - pad.b);

  const pricePath = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(new Date(p.date).getTime()).toFixed(1)},${sy(p.close).toFixed(1)}`).join('');
  let consPath = '';
  let pen = false;
  cons.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    consPath += `${pen ? 'L' : 'M'}${sx(new Date(pts[i].date).getTime()).toFixed(1)},${sy(v).toFixed(1)}`;
    pen = true;
  });

  const yTicks = niceTicks(yMin, yMax, 5);
  const grid = yTicks
    .map((v) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}" class="tl-grid"/><text x="${pad.l - 6}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end" class="tl-axis">${fmtPrice(v)}</text>`)
    .join('');
  const xTicks = [];
  const start = new Date(x0);
  const monthsSpan = (x1 - x0) / (30 * DAY);
  const stepM = monthsSpan > 30 ? 6 : monthsSpan > 12 ? 3 : 1;
  if (monthsSpan < 3.5) {
    // Korte periode: een label per week.
    for (let t = x0 + 3 * DAY; t <= x1 - 2 * DAY; t += 7 * DAY) {
      const d = new Date(t);
      xTicks.push(`<text x="${sx(t).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="tl-axis">${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}</text>`);
    }
  } else for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); d.getTime() <= x1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + stepM, 1))) {
    const label = d.getUTCMonth() === 0 || stepM >= 3 ? `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}` : MONTHS[d.getUTCMonth()];
    xTicks.push(`<text x="${sx(d.getTime()).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="tl-axis">${label}</text>`);
  }

  const dots = tg
    .map((t) => {
      const title = `${t.firm}${t.analyst_name ? ' (' + t.analyst_name + ')' : ''}: ${fmtPrice(t.target)} op ${new Date(t.at).toLocaleDateString('nl-NL')}`;
      return `<circle cx="${sx(t.at).toFixed(1)}" cy="${sy(t.target_adj).toFixed(1)}" r="4" fill="${colorOf(t.firm)}" class="tl-dot ${firmKey(t.firm)}"><title>${esc(title)}</title></circle>`;
    })
    .join('');

  const marks = (markers || [])
    .map((m) => {
      const t = new Date(m.date).getTime();
      if (t < x0 || t > x1) return '';
      const x = sx(t).toFixed(1);
      return `<line x1="${x}" x2="${x}" y1="${pad.t}" y2="${height - pad.b}" class="tl-mark"/><text x="${(Number(x) + 5).toFixed(1)}" y="${pad.t + 12}" class="tl-mark-l">${esc(m.label || '')}</text>`;
    })
    .join('');
  const svg = `<svg viewBox="0 0 ${width} ${height}" class="tl" role="img" aria-label="Koers en koersdoelen door de tijd">
    ${grid}${xTicks.join('')}${marks}
    <path d="${consPath}" class="tl-cons"/>
    <path d="${pricePath}" class="tl-price"/>
    ${dots}
  </svg>`;

  const legend = [
    ...colored.map((f, i) => ({ key: `f${i}`, label: f, color: PALETTE[i], n: counts.get(f) })),
    ...(firms.length > colored.length ? [{ key: 'fo', label: 'Overige banken', color: '#94a3b8', n: firms.slice(colored.length).reduce((s, f) => s + counts.get(f), 0) }] : []),
  ];
  return { svg, legend, count: tg.length };
}


// Cirkelmeter voor de GuruScore (0-100).
function scoreRing(score, size = 44) {
  const has = score !== null && score !== undefined && !Number.isNaN(Number(score));
  const v = has ? Math.max(0, Math.min(100, Number(score))) : 0;
  const stroke = Math.max(3, Math.round(size / 9));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const tone = !has ? 'na' : v >= 70 ? 'hi' : v >= 45 ? 'mid' : 'lo';
  const fs = Math.round(size * 0.36);
  return `<svg class="ring ring-${tone}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${has ? 'GuruScore ' + Math.round(v) : 'Nog geen GuruScore'}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg" stroke-width="${stroke}" fill="none"/>
    ${has ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-width="${stroke}" fill="none" stroke-linecap="round" stroke-dasharray="${((c * v) / 100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}
    <text x="50%" y="50%" dy="0.35em" text-anchor="middle" class="ring-txt" font-size="${fs}">${has ? Math.round(v) : '–'}</text>
  </svg>`;
}

// Donut met segmenten [{value, cls, label}].
function donut(segments, { size = 120, thickness = 18, center = '', sub = '' } = {}) {
  const total = segments.reduce((s, x) => s + (Number(x.value) || 0), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = total
    ? segments
        .filter((x) => x.value > 0)
        .map((x) => {
          const len = (c * x.value) / total;
          const el = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${thickness}" class="dn ${x.cls}" stroke-dasharray="${Math.max(0, len - 1.5).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(x.label)}: ${x.value}</title></circle>`;
          offset += len;
          return el;
        })
        .join('')
    : '';
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${thickness}" class="dn-bg"/>${arcs}
    <text x="50%" y="48%" text-anchor="middle" class="dn-c">${esc(center)}</text>
    <text x="50%" y="64%" text-anchor="middle" class="dn-s">${esc(sub)}</text>
  </svg>`;
}

// Dagelijkse staafjes boven/onder de nullijn: [{date, pos, neg}].
function divergingBars(days, { width = 560, height = 150, fmt = (v) => String(v), posLabel = '', negLabel = '' } = {}) {
  if (!days.length) return '';
  const pad = { l: 4, r: 4, t: 10, b: 18 };
  const max = Math.max(1, ...days.map((d) => Math.max(d.pos || 0, d.neg || 0)));
  const bw = (width - pad.l - pad.r) / days.length;
  const mid = pad.t + (height - pad.t - pad.b) / 2;
  const half = (height - pad.t - pad.b) / 2;
  const bars = days
    .map((d, i) => {
      const x = pad.l + i * bw + bw * 0.15;
      const w = bw * 0.7;
      const hp = ((d.pos || 0) / max) * half;
      const hn = ((d.neg || 0) / max) * half;
      const lbl = new Date(d.date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
      return `<g><title>${lbl}: ${posLabel} ${fmt(d.pos || 0)} · ${negLabel} ${fmt(d.neg || 0)}</title>
        <rect x="${x.toFixed(1)}" y="${(mid - hp).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(hp, d.pos ? 1.5 : 0).toFixed(1)}" rx="2" class="bar-pos"/>
        <rect x="${x.toFixed(1)}" y="${mid.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(hn, d.neg ? 1.5 : 0).toFixed(1)}" rx="2" class="bar-neg"/></g>`;
    })
    .join('');
  const first = new Date(days[0].date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  const last = new Date(days[days.length - 1].date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  return `<svg viewBox="0 0 ${width} ${height}" class="dbars" role="img">
    <line x1="0" x2="${width}" y1="${mid}" y2="${mid}" class="tl-grid"/>${bars}
    <text x="${pad.l}" y="${height - 4}" class="tl-axis">${first}</text><text x="${width - pad.r}" y="${height - 4}" text-anchor="end" class="tl-axis">${last}</text>
  </svg>`;
}

// Mini-lijngrafiek (sparkline) zonder assen.
function miniLine(values, { width = 120, height = 34, cls = '' } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return '';
  const min = Math.min(...v);
  const max = Math.max(...v);
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((y - min) / (max - min || 1)) * (height - 4)).toFixed(1)}`);
  const up = v[v.length - 1] >= v[0];
  const area = `M1,${height} L${pts.join(' L')} L${width - 1},${height} Z`;
  return `<svg class="mini ${cls || (up ? 'up' : 'down')}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path d="${area}" class="mini-area"/><polyline points="${pts.join(' ')}" class="mini-line"/></svg>`;
}

// Squarified treemap voor portefeuilles: [{label, value, sub, href, tone}].
function treemap(items, { width = 920, height = 420, label = 'Verdeling van de portefeuille' } = {}) {
  const data = items.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  if (!data.length) return '';
  const total = data.reduce((s, x) => s + x.value, 0);
  const scale = (width * height) / total;
  const nodes = data.map((d) => ({ ...d, area: d.value * scale }));
  const out = [];
  let rect = { x: 0, y: 0, w: width, h: height };
  const worst = (row, side) => {
    const sum = row.reduce((s, n) => s + n.area, 0);
    const mx = Math.max(...row.map((n) => n.area));
    const mn = Math.min(...row.map((n) => n.area));
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  const layoutRow = (row) => {
    const sum = row.reduce((s, n) => s + n.area, 0);
    if (rect.w >= rect.h) {
      const w = sum / rect.h;
      let y = rect.y;
      for (const n of row) {
        const h = n.area / w;
        out.push({ ...n, x: rect.x, y, w, h });
        y += h;
      }
      rect = { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h };
    } else {
      const h = sum / rect.w;
      let x = rect.x;
      for (const n of row) {
        const w = n.area / h;
        out.push({ ...n, x, y: rect.y, w, h });
        x += w;
      }
      rect = { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h };
    }
  };
  let row = [];
  for (const n of nodes) {
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n);
    else {
      layoutRow(row);
      row = [n];
    }
  }
  if (row.length) layoutRow(row);
  const cells = out
    .map((n, i) => {
      const big = n.w > 70 && n.h > 38;
      const mid = n.w > 40 && n.h > 20;
      const shade = n.fill ? 1 : Math.max(0.35, 1 - i * 0.025);
      const style = n.fill ? `fill:${n.fill}` : `opacity:${shade.toFixed(2)}`;
      return `<a href="${esc(n.href || '#')}"><g class="tm ${n.tone || ''}"><rect x="${(n.x + 1).toFixed(1)}" y="${(n.y + 1).toFixed(1)}" width="${Math.max(0, n.w - 2).toFixed(1)}" height="${Math.max(0, n.h - 2).toFixed(1)}" rx="4" style="${style}"><title>${esc(n.label)}${n.sub ? ' · ' + esc(n.sub) : ''}</title></rect>
        ${mid ? `<text x="${(n.x + 7).toFixed(1)}" y="${(n.y + 18).toFixed(1)}" class="tm-l">${esc(n.label)}</text>` : ''}
        ${big && n.sub ? `<text x="${(n.x + 7).toFixed(1)}" y="${(n.y + 34).toFixed(1)}" class="tm-s">${esc(n.sub)}</text>` : ''}</g></a>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="treemap" role="img" aria-label="${esc(label)}">${cells}</svg>`;
}

// Horizontale staven [{label, value, display, href}].
function hbars(items, { max, cls = '' } = {}) {
  const m = max || Math.max(1, ...items.map((x) => x.value));
  return `<div class="hbars ${cls}">${items
    .map((x) => `<a class="hb" href="${esc(x.href || '#')}"><span class="hb-l">${esc(x.label)}</span><span class="hb-t"><span class="hb-f" style="width:${((x.value / m) * 100).toFixed(1)}%"></span></span><span class="hb-v">${esc(x.display ?? x.value)}</span></a>`)
    .join('')}</div>`;
}


const pctTxt = (v, d = 0) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(d).replace('.', ',')}%`;

// Kleur van rood (-1) via neutraal (0) naar groen (+1), voor heatmaps.
function heat(v) {
  const t = Math.max(-1, Math.min(1, v || 0));
  const a = 0.3 + Math.abs(t) * 0.7;
  return t >= 0 ? `rgba(14,159,110,${a.toFixed(2)})` : `rgba(211,47,47,${a.toFixed(2)})`;
}

// Spreidingsdiagram met vier kwadranten: [{x, y, label, href, tone, r}] (x en y als fractie).
function scatter(points, { width = 920, height = 440, xLabel = '', yLabel = '', quadrants = [], clampAt = 0.6 } = {}) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return '';
  const pad = { l: 52, r: 16, t: 16, b: 40 };
  const cl = (v) => Math.max(-clampAt, Math.min(clampAt, v));
  const xs = pts.map((p) => cl(p.x));
  const ys = pts.map((p) => cl(p.y));
  // Zelfde schaal op beide assen, zodat de diagonaal echt 'even hard' betekent.
  const xm = Math.max(0.1, ...xs.map(Math.abs), ...ys.map(Math.abs)) * 1.08;
  const ym = xm;
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const X = (v) => pad.l + ((cl(v) + xm) / (2 * xm)) * W;
  const Y = (v) => pad.t + (1 - (cl(v) + ym) / (2 * ym)) * H;
  const ticks = (m) => niceTicks(-m, m, 6).filter((t) => Math.abs(t) <= m);
  const grid = [
    ...ticks(xm).map((t) => `<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${pad.t}" y2="${pad.t + H}" class="tl-grid ${t === 0 ? 'zero' : ''}"/><text x="${X(t).toFixed(1)}" y="${height - 22}" text-anchor="middle" class="tl-axis">${pctTxt(t)}</text>`),
    ...ticks(ym).map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="tl-grid ${t === 0 ? 'zero' : ''}"/><text x="${pad.l - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="tl-axis">${pctTxt(t)}</text>`),
  ].join('');
  // Kwadrantlabels: [linksboven, rechtsboven, linksonder, rechtsonder]
  const q = quadrants.length === 4
    ? `<text x="${pad.l + 8}" y="${pad.t + 16}" class="sc-q">${esc(quadrants[0])}</text>
       <text x="${pad.l + W - 8}" y="${pad.t + 16}" text-anchor="end" class="sc-q">${esc(quadrants[1])}</text>
       <text x="${pad.l + 8}" y="${pad.t + H - 8}" class="sc-q">${esc(quadrants[2])}</text>
       <text x="${pad.l + W - 8}" y="${pad.t + H - 8}" text-anchor="end" class="sc-q">${esc(quadrants[3])}</text>`
    : '';
  const diag = `<line x1="${X(-xm).toFixed(1)}" y1="${Y(-xm).toFixed(1)}" x2="${X(xm).toFixed(1)}" y2="${Y(xm).toFixed(1)}" class="sc-diag"/>`;
  const dots = pts
    .sort((a, b) => (a.tone ? 1 : 0) - (b.tone ? 1 : 0))
    .map((p) => {
      const r = p.r || 4.5;
      const right = X(p.x) > pad.l + W * 0.85;
      const lbl = p.tone && p.label ? `<text x="${(X(p.x) + (right ? -(r + 3) : r + 3)).toFixed(1)}" y="${(Y(p.y) + 4).toFixed(1)}" class="sc-l" ${right ? 'text-anchor="end"' : ''}>${esc(p.label)}</text>` : '';
      return `<a href="${esc(p.href || '#')}"><circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${r}" class="sc-dot ${p.tone || ''}"><title>${esc(p.title || p.label || '')}</title></circle>${lbl}</a>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="scatter" role="img" aria-label="${esc(xLabel)} tegen ${esc(yLabel)}">
    ${grid}${diag}${q}${dots}
    <text x="${pad.l + W / 2}" y="${height - 4}" text-anchor="middle" class="tl-axis sc-ax">${esc(xLabel)} →</text>
    <text transform="translate(12 ${pad.t + H / 2}) rotate(-90)" text-anchor="middle" class="tl-axis sc-ax">${esc(yLabel)} →</text>
  </svg>`;
}

// Verticale kolommen met positieve en negatieve waarden: [{label, value, sub}] (value als fractie).
function columns(items, { width = 640, height = 240 } = {}) {
  if (!items.length) return '';
  const pad = { l: 44, r: 8, t: 22, b: 44 };
  const vals = items.map((x) => (Number.isFinite(x.value) ? x.value : 0));
  const m = Math.max(0.02, ...vals.map(Math.abs)) * 1.15;
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const Y = (v) => pad.t + (1 - (v + m) / (2 * m)) * H;
  const bw = W / items.length;
  const ticks = niceTicks(-m, m, 5).filter((t) => Math.abs(t) <= m);
  const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="tl-grid ${t === 0 ? 'zero' : ''}"/><text x="${pad.l - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="tl-axis">${pctTxt(t)}</text>`).join('');
  const bars = items
    .map((x, i) => {
      const v = vals[i];
      const cx = pad.l + i * bw + bw / 2;
      const w = Math.min(64, bw * 0.6);
      const y0 = Y(0);
      const y1 = Y(v);
      const has = Number.isFinite(x.value);
      return `<g><title>${esc(x.label)}: ${has ? pctTxt(v, 1) : 'te weinig data'}${x.sub ? ' · ' + esc(x.sub) : ''}</title>
        ${has ? `<rect x="${(cx - w / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1.5, Math.abs(y1 - y0)).toFixed(1)}" rx="5" class="${v >= 0 ? 'bar-pos' : 'bar-neg'}"/>
        <text x="${cx.toFixed(1)}" y="${(v >= 0 ? y1 - 6 : y1 + 15).toFixed(1)}" text-anchor="middle" class="col-v">${pctTxt(v, 1)}</text>` : ''}
        <text x="${cx.toFixed(1)}" y="${height - 24}" text-anchor="middle" class="tl-axis col-l">${esc(x.label)}</text>
        ${x.sub ? `<text x="${cx.toFixed(1)}" y="${height - 9}" text-anchor="middle" class="tl-axis">${esc(x.sub)}</text>` : ''}</g>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="cols" role="img">${grid}${bars}</svg>`;
}

// Gestapelde balk van een adviesverdeling (sterk kopen → sterk verkopen).
function ratingBar(r, { height = 10 } = {}) {
  const parts = [
    ['sb', Number(r.strong_buy) || 0, 'Sterk kopen'],
    ['b', Number(r.buy) || 0, 'Kopen'],
    ['h', Number(r.hold) || 0, 'Houden'],
    ['s', Number(r.sell) || 0, 'Verkopen'],
    ['ss', Number(r.strong_sell) || 0, 'Sterk verkopen'],
  ];
  const total = parts.reduce((s, p) => s + p[1], 0);
  if (!total) return '';
  return `<span class="rbar" style="height:${height}px" title="${parts.filter((p) => p[1]).map((p) => `${p[2]}: ${p[1]}`).join(' · ')}">${parts
    .filter((p) => p[1])
    .map((p) => `<i class="rb-${p[0]}" style="width:${((p[1] / total) * 100).toFixed(1)}%"></i>`)
    .join('')}</span>`;
}

// Adviesverdeling door de tijd als gestapeld vlak (100%).
function ratingArea(rows, { width = 920, height = 200 } = {}) {
  const data = rows.map((r) => ({ date: r.date, v: [Number(r.strong_buy) || 0, Number(r.buy) || 0, Number(r.hold) || 0, Number(r.sell) || 0, Number(r.strong_sell) || 0] }))
    .filter((r) => r.v.some((x) => x > 0));
  if (data.length < 2) return '';
  const pad = { l: 4, r: 4, t: 4, b: 22 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const X = (i) => pad.l + (i / (data.length - 1)) * W;
  const cls = ['rb-sb', 'rb-b', 'rb-h', 'rb-s', 'rb-ss'];
  const cum = data.map((d) => {
    const t = d.v.reduce((s, x) => s + x, 0);
    let acc = 0;
    return d.v.map((x) => { const lo = acc; acc += x / t; return [lo, acc]; });
  });
  const layers = cls.map((c, k) => {
    const top = cum.map((cs, i) => `${X(i).toFixed(1)},${(pad.t + cs[k][0] * H).toFixed(1)}`);
    const bot = cum.map((cs, i) => `${X(i).toFixed(1)},${(pad.t + cs[k][1] * H).toFixed(1)}`).reverse();
    return `<polygon points="${top.concat(bot).join(' ')}" class="ra ${c}"/>`;
  }).join('');
  const grid = `<line x1="${pad.l}" x2="${pad.l + W}" y1="${pad.t + H / 2}" y2="${pad.t + H / 2}" class="ra-mid"/>`;
  const lab = (i) => { const d = new Date(data[i].date); return `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`; };
  const step = Math.max(1, Math.ceil(data.length / 8));
  const xl = data.map((_, i) => (i % step === 0 ? `<text x="${X(i).toFixed(1)}" y="${height - 6}" text-anchor="${i === 0 ? 'start' : i > data.length - step ? 'end' : 'middle'}" class="tl-axis">${lab(i)}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="rarea" role="img" aria-label="Adviesverdeling door de tijd">${layers}${grid}${xl}</svg>`;
}

// Bereikbalk: laagste–hoogste koersdoel, met koers en consensus.
function rangeBar({ low, high, price, target }) {
  const vals = [low, high, price, target].filter((v) => Number.isFinite(v) && v > 0);
  if (vals.length < 3) return '';
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const P = (v) => (((v - lo) / (hi - lo || 1)) * 100).toFixed(1);
  return `<span class="rng" title="Laag ${fmtPrice(low)} · hoog ${fmtPrice(high)} · koers ${fmtPrice(price)} · consensus ${fmtPrice(target)}"><span class="rng-r" style="left:${P(low)}%;width:${(P(high) - P(low)).toFixed(1)}%"></span><i class="rng-t" style="left:${P(target)}%"></i><i class="rng-p" style="left:${P(price)}%"></i></span>`;
}

// Paren van staven per periode: [{label, a, b, href}] (fracties), bijv. winstverrassing en koersreactie.
function pairBars(items, { width = 920, height = 230, aLabel = '', bLabel = '' } = {}) {
  if (!items.length) return '';
  const pad = { l: 44, r: 8, t: 14, b: 30 };
  const vals = items.flatMap((x) => [x.a, x.b]).filter(Number.isFinite);
  const m = Math.max(0.02, ...vals.map((v) => Math.min(Math.abs(v), 1))) * 1.15;
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const cl = (v) => Math.max(-m, Math.min(m, v));
  const Y = (v) => pad.t + (1 - (cl(v) + m) / (2 * m)) * H;
  const gw = W / items.length;
  const bw = Math.min(26, gw * 0.32);
  const ticks = niceTicks(-m, m, 5).filter((t) => Math.abs(t) <= m);
  const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="tl-grid ${t === 0 ? 'zero' : ''}"/><text x="${pad.l - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="tl-axis">${pctTxt(t)}</text>`).join('');
  const bar = (v, x, cls, lbl) => {
    if (!Number.isFinite(v)) return '';
    const y0 = Y(0);
    const y1 = Y(v);
    return `<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1.5, Math.abs(y1 - y0)).toFixed(1)}" rx="3" class="${cls} ${v >= 0 ? 'up' : 'down'}"><title>${esc(lbl)}: ${pctTxt(v, 1)}</title></rect>`;
  };
  const groups = items
    .map((x, i) => {
      const cx = pad.l + i * gw + gw / 2;
      const inner = `${bar(x.a, cx - bw - 1, 'pb-a', aLabel)}${bar(x.b, cx + 1, 'pb-b', bLabel)}
        <text x="${cx.toFixed(1)}" y="${height - 10}" text-anchor="middle" class="tl-axis">${esc(x.label)}</text>`;
      return x.href ? `<a href="${esc(x.href)}">${inner}</a>` : `<g>${inner}</g>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="cols" role="img" aria-label="${esc(aLabel)} en ${esc(bLabel)}">${grid}${groups}</svg>`;
}

const LEVEL_CLS = [['strong_sell', 'rb-ss', 'Sterk verkopen'], ['sell', 'rb-s', 'Verkopen'], ['hold', 'rb-h', 'Houden'], ['buy', 'rb-b', 'Kopen'], ['strong_buy', 'rb-sb', 'Sterk kopen']];
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return `${MONTHS[mo - 1]} '${String(y).slice(2)}`; };

// Gestapelde kolommen: aantal adviezen per maand ([{month, ratings:{strong_buy..}}]).
function ratingColumns(months, { width = 560, height = 260 } = {}) {
  const data = months.filter((m) => m.ratings);
  if (data.length < 2) return '';
  const pad = { l: 30, r: 6, t: 26, b: 26 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const max = Math.max(1, ...data.map((m) => m.ratings.total));
  const ticks = niceTicks(0, max, 4);
  const top = Math.max(max, ticks[ticks.length - 1]);
  const Y = (v) => pad.t + H - (v / top) * H;
  const bw = W / data.length;
  const w = Math.max(4, Math.min(26, bw * 0.68));
  const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="tl-grid ${t === 0 ? 'zero' : ''}"/><text x="${pad.l - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="tl-axis">${t}</text>`).join('');
  const step = Math.max(1, Math.ceil(data.length / 7));
  const cols = data.map((m, i) => {
    const x = pad.l + i * bw + (bw - w) / 2;
    let acc = 0;
    const segs = LEVEL_CLS.map(([k, cls]) => {
      const v = m.ratings[k] || 0;
      if (!v) return '';
      const y1 = Y(acc + v);
      const y0 = Y(acc);
      acc += v;
      return `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.5, y0 - y1 - 0.8).toFixed(1)}" class="ra ${cls}"/>`;
    }).join('');
    const last = i === data.length - 1;
    const tip = [...LEVEL_CLS].reverse().filter(([k]) => m.ratings[k]).map(([k, , l]) => `${m.ratings[k]} ${l.toLowerCase()}`).join(', ');
    const lbl = i % step === (data.length - 1) % step ? `<text x="${(last ? x + w : x + w / 2).toFixed(1)}" y="${height - 8}" text-anchor="${last ? 'end' : 'middle'}" class="tl-axis${last ? ' strong-ax' : ''}">${monthLabel(m.month)}</text>` : '';
    const tot = last ? `<text x="${(x + w / 2).toFixed(1)}" y="${(Y(m.ratings.total) - 6).toFixed(1)}" text-anchor="middle" class="col-v">${m.ratings.total}</text>` : '';
    return `<g class="rc-col${last ? ' now' : ''}"><title>${monthLabel(m.month)}: ${tip}</title><rect x="${(pad.l + i * bw).toFixed(1)}" y="${pad.t}" width="${bw.toFixed(1)}" height="${H}" class="rc-hit"/>${segs}${tot}${lbl}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="rcols" role="img" aria-label="Adviezen per maand">${grid}${cols}</svg>`;
}

// Koers en koersdoelen per maand: band laagste–hoogste doel, gemiddeld doel en slotkoers.
function targetBand(months, { width = 560, height = 260 } = {}) {
  const data = months.filter((m) => m.close > 0 || m.mean > 0);
  if (data.length < 3) return '';
  const pad = { l: 50, r: 64, t: 14, b: 26 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const vals = data.flatMap((m) => [m.close, m.low, m.high, m.mean]).filter((v) => v > 0);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const padV = (hi - lo) * 0.08 || hi * 0.1;
  lo = Math.max(0, lo - padV);
  hi += padV;
  const X = (i) => pad.l + (i / (data.length - 1)) * W;
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * H;
  const ticks = niceTicks(lo, hi, 5).filter((t) => t >= lo && t <= hi);
  const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="tl-grid"/><text x="${pad.l - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="tl-axis">${fmtPrice(t)}</text>`).join('');
  const path = (key) => {
    let d = '';
    let pen = false;
    data.forEach((m, i) => {
      if (m[key] > 0) { d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(m[key]).toFixed(1)}`; pen = true; } else pen = false;
    });
    return d;
  };
  const bandIdx = data.map((m, i) => (m.low > 0 && m.high > 0 ? i : -1)).filter((i) => i >= 0);
  const band = bandIdx.length > 1
    ? `<polygon points="${bandIdx.map((i) => `${X(i).toFixed(1)},${Y(data[i].high).toFixed(1)}`).concat(bandIdx.slice().reverse().map((i) => `${X(i).toFixed(1)},${Y(data[i].low).toFixed(1)}`)).join(' ')}" class="tb-band"/>`
    : '';
  const step = Math.max(1, Math.ceil(data.length / 7));
  const xl = data.map((m, i) => (i % step === (data.length - 1) % step ? `<text x="${X(i).toFixed(1)}" y="${height - 8}" text-anchor="${i === data.length - 1 ? 'end' : 'middle'}" class="tl-axis">${monthLabel(m.month)}</text>` : '')).join('');
  const last = data[data.length - 1];
  const tags = [];
  if (last.mean > 0) tags.push({ y: Y(last.mean), cls: 'tb-tag-t', txt: fmtPrice(last.mean) });
  if (last.close > 0) tags.push({ y: Y(last.close), cls: 'tb-tag-p', txt: fmtPrice(last.close) });
  if (tags.length === 2 && Math.abs(tags[0].y - tags[1].y) < 18) {
    const mid = (tags[0].y + tags[1].y) / 2;
    const up = tags[0].y <= tags[1].y ? 0 : 1;
    tags[up].y = mid - 9;
    tags[1 - up].y = mid + 9;
  }
  const tagSvg = tags.map((t) => `<g class="${t.cls}"><rect x="${pad.l + W + 6}" y="${(t.y - 9).toFixed(1)}" width="56" height="18" rx="5"/><text x="${pad.l + W + 34}" y="${(t.y + 4).toFixed(1)}" text-anchor="middle">${t.txt}</text></g>`).join('');
  const hits = data.map((m, i) => {
    const x0 = i === 0 ? pad.l : (X(i - 1) + X(i)) / 2;
    const x1 = i === data.length - 1 ? pad.l + W : (X(i) + X(i + 1)) / 2;
    const tip = `${monthLabel(m.month)}: koers ${m.close > 0 ? fmtPrice(m.close) : '–'}${m.mean > 0 ? `, gem. koersdoel ${fmtPrice(m.mean)} (${fmtPrice(m.low)}–${fmtPrice(m.high)}, ${m.analysts} analisten)` : ''}`;
    return `<rect x="${x0.toFixed(1)}" y="${pad.t}" width="${(x1 - x0).toFixed(1)}" height="${H}" class="rc-hit"><title>${esc(tip)}</title></rect>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="tband" role="img" aria-label="Koers en koersdoelen per maand">${grid}${band}
    <path d="${path('mean')}" class="tb-mean"/><path d="${path('close')}" class="tb-price"/>
    ${last.close > 0 ? `<circle cx="${X(data.length - 1).toFixed(1)}" cy="${Y(last.close).toFixed(1)}" r="4" class="tb-dot"/>` : ''}
    ${xl}${tagSvg}${hits}</svg>`;
}

// Vijf kolommen: verdeling van de adviezen van sterk verkopen tot sterk kopen.
function ratingDist(c, { width = 340, height = 170 } = {}) {
  if (!c || !c.total) return '';
  const pad = { l: 6, r: 6, t: 20, b: 34 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const max = Math.max(1, ...LEVEL_CLS.map(([k]) => c[k] || 0));
  const bw = W / 5;
  const bars = LEVEL_CLS.map(([k, cls, label], i) => {
    const v = c[k] || 0;
    const h = (v / max) * H;
    const x = pad.l + i * bw + bw * 0.16;
    const w = bw * 0.68;
    const words = label.split(' ');
    return `<g><title>${label}: ${v}</title>
      <rect x="${x.toFixed(1)}" y="${pad.t}" width="${w.toFixed(1)}" height="${H}" rx="7" class="rd-bg"/>
      ${v ? `<rect x="${x.toFixed(1)}" y="${(pad.t + H - h).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(3, h).toFixed(1)}" rx="7" class="ra ${cls}"/>` : ''}
      <text x="${(x + w / 2).toFixed(1)}" y="${(pad.t + H - h - 6).toFixed(1)}" text-anchor="middle" class="col-v">${v}</text>
      ${words.map((wd, j) => `<text x="${(x + w / 2).toFixed(1)}" y="${(height - pad.b + 15 + j * 13).toFixed(1)}" text-anchor="middle" class="tl-axis">${wd}</text>`).join('')}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="rdist" role="img" aria-label="Verdeling van de adviezen">${bars}</svg>`;
}

// Halve meter voor het adviesoordeel (1 = sterk verkopen, 5 = sterk kopen).
function gauge(value, { size = 180, min = 1, max = 5, label = '' } = {}) {
  const has = Number.isFinite(value);
  const w = size;
  const h = Math.round(size * 0.62);
  const cx = w / 2;
  const cy = h - 14;
  const r = size / 2 - 14;
  const ang = (v) => Math.PI * (1 - (Math.max(min, Math.min(max, v)) - min) / (max - min));
  const pt = (a, rr) => [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  const seg = (v0, v1, cls) => {
    const [x0, y0] = pt(ang(v0), r);
    const [x1, y1] = pt(ang(v1), r);
    return `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}" class="gg-seg ${cls}"/>`;
  };
  const step = (max - min) / 5;
  const segs = ['rb-ss', 'rb-s', 'rb-h', 'rb-b', 'rb-sb'].map((cls, i) => seg(min + i * step + 0.02, min + (i + 1) * step - 0.02, cls)).join('');
  let needle = '';
  if (has) {
    const a = ang(value);
    const [nx, ny] = pt(a, r - 16);
    needle = `<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" class="gg-needle"/><circle cx="${cx}" cy="${cy}" r="5.5" class="gg-hub"/>`;
  }
  return `<svg viewBox="0 0 ${w} ${h + 22}" class="gauge" width="${w}" role="img" aria-label="${esc(label)} ${has ? value.toFixed(2) : ''}">
    ${segs}${needle}
    <text x="${cx}" y="${h + 16}" text-anchor="middle" class="gg-v">${has ? value.toFixed(2).replace('.', ',') : '–'}</text>
  </svg>`;
}

// Koershistorie (12 maanden) met een waaier naar het hoogste, gemiddelde en laagste koersdoel
// over 12 maanden, plus een stip per koersdoel op de rechteras. targets: [{target, label}].
function forecastFan(series, targets, { width = 920, height = 340 } = {}) {
  const pts = series.filter((p) => p.close > 0);
  const tv = targets.filter((t) => t.target > 0);
  if (pts.length < 20 || !tv.length) return '';
  const last = pts[pts.length - 1];
  const t0 = new Date(pts[0].date).getTime();
  const tNow = new Date(last.date).getTime();
  const tEnd = tNow + 365 * DAY;
  const vals = tv.map((t) => t.target);
  const hi = Math.max(...vals);
  const lo = Math.min(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const all = pts.map((p) => p.close).concat(vals);
  let yMin = Math.min(...all);
  let yMax = Math.max(...all);
  const pad0 = (yMax - yMin) * 0.06;
  yMin = Math.max(0, yMin - pad0);
  yMax += pad0;
  const pad = { l: 54, r: 112, t: 14, b: 28 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const X = (t) => pad.l + ((t - t0) / (tEnd - t0)) * W;
  const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * H;
  const ticks = niceTicks(yMin, yMax, 6).filter((t) => t >= yMin && t <= yMax);
  const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="tl-grid"/><text x="${pad.l - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="tl-axis">${fmtPrice(t)}</text>`).join('');
  const months = [];
  const d = new Date(t0);
  for (let m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); m.getTime() < tEnd; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 2, 1))) months.push(m);
  const xl = months.map((m) => `<text x="${X(m.getTime()).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="tl-axis">${MONTHS[m.getUTCMonth()]} '${String(m.getUTCFullYear()).slice(2)}</text>`).join('');
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(new Date(p.date).getTime()).toFixed(1)},${Y(p.close).toFixed(1)}`).join('');
  const x0 = X(tNow);
  const y0 = Y(last.close);
  const xe = X(tEnd);
  const fan = `<polygon points="${x0.toFixed(1)},${y0.toFixed(1)} ${xe.toFixed(1)},${Y(hi).toFixed(1)} ${xe.toFixed(1)},${Y(lo).toFixed(1)}" class="ff-band"/>`;
  const ray = (v, cls) => `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${xe.toFixed(1)}" y2="${Y(v).toFixed(1)}" class="ff-ray ${cls}"/>`;
  // Labels rechts, uit elkaar geschoven als ze te dicht bij elkaar staan.
  const labels = [
    { v: hi, cls: 'hi', txt: `Hoogste ${fmtPrice(hi)}` },
    { v: mean, cls: 'mid', txt: `Gem. ${fmtPrice(mean)}` },
    { v: lo, cls: 'lo', txt: `Laagste ${fmtPrice(lo)}` },
  ].map((l) => ({ ...l, y: Y(l.v) }));
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 16) labels[i].y = labels[i - 1].y + 16;
  const lab = labels.map((l) => `<text x="${xe + 22}" y="${(l.y + 4).toFixed(1)}" class="ff-lab ${l.cls}">${l.txt}</text>`).join('');
  // Stippen per koersdoel, licht gespreid zodat gelijke doelen zichtbaar blijven.
  const seen = new Map();
  const dots = tv
    .slice()
    .sort((a, b) => a.target - b.target)
    .map((t) => {
      const key = Math.round(Y(t.target) / 6);
      const k = seen.get(key) || 0;
      seen.set(key, k + 1);
      const cx = xe + 8 + (k % 3) * 5 - (k % 3 ? 0 : 0);
      return `<circle cx="${(cx - 4).toFixed(1)}" cy="${Y(t.target).toFixed(1)}" r="4.5" class="ff-dot ${t.tone || ''}"><title>${esc(t.label)}</title></circle>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="fan" role="img" aria-label="Koers en koersdoelen over 12 maanden">${grid}
    <line x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${pad.t}" y2="${pad.t + H}" class="ff-now"/>
    <text x="${(x0 + 6).toFixed(1)}" y="${pad.t + 12}" class="tl-axis">vandaag</text>
    ${fan}${ray(hi, 'hi')}${ray(mean, 'mid')}${ray(lo, 'lo')}
    <path d="${line}" class="ff-price"/><circle cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="4" class="tb-dot"/>
    ${dots}${lab}${xl}</svg>`;
}

module.exports = { forecastFan, ratingColumns, targetBand, ratingDist, gauge, pairBars, targetTimeline, rollingConsensus, scoreRing, donut, divergingBars, miniLine, treemap, hbars, heat, scatter, columns, ratingBar, ratingArea, rangeBar };
