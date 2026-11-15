'use strict';

// Nederlandse samenvatting en vertaling van een earnings call met Claude. Dit deel bouwt alleen het verzoek en
// controleert het antwoord (zonder netwerk, dus te testen); src/translate.js doet de aanroep en slaat op.
const tr = require('./transcripts');

const NL_VERSION = 1;
const TOPIC_KEYS = tr.TOPICS.map((t) => t.key);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'outlook', 'keyPoints', 'exchanges'],
  properties: {
    summary: { type: 'string' },
    outlook: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['text', 'topic'], properties: { text: { type: 'string' }, topic: { type: 'string', enum: [...TOPIC_KEYS, ''] } } },
    },
    keyPoints: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['text', 'topic'], properties: { text: { type: 'string' }, topic: { type: 'string', enum: [...TOPIC_KEYS, ''] } } },
    },
    exchanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['i', 'q', 'a'],
        properties: { i: { type: 'integer' }, q: { type: 'string' }, a: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
};

const SYSTEM = `Je schrijft voor Guruwatch, een Nederlandse beleggerssite. Je krijgt het transcript van een earnings call (Engels) en maakt daar Nederlandse tekst van voor particuliere beleggers.

Regels:
- Schrijf helder, zakelijk Nederlands in volledige zinnen. Geen Engelse vaktaal als er een gewoon Nederlands woord voor is; gangbare termen (AI, cloud, capex, EBITDA, guidance) mogen blijven.
- Getallen precies overnemen; gebruik Nederlandse notatie (komma als decimaalteken, "miljard", "miljoen", "procentpunt").
- Verzin niets. Schrijf alleen op wat in het transcript staat. Geen eigen oordeel of beleggingsadvies.
- Juridische disclaimers (forward-looking statements, risico's die kunnen afwijken) laat je weg.

Velden:
- summary: 4 tot 6 zinnen over wat het management vertelde: hoe het kwartaal ging, wat de drijvende krachten waren en waar ze voorzichtig over waren.
- outlook: de prognose (guidance) die het management gaf voor het komende kwartaal en het (boek)jaar, elk punt één zin met de cijfers (omzet, marges, winst, investeringen, enz.). Ook uit de vragenronde. Geen prognose gegeven: lege lijst.
- keyPoints: 5 tot 8 punten uit de hele call die het belangrijkst zijn voor beleggers, elk één of twee zinnen, belangrijkste eerst. Herhaal de prognose niet.
- topic: het onderwerp dat het best past uit deze lijst, of "" als geen past: ${tr.TOPICS.map((t) => `${t.key} (${t.label})`).join(', ')}.
- exchanges: voor elke vraag in de vragenronde (zelfde nummer i) een volledige, getrouwe vertaling van de vraag (q) en van elk antwoord in dezelfde volgorde (a). Niet inkorten of samenvatten, wel haperingen en stopwoorden ("you know", "um") weglaten.`;

// Het verzoek voor één call. a = tr.analyze(content, { full: true }).
function buildRequest({ content, a, name, label, model }) {
  const turns = tr.parseTurns(content);
  const firstQ = a.exchanges.length ? turns.findIndex((t) => t.speaker === a.exchanges[0].analyst && t.text === a.exchanges[0].question) : -1;
  const prepared = (firstQ > 0 ? turns.slice(0, firstQ) : turns).map((t) => `${t.speaker}: ${t.text}`).join('\n');
  const qa = a.exchanges.map((e, i) => ({
    i,
    analyst: `${e.analyst}${e.firm ? ' (' + e.firm + ')' : ''}`,
    question: e.question,
    answers: (e.answers || []).map((x) => `${x.speaker}: ${x.text}`),
  }));
  const user = `Bedrijf: ${name}\nCall: ${label}\n\n<voorbereid_verhaal>\n${prepared}\n</voorbereid_verhaal>\n\n<vragenronde>\n${JSON.stringify(qa)}\n</vragenronde>\n\nGeef antwoord in het gevraagde JSON-formaat. exchanges moet precies ${qa.length} items hebben (i = 0 tot ${qa.length - 1}); "a" heeft per vraag evenveel teksten als er antwoorden zijn, zonder de naam van de spreker ervoor.`;
  return {
    model,
    max_tokens: 64000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: user }],
  };
}

// Controleer en orden het antwoord. Gooit een fout als het niet bruikbaar is.
function parseResult(text, a) {
  const j = JSON.parse(text);
  if (!j || typeof j.summary !== 'string' || !Array.isArray(j.keyPoints) || !Array.isArray(j.outlook) || !Array.isArray(j.exchanges)) throw new Error('onvolledig antwoord');
  const clean = (l) => l.filter((x) => x && typeof x.text === 'string' && x.text.trim()).map((x) => ({ text: x.text.trim(), topics: TOPIC_KEYS.includes(x.topic) ? [x.topic] : [] }));
  const byI = new Map(j.exchanges.map((x) => [x.i, x]));
  const exchanges = a.exchanges.map((e, i) => {
    const x = byI.get(i);
    const n = (e.answers || []).length;
    if (!x || typeof x.q !== 'string' || !Array.isArray(x.a) || (n && !x.a.length)) return null;
    // Antwoorden die ontbreken (of samengevoegd zijn) blijven op de pagina in het Engels.
    const ans = Array.from({ length: n }, (_, j) => String(x.a[j] || '').replace(/^[A-Z][\w.' -]{1,40}:\s*/, '').trim());
    if (x.a.length > n && n) ans[n - 1] = [ans[n - 1], ...x.a.slice(n).map(String)].join(' ');
    return { q: x.q.trim(), a: ans };
  });
  const missing = exchanges.filter((x) => !x).length;
  if (a.exchanges.length && missing > a.exchanges.length / 4) throw new Error(`${missing} van ${a.exchanges.length} vragen niet vertaald`);
  return { v: NL_VERSION, ex: a.exchanges.length, summary: j.summary.trim(), outlook: clean(j.outlook), keyPoints: clean(j.keyPoints), exchanges };
}

// Voor de pagina's: vragen en antwoorden met de Nederlandse tekst erin (waar die er is).
// Klopt de vertaling nog met de huidige analyse (zelfde aantal vragen)?
function nlFits(nl, exchanges) {
  return !!nl && Array.isArray(nl.exchanges) && nl.exchanges.length === exchanges.length;
}

function applyNl(exchanges, nl) {
  if (!nlFits(nl, exchanges)) return exchanges;
  return exchanges.map((e, i) => {
    const x = nl.exchanges[i];
    if (!x) return e;
    return { ...e, question: x.q, excerpt: tr.excerpt(x.q, 45).text, answers: (e.answers || []).map((an, j) => ({ ...an, text: x.a[j] || an.text })), nl: true };
  });
}

module.exports = { NL_VERSION, SCHEMA, SYSTEM, buildRequest, parseResult, applyNl, nlFits };
