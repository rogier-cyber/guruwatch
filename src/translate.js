'use strict';

// Nederlandse samenvatting en vertaling van earnings calls via Claude: één keer per call, daarna uit de database.
// Staat uit zolang ANTHROPIC_API_KEY ontbreekt.
const config = require('./config');
const db = require('./db');
const tr = require('./lib/transcripts');
const tl = require('./lib/translate');

const MAX_TRIES = 3;
const running = new Map();
let client = null;
let pausedUntil = 0;

function enabled() {
  return !!config.anthropicKey && Date.now() >= pausedUntil;
}

function getClient() {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new (Anthropic.default || Anthropic)({ apiKey: config.anthropicKey, maxRetries: 2, timeout: 10 * 60e3 });
  }
  return client;
}

async function companyName(symbol) {
  const r = await db.one('SELECT name FROM companies WHERE symbol = $1', [symbol]).catch(() => null);
  return (r && r.name) || symbol;
}

async function translateOne(symbol, year, quarter) {
  const row = await db.one('SELECT content, nl, nl_tries FROM earnings_transcripts WHERE symbol = $1 AND year = $2 AND quarter = $3', [symbol, year, quarter]);
  if (!row || row.nl_tries >= MAX_TRIES) return false;
  const a = tr.analyze(row.content, { full: true });
  if (row.nl && row.nl.v >= tl.NL_VERSION && tl.nlFits(row.nl, a.exchanges)) return false;
  const req = tl.buildRequest({ content: row.content, a, name: await companyName(symbol), label: `Q${quarter} ${year}`, model: config.translateModel });
  try {
    const msg = await getClient().messages.stream(req).finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('geweigerd');
    if (msg.stop_reason === 'max_tokens') throw new Error('antwoord te lang');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const nl = { ...tl.parseResult(text, a), model: msg.model, tokens: { in: msg.usage.input_tokens, out: msg.usage.output_tokens } };
    await db.query('UPDATE earnings_transcripts SET nl = $4, nl_at = now(), nl_tries = 0, nl_error = NULL WHERE symbol = $1 AND year = $2 AND quarter = $3', [symbol, year, quarter, JSON.stringify(nl)]);
    return true;
  } catch (err) {
    const Anthropic = require('@anthropic-ai/sdk');
    // Sleutel fout, tegoed op of te veel verzoeken: een uur pauze in plaats van alles te laten mislukken.
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.RateLimitError
      || (err instanceof Anthropic.BadRequestError && /credit|billing/i.test(err.message))) {
      pausedUntil = Date.now() + 3600e3;
      console.warn('[vertaling] gepauzeerd voor een uur:', err.message);
      throw err;
    }
    await db.query('UPDATE earnings_transcripts SET nl_tries = nl_tries + 1, nl_error = $4 WHERE symbol = $1 AND year = $2 AND quarter = $3', [symbol, year, quarter, String(err.message).slice(0, 500)]);
    console.warn('[vertaling]', symbol, year, quarter, err.message);
    return false;
  }
}

// Eén call vertalen; gelijktijdige aanvragen voor dezelfde call delen één run.
function translate(symbol, year, quarter) {
  if (!enabled()) return Promise.resolve(false);
  const k = `${symbol}:${year}:${quarter}`;
  if (running.has(k)) return running.get(k);
  const p = translateOne(symbol, year, quarter).finally(() => running.delete(k));
  running.set(k, p);
  return p;
}

// Op de achtergrond starten als iemand een call bekijkt die nog geen vertaling heeft.
function queue(symbol, year, quarter) {
  if (!enabled() || running.size >= 3) return;
  translate(symbol, year, quarter).catch(() => {});
}

// Achtergrond: per aandeel eerst de laatste call (die staat op de overzichtspagina), nieuwste eerst.
async function runTranslations({ max = 40 } = {}) {
  if (!config.anthropicKey) return { skipped: 'geen ANTHROPIC_API_KEY' };
  if (!enabled()) return { skipped: 'gepauzeerd' };
  const rows = await db.many(
    `SELECT symbol, year, quarter FROM (
       SELECT DISTINCT ON (symbol) symbol, year, quarter, date, nl, nl_tries, analysis FROM earnings_transcripts
       ORDER BY symbol, year DESC, quarter DESC) t
     WHERE (nl IS NULL OR coalesce((nl->>'v')::int, 0) < $1
            OR jsonb_array_length(coalesce(nl->'exchanges', '[]')) <> jsonb_array_length(coalesce(analysis->'exchanges', '[]')))
       AND nl_tries < $2 AND date >= current_date - 200
     ORDER BY date DESC LIMIT $3`,
    [tl.NL_VERSION, MAX_TRIES, max]
  );
  let done = 0;
  for (const r of rows) {
    try {
      if (await translate(r.symbol, r.year, r.quarter)) done++;
    } catch {
      break; // gepauzeerd
    }
  }
  return { todo: rows.length, done };
}

module.exports = { enabled, translate, queue, runTranslations };
