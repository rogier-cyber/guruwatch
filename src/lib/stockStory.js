'use strict';

// Automatische tekst voor de aandeelpagina: samenvatting, bull case, bear case en veelgestelde vragen.
//
// Opzet: de route verzamelt eerst een feitenobject (`facts`, alleen getallen en korte teksten,
// zonder opmaak). `buildStory(facts)` maakt daar met vaste sjablonen leesbare zinnen van.
// Later kan hier een taalmodel achter: geef het hetzelfde feitenobject als invoer en laat het
// dezelfde vorm teruggeven ({ summary, bull, bear, faq, description }). Feiten blijven zo controleerbaar.

const fmt = require('./format');

const P = (v) => fmt.price(v);
const pct = (v) => fmt.pct(Math.abs(v), false);
const signed = (v) => fmt.pct(v);
const list = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} en ${a[a.length - 1]}`);
const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

// Kies de sterkste punten (hoogste gewicht), maximaal `max`.
const top = (points, max) => points.filter(Boolean).sort((a, b) => b.w - a.w).slice(0, max).map((p) => p.text);

function bullPoints(f) {
  const n = f.name;
  const out = [];
  const c = f.consensus || {};
  if (isNum(c.upside) && c.upside >= 0.08) {
    out.push({ w: 6 + Math.min(4, c.upside * 10), text: `Analisten zien ruimte voor ${pct(c.upside)} koerswinst: het gemiddelde koersdoel van ${c.analysts} analisten is ${P(c.target)}, tegen een koers van ${P(f.price)}.` });
  }
  if (c.counts && c.counts.total && c.buyShare >= 0.6) {
    out.push({ w: 5 + c.buyShare * 3, text: `${c.buys} van de ${c.counts.total} analisten adviseren ${n} te kopen, het consensusoordeel is "${c.verdict}".` });
  }
  if (f.smart && isNum(f.smart.upside) && f.smart.count >= 1 && isNum(c.upside) && f.smart.upside > c.upside + 0.03) {
    out.push({ w: 6, text: `De analisten met de beste trackrecord (GuruScore 70+) zijn positiever dan gemiddeld: hun koersdoel van ${P(f.smart.target)} ligt ${pct(f.smart.upside)} boven de koers.` });
  }
  const e = f.lastEarnings;
  if (e && isNum(e.epsSurprise) && e.epsSurprise > 0.01) {
    out.push({ w: 5 + Math.min(3, e.epsSurprise * 20), text: `Bij de laatste kwartaalcijfers (${fmt.date(e.date)}) was de winst per aandeel ${P(e.epsActual)}, ${pct(e.epsSurprise)} boven de verwachting van ${P(e.epsEstimated)}${isNum(e.revSurprise) && e.revSurprise > 0 ? `, en ook de omzet versloeg de verwachting` : ''}.` });
  }
  const fin = f.fundamentals || {};
  if (isNum(fin.revenueGrowth) && fin.revenueGrowth > 0.05) {
    out.push({ w: 4 + Math.min(3, fin.revenueGrowth * 10), text: `De omzet groeide in het laatste kwartaal ${pct(fin.revenueGrowth)} ten opzichte van een jaar eerder, tot ${fmt.money(fin.revenue)}.` });
  }
  if (isNum(fin.netMargin) && fin.netMargin > 0.15) {
    out.push({ w: 3 + Math.min(2, fin.netMargin * 4), text: `${n} is zeer winstgevend, met een nettomarge van ${pct(fin.netMargin)}${isNum(fin.roe) && fin.roe > 0.15 ? ` en een rendement op eigen vermogen van ${pct(fin.roe)}` : ''}.` });
  }
  if (isNum(fin.pe) && fin.pe > 0 && fin.pe < 15) {
    out.push({ w: 4, text: `De waardering is bescheiden: de koers-winstverhouding is ${fmt.num(fin.pe, 2)}.` });
  }
  const t = f.technicals || {};
  if (isNum(t.avg50) && isNum(t.avg200) && f.price > t.avg50 && f.price > t.avg200) {
    out.push({ w: 3, text: `De koers ligt boven het 50-daags (${P(t.avg50)}) en het 200-daags gemiddelde (${P(t.avg200)}), een teken van een opwaartse trend.` });
  }
  if (isNum(t.fromHigh) && t.fromHigh <= -0.25 && isNum(c.upside) && c.upside > 0.1) {
    out.push({ w: 4, text: `Het aandeel staat ${pct(t.fromHigh)} onder de 52-weekshoogste van ${P(t.yearHigh)}, terwijl analisten herstel verwachten.` });
  }
  const a = f.actions || {};
  if (a.upgrades && a.upgrades.length) {
    out.push({ w: 5 + a.upgrades.length, text: `In de afgelopen drie maanden ${a.upgrades.length === 1 ? 'verhoogde' : 'verhoogden'} ${list(a.upgrades.slice(0, 3))} ${a.upgrades.length === 1 ? 'zijn' : 'hun'} advies.` });
  }
  if (a.raises >= 3 && a.raises > 2 * a.cuts) {
    out.push({ w: 4, text: `Koersdoelen gaan omhoog: ${a.raises} verhogingen tegenover ${a.cuts} verlaging${a.cuts === 1 ? '' : 'en'} in de afgelopen drie maanden.` });
  }
  const i = f.insiders || {};
  if (i.buys > 0 && i.buyValue > 50000) {
    out.push({ w: 5, text: `Insiders kochten de afgelopen drie maanden voor ${fmt.money(i.buyValue)} aan aandelen${i.topBuy ? `, onder wie ${i.topBuy.reporting_name}` : ''}.` });
  }
  if (f.funds && f.funds.count >= 2) {
    out.push({ w: 3 + Math.min(2, f.funds.count / 3), text: `${f.funds.count} bekende hedgefondsen hebben ${n} in portefeuille, waaronder ${list(f.funds.names.slice(0, 3))}.` });
  }
  if (isNum(f.trend3m) && f.trend3m > 0.15) {
    out.push({ w: 3, text: `Het analistenoordeel is de afgelopen drie maanden verbeterd.` });
  }
  if (f.sectorScore && isNum(c.score) && c.score > f.sectorScore + 0.2) {
    out.push({ w: 2, text: `Analisten zijn positiever over ${n} dan over de gemiddelde ${f.sector ? `${f.sector}-aandelen` : 'sectorgenoot'}.` });
  }
  return top(out, 5);
}

function bearPoints(f) {
  const n = f.name;
  const out = [];
  const c = f.consensus || {};
  if (isNum(c.upside) && c.upside < 0) {
    out.push({ w: 7 + Math.min(3, -c.upside * 10), text: `De koers van ${P(f.price)} ligt ${pct(c.upside)} boven het gemiddelde koersdoel van ${P(c.target)}: analisten zien het aandeel als vol gewaardeerd.` });
  } else if (isNum(c.upside) && c.upside < 0.05) {
    out.push({ w: 4, text: `Het potentieel volgens analisten is beperkt: het gemiddelde koersdoel van ${P(c.target)} ligt maar ${pct(c.upside)} boven de koers.` });
  }
  if (c.counts && c.counts.total && (c.sellShare >= 0.15 || (isNum(c.score) && c.score < 2.75))) {
    out.push({ w: 5 + c.sellShare * 5, text: `${c.sells} van de ${c.counts.total} analisten adviseren verkopen en ${c.holds} houden; het consensusoordeel is "${c.verdict}".` });
  }
  if (c.low > 0 && c.high > 0 && c.high / c.low >= 1.8) {
    out.push({ w: 4, text: `Analisten zijn het sterk oneens: de koersdoelen lopen uiteen van ${P(c.low)} tot ${P(c.high)}.` });
  }
  const e = f.lastEarnings;
  if (e && isNum(e.epsSurprise) && e.epsSurprise < -0.01) {
    out.push({ w: 6 + Math.min(3, -e.epsSurprise * 20), text: `De laatste kwartaalcijfers (${fmt.date(e.date)}) vielen tegen: de winst per aandeel was ${P(e.epsActual)}, ${pct(e.epsSurprise)} onder de verwachting van ${P(e.epsEstimated)}.` });
  } else if (e && isNum(e.revSurprise) && e.revSurprise < -0.01) {
    out.push({ w: 4, text: `Bij de laatste kwartaalcijfers (${fmt.date(e.date)}) bleef de omzet ${pct(e.revSurprise)} achter bij de verwachting.` });
  }
  if (e && isNum(e.reaction) && e.reaction < -0.05) {
    out.push({ w: 3, text: `Beleggers reageerden negatief op die cijfers: de koers daalde ${pct(e.reaction)}.` });
  }
  const fin = f.fundamentals || {};
  if (isNum(fin.revenueGrowth) && fin.revenueGrowth < 0) {
    out.push({ w: 5, text: `De omzet kromp in het laatste kwartaal ${pct(fin.revenueGrowth)} ten opzichte van een jaar eerder.` });
  }
  if (isNum(fin.netMargin) && fin.netMargin < 0) {
    out.push({ w: 5, text: `${n} is verlieslatend, met een nettomarge van ${signed(fin.netMargin)}.` });
  }
  if (isNum(fin.pe) && fin.pe > 35) {
    out.push({ w: 4 + Math.min(2, fin.pe / 50), text: `De waardering is hoog: met een koers-winstverhouding van ${fmt.num(fin.pe, 2)} is er weinig ruimte voor teleurstellingen.` });
  }
  const t = f.technicals || {};
  if (isNum(t.avg50) && f.price < t.avg50) {
    out.push({ w: isNum(t.avg200) && f.price < t.avg200 ? 4 : 3, text: `De koers staat onder het 50-daags gemiddelde van ${P(t.avg50)}${isNum(t.avg200) && f.price < t.avg200 ? ` en het 200-daags gemiddelde van ${P(t.avg200)}` : ''}, wat wijst op zwakte op korte termijn.` });
  }
  if (isNum(t.fromHigh) && t.fromHigh > -0.03 && isNum(c.upside) && c.upside < 0.1) {
    out.push({ w: 3, text: `Het aandeel noteert vlak bij de 52-weekshoogste van ${P(t.yearHigh)}, wat de ruimte voor verdere stijging kan beperken.` });
  }
  const a = f.actions || {};
  if (a.downgrades && a.downgrades.length) {
    out.push({ w: 6 + a.downgrades.length, text: `In de afgelopen drie maanden ${a.downgrades.length === 1 ? 'verlaagde' : 'verlaagden'} ${list(a.downgrades.slice(0, 3))} ${a.downgrades.length === 1 ? 'zijn' : 'hun'} advies.` });
  }
  if (a.cuts >= 3 && a.cuts > a.raises) {
    out.push({ w: 4, text: `Koersdoelen gaan omlaag: ${a.cuts} verlagingen tegenover ${a.raises} verhoging${a.raises === 1 ? '' : 'en'} in de afgelopen drie maanden.` });
  }
  const i = f.insiders || {};
  if (i.sells >= 2 && i.sellValue > 250000 && i.sellValue > 3 * (i.buyValue || 0)) {
    const s = i.topSell;
    out.push({ w: 4 + Math.min(2, i.sells / 5), text: `Insiders verkochten de afgelopen drie maanden voor ${fmt.money(i.sellValue)} aan aandelen${s ? `, waaronder ${s.reporting_name}${s.type_of_owner ? ` (${s.type_of_owner})` : ''} met ${fmt.num(s.shares)} stuks tegen ${P(s.price)}` : ''}.` });
  }
  if (isNum(f.trend3m) && f.trend3m < -0.15) {
    out.push({ w: 4, text: `Het analistenoordeel is de afgelopen drie maanden verslechterd.` });
  }
  if (f.nextEarnings && f.nextEarnings.inDays >= 0 && f.nextEarnings.inDays <= 21) {
    out.push({ w: 2, text: `Op ${fmt.date(f.nextEarnings.date)} volgen nieuwe kwartaalcijfers; die kunnen de koers flink laten bewegen.` });
  }
  if (f.sectorScore && isNum(c.score) && c.score < f.sectorScore - 0.2) {
    out.push({ w: 2, text: `Analisten zijn minder enthousiast over ${n} dan over de gemiddelde ${f.sector ? `${f.sector}-aandelen` : 'sectorgenoot'}.` });
  }
  return top(out, 5);
}

function summary(f) {
  const n = f.name;
  const c = f.consensus || {};
  const t = f.technicals || {};
  const parts = [];
  let s1 = `${n} (${f.symbol}) noteert op ${P(f.price)}`;
  if (isNum(f.changePct)) s1 += `, ${f.changePct >= 0 ? 'een stijging' : 'een daling'} van ${pct(f.changePct)} vandaag`;
  s1 += '.';
  if (isNum(t.yearHigh) && isNum(t.yearLow)) s1 += ` In het afgelopen jaar bewoog het aandeel tussen ${P(t.yearLow)} en ${P(t.yearHigh)}.`;
  parts.push(s1);
  if (isNum(c.target)) {
    let s2 = `${c.analysts} analist${c.analysts === 1 ? '' : 'en'} ${c.analysts === 1 ? 'heeft' : 'hebben'} het afgelopen jaar een koersdoel afgegeven; gemiddeld is dat ${P(c.target)}, ${pct(c.upside)} ${c.upside >= 0 ? 'boven' : 'onder'} de huidige koers.`;
    if (c.low > 0 && c.high > 0 && c.analysts > 1) s2 += ` Het laagste doel is ${P(c.low)}, het hoogste ${P(c.high)}.`;
    parts.push(s2);
  }
  if (c.verdict && c.counts) {
    let s3 = `Het consensusoordeel is "${c.verdict}": ${c.buys} keer kopen, ${c.holds} keer houden en ${c.sells} keer verkopen.`;
    if (f.sectorScore && isNum(c.score)) {
      const diff = c.score - f.sectorScore;
      s3 += Math.abs(diff) < 0.15
        ? ` Dat is vergelijkbaar met andere ${f.sector || 'sector'}-aandelen.`
        : ` Analisten zijn daarmee ${diff > 0 ? 'positiever' : 'negatiever'} dan over de gemiddelde ${f.sector || 'sector'}-aandelen.`;
    }
    parts.push(s3);
  }
  if (f.nextEarnings && f.nextEarnings.inDays >= 0) parts.push(`De volgende kwartaalcijfers worden verwacht op ${fmt.date(f.nextEarnings.date)}.`);
  return parts;
}

// Korte uitleg boven de grafiek met de koersverwachting.
function forecast(f) {
  const c = f.consensus || {};
  if (!isNum(c.target) || !c.analysts) return null;
  const up = c.upside;
  return {
    analysts: c.analysts,
    target: c.target,
    upside: up,
    text: `Het afgelopen jaar gaven ${c.analysts} analist${c.analysts === 1 ? '' : 'en'} een koersdoel voor ${f.name}. Gemiddeld verwachten zij dat het aandeel binnen twaalf maanden ${P(c.target)} waard is.`
      + (isNum(up) ? ` Dat betekent dat het aandeel ${pct(up)} kan ${up >= 0 ? 'stijgen' : 'dalen'} vanaf de huidige koers van ${P(f.price)}.` : ''),
  };
}

function faq(f) {
  const n = f.name;
  const c = f.consensus || {};
  const out = [];
  if (isNum(c.target)) {
    out.push({ q: `Wat is het koersdoel van ${n}?`, a: `Het gemiddelde koersdoel van ${c.analysts} analist${c.analysts === 1 ? '' : 'en'} voor ${n} (${f.symbol}) is ${P(c.target)}. Dat is ${pct(c.upside)} ${c.upside >= 0 ? 'boven' : 'onder'} de huidige koers van ${P(f.price)}.${c.low > 0 && c.analysts > 1 ? ` De koersdoelen lopen uiteen van ${P(c.low)} tot ${P(c.high)}.` : ''}` });
  }
  if (c.verdict && c.counts) {
    out.push({ q: `Is ${n} een koop volgens analisten?`, a: `Het consensusoordeel van analisten over ${n} is "${c.verdict}". Van de ${c.counts.total} adviezen zijn er ${c.buys} kopen, ${c.holds} houden en ${c.sells} verkopen.` });
  }
  if (f.nextEarnings && f.nextEarnings.inDays >= 0) {
    out.push({ q: `Wanneer publiceert ${n} de volgende kwartaalcijfers?`, a: `${n} publiceert naar verwachting op ${fmt.date(f.nextEarnings.date)} nieuwe kwartaalcijfers.${isNum(f.nextEarnings.epsEstimated) ? ` Analisten verwachten een winst per aandeel van ${P(f.nextEarnings.epsEstimated)}.` : ''}` });
  }
  if (f.bestAnalyst) {
    out.push({ q: `Welke analist voorspelt ${n} het best?`, a: `Op basis van eerdere koersdoelen voor ${n} scoort ${f.bestAnalyst.name}${f.bestAnalyst.firm ? ` (${f.bestAnalyst.firm})` : ''} het best, met een GuruScore van ${Math.round(f.bestAnalyst.score)} over ${f.bestAnalyst.calls} adviezen.` });
  }
  return out;
}

function description(f) {
  const c = f.consensus || {};
  let d = `${f.name} (${f.symbol}) aandeel: koers ${P(f.price)}`;
  if (isNum(c.target)) d += `, gemiddeld koersdoel ${P(c.target)} (${signed(c.upside)}) van ${c.analysts} analisten`;
  if (c.verdict) d += `, oordeel ${c.verdict.toLowerCase()}`;
  d += '. Bull en bear case, adviezen door de tijd en welke analist het aandeel het best voorspelt.';
  return d.length > 300 ? d.slice(0, 297) + '…' : d;
}

// Bedrijfsnamen eindigen soms op een punt ("Apple Inc."): voorkom dubbele punten.
const tidy = (t) => (typeof t === 'string' ? t.replace(/\.\./g, '.') : t);

function buildStory(facts) {
  const fc = forecast(facts);
  return {
    source: 'sjabloon',
    summary: summary(facts).map(tidy),
    bull: bullPoints(facts).map(tidy),
    bear: bearPoints(facts).map(tidy),
    faq: faq(facts).map((x) => ({ q: tidy(x.q), a: tidy(x.a) })),
    forecast: fc ? { ...fc, text: tidy(fc.text) } : null,
    description: tidy(description(facts)),
  };
}

module.exports = { buildStory };
