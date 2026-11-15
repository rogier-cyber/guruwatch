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

module.exports = { toneLine, toneBoth, topicHeat, score };
