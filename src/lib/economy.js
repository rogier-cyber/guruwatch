'use strict';

// Economische kalender: normaliseren van FMP/EODHD-regels, Nederlandse namen en weergave.

const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Landen die we tonen, in volgorde van belang voor een Nederlandse belegger.
const COUNTRIES = [
  { code: 'NL', name: 'Nederland', flag: '🇳🇱' },
  { code: 'EU', name: 'Eurozone', flag: '🇪🇺' },
  { code: 'US', name: 'Verenigde Staten', short: 'VS', flag: '🇺🇸' },
  { code: 'DE', name: 'Duitsland', flag: '🇩🇪' },
  { code: 'FR', name: 'Frankrijk', flag: '🇫🇷' },
  { code: 'BE', name: 'België', flag: '🇧🇪' },
  { code: 'GB', name: 'Verenigd Koninkrijk', short: 'VK', flag: '🇬🇧' },
  { code: 'CN', name: 'China', flag: '🇨🇳' },
  { code: 'JP', name: 'Japan', flag: '🇯🇵' },
];
const COUNTRY = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));
const ALIASES = { UK: 'GB', EMU: 'EU', EZ: 'EU', EA: 'EU', USA: 'US' };

function countryCode(c) {
  const up = String(c || '').trim().toUpperCase();
  return ALIASES[up] || up;
}

// EODHD geeft geen 'impact'; schat die op basis van de naam.
const HIGH_RE = /non[- ]?farm|payrolls|interest rate decision|rate decision|deposit (facility )?rate|cpi|inflation rate|consumer price|gdp|unemployment rate|retail sales|ism (manufacturing|services|non-manufacturing)|pce|fomc|press conference|jolts|ifo business|zew/i;
const MED_RE = /pmi|jobless claims|ppi|producer price|industrial production|durable goods|consumer confidence|consumer sentiment|michigan|balance of trade|trade balance|housing starts|building permits|home sales|adp|average (hourly )?earnings|factory orders|business confidence|crude oil inventories|speech|minutes/i;

function guessImpact(event) {
  if (HIGH_RE.test(event)) return 'High';
  if (MED_RE.test(event)) return 'Medium';
  return 'Low';
}

function normImpact(v, event) {
  const s = String(v || '').toLowerCase();
  if (s.startsWith('h')) return 'High';
  if (s.startsWith('m')) return 'Medium';
  if (s.startsWith('l')) return 'Low';
  return guessImpact(event);
}

// FMP en EODHD geven tijden in UTC als "2026-11-18 13:30:00".
function utcDate(s) {
  if (!s) return null;
  const str = String(s).trim().replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : `${str}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Periode tussen haakjes uit de naam halen: "Non Farm Payrolls (Oct)" -> event + "Oct".
function splitPeriod(event) {
  const m = String(event || '').match(/^(.*?)\s*\(([^)]{1,12})\)\s*$/);
  return m ? { event: m[1].trim(), period: m[2].trim() } : { event: String(event || '').trim(), period: '' };
}

function fromFmp(x) {
  const at = utcDate(x && x.date);
  if (!at || !x.event) return null;
  const { event, period } = splitPeriod(x.event);
  return {
    at, country: countryCode(x.country), currency: x.currency || null, event, period,
    impact: normImpact(x.impact, event), previous: n(x.previous), estimate: n(x.estimate), actual: n(x.actual),
    unit: x.unit || null, source: 'fmp',
  };
}

function fromEodhd(x) {
  const at = utcDate(x && x.date);
  if (!at || !x.type) return null;
  const sp = splitPeriod(x.type);
  return {
    at, country: countryCode(x.country), currency: null, event: sp.event, period: x.period || sp.period || '',
    impact: guessImpact(sp.event), previous: n(x.previous), estimate: n(x.estimate), actual: n(x.actual),
    unit: x.comparison && /%|percent/i.test(x.comparison) ? '%' : null, source: 'eodhd',
  };
}

// ---------- Nederlandse namen ----------
// Volgorde telt: langere/specifiekere zinsdelen eerst.
const PHRASES = [
  [/fed interest rate decision/i, 'Rentebesluit Fed'],
  [/ecb interest rate decision|ecb main refinancing rate/i, 'Rentebesluit ECB'],
  [/ecb deposit (facility )?rate( decision)?/i, 'Depositorente ECB'],
  [/boe interest rate decision|bank of england interest rate decision/i, 'Rentebesluit Bank of England'],
  [/boj interest rate decision/i, 'Rentebesluit Bank of Japan'],
  [/pboc loan prime rate|loan prime rate( \d+y)?/i, 'Loan prime rate China'],
  [/fomc minutes/i, 'Notulen Fed (FOMC)'],
  [/fomc economic projections/i, 'Economische projecties Fed'],
  [/ecb monetary policy (meeting )?accounts/i, 'Notulen ECB'],
  [/ecb press conference/i, 'Persconferentie ECB'],
  [/fed press conference|fomc press conference/i, 'Persconferentie Fed'],
  [/(fed chair )?powell speech|fed chair powell speaks/i, 'Toespraak Fed-voorzitter Powell'],
  [/(ecb president )?lagarde speech|ecb president lagarde speaks/i, 'Toespraak ECB-president Lagarde'],
  [/non[- ]?farm payrolls/i, 'Banen buiten de landbouw (nonfarm payrolls)'],
  [/adp employment change/i, 'ADP-banengroei'],
  [/initial jobless claims/i, 'Nieuwe WW-aanvragen'],
  [/continuing jobless claims/i, 'Lopende WW-aanvragen'],
  [/jolts job openings/i, 'Vacatures (JOLTS)'],
  [/average hourly earnings/i, 'Gemiddeld uurloon'],
  [/unemployment rate/i, 'Werkloosheid'],
  [/unemployment change/i, 'Verandering werkloosheid'],
  [/employment change/i, 'Banengroei'],
  [/core pce price index/i, 'Kern-PCE-prijsindex'],
  [/pce price index/i, 'PCE-prijsindex'],
  [/core inflation rate/i, 'Kerninflatie'],
  [/inflation rate/i, 'Inflatie'],
  [/core cpi/i, 'Kern-CPI'],
  [/harmonised (inflation rate|cpi)|hicp/i, 'Geharmoniseerde inflatie (HICP)'],
  [/cpi/i, 'Consumentenprijzen (CPI)'],
  [/core ppi/i, 'Kern-producentenprijzen'],
  [/ppi|producer price index|producer prices/i, 'Producentenprijzen'],
  [/gdp growth rate/i, 'Bbp-groei'],
  [/gdp price index/i, 'Bbp-prijsindex'],
  [/gdp/i, 'Bbp'],
  [/retail sales ex autos/i, 'Detailhandelsverkopen excl. auto’s'],
  [/retail sales/i, 'Detailhandelsverkopen'],
  [/ism manufacturing pmi/i, 'ISM-inkoopmanagersindex industrie'],
  [/ism (services|non-manufacturing) pmi/i, 'ISM-inkoopmanagersindex diensten'],
  [/manufacturing pmi/i, 'Inkoopmanagersindex industrie'],
  [/services pmi/i, 'Inkoopmanagersindex diensten'],
  [/composite pmi/i, 'Inkoopmanagersindex totaal'],
  [/industrial production/i, 'Industriële productie'],
  [/manufacturing production/i, 'Productie industrie'],
  [/durable goods orders ex transportation/i, 'Orders duurzame goederen excl. transport'],
  [/durable goods orders/i, 'Orders duurzame goederen'],
  [/factory orders/i, 'Fabrieksorders'],
  [/michigan consumer sentiment/i, 'Consumentenvertrouwen Michigan'],
  [/michigan inflation expectations/i, 'Inflatieverwachting Michigan'],
  [/cb consumer confidence/i, 'Consumentenvertrouwen Conference Board'],
  [/consumer confidence/i, 'Consumentenvertrouwen'],
  [/consumer sentiment/i, 'Consumentenvertrouwen'],
  [/business confidence/i, 'Producentenvertrouwen'],
  [/ifo business climate/i, 'Ifo-ondernemersklimaat'],
  [/zew economic sentiment( index)?/i, 'ZEW-economisch sentiment'],
  [/zew current conditions/i, 'ZEW-huidige situatie'],
  [/balance of trade|trade balance/i, 'Handelsbalans'],
  [/current account/i, 'Lopende rekening'],
  [/building permits/i, 'Bouwvergunningen'],
  [/housing starts/i, 'Woningbouw gestart'],
  [/existing home sales/i, 'Verkopen bestaande woningen'],
  [/new home sales/i, 'Verkopen nieuwe woningen'],
  [/pending home sales/i, 'Voorlopige woningverkopen'],
  [/house price index/i, 'Huizenprijsindex'],
  [/eia crude oil stocks change|crude oil inventories/i, 'Olievoorraden VS'],
  [/philadelphia fed manufacturing index/i, 'Philly Fed-industrie-index'],
  [/ny empire state manufacturing index/i, 'Empire State-industrie-index'],
  [/household consumption|household spending/i, 'Consumptie huishoudens'],
  [/personal income/i, 'Persoonlijk inkomen'],
  [/personal spending/i, 'Persoonlijke uitgaven'],
  [/exports/i, 'Export'],
  [/imports/i, 'Import'],
];
const SUFFIX = [[/\bYoY\b/i, 'j/j'], [/\bMoM\b/i, 'm/m'], [/\bQoQ\b/i, 'k/k'], [/\bFinal\b/i, '(definitief)'], [/\bPrel(iminary)?\b/i, '(voorlopig)'], [/\bFlash\b/i, '(eerste raming)'], [/\bAdv(ance)?\b/i, '(eerste raming)'], [/\b2nd Est(imate)?\b/i, '(2e raming)'], [/\b3rd Est(imate)?\b/i, '(3e raming)']];
// Woorden die na vertalen mogen blijven staan (namen, afkortingen).
const KEEP = new Set(['hcob', 's&p', 'global', 'caixin', 'nbs', 'au', 'jibun', 'bank', 'nevi', 'ism', 'cb', 'ecb', 'fed', 'boe', 'boj', 'ifo', 'zew', 'gfk', 'cbs', 'nbb', 'insee', 'destatis', 'adp', 'nationwide', 'halifax', 'rics', 'tankan', 'ex', 'excl', 'sa', 'nsa', 'w/e', 's.a', 'n.s.a', 'annualized', 'total']);

function dutchEvent(event) {
  const original = String(event || '').trim();
  let rest = original;
  let nl = '';
  for (const [re, txt] of PHRASES) {
    if (re.test(rest)) {
      rest = rest.replace(re, ' ').trim();
      nl = txt;
      break;
    }
  }
  if (!nl) return original;
  const tags = [];
  for (const [re, txt] of SUFFIX) {
    if (re.test(rest)) {
      rest = rest.replace(re, ' ');
      if (!tags.includes(txt)) tags.push(txt);
    }
  }
  // Wat er nog over is: alleen toegestaan als het een naam/afkorting is (bv. "HCOB", "S&P Global").
  const left = rest.split(/\s+/).filter(Boolean);
  const unknown = left.filter((w) => !KEEP.has(w.toLowerCase().replace(/[(),.-]+$/g, '')) && !/^[A-Z0-9&]{2,}$/.test(w));
  if (unknown.length) return original;
  const prefix = left.length ? `${left.join(' ')} ` : '';
  const out = `${prefix}${nl}`;
  return tags.length ? `${out} ${tags.join(' ')}` : out;
}

// ---------- Weergave ----------
const PCT_RE = /rate|yoy|mom|qoq|growth|inflation|cpi|ppi|pce|change %|%/i;
const INDEX_RE = /pmi|sentiment|confidence|climate|index/i;

function unitFor(e) {
  if (e.unit) return String(e.unit).trim();
  if (INDEX_RE.test(e.event) && !/price index|cpi|ppi|pce/i.test(e.event)) return '';
  if (PCT_RE.test(e.event)) return '%';
  return '';
}

const nl = (v, digits) => new Intl.NumberFormat('nl-NL', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);

function decimals(v) {
  const a = Math.abs(v);
  if (a >= 100) return a % 1 === 0 ? 0 : 1;
  const s = String(v);
  const d = s.includes('.') ? s.split('.')[1].length : 0;
  return Math.min(2, d);
}

function formatValue(v, unit) {
  if (v === null || v === undefined) return '–';
  const u = String(unit || '').trim();
  const str = nl(v, decimals(v));
  if (u === '%') return `${str}%`;
  if (/^k$/i.test(u)) return `${str}K`;
  if (/^m$/i.test(u)) return `${str} mln`;
  if (/^b$/i.test(u)) return `${str} mld`;
  if (/^t$/i.test(u)) return `${str} bln`;
  return u ? `${str} ${u}` : str;
}

// Uitkomst ten opzichte van de verwachting: richting zonder oordeel (hoger is niet altijd beter).
function vsEstimate(actual, estimate) {
  if (actual === null || actual === undefined || estimate === null || estimate === undefined) return null;
  const diff = actual - estimate;
  if (Math.abs(diff) < 1e-9) return { dir: 0, label: 'gelijk aan verwachting' };
  return { dir: diff > 0 ? 1 : -1, label: diff > 0 ? 'boven verwachting' : 'onder verwachting' };
}

const MONTHS = { jan: 'jan', feb: 'feb', mar: 'mrt', apr: 'apr', may: 'mei', jun: 'jun', jul: 'jul', aug: 'aug', sep: 'sep', oct: 'okt', nov: 'nov', dec: 'dec' };
function dutchPeriod(p) {
  return String(p || '').replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, (m, k) => MONTHS[k.toLowerCase()]);
}

const IMPACT_LEVEL = { High: 3, Medium: 2, Low: 1 };

// Voor de pagina: Amsterdamse dag + tijd, landnaam, Nederlandse naam.
function present(e, now = new Date()) {
  const at = new Date(e.at);
  const ams = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  const [day, time] = ams.split(' ');
  const unit = unitFor(e);
  const c = COUNTRY[e.country] || { code: e.country, name: e.country, flag: '' };
  return {
    ...e,
    day, time: time === '00:00' ? 'hele dag' : time,
    country: c,
    name: dutchEvent(e.event),
    period: dutchPeriod(e.period),
    level: IMPACT_LEVEL[e.impact] || 1,
    unit,
    fmt: { actual: formatValue(e.actual, unit), estimate: formatValue(e.estimate, unit), previous: formatValue(e.previous, unit) },
    vs: vsEstimate(e.actual, e.estimate),
    past: at <= now,
  };
}

module.exports = { dutchPeriod, COUNTRIES, COUNTRY, countryCode, guessImpact, utcDate, splitPeriod, fromFmp, fromEodhd, dutchEvent, unitFor, formatValue, vsEstimate, present };
