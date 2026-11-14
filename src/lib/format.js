'use strict';

// Weergavehelpers voor de templates (Nederlandse notatie).
const nl = (opts) => new Intl.NumberFormat('nl-NL', opts);
const n0 = nl({ maximumFractionDigits: 0 });
const n2 = nl({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct1 = nl({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const pct1plain = nl({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Amsterdam' });
const dateTimeFmt = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

function num(v, digits = 0) {
  if (!isNum(v)) return '–';
  return digits === 2 ? n2.format(Number(v)) : n0.format(Number(v));
}

function price(v) {
  return isNum(v) ? `$${n2.format(Number(v))}` : '–';
}

// Grote bedragen compact: $1,2 mld / $340 mln.
function money(v) {
  if (!isNum(v)) return '–';
  const x = Number(v);
  const abs = Math.abs(x);
  if (abs >= 1e12) return `$${nl({ maximumFractionDigits: 2 }).format(x / 1e12)} bln`;
  if (abs >= 1e9) return `$${nl({ maximumFractionDigits: 1 }).format(x / 1e9)} mld`;
  if (abs >= 1e6) return `$${nl({ maximumFractionDigits: 1 }).format(x / 1e6)} mln`;
  if (abs >= 1e3) return `$${nl({ maximumFractionDigits: 0 }).format(x / 1e3)}k`;
  return `$${n0.format(x)}`;
}

function pct(v, signed = true) {
  if (!isNum(v)) return '–';
  return (signed ? pct1 : pct1plain).format(Number(v));
}

function date(v) {
  if (!v) return '–';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? '–' : dateFmt.format(d);
}

function dateTime(v) {
  if (!v) return '–';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? '–' : dateTimeFmt.format(d);
}

function ago(v) {
  if (!v) return '';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min geleden`;
  if (s < 86400) return `${Math.round(s / 3600)} uur geleden`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d geleden`;
  return date(v);
}

const POSITIVE = /(buy|outperform|overweight|positive|accumulate|add|strong buy|market outperform|sector outperform|conviction)/i;
const NEGATIVE = /(sell|underperform|underweight|negative|reduce|market underperform|sector underperform)/i;

function gradeTone(grade) {
  if (!grade) return 'neutral';
  if (NEGATIVE.test(grade)) return 'neg';
  if (POSITIVE.test(grade)) return 'pos';
  return 'neutral';
}

const ACTIONS = { upgrade: 'Upgrade', downgrade: 'Downgrade', maintain: 'Gehandhaafd', hold: 'Gehandhaafd', init: 'Gestart', initiate: 'Gestart', reiterate: 'Herhaald' };
function action(a) {
  if (!a) return '–';
  return ACTIONS[String(a).toLowerCase()] || a;
}
function actionTone(a) {
  const x = String(a || '').toLowerCase();
  if (x === 'upgrade') return 'pos';
  if (x === 'downgrade') return 'neg';
  return 'neutral';
}

// Insider-transactietype, bv. "P-Purchase" of "S-Sale".
function txType(t) {
  const code = String(t || '').split('-')[0].toUpperCase();
  const map = { P: 'Aankoop', S: 'Verkoop', A: 'Toekenning', M: 'Optie-uitoefening', F: 'Belasting', G: 'Schenking', D: 'Teruggave', C: 'Conversie', X: 'Optie-uitoefening', J: 'Overig' };
  return map[code] || t || '–';
}
function txTone(t) {
  const code = String(t || '').split('-')[0].toUpperCase();
  if (code === 'P') return 'pos';
  if (code === 'S') return 'neg';
  return 'neutral';
}

function tone(v) {
  if (!isNum(v) || Number(v) === 0) return '';
  return Number(v) > 0 ? 'pos' : 'neg';
}

// Kleine SVG-lijngrafiek voor koershistorie.
function sparkline(points, { width = 640, height = 160, markers = [] } = {}) {
  const pts = (points || []).filter((p) => isNum(p.close));
  if (pts.length < 2) return '';
  const xs = pts.map((p) => new Date(p.date).getTime());
  const ys = pts.map((p) => Number(p.close));
  const markerYs = markers.map((m) => Number(m.value)).filter((v) => v > 0);
  const minY = Math.min(...ys, ...markerYs) * 0.97;
  const maxY = Math.max(...ys, ...markerYs) * 1.03;
  const minX = xs[0];
  const maxX = xs[xs.length - 1];
  const sx = (x) => ((x - minX) / (maxX - minX || 1)) * (width - 8) + 4;
  const sy = (y) => height - 4 - ((y - minY) / (maxY - minY || 1)) * (height - 8);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  const lines = markers
    .filter((m) => Number(m.value) > 0)
    .map((m) => {
      const y = sy(Number(m.value)).toFixed(1);
      return `<line x1="0" x2="${width}" y1="${y}" y2="${y}" class="mk ${m.cls || ''}"><title>${m.label}</title></line>`;
    })
    .join('');
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Koersverloop">${lines}<path d="${d}" fill="none" vector-effect="non-scaling-stroke"/></svg>`;
}

module.exports = { num, price, money, pct, date, dateTime, ago, gradeTone, action, actionTone, txType, txTone, tone, sparkline, isNum };
