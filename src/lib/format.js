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
  if (!isNum(v)) return '–';
  const x = Number(v);
  return `${x < 0 ? '−' : ''}$${n2.format(Math.abs(x))}`;
}

// "Apple Inc." -> "Apple", "Deckers Outdoor Corporation" -> "Deckers Outdoor".
function company(n) {
  const s = String(n || '').trim();
  // Aandelenklasse en "Common Stock" weg ("Zillow Group, Inc. Class C" -> "Zillow Group").
  const k = s.replace(/[\s,]+(class\s+[a-z]\b.*|common\s+(stock|shares).*|ordinary\s+shares.*)$/i, '').trim() || s;
  return k.replace(/,?\s+(inc\.?|incorporated|corporation|corp\.?|co\.|ltd\.?|limited|plc|n\.v\.|s\.a\.|se|ag|l\.p\.|lp)$/i, '').trim() || k;
}

// Portefeuillegewicht: kleine posities als "<0,1%" in plaats van "0,0%".
function weight(v) {
  if (!isNum(v)) return '–';
  const x = Number(v);
  if (x > 0 && x < 0.0005) return '<0,1%';
  return pct(x, false);
}

// SEC-namen staan vaak in hoofdletters ("WANG CHUN KAI"): maak er "Wang Chun Kai" van.
function person(n) {
  const s = String(n || '').trim();
  if (!s || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

// Functie van een insider kort en in het Nederlands: "director, officer: Chief Executive Officer" -> "CEO · commissaris".
function role(t) {
  const s = String(t || '').toLowerCase();
  if (!s) return '';
  const out = [];
  const add = (x) => { if (!out.includes(x)) out.push(x); };
  if (/chief executive|\bceo\b/.test(s)) add('CEO');
  if (/chief financial|\bcfo\b/.test(s)) add('CFO');
  if (/chief operating|\bcoo\b/.test(s)) add('COO');
  if (/chief technology|\bcto\b/.test(s)) add('CTO');
  if (/chief medical/.test(s)) add('medisch directeur');
  if (/chief legal|general counsel/.test(s)) add('jurist');
  if (/chair/.test(s)) add('voorzitter');
  if (/president/.test(s) && !out.length) add('president');
  if (/\bevp\b|executive vice|\bsvp\b|senior vice|\bvp\b|vice president/.test(s) && !out.length) add('vicepresident');
  if (/officer/.test(s) && !out.length) add('directie');
  if (/director/.test(s)) add('commissaris');
  if (/10\s*percent|10%/.test(s)) add('grootaandeelhouder');
  return out.slice(0, 2).join(' · ') || String(t);
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

function action(a) {
  if (!a) return '–';
  const x = String(a).toLowerCase();
  if (x.startsWith('up')) return 'Upgrade';
  if (x.startsWith('down')) return 'Downgrade';
  if (x.startsWith('init')) return 'Gestart';
  if (x.startsWith('reit')) return 'Herhaald';
  if (x.startsWith('main') || x === 'hold') return 'Gehandhaafd';
  return a.charAt(0).toUpperCase() + a.slice(1);
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

// Lange tekst in korte alinea's knippen (op zinsgrenzen, ~max tekens per alinea), zodat er niet te veel tekst
// achter elkaar staat. Een korte laatste zin blijft bij de alinea ervoor.
function paras(text, max = 280) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return [];
  const out = [];
  for (const block of t.split(/\n\s*\n/)) {
    const zinnen = block.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…][”"’)]?)\s+(?=[A-ZÀ-Ý0-9“"‘(])/);
    let cur = '';
    for (const z of zinnen) {
      if (cur && cur.length + z.length + 1 > max) { out.push(cur); cur = z; } else cur = cur ? cur + ' ' + z : z;
    }
    if (cur) {
      if (out.length && cur.length < 70 && out[out.length - 1].length + cur.length < max * 1.4) out[out.length - 1] += ' ' + cur;
      else out.push(cur);
    }
  }
  return out;
}

module.exports = {
  weight, paras, company, person, role, num, price, money, pct, date, dateTime, ago, gradeTone, action, actionTone, txType, txTone, tone, sparkline, isNum };
