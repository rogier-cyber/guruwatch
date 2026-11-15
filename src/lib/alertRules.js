'use strict';

// Soorten meldingen voor Mijn GuruWatch, met standaardinstellingen en uitleg.
// Puur (geen database), zodat het te testen is.

const RULES = {
  top_raises: {
    label: 'Topanalisten verhogen samen',
    describe: (p) => `${p.min}+ analisten met GuruScore ${p.minScore}+ verhogen binnen ${p.days} dagen hun koersdoel${p.scope === 'all' ? ' (alle aandelen)' : ' op een aandeel dat je volgt'}`,
    defaults: { min: 3, days: 7, minScore: 70, scope: 'watchlist', email: 'direct' },
    fields: ['min', 'days', 'minScore', 'scope', 'email'],
  },
  smart_upside: {
    label: 'Slimme consensus ziet veel potentieel',
    describe: (p) => `De slimme consensus (GuruScore ${p.minScore}+) ziet meer dan ${Math.round(p.min * 100)}% potentieel${p.scope === 'all' ? ' (alle aandelen)' : ' op een aandeel dat je volgt'}`,
    defaults: { min: 0.25, minScore: 70, scope: 'watchlist', email: 'direct' },
    fields: ['min', 'minScore', 'scope', 'email'],
  },
  top_flip: {
    label: 'Een topanalist draait',
    describe: (p) => `Een analist met GuruScore ${p.minScore}+ draait van positief naar negatief (of andersom), of een topbank up- of downgradet${p.scope === 'all' ? ' (alle aandelen)' : ' een aandeel dat je volgt'}`,
    defaults: { minScore: 70, scope: 'watchlist', email: 'direct' },
    fields: ['minScore', 'scope', 'email'],
  },
  target_hit: {
    label: 'Koersdoel gehaald',
    describe: (p) => `De koers bereikt vandaag het koersdoel van een analist met GuruScore ${p.minScore}+ op een aandeel dat je volgt`,
    defaults: { minScore: 60, scope: 'watchlist', email: 'direct' },
    fields: ['minScore', 'email'],
  },
  insider_buy: {
    label: 'Insider koopt',
    describe: (p) => `Een insider koopt voor meer dan $${Math.round(p.min / 1000)}k aandelen van een bedrijf dat je volgt`,
    defaults: { min: 100000, scope: 'watchlist', email: 'direct' },
    fields: ['min', 'email'],
  },
  analyst_call: {
    label: 'Gevolgde analist publiceert',
    describe: () => 'Een analist die je volgt geeft een nieuw koersdoel af',
    defaults: { email: 'briefing' },
    fields: ['email'],
  },
  fund_change: {
    label: 'Gevolgd fonds heeft nieuwe 13F',
    describe: () => 'Een hedge fund dat je volgt publiceert een nieuwe kwartaalportefeuille',
    defaults: { email: 'briefing' },
    fields: ['email'],
  },
  watch_activity: {
    label: 'Alle analistenactiviteit op je aandelen',
    describe: () => 'Elk nieuw koersdoel en elke up- of downgrade op aandelen die je volgt',
    defaults: { email: 'briefing' },
    fields: ['email'],
  },
};

const KINDS = Object.keys(RULES);

// Grenzen voor wat iemand kan invullen.
const LIMITS = {
  min: { top_raises: [2, 10], smart_upside: [0.05, 2], insider_buy: [10000, 10000000] },
  days: [1, 30],
  minScore: [40, 95],
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Maak van formulier- of databasewaarden geldige instellingen.
function normalizeParams(kind, raw = {}) {
  const def = RULES[kind];
  if (!def) return null;
  const p = { ...def.defaults };
  for (const f of def.fields) {
    const v = raw[f];
    if (v === undefined || v === null || v === '') continue;
    if (f === 'scope') p.scope = v === 'all' ? 'all' : 'watchlist';
    else if (f === 'email') p.email = v === 'briefing' ? 'briefing' : 'direct';
    else {
      let n = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n)) continue;
      // Percentages mogen als 25 of als 0,25 worden ingevuld.
      if (f === 'min' && kind === 'smart_upside' && n > 2) n /= 100;
      const lim = f === 'min' ? LIMITS.min[kind] : LIMITS[f];
      p[f] = lim ? clamp(n, lim[0], lim[1]) : n;
      if (f !== 'min' || kind !== 'smart_upside') p[f] = Math.round(p[f]);
    }
  }
  return p;
}

function describe(kind, params) {
  const def = RULES[kind];
  return def ? def.describe(normalizeParams(kind, params)) : kind;
}

// Standaardset voor nieuwe gebruikers.
const DEFAULT_KINDS = ['top_raises', 'smart_upside', 'top_flip', 'target_hit', 'insider_buy', 'analyst_call', 'fund_change', 'watch_activity'];

// Moment voor de ochtendbriefing: werkdagen om 08:00 Amsterdamse tijd.
function amsterdamParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: parts.weekday };
}

function briefingDue(lastSentAt, now = new Date()) {
  const p = amsterdamParts(now);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  if (p.hour < 8 || p.hour >= 11) return false; // na 11:00 niet meer inhalen
  if (!lastSentAt) return true;
  return amsterdamParts(new Date(lastSentAt)).day !== p.day;
}

// Weekmail: zaterdag tussen 09:00 en 13:00 (Amsterdam), één keer per zaterdag.
function weeklyDue(lastSentAt, now = new Date()) {
  const p = amsterdamParts(now);
  if (p.weekday !== 'Sat' || p.hour < 9 || p.hour >= 13) return false;
  if (!lastSentAt) return true;
  return amsterdamParts(new Date(lastSentAt)).day !== p.day;
}

module.exports = { RULES, KINDS, DEFAULT_KINDS, normalizeParams, describe, amsterdamParts, briefingDue, weeklyDue };
