'use strict';

const express = require('express');
const q = require('../lib/queries');
const db = require('../db');
const fmp = require('../lib/fmp');
const eodhd = require('../lib/eodhd');
const ingest = require('../ingest');
const { consensus: calcConsensus, computeScores } = require('../lib/scoring');
const { targetTimeline } = require('../lib/charts');
const fmt = require('../lib/format');
const rq = require('../lib/radarQueries');
const eq = require('../lib/earningsQueries');
const er = require('../lib/earnings');
const radar = require('../lib/radar');

const router = express.Router();

// Aantal ongelezen meldingen voor het menu.
router.use(async (req, res, next) => {
  res.locals.unread = 0;
  if (req.user) {
    try {
      const r = await db.one('SELECT count(*)::int AS n FROM alerts WHERE user_id = $1 AND seen_at IS NULL', [req.user.id]);
      res.locals.unread = r ? r.n : 0;
    } catch (err) {
      // Tabel bestaat nog niet tijdens een migratie: geen teller tonen.
    }
  }
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const SYMBOL_RE = /^[A-Z0-9.\-^]{1,15}$/;
const safe = (p, fallback = null) => p.then((v) => v ?? fallback).catch((err) => {
  console.warn('[page] databron faalde:', err.message);
  return fallback;
});

router.get('/', wrap(async (req, res) => {
  const [grades, activity, buys, clusters, popular, counts, gradeDays, insiderDays, revisionDays, scored] = await Promise.all([
    q.latestGrades({ limit: 10 }),
    q.latestTargets(10),
    q.latestInsiders({ limit: 8, type: 'buy' }),
    q.insiderClusters(30, 8),
    q.popularAmongFunds(8),
    q.counts(),
    q.dailyGradeCounts(30),
    q.dailyInsiderFlows(30),
    q.dailyTargetRevisions(30),
    q.hasGuruScores(),
  ]);
  const top = scored ? await q.guruLeaderboard({ minCalls: 10, limit: 5 }) : [];
  const mom = (await safe(rq.momentum({ days: 30 }), [])).map((r) => ({ ...r, score: radar.momentumScore(r) })).sort((a, b) => b.score - a.score);
  const radarTop = mom.filter((r) => r.score > 0).slice(0, 6);
  const radarBottom = mom.filter((r) => r.score < 0).slice(-6).reverse();
  const sum = (arr, k) => arr.reduce((s, d) => s + (Number(d[k]) || 0), 0);
  const kpi = {
    upgrades: sum(gradeDays, 'pos'),
    downgrades: sum(gradeDays, 'neg'),
    raised: sum(revisionDays, 'pos'),
    lowered: sum(revisionDays, 'neg'),
    insiderBuy: sum(insiderDays, 'pos'),
    insiderSell: sum(insiderDays, 'neg'),
  };
  res.render('home', { title: 'Overzicht', radarTop, radarBottom, grades, activity, buys, clusters, popular, counts, gradeDays, insiderDays, revisionDays, top, kpi });
}));

// ---------- Analisten ----------
router.get('/analisten', wrap(async (req, res) => {
  const tab = ['ranglijst', 'koersdoelen', 'ratings', 'banken'].includes(req.query.tab) ? req.query.tab : 'ranglijst';
  const action = ['upgrade', 'downgrade'].includes(req.query.actie) ? req.query.actie : undefined;
  const data = { tab, action, scored: await q.hasGuruScores() };
  if (tab === 'ranglijst') {
    data.leaders = data.scored ? await q.guruLeaderboard({ minCalls: 5, limit: 100 }) : await q.analystLeaderboard({ minCalls: 5, limit: 100 });
    data.dist = data.scored ? await q.scoreDistribution() : [];
  }
  if (tab === 'koersdoelen') data.targets = await q.latestTargets(150);
  if (tab === 'ratings') data.grades = await q.latestGrades({ limit: 150, action });
  if (tab === 'banken') {
    data.firms = await q.firmStats(60);
    data.firmScores = data.scored ? await q.guruLeaderboard({ kind: 'firm', minCalls: 10, limit: 60 }) : [];
  }
  res.render('analysts', { title: 'Analisten', ...data });
}));

router.get('/analist/:slug', wrap(async (req, res) => {
  const analyst = await q.analystBySlug(req.params.slug);
  if (!analyst) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Deze analist kennen we (nog) niet.' });
  const [guru, calls, bySymbol, firmScore, watched] = await Promise.all([
    q.guruScore('analyst', analyst.id),
    q.analystCalls(analyst.id),
    q.analystBySymbol(analyst.id),
    analyst.firm ? q.guruScore('firm', analyst.firm) : null,
    q.isWatched(req.user && req.user.id, 'analyst', analyst.slug),
  ]);
  const symbols = [...new Set(calls.map((t) => t.symbol))];
  res.render('analyst', { title: analyst.name, analyst, guru, calls, bySymbol, firmScore, symbols, watched });
}));

router.get('/bank/:firm', wrap(async (req, res) => {
  const firm = req.params.firm;
  const [grades, leaders, guru] = await Promise.all([
    q.latestGrades({ firm, limit: 150 }),
    q.guruLeaderboard({ firm, minCalls: 1, limit: 50 }),
    q.guruScore('firm', firm),
  ]);
  res.render('firm', { title: firm, firm, grades, leaders, guru });
}));

router.get('/methode', (req, res) => res.render('method', { title: 'Hoe de GuruScore werkt' }));

// ---------- Insiders ----------
router.get('/insiders', wrap(async (req, res) => {
  const type = ['buy', 'sell', 'all'].includes(req.query.type) ? req.query.type : 'buy';
  const minValue = Number(req.query.min) > 0 ? Number(req.query.min) : undefined;
  const [trades, clusters, flows] = await Promise.all([q.latestInsiders({ limit: 200, type, minValue }), q.insiderClusters(30, 15), q.dailyInsiderFlows(60)]);
  res.render('insiders', { title: 'Insider trades', trades, clusters, type, minValue, flows });
}));

router.get('/insider/:cik', wrap(async (req, res) => {
  const cik = String(req.params.cik).replace(/\D/g, '');
  const [person, trades] = await Promise.all([q.insiderPerson(cik), q.latestInsiders({ cik, limit: 200 })]);
  if (!person) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Geen transacties gevonden voor deze insider.' });
  res.render('insider', { title: person.reporting_name, person, trades });
}));

// ---------- Hedge funds ----------
router.get('/fondsen', wrap(async (req, res) => {
  const [funds, popular] = await Promise.all([q.fundsList(), q.popularAmongFunds(25)]);
  res.render('funds', { title: 'Hedge funds', funds, popular });
}));

router.get('/fonds/:slug', wrap(async (req, res) => {
  let fund = await q.fundBySlug(req.params.slug);
  if (!fund) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Dit fonds volgen we (nog) niet.' });
  let periods = await q.fundPeriods(fund.cik);
  if (!periods.length) {
    await safe(ingest.refreshFund(fund.cik));
    fund = await q.fundBySlug(req.params.slug);
    periods = await q.fundPeriods(fund.cik);
  }
  const period = periods[0];
  const { diffHoldings } = require('../lib/normalize');
  let positions = [];
  let sold = [];
  if (period) {
    const [cur, prev] = await Promise.all([q.fundHoldings(fund.cik, period), periods[1] ? q.fundHoldings(fund.cik, periods[1]) : []]);
    ({ positions, sold } = diffHoldings(cur, prev));
  }
  const total = positions.reduce((s, p) => s + (p.put_call ? 0 : Number(p.value)), 0);
  const watched = await q.isWatched(req.user && req.user.id, 'fund', fund.slug);
  res.render('fund', { title: fund.manager || fund.name, fund, period, prevPeriod: periods[1], positions, sold, total, watched });
}));

// ---------- Aandeel ----------
router.get('/aandeel/:symbol', wrap(async (req, res) => {
  const symbol = String(req.params.symbol).toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Ongeldig tickersymbool.' });

  // Historie voor dit symbool aanvullen (gecachet, dus goedkoop bij herhaald bezoek).
  await safe(ingest.backfillSymbol(symbol));

  const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const [profile, quote, consensus, gradesConsensus, history, targets, grades, insiders, holders, watched] = await Promise.all([
    safe(fmp.profile(symbol)),
    safe(fmp.quote(symbol)),
    safe(fmp.priceTargetConsensus(symbol)),
    safe(fmp.gradesConsensus(symbol)),
    safe(eodhd.eod(symbol, from).then((h) => h || fmp.historicalLight(symbol, from).then((r) => r.map((x) => ({ date: x.date, close: x.price ?? x.close })).reverse())), []),
    q.latestTargets(60, symbol),
    q.latestGrades({ symbol, limit: 60 }),
    q.latestInsiders({ symbol, limit: 60 }),
    q.fundsHolding(symbol),
    q.isWatched(req.user && req.user.id, 'stock', symbol),
  ]);
  if (!profile && !quote && !targets.length && !grades.length && !insiders.length) {
    return res.status(404).render('error', { title: 'Niet gevonden', message: `Geen gegevens gevonden voor ${symbol}.` });
  }
  const sortedHistory = (history || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));

  // Analistenkern: consensus, bulls vs bears, beste analisten, tijdlijn, activiteit.
  const since = new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10);
  const [latest, activity, stats, timelineTargets, dbSeries, ratingRows, earningsRows, nextEarn] = await Promise.all([
    q.latestTargetPerAnalyst(symbol),
    q.targetActivity(symbol, 25),
    q.symbolAnalystStats(symbol),
    q.targetTimeline(symbol, since),
    q.priceSeries(symbol, since),
    safe(rq.ratingHistory(symbol), []),
    safe(eq.reactions({ symbol, limit: 8 }), []),
    safe(eq.nextEarnings(symbol)),
  ]);
  // Adviesverdeling door de tijd: uit de database, anders direct van FMP.
  let ratingTrend = ratingRows;
  if (!ratingTrend.length) {
    const live = await safe(fmp.ratingHistory(symbol), []);
    const pick = (o, k) => Number(o[Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase())]) || 0;
    ratingTrend = live.filter((x) => x && x.date).map((x) => ({ date: x.date, strong_buy: pick(x, 'analystRatingsStrongBuy'), buy: pick(x, 'analystRatingsBuy'),
      hold: pick(x, 'analystRatingsHold'), sell: pick(x, 'analystRatingsSell'), strong_sell: pick(x, 'analystRatingsStrongSell') }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  const price = quote && Number(quote.price);
  const smart = calcConsensus(latest, price, { topScore: 70 });
  const ranked = latest.filter((t) => Number(t.price_target) > 0).sort((a, b) => Number(b.price_target) - Number(a.price_target));
  const bull = ranked[0] || null;
  const bear = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  const groups = new Map();
  const meta = new Map();
  for (const r of stats) {
    const k = String(r.analyst_id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
    meta.set(k, { slug: r.slug, name: r.name, firm: r.firm });
  }
  const experts = computeScores(groups)
    .filter((x) => x.calls >= 2)
    .slice(0, 8)
    .map((x) => ({ ...x, ...meta.get(x.ref) }));

  const series = dbSeries.length >= 60 ? dbSeries : sortedHistory;
  const timeline = targetTimeline(series, timelineTargets);
  res.render('stock', {
    ratingTrend,
    earningsHist: earningsRows.map(withReaction).reverse().map((h) => ({ ...h, label: er.quarterLabel(h.date) })),
    nextEarn,
    title: profile ? `${profile.companyName} (${symbol})` : symbol,
    symbol,
    profile,
    quote,
    consensus,
    gradesConsensus,
    history: sortedHistory,
    smart,
    latest,
    bull,
    bear,
    experts,
    activity,
    timeline,
    targets,
    grades,
    insiders,
    holders,
    watched,
    logo: eodhd.logoUrl(symbol, profile && profile.image),
  });
}));

// ---------- Zoeken ----------
router.get('/zoek', wrap(async (req, res) => {
  const term = String(req.query.q || '').trim().slice(0, 60);
  if (!term) return res.render('search', { title: 'Zoeken', term, stocks: [], analysts: [], funds: [] });
  if (SYMBOL_RE.test(term.toUpperCase()) && req.query.direct === '1') return res.redirect(`/aandeel/${encodeURIComponent(term.toUpperCase())}`);
  const lower = term.toLowerCase();
  const [bySymbol, byName, analysts, allFunds] = await Promise.all([
    safe(fmp.searchSymbol(term), []),
    safe(fmp.searchName(term), []),
    q.analystSearch(term),
    q.fundsList(),
  ]);
  const seen = new Set();
  const stocks = [...bySymbol, ...byName].filter((s) => s && s.symbol && !seen.has(s.symbol) && seen.add(s.symbol)).slice(0, 20);
  const funds = allFunds.filter((f) => `${f.name} ${f.manager}`.toLowerCase().includes(lower));
  res.render('search', { title: `Zoeken: ${term}`, term, stocks, analysts, funds });
}));

// ---------- Volglijst ----------
// ---------- Mijn GuruWatch ----------
router.get('/volglijst', (req, res) => res.redirect(301, '/mijn'));

router.get('/mijn', wrap(async (req, res) => {
  const alerts = require('../alerts');
  await alerts.ensureDefaults(req.user.id);
  const items = await q.watchlist(req.user.id);
  const stocks = items.filter((i) => i.kind === 'stock').map((i) => i.ref);
  const [health, feed, funds, mom, analysts] = await Promise.all([
    rq.watchHealth(stocks),
    db.many('SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60', [req.user.id]),
    q.fundsList(),
    stocks.length ? safe(rq.momentum({ days: 30 }), []) : [],
    db.many(
      `SELECT a.slug, a.name, a.firm, g.score FROM watchlist w JOIN analysts a ON a.slug = w.ref
       LEFT JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = a.id::text
       WHERE w.user_id = $1 AND w.kind = 'analyst'`,
      [req.user.id]
    ),
  ]);
  const momBy = new Map(mom.map((r) => [r.symbol, radar.momentumScore(r)]));
  const rows = health.map((h) => {
    const share = radar.bullShare(h);
    const upside = h.target && h.price ? h.target / h.price - 1 : null;
    const smartUpside = h.smart && h.price && h.smart_n >= 2 ? h.smart / h.price - 1 : null;
    const momentum = momBy.get(h.symbol) ?? 0;
    // Advies-gezondheid 0-100: koopadviezen, potentieel en momentum.
    let health01 = 0.5;
    if (share.bull !== null) health01 = 0.45 * share.bull + 0.35 * Math.max(0, Math.min(1, ((upside ?? 0) + 0.1) / 0.5)) + 0.2 * Math.max(0, Math.min(1, (momentum + 5) / 10));
    return { ...h, ...share, upside, smartUpside, momentum, health: Math.round(health01 * 100) };
  });
  const fundMap = new Map(funds.map((f) => [f.slug, f]));
  const unseen = feed.filter((a) => !a.seen_at).length;
  if (unseen) await db.query('UPDATE alerts SET seen_at = now() WHERE user_id = $1 AND seen_at IS NULL', [req.user.id]);
  res.locals.unread = 0;
  res.render('mine', { title: 'Mijn GuruWatch', items, rows, feed, unseen, fundMap, analysts, followedFunds: items.filter((i) => i.kind === 'fund') });
}));

router.get('/mijn/meldingen', wrap(async (req, res) => {
  const alerts = require('../alerts');
  const { RULES, describe } = require('../lib/alertRules');
  await alerts.ensureDefaults(req.user.id);
  const [rules, settings] = await Promise.all([
    db.many('SELECT * FROM alert_rules WHERE user_id = $1 ORDER BY id', [req.user.id]),
    db.one('SELECT * FROM user_settings WHERE user_id = $1', [req.user.id]),
  ]);
  res.render('rules', { title: 'Meldingen', rules: rules.map((r) => ({ ...r, text: describe(r.kind, r.params), label: RULES[r.kind] ? RULES[r.kind].label : r.kind })), RULES, settings, saved: req.query.ok === '1' });
}));

router.post('/mijn/regel', wrap(async (req, res) => {
  const { normalizeParams } = require('../lib/alertRules');
  const params = normalizeParams(String(req.body.kind || ''), req.body);
  if (!params) return res.status(400).send('Onbekende melding');
  const count = await db.one('SELECT count(*)::int AS n FROM alert_rules WHERE user_id = $1', [req.user.id]);
  if (count.n >= 40) return res.status(400).send('Maximaal 40 meldingen');
  await db.query('INSERT INTO alert_rules (user_id, kind, params) VALUES ($1, $2, $3)', [req.user.id, req.body.kind, JSON.stringify(params)]);
  res.redirect('/mijn/meldingen?ok=1');
}));

router.post('/mijn/regel/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const action = String(req.body.action || '');
  if (action === 'delete') await db.query('DELETE FROM alert_rules WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  else if (action === 'toggle') await db.query('UPDATE alert_rules SET active = NOT active WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  else if (action === 'email') await db.query(`UPDATE alert_rules SET params = params || jsonb_build_object('email', CASE WHEN params->>'email' = 'briefing' THEN 'direct' ELSE 'briefing' END) WHERE id = $1 AND user_id = $2`, [id, req.user.id]);
  res.redirect('/mijn/meldingen?ok=1');
}));

router.post('/mijn/instellingen', wrap(async (req, res) => {
  await db.query(
    `INSERT INTO user_settings (user_id, briefing, instant_email) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET briefing = EXCLUDED.briefing, instant_email = EXCLUDED.instant_email`,
    [req.user.id, req.body.briefing === 'on', req.body.instant_email === 'on']
  );
  res.redirect('/mijn/meldingen?ok=1');
}));

router.get('/mijn/briefing', wrap(async (req, res) => {
  const alerts = require('../alerts');
  await alerts.ensureDefaults(req.user.id);
  await alerts.evaluateUser(req.user.id);
  const { html } = await alerts.renderBriefing(req.user.id, null);
  res.render('briefing', { title: 'Voorbeeld ochtendbriefing', html });
}));

router.post('/volg', wrap(async (req, res) => {
  const kind = String(req.body.kind || '');
  const ref = String(req.body.ref || '').slice(0, 100);
  if (!['stock', 'analyst', 'fund'].includes(kind) || !ref) return res.status(400).send('Ongeldig verzoek');
  await q.toggleWatch(req.user.id, kind, kind === 'stock' ? ref.toUpperCase() : ref);
  const back = String(req.body.back || '/volglijst');
  res.redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/volglijst');
}));

// ---------- Cijfers ----------
const withReaction = (r) => {
  const reaction = r.price_before > 0 && r.price_after > 0 ? r.price_after / r.price_before - 1 : null;
  return { ...r, surprise: er.surprise(r.eps_actual, r.eps_estimated), revSurprise: er.surprise(r.revenue_actual, r.revenue_estimated), reaction, verdict: er.verdict(reaction, r.avg_change) };
};

router.get('/cijfers', wrap(async (req, res) => {
  const tab = ['kalender', 'reacties', 'herzieningen'].includes(req.query.tab) ? req.query.tab : 'kalender';
  const data = { tab };
  const watched = req.user ? (await q.watchlist(req.user.id)).filter((i) => i.kind === 'stock').map((i) => i.ref) : [];
  data.watched = new Set(watched);
  if (tab === 'kalender') {
    const only = req.query.mijn === '1';
    const rows = await eq.upcoming({ days: 21, symbols: only ? watched : null });
    const days = new Map();
    for (const r of rows) {
      if (!days.has(r.date)) days.set(r.date, []);
      days.get(r.date).push(r);
    }
    Object.assign(data, { only, days: [...days.entries()].map(([date, list]) => ({ date, list })), count: rows.length });
  }
  if (tab === 'reacties') {
    const period = [7, 30, 90].includes(Number(req.query.dagen)) ? Number(req.query.dagen) : 30;
    const rows = (await eq.reactions({ days: period })).map(withReaction);
    const scored = rows.filter((r) => r.reaction !== null && r.avg_change !== null && r.revisions >= 2);
    const group = (k) => scored.filter((r) => r.verdict && r.verdict.key === k).sort((a, b) => Math.abs(b.reaction - b.avg_change) - Math.abs(a.reaction - a.avg_change)).slice(0, 12);
    const beats = rows.filter((r) => r.surprise !== null);
    Object.assign(data, {
      period,
      rows: rows.slice(0, 150),
      scored,
      groups: { up: group('koers-omlaag-doelen-omhoog'), down: group('koers-omhoog-doelen-omlaag') },
      stats: {
        reported: rows.length,
        beatRate: beats.length ? beats.filter((r) => r.surprise > 0).length / beats.length : null,
        avgReaction: scored.length ? scored.reduce((s2, r) => s2 + r.reaction, 0) / scored.length : null,
        avgRevision: scored.length ? scored.reduce((s2, r) => s2 + r.avg_change, 0) / scored.length : null,
      },
    });
  }
  if (tab === 'herzieningen') {
    const period = [7, 30, 90].includes(Number(req.query.dagen)) ? Number(req.query.dagen) : 30;
    const [rows, span] = await Promise.all([eq.epsRevisions({ days: period }), eq.snapshotSpan()]);
    const valid = rows.filter((r) => Number.isFinite(r.change) && Math.abs(r.change) < 2);
    Object.assign(data, {
      period,
      span,
      ups: valid.filter((r) => r.change > 0.001).sort((a, b) => b.change - a.change).slice(0, 25),
      downs: valid.filter((r) => r.change < -0.001).sort((a, b) => a.change - b.change).slice(0, 25),
      total: valid.length,
    });
  }
  res.render('earnings', { title: 'Cijfers', ...data });
}));

router.get('/aandeel/:symbol/cijfers/:date', wrap(async (req, res) => {
  const symbol = String(req.params.symbol).toUpperCase();
  const date = String(req.params.date);
  if (!SYMBOL_RE.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Onbekend cijfermoment.' });
  const [row, revisions, history, stats, company] = await Promise.all([
    eq.earningsRow(symbol, date),
    eq.eventRevisions(symbol, date),
    eq.reactions({ symbol, limit: 12 }),
    q.symbolAnalystStats(symbol),
    db.one('SELECT name, sector FROM companies WHERE symbol = $1', [symbol]),
  ]);
  if (!row) return res.status(404).render('error', { title: 'Niet gevonden', message: `Geen cijfers van ${symbol} op ${date}.` });
  const ev = withReaction(history.find((h) => h.date === date) || { ...row });
  const summary = er.summarizeRevisions(revisions);
  // Wie voorspelde dit aandeel historisch het best?
  const groups = new Map();
  const meta = new Map();
  for (const r of stats) {
    const k = String(r.analyst_id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
    meta.set(k, { slug: r.slug, name: r.name, firm: r.firm });
  }
  const experts = computeScores(groups).filter((x) => x.calls >= 2).slice(0, 6).map((x) => ({ ...x, ...meta.get(x.ref) }));
  const from = new Date(new Date(date).getTime() - 45 * 864e5).toISOString().slice(0, 10);
  const to = new Date(new Date(date).getTime() + 45 * 864e5).toISOString().slice(0, 10);
  const [series, around] = await Promise.all([
    db.many('SELECT date::text AS date, close::float8 AS close FROM prices WHERE symbol = $1 AND date BETWEEN $2 AND $3 ORDER BY date', [symbol, from, to]),
    q.targetTimeline(symbol, from),
  ]);
  const timeline = targetTimeline(series, around.filter((t) => new Date(t.published_at) <= new Date(to)), { markers: [{ date, label: 'Cijfers' }], height: 300 });
  const hist = history.map(withReaction).reverse().map((h) => ({ ...h, label: er.quarterLabel(h.date) }));
  res.render('earnings-event', { title: `${symbol} cijfers ${fmt.date(date)}`, symbol, date, company, ev, revisions, summary, experts, timeline, hist });
}));

// ---------- Radar ----------
const RADAR_TABS = ['momentum', 'verrassing', 'potentieel', 'contrair'];

function radarFilters(query) {
  const sector = typeof query.sector === 'string' && query.sector.length <= 60 ? query.sector : '';
  const cap = radar.CAPS.some((c) => c.key === query.cap) ? query.cap : '';
  return { sector, cap };
}

router.get('/radar', wrap(async (req, res) => {
  const tab = RADAR_TABS.includes(req.query.tab) ? req.query.tab : 'momentum';
  const filters = radarFilters(req.query);
  const data = { tab, filters, caps: radar.CAPS, sectors: await safe(rq.sectors(), []) };

  if (tab === 'momentum') {
    const days = [7, 30, 90].includes(Number(req.query.dagen)) ? Number(req.query.dagen) : 30;
    const rows = (await rq.momentum({ days, ...filters })).map((r) => ({ ...r, score: radar.momentumScore(r), herd: radar.herd(r) }));
    rows.sort((a, b) => b.score - a.score || (b.raises + b.ups) - (a.raises + a.ups));
    const bySector = new Map();
    for (const r of rows) {
      if (!r.sector) continue;
      const s = bySector.get(r.sector) || { sector: r.sector, pos: 0, neg: 0, n: 0 };
      s.pos += r.raises + r.ups;
      s.neg += r.cuts + r.downs;
      s.n += 1;
      bySector.set(r.sector, s);
    }
    Object.assign(data, {
      days,
      risers: rows.filter((r) => r.score > 0).slice(0, 30),
      fallers: rows.filter((r) => r.score < 0).slice(-20).reverse(),
      herds: rows.filter((r) => r.herd).sort((a, b) => (b.h_up + b.h_down) - (a.h_up + a.h_down)).slice(0, 24),
      sectorHeat: [...bySector.values()].filter((s) => s.pos + s.neg > 0),
      totals: { pos: rows.filter((r) => r.score > 0).length, neg: rows.filter((r) => r.score < 0).length, all: rows.length },
      hasEps: rows.some((r) => r.eps_rev !== null && r.eps_rev !== undefined),
    });
  }

  if (tab === 'verrassing') {
    const days = [30, 90, 180].includes(Number(req.query.dagen)) ? Number(req.query.dagen) : 90;
    const rows = (await rq.consensusShift({ days, ...filters })).map((r) => ({ ...r, signal: radar.surprise(r.price_chg, r.target_chg) }));
    const group = (k) => rows.filter((r) => r.signal === k).sort((a, b) => Math.abs(b.price_chg - b.target_chg) - Math.abs(a.price_chg - a.target_chg)).slice(0, 15);
    Object.assign(data, {
      days,
      points: rows,
      groups: { 'koers-daalt': group('koers-daalt'), 'koers-stijgt': group('koers-stijgt'), 'doelen-stijgen': group('doelen-stijgen'), 'doelen-dalen': group('doelen-dalen') },
    });
  }

  if (tab === 'potentieel') {
    const minAnalysts = [3, 5, 10, 20].includes(Number(req.query.min)) ? Number(req.query.min) : 5;
    const sort = req.query.sort === 'slim' ? 'slim' : 'gewoon';
    let rows = await rq.upside({ ...filters, minAnalysts });
    if (sort === 'slim') rows = rows.filter((r) => Number.isFinite(r.smart_upside) && r.smart_n >= 2).sort((a, b) => b.smart_upside - a.smart_upside);
    else rows.sort((a, b) => b.upside - a.upside);
    // Extreme uitschieters (vaak verouderde koersdoelen of penny stocks) apart houden.
    Object.assign(data, { minAnalysts, sort, rows: rows.filter((r) => r.upside < 3).slice(0, 100), count: rows.length });
  }

  if (tab === 'contrair') {
    const rows = (await rq.ratingSnapshot(filters)).map((r) => ({ ...r, ...radar.bullShare(r) }));
    const backtest = await safe(rq.cached('contrarian_backtest'));
    Object.assign(data, {
      hated: [...rows].sort((a, b) => a.bull - b.bull || b.bear - a.bear).slice(0, 20),
      loved: [...rows].sort((a, b) => b.bull - a.bull || b.total - a.total).slice(0, 20),
      backtest: backtest && backtest.data,
      backtestAt: backtest && backtest.updated_at,
      count: rows.length,
    });
  }

  res.render('radar', { title: 'Radar', ...data });
}));

// ---------- Status ----------
router.get('/status', wrap(async (req, res) => {
  const [jobs, counts] = await Promise.all([q.jobStatus(), q.counts()]);
  res.render('status', { title: 'Status', jobs, counts });
}));

module.exports = router;
