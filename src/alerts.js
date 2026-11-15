'use strict';

// Mijn GuruWatch: meldingen berekenen, direct mailen en de ochtendbriefing versturen.
const path = require('path');
const crypto = require('crypto');
const ejs = require('ejs');
const db = require('./db');
const config = require('./config');
const { sendMail } = require('./auth');
const { RULES, DEFAULT_KINDS, normalizeParams, briefingDue, weeklyDue } = require('./lib/alertRules');
const fmt = require('./lib/format');

const TARGET = 'coalesce(p.adj_price_target, p.price_target)';
const pct = (v) => fmt.pct(v);
const money = (v) => fmt.price(v);

// ---------- Regels per gebruiker ----------

async function ensureDefaults(userId) {
  await db.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  const has = await db.one('SELECT 1 AS x FROM alert_rules WHERE user_id = $1 LIMIT 1', [userId]);
  if (has) return;
  for (const kind of DEFAULT_KINDS) {
    await db.query('INSERT INTO alert_rules (user_id, kind, params) VALUES ($1, $2, $3)', [userId, kind, JSON.stringify(RULES[kind].defaults)]);
  }
}

async function watchOf(userId) {
  const rows = await db.many('SELECT kind, ref FROM watchlist WHERE user_id = $1', [userId]);
  return {
    stocks: rows.filter((r) => r.kind === 'stock').map((r) => r.ref),
    analysts: rows.filter((r) => r.kind === 'analyst').map((r) => r.ref),
    funds: rows.filter((r) => r.kind === 'fund').map((r) => r.ref),
  };
}

// ---------- Evaluatie per soort ----------
// Elke functie geeft [{ symbol, title, body, url, tone, key }] terug.

const evaluators = {
  async top_raises(p, scope) {
    const rows = await db.many(
      `WITH rev AS (
         SELECT p.symbol, p.analyst_id, p.published_at, ${TARGET} AS t,
                lag(${TARGET}) OVER (PARTITION BY p.symbol, p.analyst_id ORDER BY p.published_at) AS prev
         FROM price_targets p
         WHERE p.analyst_id IS NOT NULL AND p.published_at > now() - interval '400 days'
           AND ($1::text[] IS NULL OR p.symbol = ANY($1))
       )
       SELECT r.symbol, count(DISTINCT r.analyst_id)::int AS n, max(r.published_at) AS last_at,
              string_agg(DISTINCT a.name || ' (' || coalesce(a.firm, '?') || ')', ', ') AS names,
              avg(r.t / r.prev - 1)::float8 AS avg_change
       FROM rev r
       JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = r.analyst_id::text AND g.score >= $2
       JOIN analysts a ON a.id = r.analyst_id
       WHERE r.published_at > now() - make_interval(days => $3) AND r.prev > 0 AND r.t > r.prev * 1.001
       GROUP BY r.symbol HAVING count(DISTINCT r.analyst_id) >= $4
         AND max(r.published_at) > now() - interval '2 days'`,
      [scope, p.minScore, p.days, p.min]
    );
    return rows.map((r) => ({
      symbol: r.symbol,
      title: `${r.n} topanalisten verhogen hun koersdoel voor ${r.symbol}`,
      body: `Gemiddeld ${pct(r.avg_change)} omhoog in ${p.days} dagen: ${r.names}.`,
      tone: 'pos',
      key: `top_raises:${r.symbol}`,
      cooldown: p.days,
    }));
  },

  async smart_upside(p, scope) {
    const rows = await db.many(
      `WITH latest AS (
         SELECT DISTINCT ON (p.symbol, p.analyst_id) p.symbol, p.analyst_id, ${TARGET} AS t
         FROM price_targets p
         WHERE p.analyst_id IS NOT NULL AND p.published_at > now() - interval '365 days' AND ${TARGET} > 0
           AND ($1::text[] IS NULL OR p.symbol = ANY($1))
         ORDER BY p.symbol, p.analyst_id, p.published_at DESC
       )
       SELECT l.symbol, avg(l.t)::float8 AS smart, count(*)::int AS n, q.price::float8 AS price
       FROM latest l
       JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = l.analyst_id::text AND g.score >= $2
       JOIN quotes q ON q.symbol = l.symbol AND q.price > 0
       GROUP BY l.symbol, q.price
       HAVING count(*) >= 2 AND avg(l.t) / q.price - 1 >= $3 AND avg(l.t) / q.price - 1 < 3`,
      [scope, p.minScore, p.min]
    );
    return rows.map((r) => ({
      symbol: r.symbol,
      title: `Slimme consensus ziet ${pct(r.smart / r.price - 1)} potentieel in ${r.symbol}`,
      body: `${r.n} topanalisten mikken gemiddeld op ${money(r.smart)}, de koers is ${money(r.price)}.`,
      tone: 'pos',
      key: `smart_upside:${r.symbol}`,
      cooldown: 14,
    }));
  },

  async top_flip(p, scope) {
    const flips = await db.many(
      `WITH rev AS (
         SELECT p.id, p.symbol, p.analyst_id, p.published_at, ${TARGET} AS t, p.price_when_posted AS pwp,
                lag(${TARGET}) OVER w AS prev_t, lag(p.price_when_posted) OVER w AS prev_pwp
         FROM price_targets p
         WHERE p.analyst_id IS NOT NULL AND p.published_at > now() - interval '600 days'
           AND ($1::text[] IS NULL OR p.symbol = ANY($1))
         WINDOW w AS (PARTITION BY p.symbol, p.analyst_id ORDER BY p.published_at)
       )
       SELECT r.id, r.symbol, r.t::float8 AS t, r.prev_t::float8 AS prev_t, r.pwp::float8 AS pwp, a.name, a.firm, g.score
       FROM rev r
       JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = r.analyst_id::text AND g.score >= $2
       JOIN analysts a ON a.id = r.analyst_id
       WHERE r.published_at > now() - interval '2 days' AND r.pwp > 0 AND r.prev_pwp > 0
         AND ((r.prev_t > r.prev_pwp AND r.t < r.pwp) OR (r.prev_t < r.prev_pwp AND r.t > r.pwp))`,
      [scope, p.minScore]
    );
    const grades = await db.many(
      `SELECT gr.id, gr.symbol, gr.grading_company, gr.previous_grade, gr.new_grade, gr.action, g.score
       FROM grades gr
       JOIN guru_scores g ON g.kind = 'firm' AND lower(g.ref) = lower(gr.grading_company) AND g.score >= $2
       WHERE gr.published_at > now() - interval '2 days' AND gr.action IN ('upgrade', 'downgrade')
         AND ($1::text[] IS NULL OR gr.symbol = ANY($1))`,
      [scope, p.minScore]
    );
    return [
      ...flips.map((r) => {
        const up = r.t > r.pwp;
        return {
          symbol: r.symbol,
          title: `${r.name} (${r.firm || '?'}) draait ${up ? 'positief' : 'negatief'} op ${r.symbol}`,
          body: `Koersdoel van ${money(r.prev_t)} naar ${money(r.t)} bij een koers van ${money(r.pwp)}. GuruScore ${Math.round(r.score)}.`,
          tone: up ? 'pos' : 'neg',
          key: `top_flip:pt:${r.id}`,
        };
      }),
      ...grades.map((r) => ({
        symbol: r.symbol,
        title: `${r.grading_company} ${r.action === 'upgrade' ? 'upgradet' : 'downgradet'} ${r.symbol}`,
        body: `${r.previous_grade || '?'} → ${r.new_grade || '?'}. Bank-GuruScore ${Math.round(r.score)}.`,
        tone: r.action === 'upgrade' ? 'pos' : 'neg',
        key: `top_flip:gr:${r.id}`,
      })),
    ];
  },

  async target_hit(p, scope) {
    if (!scope || !scope.length) return [];
    const rows = await db.many(
      `WITH latest AS (
         SELECT DISTINCT ON (p.symbol, p.analyst_id) p.id, p.symbol, p.analyst_id, p.published_at, ${TARGET} AS t, p.price_when_posted AS pwp
         FROM price_targets p
         WHERE p.analyst_id IS NOT NULL AND p.published_at > now() - interval '365 days' AND p.symbol = ANY($1)
         ORDER BY p.symbol, p.analyst_id, p.published_at DESC
       )
       SELECT l.id, l.symbol, l.t::float8 AS t, l.published_at, a.name, a.firm, q.price::float8 AS price
       FROM latest l
       JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = l.analyst_id::text AND g.score >= $2
       JOIN analysts a ON a.id = l.analyst_id
       JOIN quotes q ON q.symbol = l.symbol AND q.price > 0 AND q.updated_at > now() - interval '1 day'
       WHERE l.t > l.pwp AND q.price >= l.t AND q.price / (1 + coalesce(q.change_pct, 0) / 100) < l.t`,
      [scope, p.minScore]
    );
    return rows.map((r) => ({
      symbol: r.symbol,
      title: `${r.symbol} haalt het koersdoel van ${r.name}`,
      body: `${r.name} (${r.firm || '?'}) mikte op ${money(r.t)} op ${fmt.date(r.published_at)}. De koers staat nu op ${money(r.price)}.`,
      tone: 'pos',
      key: `target_hit:${r.id}`,
    }));
  },

  async insider_buy(p, scope) {
    if (!scope || !scope.length) return [];
    const rows = await db.many(
      `SELECT uid, symbol, reporting_name, type_of_owner, securities_transacted * price AS value, price, transaction_date
       FROM insider_trades
       WHERE symbol = ANY($1) AND filing_date > now() - interval '3 days'
         AND transaction_type ILIKE 'P-%' AND securities_transacted * price >= $2`,
      [scope, p.min]
    );
    return rows.map((r) => ({
      symbol: r.symbol,
      title: `Insider koopt ${r.symbol} voor ${fmt.money(r.value)}`,
      body: `${r.reporting_name}${r.type_of_owner ? ' (' + r.type_of_owner + ')' : ''} kocht op ${fmt.date(r.transaction_date)} tegen ${money(r.price)}.`,
      tone: 'pos',
      key: `insider_buy:${r.uid}`,
    }));
  },

  async analyst_call(p, scope, watch) {
    if (!watch.analysts.length) return [];
    const rows = await db.many(
      `SELECT p.id, p.symbol, ${TARGET}::float8 AS t, p.price_when_posted::float8 AS pwp, a.name, a.firm, a.slug
       FROM price_targets p JOIN analysts a ON a.id = p.analyst_id
       WHERE a.slug = ANY($1) AND p.published_at > now() - interval '2 days'`,
      [watch.analysts]
    );
    return rows.map((r) => ({
      symbol: r.symbol,
      title: `${r.name} geeft ${r.symbol} een koersdoel van ${money(r.t)}`,
      body: r.pwp > 0 ? `${pct(r.t / r.pwp - 1)} ten opzichte van de koers van ${money(r.pwp)}.` : '',
      tone: r.pwp > 0 ? (r.t >= r.pwp ? 'pos' : 'neg') : '',
      url: `/analist/${r.slug}`,
      key: `analyst_call:${r.id}`,
    }));
  },

  async fund_change(p, scope, watch) {
    if (!watch.funds.length) return [];
    const rows = await db.many(
      `SELECT slug, name, manager, latest_period::text AS period, latest_value, latest_positions
       FROM funds WHERE slug = ANY($1) AND latest_period > current_date - 150 AND refreshed_at > now() - interval '2 days'`,
      [watch.funds]
    );
    return rows.map((r) => ({
      symbol: null,
      title: `${r.manager || r.name}: nieuwe portefeuille (${fmt.date(r.period)})`,
      body: `${r.latest_positions || '?'} posities, totaal ${fmt.money(r.latest_value)}.`,
      url: `/guru/${r.slug}`,
      key: `fund_change:${r.slug}:${r.period}`,
    }));
  },

  async watch_activity(p, scope) {
    if (!scope || !scope.length) return [];
    const targets = await db.many(
      `SELECT p.id, p.symbol, ${TARGET}::float8 AS t, p.price_when_posted::float8 AS pwp, p.analyst_name, p.analyst_firm
       FROM price_targets p WHERE p.symbol = ANY($1) AND p.published_at > now() - interval '2 days'`,
      [scope]
    );
    const grades = await db.many(
      `SELECT id, symbol, grading_company, previous_grade, new_grade, action FROM grades
       WHERE symbol = ANY($1) AND published_at > now() - interval '2 days'`,
      [scope]
    );
    return [
      ...targets.map((r) => ({
        symbol: r.symbol,
        title: `${r.analyst_firm || r.analyst_name || 'Analist'}: koersdoel ${r.symbol} ${money(r.t)}`,
        body: r.pwp > 0 ? `${pct(r.t / r.pwp - 1)} ten opzichte van de koers.` : '',
        tone: r.pwp > 0 ? (r.t >= r.pwp ? 'pos' : 'neg') : '',
        key: `watch:pt:${r.id}`,
      })),
      ...grades.map((r) => ({
        symbol: r.symbol,
        title: `${r.grading_company}: ${fmt.action(r.action)} ${r.symbol}`,
        body: `${r.previous_grade || ''}${r.previous_grade ? ' → ' : ''}${r.new_grade || ''}`,
        tone: fmt.actionTone(r.action),
        key: `watch:gr:${r.id}`,
      })),
    ];
  },
};

// Sla meldingen op; dubbele en te snel herhaalde meldingen worden overgeslagen.
async function saveAlerts(userId, rule, events) {
  let added = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const e of events) {
    if (e.cooldown && e.symbol) {
      const recent = await db.one(
        `SELECT 1 AS x FROM alerts WHERE user_id = $1 AND kind = $2 AND symbol = $3 AND created_at > now() - make_interval(days => $4)`,
        [userId, rule.kind, e.symbol, e.cooldown]
      );
      if (recent) continue;
    }
    const key = e.cooldown ? `${e.key}:${day}` : e.key;
    const r = await db.query(
      `INSERT INTO alerts (user_id, rule_id, kind, symbol, title, body, url, tone, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [userId, rule.id, rule.kind, e.symbol, e.title.slice(0, 300), (e.body || '').slice(0, 1000),
        e.url || (e.symbol ? `/aandeel/${encodeURIComponent(e.symbol)}` : null), e.tone || null, key]
    );
    added += r.rowCount;
  }
  return added;
}

async function evaluateUser(userId) {
  await ensureDefaults(userId);
  const watch = await watchOf(userId);
  const rules = await db.many('SELECT id, kind, params FROM alert_rules WHERE user_id = $1 AND active ORDER BY id', [userId]);
  let added = 0;
  const errors = [];
  for (const rule of rules) {
    const fn = evaluators[rule.kind];
    if (!fn) continue;
    const p = normalizeParams(rule.kind, rule.params);
    const scope = p.scope === 'all' ? null : watch.stocks;
    if (p.scope !== 'all' && !watch.stocks.length && !['analyst_call', 'fund_change'].includes(rule.kind)) continue;
    try {
      added += await saveAlerts(userId, rule, await fn(p, scope, watch));
    } catch (err) {
      errors.push(`${rule.kind}: ${err.message}`);
    }
  }
  return { added, errors };
}

// ---------- E-mail ----------

const base = () => (config.publicUrl || '').replace(/\/$/, '');
const unsubToken = (userId) => crypto.createHmac('sha256', config.sessionSecret).update(`unsub:${userId}`).digest('hex').slice(0, 32);
const unsubUrl = (userId) => `${base()}/uit?u=${userId}&t=${unsubToken(userId)}`;
const checkUnsub = (userId, token) => {
  const a = Buffer.from(unsubToken(userId));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const render = (view, data) => ejs.renderFile(path.join(__dirname, '..', 'views', 'email', `${view}.ejs`), { fmt, base: base(), ...data });

async function sendInstant() {
  const users = await db.many(
    `SELECT DISTINCT u.id, u.email FROM alerts a
     JOIN users u ON u.id = a.user_id
     JOIN user_settings s ON s.user_id = u.id AND s.instant_email
     JOIN alert_rules r ON r.id = a.rule_id
     WHERE a.emailed_at IS NULL AND a.created_at > now() - interval '6 hours' AND coalesce(r.params->>'email', 'direct') = 'direct'`
  );
  let sent = 0;
  for (const u of users) {
    const alerts = await db.many(
      `SELECT a.* FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
       WHERE a.user_id = $1 AND a.emailed_at IS NULL AND a.created_at > now() - interval '6 hours'
         AND coalesce(r.params->>'email', 'direct') = 'direct'
       ORDER BY a.created_at`,
      [u.id]
    );
    if (!alerts.length) continue;
    const subject = alerts.length === 1 ? alerts[0].title : `${alerts.length} nieuwe meldingen op Guruwatch`;
    const html = await render('instant', { alerts, unsub: unsubUrl(u.id) });
    const text = alerts.map((a) => `• ${a.title}\n  ${a.body || ''}`).join('\n') + `\n\n${base()}/mijn`;
    await sendMail(u.email, subject, text, html);
    await db.query('UPDATE alerts SET emailed_at = now() WHERE id = ANY($1)', [alerts.map((a) => a.id)]);
    sent++;
  }
  return sent;
}

// Inhoud van de ochtendbriefing voor één gebruiker.
async function briefingData(userId, since) {
  const sinceTs = since || new Date(Date.now() - 24 * 3600 * 1000);
  const watch = await watchOf(userId);
  const [alerts, topCalls, upgrades] = await Promise.all([
    db.many(
      `SELECT * FROM alerts WHERE user_id = $1 AND created_at > $2 ORDER BY (kind = 'watch_activity'), created_at DESC LIMIT 60`,
      [userId, sinceTs]
    ),
    db.many(
      `SELECT p.symbol, ${TARGET}::float8 AS t, p.price_when_posted::float8 AS pwp, a.name, a.firm, a.slug, g.score
       FROM price_targets p JOIN analysts a ON a.id = p.analyst_id
       JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = p.analyst_id::text AND g.score >= 70
       WHERE p.published_at > $1 ORDER BY g.score DESC, p.published_at DESC LIMIT 10`,
      [sinceTs]
    ),
    db.many(
      `SELECT symbol, grading_company, previous_grade, new_grade, action FROM grades
       WHERE published_at > $1 AND action IN ('upgrade', 'downgrade') ORDER BY published_at DESC LIMIT 12`,
      [sinceTs]
    ),
  ]);
  const radar = require('./lib/radar');
  const rq = require('./lib/radarQueries');
  const eq = require('./lib/earningsQueries');
  const upcomingEarnings = watch.stocks.length ? await eq.upcoming({ days: 7, symbols: watch.stocks }).catch(() => []) : [];
  const mom = (await rq.momentum({ days: 7 }).catch(() => [])).map((r) => ({ ...r, score: radar.momentumScore(r) })).sort((a, b) => b.score - a.score);
  return {
    since: sinceTs,
    watchCount: watch.stocks.length,
    important: alerts.filter((a) => a.kind !== 'watch_activity'),
    activity: alerts.filter((a) => a.kind === 'watch_activity'),
    topCalls,
    upgrades,
    upcomingEarnings,
    risers: mom.filter((r) => r.score > 0).slice(0, 5),
    fallers: mom.filter((r) => r.score < 0).slice(-5).reverse(),
  };
}

async function renderBriefing(userId, since, { weekly = false } = {}) {
  const data = await briefingData(userId, since);
  const html = await render('briefing', { ...data, weekly, unsub: unsubUrl(userId) });
  return { data, html };
}

// Zaterdagmail: wat er deze week gebeurde bij de aandelen op je volglijst. Alleen als er iets te melden is.
async function sendWeekly({ force = false } = {}) {
  const users = await db.many(
    `SELECT u.id, u.email, s.last_weekly_at FROM users u JOIN user_settings s ON s.user_id = u.id WHERE s.weekly`
  );
  let sent = 0;
  for (const u of users) {
    if (!force && !weeklyDue(u.last_weekly_at)) continue;
    await db.query('UPDATE user_settings SET last_weekly_at = now() WHERE user_id = $1', [u.id]);
    const since = new Date(Date.now() - 7 * 864e5);
    const { data, html } = await renderBriefing(u.id, since, { weekly: true });
    const updates = data.important.length + data.activity.length + data.upcomingEarnings.length;
    if (!data.watchCount || !updates) continue;
    const dateTxt = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam' }).format(new Date());
    const subject = `Guruwatch weekoverzicht · ${dateTxt} · ${updates} ${updates === 1 ? 'update' : 'updates'} op je volglijst`;
    const text = [
      `Guruwatch weekoverzicht, ${dateTxt}`,
      ...data.important.map((a) => `• ${a.title}`),
      `${data.activity.length} nieuwe adviezen op aandelen die je volgt.`,
      `Bekijk alles: ${base()}/mijn`,
    ].join('\n');
    await sendMail(u.email, subject, text, html);
    sent++;
  }
  return sent;
}

async function sendBriefings({ force = false } = {}) {
  const users = await db.many(
    `SELECT u.id, u.email, s.last_briefing_at FROM users u JOIN user_settings s ON s.user_id = u.id WHERE s.briefing`
  );
  let sent = 0;
  for (const u of users) {
    if (!force && !briefingDue(u.last_briefing_at)) continue;
    // Eerst markeren, zodat een herstart halverwege niet dubbel mailt.
    await db.query('UPDATE user_settings SET last_briefing_at = now() WHERE user_id = $1', [u.id]);
    const since = u.last_briefing_at ? new Date(u.last_briefing_at) : null;
    const { data, html } = await renderBriefing(u.id, since);
    const dateTxt = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam' }).format(new Date());
    const subject = `Guruwatch ochtendbriefing · ${dateTxt}${data.important.length ? ` · ${data.important.length} meldingen` : ''}`;
    const text = [
      `Guruwatch ochtendbriefing, ${dateTxt}`,
      ...data.important.map((a) => `• ${a.title}`),
      `${data.activity.length} nieuwe adviezen op aandelen die je volgt.`,
      `Bekijk alles: ${base()}/mijn`,
    ].join('\n');
    await sendMail(u.email, subject, text, html);
    await db.query('UPDATE alerts SET emailed_at = coalesce(emailed_at, now()) WHERE user_id = $1 AND created_at <= now()', [u.id]);
    sent++;
  }
  return sent;
}

async function runAlerts() {
  const users = await db.many('SELECT id FROM users');
  let added = 0;
  const errors = [];
  for (const u of users) {
    const r = await evaluateUser(u.id);
    added += r.added;
    errors.push(...r.errors);
  }
  const instant = await sendInstant();
  return { users: users.length, added, instant, errors: errors.slice(0, 5) };
}

module.exports = { runAlerts, sendBriefings, sendWeekly, evaluateUser, ensureDefaults, renderBriefing, briefingData, checkUnsub, evaluators };
