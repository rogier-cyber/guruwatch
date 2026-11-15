'use strict';

// Analyse van earnings call transcripts zonder AI: sprekers, vragenronde, onderwerpen en toon.
// Alles hier is puur (geen database), zodat het los te testen is.

// Onderwerpen met Engelse zoekwoorden (transcripts zijn Engels). Label in het Nederlands.
const TOPICS = [
  { key: 'ai', label: 'AI', re: /\b(ai|a\.i\.|artificial intelligence|generative|gen ?ai|llms?|large language models?|machine learning|inference|copilot|agentic)\b/g },
  { key: 'vraag', label: 'Vraag en orders', re: /\b(demand|orders?|order book|backlog|bookings?|pipeline)\b/g },
  { key: 'marge', label: 'Marges', re: /\b(margins?|profitability)\b/g },
  { key: 'prijs', label: 'Prijzen', re: /\b(pricing|price increases?|price hikes?|price points?)\b/g },
  { key: 'kosten', label: 'Kosten', re: /\b(costs?|expenses?|opex|efficienc(y|ies)|headcount|restructuring|savings)\b/g },
  { key: 'guidance', label: 'Vooruitzichten', re: /\b(guidance|outlook|full[- ]year|next quarter|forecast)\b/g },
  { key: 'china', label: 'China', re: /\b(china|chinese|greater china)\b/g },
  { key: 'tarief', label: 'Heffingen en handel', re: /\b(tariffs?|trade war|export controls?|export restrictions?|duties)\b/g },
  { key: 'capex', label: 'Investeringen', re: /\b(capex|capital expenditures?|data cent(er|re)s?|capacity|build[- ]?outs?)\b/g },
  { key: 'kapitaal', label: 'Inkoop en dividend', re: /\b(buybacks?|repurchases?|repurchasing|dividends?|capital returns?|return of capital)\b/g },
  { key: 'concurrentie', label: 'Concurrentie', re: /\b(competition|competitive|competitors?|market share)\b/g },
  { key: 'regels', label: 'Regels en rechtszaken', re: /\b(regulat\w+|antitrust|doj|ftc|european commission|lawsuits?|litigation|legal)\b/g },
  { key: 'macro', label: 'Economie en consument', re: /\b(macro\w*|consumers?|inflation|interest rates?|recession|economy|economic)\b/g },
  { key: 'cloud', label: 'Cloud en abonnementen', re: /\b(cloud|saas|subscriptions?|subscribers?|recurring revenue|arr)\b/g },
  { key: 'keten', label: 'Toelevering', re: /\b(supply chain|suppl(y|iers?)|inventor(y|ies)|shortages?|constraints?)\b/g },
  { key: 'product', label: 'Nieuwe producten', re: /\b(launch(es|ed|ing)?|new products?|roadmap|innovation|next[- ]generation)\b/g },
  { key: 'overname', label: 'Overnames', re: /\b(acquisitions?|acquire[ds]?|m&a|mergers?)\b/g },
  { key: 'valuta', label: 'Valuta', re: /\b(currency|currencies|fx|foreign exchange|stronger dollar|weaker dollar)\b/g },
];

// Kleine woordenlijsten voor de toon, in de geest van Loughran-McDonald (financiële taal).
const POS = /\b(strong(er|est|ly)?|record|growth|grew|grow(ing)?|improv(e|ed|es|ing|ement|ements)|exceed(ed|ing)?|robust|momentum|confiden(t|ce)|pleased|excited|exciting|outperform\w*|accelerat(e|ed|ing|ion)|healthy|solid|opportunit(y|ies)|success(ful|fully)?|gains?|benefit(s|ed)?|beat|favorable|upside|tailwinds?|expan(d|ded|ding|sion)|resilien(t|ce)|outstanding|great)\b/g;
const NEG = /\b(declin(e|ed|es|ing)|weak(ness|er|ened|ening)?|challeng(e|es|ed|ing)|difficult(y|ies)?|headwinds?|pressures?|loss(es)?|decreas(e|ed|es|ing)|slow(er|down|ed|ing)|soft(ness|er|ening)?|risks?|concern(s|ed)?|miss(ed)?|disappoint(ed|ing|ment)?|impairments?|cautious|adverse(ly)?|shortfall|delay(s|ed)?|downturn|deteriorat\w+|uncertain\w*)\b/g;
const UNC = /\b(uncertain\w*|unclear|unpredictab\w*|volatil\w*|may|might|could|possibl[ey]|depend(s|ing|ent)?|approximately|roughly)\b/g;

// Verhoog bij een betere analyse: opgeslagen calls worden dan opnieuw geanalyseerd.
const VERSION = 2;

const count = (text, re) => {
  re.lastIndex = 0;
  const m = text.match(re);
  return m ? m.length : 0;
};
const words = (text) => (text.match(/[A-Za-z0-9'’-]+/g) || []).length;

// "Naam: tekst" per regel. Regels zonder spreker horen bij de vorige spreker.
function parseTurns(content) {
  const turns = [];
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Z][A-Za-z.'’\- ]{1,60}?)\s*:\s+(.*)$/);
    if (m && m[1].split(/\s+/).length <= 6) turns.push({ speaker: m[1].trim(), text: m[2].trim() });
    else if (turns.length) turns[turns.length - 1].text += ' ' + line;
    else turns.push({ speaker: 'Onbekend', text: line });
  }
  return turns;
}

const isOperator = (s) => /^(operator|moderator|conference operator)$/i.test(s.trim());
const NAME = "([A-Z][\\w.'’-]+(?:\\s+(?:[A-Z][\\w.'’-]+|de|van|von|del|da|di|la|le)){0,4})";
const FIRM = "([A-Z][\\w&.'’-]*(?:[\\s,]+(?:[A-Z&][\\w&.'’-]*|and|of|de|du|&))*)";
const INTRO = new RegExp(`(?:from|is|of|to)\\s+(?:the\\s+line\\s+of\\s+)?${NAME}\\s+(?:with|from|of|at)\\s+${FIRM}`, 'g');
const STOP = /^(the|our|your|this|that|line|question|questions|next|first|last|please|go|ahead)$/i;

// Haal analist + bank uit de zinnen van de operator ("Our next question comes from X with Y.").
function analystIntros(turns) {
  const map = new Map();
  for (const t of turns) {
    if (!isOperator(t.speaker)) continue;
    t.intros = [];
    if (!/question|line|caller|next/i.test(t.text)) continue;
    INTRO.lastIndex = 0;
    let m;
    while ((m = INTRO.exec(t.text))) {
      const name = m[1].trim();
      if (STOP.test(name.split(/\s+/)[0])) continue;
      const firm = m[2].replace(/[\s,]+(Please|Your|You|Go|Thank|The|Ladies)\b.*$/, '').replace(/[.,\s]+$/, '').trim();
      if (!map.has(name)) map.set(name, firm || null);
      t.intros.push(firm || null);
    }
  }
  return map;
}

// Komt een spreker overeen met een door de operator genoemde naam (soms alleen voornaam+achternaam)?
function matchName(speaker, names) {
  const s = speaker.toLowerCase();
  for (const n of names) {
    const l = n.toLowerCase();
    if (l === s) return n;
    const sp = s.split(/\s+/);
    const np = l.split(/\s+/);
    // Zelfde achternaam en voorletter: Alex/Alexander, C.J./Christopher, Jeff/Jeffrey.
    if (sp.length > 1 && sp[0][0] === np[0][0] && sp[sp.length - 1] === np[np.length - 1]) return n;
  }
  return null;
}

function topicCounts(text) {
  const lower = text.toLowerCase();
  const out = {};
  for (const tp of TOPICS) out[tp.key] = count(lower, tp.re);
  return out;
}

function tone(text) {
  const lower = text.toLowerCase();
  const pos = count(lower, POS);
  const neg = count(lower, NEG);
  const unc = count(lower, UNC);
  const w = words(text);
  // Onder 5 toonwoorden zegt de verhouding te weinig.
  return { pos, neg, unc, words: w, net: pos + neg >= 5 ? (pos - neg) / (pos + neg) : null };
}

function firstWords(text, n) {
  const w = String(text).split(/\s+/).filter(Boolean);
  return w.slice(0, n).join(' ') + (w.length > n ? ' …' : '');
}

// De volledige analyse van één transcript.
function analyze(content) {
  const turns = parseTurns(content);
  const intros = analystIntros(turns);
  const introNames = [...intros.keys()];

  // Start van de vragenronde: eerste operator-beurt die over vragen gaat, na minstens één andere spreker.
  let qaStart = turns.length;
  let seenOther = false;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!isOperator(t.speaker)) { seenOther = true; continue; }
    if (seenOther && /question|q&a|q & a|line of|caller/i.test(t.text)) { qaStart = i; break; }
  }

  const prepared = new Set(turns.slice(0, qaStart).filter((t) => !isOperator(t.speaker)).map((t) => t.speaker));
  // Sprekers die direct na een operator-introductie in de vragenronde praten en niet in het eerste deel spraken = analisten.
  const role = new Map();
  for (let i = qaStart; i < turns.length; i++) {
    const t = turns[i];
    if (isOperator(t.speaker) || role.has(t.speaker)) continue;
    const named = matchName(t.speaker, introNames);
    if (named) role.set(t.speaker, { kind: 'analyst', firm: intros.get(named) });
    // Niet bij naam genoemd (bv. "This is Emily on for Dave"): direct na een introductie, dan de bank van die introductie.
    else if (!prepared.has(t.speaker) && i > 0 && isOperator(turns[i - 1].speaker)) role.set(t.speaker, { kind: 'analyst', firm: (turns[i - 1].intros || [])[0] || null });
  }
  for (const t of turns) if (!isOperator(t.speaker) && !role.has(t.speaker)) role.set(t.speaker, { kind: 'mgmt' });

  const mgmtText = [];
  const anText = [];
  const preparedText = [];
  const qaMgmtText = [];
  const analysts = new Map();
  const mgmt = new Map();
  const exchanges = []; // per vraag: analist, vraag (kort), wie antwoordde
  let cur = null;
  turns.forEach((t, i) => {
    if (isOperator(t.speaker)) { cur = null; return; }
    const r = role.get(t.speaker);
    if (r.kind === 'analyst') {
      anText.push(t.text);
      if (!analysts.has(t.speaker)) analysts.set(t.speaker, { name: t.speaker, firm: r.firm, turns: 0, words: 0, text: [] });
      const a = analysts.get(t.speaker);
      a.turns++;
      a.words += words(t.text);
      a.text.push(t.text);
      // Korte bedankjes tellen niet als nieuwe vraag.
      if (words(t.text) >= 12 || /\?/.test(t.text)) {
        cur = { analyst: t.speaker, firm: r.firm, q: t.text, answeredBy: [], answerWords: 0 };
        exchanges.push(cur);
      }
    } else {
      mgmtText.push(t.text);
      (i < qaStart ? preparedText : qaMgmtText).push(t.text);
      if (!mgmt.has(t.speaker)) mgmt.set(t.speaker, { name: t.speaker, words: 0 });
      mgmt.get(t.speaker).words += words(t.text);
      if (cur && i >= qaStart) {
        if (!cur.answeredBy.includes(t.speaker)) cur.answeredBy.push(t.speaker);
        cur.answerWords += words(t.text);
      }
    }
  });

  const mT = mgmtText.join(' ');
  const aT = anText.join(' ');
  const topicsM = topicCounts(mT);
  const topicsA = topicCounts(aT);
  const wordsM = words(mT);
  const wordsA = words(aT);

  return {
    v: VERSION,
    words: { total: wordsM + wordsA, mgmt: wordsM, analysts: wordsA, prepared: words(preparedText.join(' ')), qa: words(qaMgmtText.join(' ')) + wordsA },
    tone: { mgmt: tone(mT), analysts: tone(aT), prepared: tone(preparedText.join(' ')), qa: tone(qaMgmtText.join(' ')) },
    topics: { mgmt: topicsM, analysts: topicsA },
    analysts: [...analysts.values()].map((a) => ({ name: a.name, firm: a.firm, questions: exchanges.filter((e) => e.analyst === a.name).length || 1, words: a.words, topics: topTopics(topicCounts(a.text.join(' ')), 3) })),
    management: [...mgmt.values()].sort((a, b) => b.words - a.words),
    exchanges: exchanges.map((e) => ({ analyst: e.analyst, firm: e.firm, excerpt: firstWords(e.q, 40), topics: topTopics(topicCounts(e.q), 2), answeredBy: e.answeredBy, answerWords: e.answerWords })),
    hasQa: qaStart < turns.length,
  };
}

function topTopics(counts, n) {
  return Object.entries(counts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

const topicLabel = (key) => (TOPICS.find((t) => t.key === key) || { label: key }).label;

// Per 10.000 woorden, zodat lange en korte calls vergelijkbaar zijn.
const per10k = (n, w) => (w > 0 ? (n / w) * 10000 : 0);

// Vergelijk een call met de vorige: welke onderwerpen stijgen of dalen, bij management en bij analisten.
function compare(cur, prev) {
  if (!cur || !prev) return null;
  const rows = TOPICS.map((tp) => {
    const m = per10k(cur.topics.mgmt[tp.key], cur.words.mgmt) - per10k(prev.topics.mgmt[tp.key], prev.words.mgmt);
    const a = per10k(cur.topics.analysts[tp.key], cur.words.analysts) - per10k(prev.topics.analysts[tp.key], prev.words.analysts);
    return { key: tp.key, label: tp.label, mgmt: m, analysts: a, curM: cur.topics.mgmt[tp.key], prevM: prev.topics.mgmt[tp.key], curA: cur.topics.analysts[tp.key], prevA: prev.topics.analysts[tp.key] };
  });
  const sig = (r, f) => Math.abs(r[f]) >= 3;
  const by = (f, dir) => rows.filter((r) => sig(r, f) && Math.sign(r[f]) === dir).sort((x, y) => dir * (y[f] - x[f])).slice(0, 4);
  const tn = (x) => (x && x.net != null ? x.net : null);
  return {
    mgmtUp: by('mgmt', 1),
    mgmtDown: by('mgmt', -1),
    anUp: by('analysts', 1),
    anDown: by('analysts', -1),
    toneMgmt: tn(cur.tone.mgmt) != null && tn(prev.tone.mgmt) != null ? tn(cur.tone.mgmt) - tn(prev.tone.mgmt) : null,
    toneAn: tn(cur.tone.analysts) != null && tn(prev.tone.analysts) != null ? tn(cur.tone.analysts) - tn(prev.tone.analysts) : null,
    uncMgmt: per10k(cur.tone.mgmt.unc, cur.words.mgmt) - per10k(prev.tone.mgmt.unc, prev.words.mgmt),
    newAnalysts: cur.analysts.filter((a) => !prev.analysts.some((p) => p.name === a.name)).map((a) => a.name),
  };
}

// Toon als woord, voor in teksten en tooltips.
function toneWord(net) {
  if (net == null) return 'onbekend';
  if (net >= 0.6) return 'zeer positief';
  if (net >= 0.35) return 'positief';
  if (net >= 0.1) return 'licht positief';
  if (net > -0.1) return 'neutraal';
  if (net > -0.35) return 'licht negatief';
  return 'negatief';
}

module.exports = { VERSION, TOPICS, parseTurns, analystIntros, analyze, compare, topicLabel, topTopics, per10k, toneWord, tone };
