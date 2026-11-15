'use strict';

// Automatische tekst voor de aandeelpagina: samenvatting, bull case, bear case en veelgestelde vragen.
//
// Opzet: de route verzamelt eerst een feitenobject (`facts`, alleen getallen en korte teksten,
// zonder opmaak). `buildStory(facts)` maakt daar met vaste sjablonen leesbare zinnen van.
// Later kan hier een taalmodel achter: geef het hetzelfde feitenobject als invoer en laat het
// dezelfde vorm teruggeven ({ summary, bull, bear, faq, sections, title, description }). Feiten blijven zo controleerbaar.

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
    let s2 = `${c.analysts} analist${c.analysts === 1 ? '' : 'en'} ${c.analysts === 1 ? 'heeft' : 'hebben'} de afgelopen 6 maanden een koersdoel afgegeven; gemiddeld is dat ${P(c.target)}, ${pct(c.upside)} ${c.upside >= 0 ? 'boven' : 'onder'} de huidige koers.`;
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
    text: `De afgelopen 6 maanden gaven ${c.analysts} analist${c.analysts === 1 ? '' : 'en'} een koersdoel voor ${f.name}. Gemiddeld verwachten zij dat het aandeel binnen twaalf maanden ${P(c.target)} waard is.`
      + (isNum(up) ? ` Dat betekent dat het aandeel ${pct(up)} kan ${up >= 0 ? 'stijgen' : 'dalen'} vanaf de huidige koers van ${P(f.price)}.` : ''),
  };
}

// Veelgestelde vragen, gericht op waar beleggers op zoeken. De vraag over het koersdoel staat er altijd in.
function faq(f) {
  const n = f.name;
  const S = f.symbol;
  const c = f.consensus || {};
  const fy = f.forecastYear || new Date().getFullYear() + 1;
  const out = [];
  const add = (id, chip, q, a) => { if (a) out.push({ id, chip, q, a }); };

  add('koersdoel', `Koersdoel ${S}`, `Wat is het koersdoel van ${n} (${S})?`, isNum(c.target)
    ? `Het gemiddelde koersdoel van ${c.analysts} analist${c.analysts === 1 ? '' : 'en'} voor ${n} (${S}) is ${P(c.target)}. Dat is ${pct(c.upside)} ${c.upside >= 0 ? 'boven' : 'onder'} de huidige koers van ${P(f.price)}.${c.low > 0 && c.analysts > 1 ? ` De koersdoelen lopen uiteen van ${P(c.low)} tot ${P(c.high)}.` : ''} We nemen per analist het laatste koersdoel van de afgelopen twaalf maanden.`
    : `Voor ${n} (${S}) hebben analisten de afgelopen 6 maanden geen koersdoel afgegeven dat in onze data staat. Zodra er een koersdoel verschijnt, zie je het hier en in de grafiek met verwachtingen.`);

  const eo = f.epsOutlook;
  if (isNum(c.target) || eo) {
    let a = '';
    if (isNum(c.target)) a += `Analisten verwachten gemiddeld dat ${n} over twaalf maanden ${P(c.target)} waard is, ${pct(c.upside)} ${c.upside >= 0 ? 'hoger' : 'lager'} dan nu.`;
    if (eo && isNum(eo.eps)) {
      a += ` Voor boekjaar ${eo.year} rekenen ${eo.analysts ? `${eo.analysts} analisten` : 'analisten'} op een winst per aandeel van ${P(eo.eps)}`;
      a += isNum(eo.growth) ? `, ${eo.growth >= 0 ? 'een groei' : 'een daling'} van ${pct(eo.growth)} ten opzichte van het jaar ervoor.` : '.';
      if (isNum(eo.revenue)) a += ` De verwachte omzet is ${fmt.money(eo.revenue)}.`;
    }
    add('verwachting', `Verwachting ${fy}`, `Wat is de verwachting voor het aandeel ${n} in ${fy}?`, a.trim());
  }

  if (c.verdict && c.counts) {
    add('kopen', 'Kopen of verkopen?', `Is ${n} een koop, of kun je het aandeel beter verkopen?`,
      `Het consensusoordeel van analisten over ${n} is "${c.verdict}". Van de ${c.counts.total} adviezen zijn er ${c.buys} kopen, ${c.holds} houden en ${c.sells} verkopen (${pct(c.buyShare)} positief).${f.trend3m !== null && isNum(f.trend3m) && Math.abs(f.trend3m) >= 0.1 ? ` Het oordeel is de afgelopen drie maanden ${f.trend3m > 0 ? 'verbeterd' : 'verslechterd'}.` : ''} Dit is een samenvatting van analistenadviezen, geen persoonlijk beleggingsadvies.`);
  }

  const hi = f.highTarget;
  if (hi && isNum(hi.target)) {
    add('stijgen', 'Hoe hoog?', `Hoe hoog kan het aandeel ${n} stijgen volgens analisten?`,
      `Het hoogste koersdoel voor ${n} is ${P(hi.target)}, afgegeven door ${hi.who}${hi.date ? ` op ${fmt.date(hi.date)}` : ''}. Dat ligt ${pct(hi.upside)} ${hi.upside >= 0 ? 'boven' : 'onder'} de huidige koers. Het gemiddelde koersdoel is ${P(c.target)}.`);
  }
  const lo = f.lowTarget;
  if (lo && isNum(lo.target)) {
    add('dalen', 'Hoe laag?', `Hoe ver kan ${n} dalen volgens de meest negatieve analist?`,
      `Het laagste koersdoel voor ${n} is ${P(lo.target)}, van ${lo.who}${lo.date ? ` (${fmt.date(lo.date)})` : ''}. Dat is ${pct(lo.upside)} ${lo.upside >= 0 ? 'boven' : 'onder'} de huidige koers van ${P(f.price)}.`);
  }

  const ra = f.recentActions;
  if (ra) {
    let a;
    if (!ra.upgrades && !ra.downgrades && !ra.raises && !ra.cuts) a = `In de afgelopen drie maanden hebben analisten hun advies en koersdoel voor ${n} niet aangepast.`;
    else {
      const bits = [];
      if (ra.upgrades) bits.push(`${ra.upgrades} upgrade${ra.upgrades === 1 ? '' : 's'}`);
      if (ra.downgrades) bits.push(`${ra.downgrades} downgrade${ra.downgrades === 1 ? '' : 's'}`);
      if (ra.raises) bits.push(`${ra.raises} verhoogd${ra.raises === 1 ? ' koersdoel' : 'e koersdoelen'}`);
      if (ra.cuts) bits.push(`${ra.cuts} verlaagd${ra.cuts === 1 ? ' koersdoel' : 'e koersdoelen'}`);
      a = `In de afgelopen drie maanden telden we voor ${n} ${list(bits)}.`;
      const ACT = { Upgrade: 'een upgrade', Downgrade: 'een downgrade', Gestart: 'een nieuwe dekking', Herhaald: 'een herhaald advies', 'Doel omhoog': 'een hoger koersdoel', 'Doel omlaag': 'een lager koersdoel' };
      if (ra.last && ra.last.firm) a += ` De meest recente actie was ${ACT[ra.last.label] || 'een nieuw advies'} van ${ra.last.firm} op ${fmt.date(ra.last.date)}.`;
    }
    add('upgrades', 'Upgrades en downgrades', `Is ${n} onlangs opgewaardeerd of afgewaardeerd?`, a);
  }

  if (f.analystFirms && f.analystFirms.length) {
    const fl = f.analystFirms;
    add('analisten', 'Welke analisten?', `Welke analisten en banken volgen het aandeel ${n}?`,
      `De afgelopen 6 maanden gaven ${fl.length} bank${fl.length === 1 ? '' : 'en'} een koersdoel voor ${n}, waaronder ${list(fl.slice(0, 6))}.${f.bestAnalyst ? ` De analist met de beste trackrecord op dit aandeel is ${f.bestAnalyst.name}${f.bestAnalyst.firm ? ` van ${f.bestAnalyst.firm}` : ''}.` : ''}`);
  }

  if (f.bestAnalyst) {
    add('beste', 'Beste analist', `Welke analist voorspelt de koers van ${n} het best?`,
      `Op basis van eerdere koersdoelen voor ${n} scoort ${f.bestAnalyst.name}${f.bestAnalyst.firm ? ` (${f.bestAnalyst.firm})` : ''} het best, met een GuruScore van ${Math.round(f.bestAnalyst.score)} over ${f.bestAnalyst.calls} adviezen. De GuruScore kijkt hoe vaak een koersdoel werd gehaald en hoe het aandeel het daarna deed ten opzichte van de S&P 500.`);
  }

  const pe = f.peers;
  if (pe && pe.length >= 2 && isNum(c.upside)) {
    const best = pe.filter((p) => isNum(p.upside)).sort((a, b) => b.upside - a.upside)[0];
    const better = pe.filter((p) => isNum(p.upside) && p.upside > c.upside).length;
    add('concurrenten', 'Versus concurrenten', `Hoe doet ${n} het ten opzichte van concurrenten?`,
      `Vergeleken met ${pe.length} andere ${f.sector ? `${f.sector}-aandelen` : 'sectorgenoten'} (${list(pe.slice(0, 4).map((p) => p.symbol))}) zien analisten bij ${better === 0 ? 'geen enkele' : better} ${better === 1 ? 'concurrent' : 'concurrenten'} meer potentieel dan bij ${n}.${best ? ` Het meeste potentieel heeft ${best.name || best.symbol} (${best.symbol}) met ${signed(best.upside)}.` : ''}`);
  }

  if (f.nextEarnings && f.nextEarnings.inDays >= 0) {
    add('cijfers', 'Volgende cijfers', `Wanneer publiceert ${n} de volgende kwartaalcijfers?`,
      `${n} publiceert naar verwachting op ${fmt.date(f.nextEarnings.date)} nieuwe kwartaalcijfers.${isNum(f.nextEarnings.epsEstimated) ? ` Analisten verwachten een winst per aandeel van ${P(f.nextEarnings.epsEstimated)}.` : ''}`);
  }

  const e = f.lastEarnings;
  if (e && isNum(e.epsSurprise)) {
    const b = f.earningsBeats;
    add('laatstecijfers', 'Laatste cijfers', `Versloeg ${n} de verwachtingen bij de laatste kwartaalcijfers?`,
      `Bij de cijfers van ${fmt.date(e.date)} was de winst per aandeel ${P(e.epsActual)}, tegen een verwachting van ${P(e.epsEstimated)}: ${e.epsSurprise >= 0 ? `${pct(e.epsSurprise)} beter` : `${pct(e.epsSurprise)} slechter`} dan verwacht.${isNum(e.reaction) ? ` De koers reageerde met ${signed(e.reaction)}.` : ''}${b && b.total >= 3 ? ` In ${b.beats} van de laatste ${b.total} kwartalen was de winst hoger dan verwacht.` : ''}`);
  }

  const i = f.insiders;
  if (i && (i.buys || i.sells)) {
    add('insiders', 'Insiders', `Kopen of verkopen insiders aandelen ${n}?`,
      `In de afgelopen drie maanden waren er ${i.buys} aankopen${i.buys ? ` (${fmt.money(i.buyValue)})` : ''} en ${i.sells} verkopen${i.sells ? ` (${fmt.money(i.sellValue)})` : ''} door bestuurders en grootaandeelhouders van ${n}.${i.topBuy ? ` De grootste aankoop was van ${i.topBuy.reporting_name}.` : i.topSell ? ` De grootste verkoop was van ${i.topSell.reporting_name}.` : ''} Insiders verkopen vaak om persoonlijke redenen; aankopen zeggen meestal meer.`);
  }

  if (f.funds && f.funds.count) {
    add('guru', "Guru's", `Welke bekende beleggers hebben ${n} in portefeuille?`,
      `Volgens de laatste 13F-opgaven ${f.funds.count === 1 ? 'heeft' : 'hebben'} ${list(f.funds.names.slice(0, 5))} aandelen ${n} in portefeuille.`);
  }

  const fin = f.fundamentals || {};
  if (isNum(fin.pe) && fin.pe > 0) {
    add('waardering', 'Waardering', `Is het aandeel ${n} duur?`,
      `${n} heeft een koers-winstverhouding van ${fmt.num(fin.pe, 1)} op basis van de winst van de afgelopen twaalf maanden. ${fin.pe < 15 ? 'Dat is laag: beleggers betalen relatief weinig voor elke euro winst.' : fin.pe > 30 ? 'Dat is hoog: beleggers rekenen op flinke groei.' : 'Dat is gemiddeld voor een beursgenoteerd bedrijf.'}${isNum(fin.netMargin) ? ` De nettomarge is ${signed(fin.netMargin)}.` : ''}`);
  }

  const dv = f.dividend;
  if (dv) {
    add('dividend', 'Dividend', `Keert ${n} dividend uit?`, dv.amount > 0
      ? `Ja. ${n} keert per jaar ongeveer ${P(dv.amount)} dividend per aandeel uit${isNum(dv.yield) ? `, een dividendrendement van ${pct(dv.yield)} bij de huidige koers` : ''}.`
      : `${n} keert op dit moment geen dividend uit.`);
  }

  const ab = f.about;
  if (ab && (ab.text || ab.industry)) {
    let a = ab.text || '';
    const facts2 = [];
    if (ab.industry) facts2.push(`${n} valt in de sector ${f.sector || 'onbekend'}, in de branche ${ab.industry}`);
    if (ab.exchange) facts2.push(`het aandeel staat genoteerd aan de ${ab.exchange} onder de ticker ${S}`);
    if (ab.marketCap) facts2.push(`de beurswaarde is ${fmt.money(ab.marketCap)}`);
    let b = facts2.length ? `${facts2[0].charAt(0).toUpperCase()}${facts2[0].slice(1)}${facts2.length > 1 ? `; ${facts2.slice(1).join(' en ')}` : ''}.` : '';
    if (ab.ceo) b += ` De topman is ${ab.ceo}.`;
    if (ab.employees) b += ` Het bedrijf heeft ongeveer ${fmt.num(ab.employees)} medewerkers${ab.country ? ` en het hoofdkantoor staat in ${ab.country === 'US' ? 'de Verenigde Staten' : ab.country}` : ''}.`;
    if (ab.ipo) b += ` ${n} ging op ${fmt.date(ab.ipo)} naar de beurs.`;
    const pos = out.findIndex((x) => x.id === 'stijgen');
    const item = { id: 'bedrijf', chip: `Wat doet ${n}?`, q: `Wat doet ${n} en hoe verdient het bedrijf geld?`, a: [a, b.trim()].filter(Boolean).join('\n\n') };
    if (item.a) out.splice(pos >= 0 ? pos : out.length, 0, item);
  }
  return out.map((x) => ({ ...x, a: [x.a, ...extra(x.id, f)].filter(Boolean).join('\n\n') }));
}

// Extra uitleg per vraag: meer context en meer getallen, zodat elk antwoord op zichzelf staat.
function extra(id, f) {
  const n = f.name;
  const c = f.consensus || {};
  const t = f.technicals || {};
  const fin = f.fundamentals || {};
  const out = [];
  switch (id) {
    case 'koersdoel': {
      if (isNum(c.target) && f.smart && isNum(f.smart.target)) out.push(`Kijk je alleen naar de analisten met de beste trackrecord (GuruScore 70 of hoger), dan is het gemiddelde koersdoel ${P(f.smart.target)}, ${pct(f.smart.upside)} ${f.smart.upside >= 0 ? 'boven' : 'onder'} de koers. Hun oordeel weegt zwaarder omdat zij in het verleden vaker gelijk kregen.`);
      const mt = f.monthsTrend;
      if (mt && isNum(mt.targetThen) && isNum(mt.targetNow) && mt.targetThen > 0) out.push(`${mt.monthsBack} maanden geleden lag het gemiddelde koersdoel nog op ${P(mt.targetThen)}; sindsdien is het ${mt.targetNow >= mt.targetThen ? 'gestegen' : 'gedaald'} met ${pct(mt.targetNow / mt.targetThen - 1)}.`);
      out.push(`Een koersdoel is de prijs die een analist verwacht dat het aandeel over ongeveer twaalf maanden waard is. Het is geen garantie: koersdoelen worden regelmatig bijgesteld na kwartaalcijfers, nieuws of veranderingen in de markt. Op Guruwatch zie je per analist ook hoe vaak eerdere koersdoelen werden gehaald.`);
      break;
    }
    case 'verwachting': {
      if (isNum(t.yearLow) && isNum(t.yearHigh)) out.push(`Ter vergelijking: in de afgelopen twaalf maanden bewoog ${n} tussen ${P(t.yearLow)} en ${P(t.yearHigh)}. De huidige koers is ${P(f.price)}${isNum(t.fromHigh) ? `, ${pct(t.fromHigh)} onder de hoogste koers van het jaar` : ''}.`);
      if (c.low > 0 && c.high > 0) out.push(`De spreiding in verwachtingen is groot: de meest optimistische analist rekent op ${P(c.high)}, de meest voorzichtige op ${P(c.low)}. Hoe verder die uit elkaar liggen, hoe onzekerder de toekomst van het aandeel volgens de markt.`);
      break;
    }
    case 'kopen': {
      if (f.smart && isNum(f.smart.upside) && isNum(c.upside)) out.push(`De beste analisten (GuruScore 70+) zijn ${f.smart.upside > c.upside + 0.02 ? 'positiever' : f.smart.upside < c.upside - 0.02 ? 'voorzichtiger' : 'even positief'} dan het gemiddelde: hun koersdoel ligt ${pct(f.smart.upside)} ${f.smart.upside >= 0 ? 'boven' : 'onder'} de koers.`);
      if (f.sectorScore && isNum(c.score)) out.push(`Op een schaal van 1 (sterk verkopen) tot 5 (sterk kopen) scoort ${n} ${fmt.num(c.score, 2)}, tegen gemiddeld ${fmt.num(f.sectorScore, 2)} voor ${f.sector || 'sector'}-aandelen.`);
      out.push(`Kijk bij een beslissing ook naar de waardering, de laatste kwartaalcijfers en wat insiders doen. Die staan allemaal verderop op deze pagina, in de bull case en de bear case.`);
      break;
    }
    case 'stijgen':
    case 'dalen':
      if (c.low > 0 && c.high > 0 && c.analysts > 1) out.push(`Alle ${c.analysts} koersdoelen samen lopen van ${P(c.low)} tot ${P(c.high)}. Het gemiddelde van ${P(c.target)} geeft het beste beeld van wat analisten gemiddeld verwachten; de uitersten laten zien hoe groot de onzekerheid is.`);
      break;
    case 'upgrades':
      out.push(`Een upgrade betekent dat een analist zijn advies verhoogt, bijvoorbeeld van houden naar kopen; een downgrade is het omgekeerde. Ook zonder nieuw advies kan een analist het koersdoel verhogen of verlagen. Een reeks upgrades of hogere koersdoelen is vaak een teken dat het sentiment rond het aandeel verbetert.`);
      break;
    case 'analisten':
      if (c.analysts) out.push(`In totaal telden we de afgelopen 6 maanden ${c.analysts} analist${c.analysts === 1 ? '' : 'en'} met een koersdoel. Bij elke analist zie je op Guruwatch de GuruScore: een cijfer van 0 tot 100 dat laat zien hoe goed zijn eerdere koersdoelen uitkwamen.`);
      break;
    case 'beste':
      out.push(`Een hoge GuruScore betekent niet dat de analist altijd gelijk heeft, maar wel dat zijn koersdoelen in het verleden vaker uitkwamen dan gemiddeld. Daarom loont het om bij een aandeel extra te letten op wat de best scorende analisten zeggen.`);
      break;
    case 'cijfers':
      if (f.earningsBeats && f.earningsBeats.total >= 3) out.push(`${n} versloeg de winstverwachting in ${f.earningsBeats.beats} van de laatste ${f.earningsBeats.total} kwartalen. Rond de publicatie beweegt de koers vaak sterker dan normaal.`);
      break;
    case 'insiders':
      out.push(`Insiders zijn bestuurders, commissarissen en grootaandeelhouders. Zij moeten elke transactie binnen twee werkdagen melden bij de Amerikaanse toezichthouder SEC. Toekenningen van aandelen als beloning tellen we niet mee als aankoop.`);
      break;
    case 'waardering':
      if (isNum(fin.revenueGrowth)) out.push(`De omzet ${fin.revenueGrowth >= 0 ? 'groeide' : 'kromp'} in het laatste kwartaal ${pct(fin.revenueGrowth)} ten opzichte van een jaar eerder. Snelle groei kan een hogere koers-winstverhouding rechtvaardigen.`);
      if (isNum(c.upside)) out.push(`Analisten zien gemiddeld ${pct(c.upside)} ${c.upside >= 0 ? 'opwaarts potentieel' : 'neerwaarts risico'}, wat ook iets zegt over hoe zij de huidige waardering inschatten.`);
      break;
    case 'dividend':
      out.push(`Het dividendrendement is het jaarlijkse dividend gedeeld door de koers. Een hoog rendement is aantrekkelijk voor inkomen, maar kan ook betekenen dat de koers flink is gedaald.`);
      break;
    case 'guru':
      out.push(`Grote Amerikaanse beleggers moeten elk kwartaal via een 13F-opgave melden welke aandelen ze bezitten. Die opgaven komen tot 45 dagen na het kwartaal naar buiten, dus de posities kunnen inmiddels veranderd zijn.`);
      break;
    default:
  }
  return out.map(tidy);
}

// Korte inleidingen per blok op de pagina.
function sections(f) {
  const n = f.name;
  const c = f.consensus || {};
  const out = {};
  const mt = f.monthsTrend;
  if (mt && isNum(mt.targetThen) && isNum(mt.targetNow)) {
    const ch = mt.targetNow / mt.targetThen - 1;
    let t = `Het gemiddelde koersdoel voor ${n} ging in ${mt.monthsBack} maanden van ${P(mt.targetThen)} naar ${P(mt.targetNow)} (${signed(ch)}).`;
    if (isNum(mt.closeThen) && isNum(mt.closeNow)) {
      const pc = mt.closeNow / mt.closeThen - 1;
      t += ` De koers ${pc >= 0 ? 'steeg' : 'daalde'} in dezelfde periode ${pct(pc)}${Math.sign(pc) === Math.sign(ch) ? ', dus analisten bewogen mee met de markt.' : ', analisten gingen dus tegen de koers in.'}`;
    }
    out.targets = t;
  }
  if (mt && isNum(mt.buyShareThen) && isNum(mt.buyShareNow)) {
    const d = mt.buyShareNow - mt.buyShareThen;
    out.ratings = `${pct(mt.buyShareNow)} van de analisten adviseert nu kopen, tegen ${pct(mt.buyShareThen)} ${mt.ratingsBack} maanden geleden. ${Math.abs(d) < 0.05 ? 'Het sentiment is dus vrijwel gelijk gebleven.' : d > 0 ? 'Analisten zijn dus positiever geworden.' : 'Analisten zijn dus voorzichtiger geworden.'}`;
  }
  const r = f.rotThen;
  if (r && r.verdict && c.verdict) {
    out.rot = r.verdict === c.verdict
      ? `Een jaar geleden was het oordeel over ${n} ook "${c.verdict}"; het beeld is dus stabiel.`
      : `Een jaar geleden was het oordeel over ${n} nog "${r.verdict}", nu is het "${c.verdict}".`;
    if (isNum(r.target) && isNum(c.target)) out.rot += ` Het gemiddelde koersdoel was toen ${P(r.target)}, nu ${P(c.target)}.`;
  }
  const ra = f.recentActions;
  if (ra && ra.total) {
    out.actions = `De afgelopen drie maanden kwamen er ${ra.total} analistenacties binnen voor ${n}: ${ra.upgrades} upgrade${ra.upgrades === 1 ? '' : 's'}, ${ra.downgrades} downgrade${ra.downgrades === 1 ? '' : 's'}, ${ra.raises} hogere en ${ra.cuts} lagere koersdoelen.`;
  }
  if (isNum(c.score) && f.sectorScore) {
    const d = c.score - f.sectorScore;
    out.compare = `Analisten geven ${n} een score van ${fmt.num(c.score, 2)} op 5, tegen gemiddeld ${fmt.num(f.sectorScore, 2)} in de sector ${f.sector}. ${Math.abs(d) < 0.15 ? 'Dat is ongeveer gelijk.' : d > 0 ? `${n} wordt dus positiever beoordeeld dan de gemiddelde sectorgenoot.` : `${n} wordt dus minder positief beoordeeld dan de gemiddelde sectorgenoot.`}`;
  }
  const b = f.earningsBeats;
  if (b && b.total >= 2) {
    out.earnings = `${n} versloeg de winstverwachting in ${b.beats} van de laatste ${b.total} kwartalen.${f.nextEarnings && f.nextEarnings.inDays >= 0 ? ` De volgende cijfers staan gepland voor ${fmt.date(f.nextEarnings.date)}.` : ''}`;
  }
  const pe = f.peers;
  if (pe && pe.length) {
    out.peers = pe.some((p) => p.curated)
      ? `De belangrijkste concurrenten van ${n} en hun analistenoordeel, zodat je kunt zien hoe ${n} ervoor staat tegenover bedrijven die op dezelfde markt actief zijn.`
      : `Bedrijven uit dezelfde branche met analistenadviezen, zodat je ${n} kunt vergelijken met concurrenten.`;
  }
  const i = f.insiders || {};
  const fu = f.funds;
  if (i.buys || i.sells || (fu && fu.count)) {
    const parts = [];
    if (i.buys || i.sells) parts.push(`insiders deden de afgelopen drie maanden ${i.buys} aankopen en ${i.sells} verkopen`);
    if (fu && fu.count) parts.push(`${fu.count} gevolgde fonds${fu.count === 1 ? '' : 'en'} ${fu.count === 1 ? 'heeft' : 'hebben'} het aandeel in portefeuille`);
    out.owners = `Bij ${n} ${list(parts)}.`;
  }
  return out;
}

function title(f) {
  return `${f.name} (${f.symbol}) koersdoel en verwachting ${f.forecastYear || new Date().getFullYear() + 1}: kopen of verkopen?`;
}

function description(f) {
  const c = f.consensus || {};
  let d = `${f.name} (${f.symbol}) aandeel: koers ${P(f.price)}`;
  if (isNum(c.target)) d += `, gemiddeld koersdoel ${P(c.target)} (${signed(c.upside)}) van ${c.analysts} analisten`;
  if (c.verdict) d += `, oordeel ${c.verdict.toLowerCase()}`;
  d += '. Verwachting, bull en bear case, upgrades en downgrades en welke analist het aandeel het best voorspelt.';
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
    faq: faq(facts).map((x) => ({ ...x, q: tidy(x.q), a: tidy(x.a) })),
    sections: Object.fromEntries(Object.entries(sections(facts)).map(([k, v]) => [k, tidy(v)])),
    title: tidy(title(facts)),
    forecast: fc ? { ...fc, text: tidy(fc.text) } : null,
    description: tidy(description(facts)),
  };
}

module.exports = { buildStory };
