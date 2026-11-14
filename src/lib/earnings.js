'use strict';

// Rekenregels rond kwartaalcijfers. Puur, zodat ze te testen zijn.

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Winstverrassing: werkelijke winst per aandeel versus verwachting.
function surprise(actual, estimate) {
  const a = num(actual);
  const e = num(estimate);
  if (a === null || e === null) return null;
  if (Math.abs(e) < 0.01) return null; // rond nul is een percentage zinloos
  return (a - e) / Math.abs(e);
}

// Vergelijk de koersreactie met hoe sterk analisten hun koersdoel aanpasten.
function verdict(reaction, revision) {
  const r = num(reaction);
  const v = num(revision);
  if (r === null || v === null) return null;
  if (r <= -0.05 && v >= 0.02) return { key: 'koers-omlaag-doelen-omhoog', label: 'Koers omlaag, analisten omhoog', tone: 'pos' };
  if (r >= 0.05 && v <= -0.02) return { key: 'koers-omhoog-doelen-omlaag', label: 'Koers omhoog, analisten omlaag', tone: 'neg' };
  if (Math.abs(r) > Math.abs(v) + 0.03) return { key: 'koers-sterker', label: 'Koers reageerde sterker dan analisten', tone: '' };
  if (Math.abs(v) > Math.abs(r) + 0.03) return { key: 'analisten-sterker', label: 'Analisten pasten sterker aan dan de koers', tone: '' };
  return { key: 'in-lijn', label: 'Koers en analisten in lijn', tone: '' };
}

// Herzieningen na de cijfers samenvatten: [{ t, prev, published_at, firm, name }].
function summarizeRevisions(rows) {
  const withPrev = rows.filter((r) => num(r.prev) > 0 && num(r.t) > 0);
  const raises = withPrev.filter((r) => r.t > r.prev * 1.001);
  const cuts = withPrev.filter((r) => r.t < r.prev * 0.999);
  const changes = withPrev.map((r) => r.t / r.prev - 1);
  const avg = changes.length ? changes.reduce((s, x) => s + x, 0) / changes.length : null;
  const firstMovers = [...rows].sort((a, b) => new Date(a.published_at) - new Date(b.published_at)).slice(0, 5);
  return { total: rows.length, raises: raises.length, cuts: cuts.length, kept: withPrev.length - raises.length - cuts.length, avgChange: avg, firstMovers };
}

// Kwartaallabel uit een rapportagedatum (cijfers gaan over het vorige kwartaal).
function quarterLabel(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  let q = Math.floor(d.getUTCMonth() / 3);
  let y = d.getUTCFullYear();
  if (q === 0) {
    q = 4;
    y -= 1;
  }
  return `Q${q} '${String(y).slice(2)}`;
}

module.exports = { surprise, verdict, summarizeRevisions, quarterLabel };
