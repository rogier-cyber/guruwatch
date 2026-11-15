'use strict';

// Grafieken voor de earnings calls: toon door de tijd (lijnen) en de onderwerpen-heatmap (HTML-tabel).
const tr = require('./transcripts');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const score = (net) => (net == null ? null : Math.round(net * 100));

// calls: [{label, date, analysis}] oud -> nieuw. Twee lijnen: management en analisten, schaal -100..+100.
function toneLine(calls, { width = 920, height = 260 } = {}) {
  const pts = calls.filter((c) => c.analysis && c.analysis.tone);
  if (pts.length < 2) return '';
  const pad = { l: 40, r: 14, t: 16, b: 34 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const vals = pts.flatMap((c) => [score(c.analysis.tone.mgmt.net), score(c.analysis.tone.analysts.net)]).filter(Number.isFinite);
  const lo = Math.max(-100, Math.floor((Math.min(0, ...vals) - 10) / 20) * 20);
  const hi = Math.min(100, Math.ceil((Math.max(...vals) + 10) / 20) * 20);
  const X = (i) => pad.l + (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * H;
  const grid = [];
  for (let v = lo; v <= hi; v += 20) {
    grid.push(`<line x1="${pad.l}" x2="${pad.l + W}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="tl-grid ${v === 0 ? 'zero' : ''}"/><text x="${pad.l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" class="tl-axis">${v > 0 ? '+' : ''}${v}</text>`);
  }
  const step = width < 500 ? Math.ceil(pts.length / 4) : 1;
  const xl = pts.map((c, i) => (i % step === 0 || i === pts.length - 1 ? `<text x="${X(i).toFixed(1)}" y="${height - 12}" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}" class="tl-axis">${esc(c.label)}</text>` : '')).join('');
  const series = (key, cls, who) => {
    const p = pts.map((c, i) => ({ i, v: score(c.analysis.tone[key].net), t: c.analysis.tone[key], c })).filter((x) => x.v != null);
    if (!p.length) return '';
    const d = p.map((x, k) => `${k ? 'L' : 'M'}${X(x.i).toFixed(1)},${Y(x.v).toFixed(1)}`).join(' ');
    const dots = p.map((x) => `<g class="ct-hit"><circle cx="${X(x.i).toFixed(1)}" cy="${Y(x.v).toFixed(1)}" r="4.5" class="ct-dot ${cls}"/><circle cx="${X(x.i).toFixed(1)}" cy="${Y(x.v).toFixed(1)}" r="12" fill="transparent"/><title>${esc(who)} · ${esc(x.c.label)}\nToon ${x.v > 0 ? '+' : ''}${x.v} (${tr.toneWord(x.t.net)})\n${x.t.pos} positieve en ${x.t.neg} negatieve woorden\n${Math.round(tr.per10k(x.t.unc, x.t.words))} onzekere woorden per 10.000</title></g>`).join('');
    return `<path d="${d}" class="ct-line ${cls}"/>${dots}`;
  };
  return `<svg viewBox="0 0 ${width} ${height}" class="ct-svg" role="img" aria-label="Toon van management en analisten per call">${grid.join('')}${xl}${series('analysts', 'an', 'Analisten')}${series('mgmt', 'mg', 'Management')}</svg>`;
}

const toneBoth = (calls, opts = {}) => {
  const d = toneLine(calls, opts);
  if (!d) return '';
  return `<div class="rsp"><div class="rsp-d">${d}</div><div class="rsp-m">${toneLine(calls, { width: 340, height: 230 })}</div></div>`;
};

// Heatmap: onderwerpen (rijen) x calls (kolommen). who: 'mgmt' | 'analysts' | 'all'.
function topicHeat(calls, { who = 'all', rows = 12 } = {}) {
  const pts = calls.filter((c) => c.analysis && c.analysis.topics);
  if (!pts.length) return '';
  const val = (c, k) => {
    const a = c.analysis;
    if (who === 'mgmt') return tr.per10k(a.topics.mgmt[k] || 0, a.words.mgmt);
    if (who === 'analysts') return tr.per10k(a.topics.analysts[k] || 0, a.words.analysts);
    return tr.per10k((a.topics.mgmt[k] || 0) + (a.topics.analysts[k] || 0), a.words.total);
  };
  const topics = tr.TOPICS.map((t) => ({ ...t, sum: pts.reduce((s, c) => s + val(c, t.key), 0) }))
    .filter((t) => t.sum > 0)
    .sort((a, b) => b.sum - a.sum)
    .slice(0, rows);
  const max = Math.max(1, ...topics.flatMap((t) => pts.map((c) => val(c, t.key))));
  const head = pts.map((c) => `<th><a href="${esc(c.href)}" data-tip="${esc(c.label)}\nCall van ${esc(c.dateTxt)}">${esc(c.short)}</a></th>`).join('');
  const body = topics.map((t) => {
    const cells = pts.map((c, i) => {
      const v = val(c, t.key);
      const a = c.analysis;
      const prev = i ? val(pts[i - 1], t.key) : null;
      const k = Math.pow(v / max, 0.7);
      const tip = `${t.label} · ${c.label}\nManagement: ${a.topics.mgmt[t.key] || 0}x\nAnalisten: ${a.topics.analysts[t.key] || 0}x\n${v.toFixed(0)} per 10.000 woorden${prev != null ? ` (${v - prev >= 0 ? '+' : ''}${(v - prev).toFixed(0)} t.o.v. vorige call)` : ''}`;
      return `<td><span class="hm-c${k > 0.55 ? ' hot' : ''}" style="--k:${k.toFixed(2)}" data-tip="${esc(tip)}">${v >= 0.5 ? Math.round(v) : ''}</span></td>`;
    }).join('');
    return `<tr><th scope="row">${esc(t.label)}</th>${cells}</tr>`;
  }).join('');
  return `<div class="tbl-wrap hm-wrap" data-scroll-end><table class="hm"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Toonmeter: halve cirkel van -100 (negatief) tot +100 (positief), naald op de toon van deze call,
// streepje op de vorige call.
function toneGauge(v, prev, { size = 220 } = {}) {
  if (!Number.isFinite(v)) return '';
  const w = size, cx = w / 2, r = w / 2 - 16, cy = r + 12, h = cy + 30;
  const ang = (x) => Math.PI * (1 - (Math.max(-100, Math.min(100, x)) + 100) / 200);
  const pt = (a, rr) => [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  const segs = [[-100, -35, 'tg-n2'], [-35, -10, 'tg-n1'], [-10, 10, 'tg-0'], [10, 35, 'tg-p1'], [35, 60, 'tg-p2'], [60, 100, 'tg-p3']].map(([a0, a1, cls]) => {
    const [x0, y0] = pt(ang(a0 + 1.2), r);
    const [x1, y1] = pt(ang(a1 - 1.2), r);
    return `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}" class="tg-seg ${cls}"/>`;
  }).join('');
  let ghost = '';
  if (Number.isFinite(prev)) {
    const a = ang(prev);
    const [x0, y0] = pt(a, r - 13);
    const [x1, y1] = pt(a, r + 13);
    ghost = `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="tg-prev"><title>Vorige call: ${prev > 0 ? '+' : ''}${prev}</title></line>`;
  }
  const [nx, ny] = pt(ang(v), r - 22);
  return `<svg viewBox="0 0 ${w} ${h}" class="tg" role="img" aria-label="Toon van het management: ${v > 0 ? '+' : ''}${v} op een schaal van -100 tot +100">${segs}${ghost}
    <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" class="tg-needle"/><circle cx="${cx}" cy="${cy}" r="6" class="tg-hub"/>
    <text x="2" y="${cy + 20}" text-anchor="start" class="tg-ax">negatief</text><text x="${w - 2}" y="${cy + 20}" text-anchor="end" class="tg-ax">positief</text></svg>`;
}

// Klein lijntje met de toon van het management per call. hist: [{label, v}] oud -> nieuw.
function toneSpark(hist, { width = 480, height = 90 } = {}) {
  const p = hist.filter((x) => Number.isFinite(x.v));
  if (p.length < 2) return '';
  const pad = { l: 6, r: 6, t: 10, b: 18 };
  const vals = p.map((x) => x.v);
  const lo = Math.min(0, ...vals) - 5, hi = Math.max(0, ...vals) + 5;
  const X = (i) => pad.l + (i / (p.length - 1)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
  const d = p.map((x, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(x.v).toFixed(1)}`).join(' ');
  const area = `${d} L${X(p.length - 1).toFixed(1)},${Y(lo).toFixed(1)} L${X(0).toFixed(1)},${Y(lo).toFixed(1)} Z`;
  const dots = p.map((x, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(x.v).toFixed(1)}" r="${i === p.length - 1 ? 4.5 : 3}" class="ts-dot${i === p.length - 1 ? ' last' : ''}"><title>${esc(x.label)}: toon ${x.v > 0 ? '+' : ''}${x.v}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="ts" role="img" aria-label="Toon van het management per call">
    <line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" class="ts-zero"/>
    <path d="${area}" class="ts-area"/><path d="${d}" class="ts-line"/>${dots}
    <text x="${pad.l}" y="${height - 4}" class="ts-ax">${esc(p[0].label)}</text><text x="${width - pad.r}" y="${height - 4}" text-anchor="end" class="ts-ax">${esc(p[p.length - 1].label)}</text></svg>`;
}

module.exports = { toneLine, toneBoth, topicHeat, score, toneGauge, toneSpark };
