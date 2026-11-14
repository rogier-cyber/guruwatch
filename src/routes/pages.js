'use strict';

const express = require('express');
const q = require('../lib/queries');
const db = require('../db');
const fmp = require('../lib/fmp');
const eodhd = require('../lib/eodhd');
const ingest = require('../ingest');
const { consensus: calcConsensus, computeScores } = require('../lib/scoring');
const { targetTimeline } = require('../lib/charts');
const charts = require('../lib/charts');
const fmt = require('../lib/format');
const rq = require('../lib/radarQueries');
const eq = require('../lib/earningsQueries');
const er = require('../lib/earnings');
const radar = require('../lib/radar');
const av = require('../lib/analystView');
const sq = require('../lib/stockQueries');
const indexes = require('../lib/indexes');
const { buildStory } = require('../lib/stockStory');
const config = require('../config');

const router = express.Router();

// Aantal ongelezen meldingen voor het menu.
async function unreadCount(req, res, next) {
  if (res.locals.unreadSet) return next();
  res.locals.unreadSet = true;
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
}
router.use(unreadCount);

// Openbare pagina's (zonder inloggen, ook voor zoekmachines).
const pub = express.Router();
pub.use(unreadCount);

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
pub.get('/aandeel/:symbol', wrap(async (req, res) => {
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
    q.latestGrades({ symbol, limit: 80 }),
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
  const [latest, activity, stats, timelineTargets, dbSeries, ratingRows, earningsRows, nextEarn, bench, insiderSum, ratios, metrics, income] = await Promise.all([
    q.latestTargetPerAnalyst(symbol),
    q.targetActivity(symbol, 80),
    q.symbolAnalystStats(symbol),
    q.targetTimeline(symbol, since),
    q.priceSeries(symbol, since),
    safe(rq.ratingHistory(symbol), []),
    safe(eq.reactions({ symbol, limit: 8 }), []),
    safe(eq.nextEarnings(symbol)),
    safe(sq.benchmarkData(), { market: {}, sectors: {} }),
    safe(sq.insiderSummary(symbol, 90), {}),
    safe(fmp.ratiosTtm(symbol)),
    safe(fmp.keyMetricsTtm(symbol)),
    safe(fmp.incomeQuarterly(symbol), []),
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
  ratingTrend = ratingTrend.map((r) => ({ ...r, date: String(r.date instanceof Date ? r.date.toISOString() : r.date).slice(0, 10) }));
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

  // Analistenblok: oordeel door de tijd, per maand, acties en vergelijking.
  const gc = gradesConsensus;
  const current = gc ? { strong_buy: gc.strongBuy, buy: gc.buy, hold: gc.hold, sell: gc.sell, strong_sell: gc.strongSell } : null;
  const rot = av.ratingsOverTime({ ratingRows: ratingTrend, targets: timelineTargets, series, price, current });
  const now = rot[0];
  const months = av.monthly({ ratingRows: ratingTrend, targets: timelineTargets, series, months: 24 });
  if (price > 0 && months.length) months[months.length - 1].close = price;
  const actions = av.mergeActions(grades.filter((g) => new Date(g.published_at) > Date.now() - 400 * 864e5), activity, price, 15);
  const sector = profile && profile.sector;
  const sectorBench = sector && bench.sectors ? bench.sectors[sector] : null;
  const compare = {
    stock: { label: profile ? profile.companyName : symbol, score: now.score, upside: now.upside, analysts: now.analysts },
    sector: sectorBench ? { label: sector, ...sectorBench } : null,
    market: bench.market && bench.market.stocks ? { label: 'Alle aandelen', ...bench.market } : null,
  };

  // Feiten voor de automatische tekst (ook geschikt als invoer voor een taalmodel later).
  const c = now.counts;
  const day = 864e5;
  const recent = (d) => Date.now() - new Date(d).getTime() < 92 * day;
  const lastE = earningsRows.length ? withReaction(earningsRows[0]) : null;
  const revs = income.map((x) => Number(x.revenue)).filter((v) => v > 0);
  const facts = {
    name: profile ? profile.companyName : symbol,
    symbol,
    sector,
    price,
    changePct: quote && Number.isFinite(Number(quote.changePercentage)) ? Number(quote.changePercentage) / 100 : null,
    consensus: {
      target: now.target, upside: now.upside, analysts: now.analysts,
      low: consensus && consensus.targetLow, high: consensus && consensus.targetHigh,
      counts: c, score: now.score, verdict: now.verdict && now.verdict.label,
      buys: c ? c.strong_buy + c.buy : 0, holds: c ? c.hold : 0, sells: c ? c.sell + c.strong_sell : 0,
      buyShare: c ? (c.strong_buy + c.buy) / c.total : null, sellShare: c ? (c.sell + c.strong_sell) / c.total : null,
    },
    smart: smart && smart.topMean ? { target: smart.topMean, upside: smart.topUpside, count: smart.topCount } : null,
    sectorScore: sectorBench && sectorBench.score,
    trend3m: now.score !== null && rot[2].score !== null ? now.score - rot[2].score : null,
    lastEarnings: lastE ? { date: lastE.date, epsActual: lastE.eps_actual, epsEstimated: lastE.eps_estimated, epsSurprise: lastE.surprise, revSurprise: lastE.revSurprise, reaction: lastE.reaction } : null,
    nextEarnings: nextEarn ? { date: nextEarn.date, epsEstimated: nextEarn.eps_estimated, inDays: Math.round((new Date(nextEarn.date) - Date.now()) / day) } : null,
    fundamentals: {
      pe: ratios && Number(ratios.priceToEarningsRatioTTM) ? Number(ratios.priceToEarningsRatioTTM) : null,
      netMargin: ratios && ratios.netProfitMarginTTM !== undefined ? Number(ratios.netProfitMarginTTM) : null,
      roe: metrics && metrics.returnOnEquityTTM !== undefined ? Number(metrics.returnOnEquityTTM) : null,
      revenue: revs[0] || null,
      revenueGrowth: revs.length >= 5 ? revs[0] / revs[4] - 1 : null,
    },
    technicals: quote ? {
      yearHigh: Number(quote.yearHigh) || null, yearLow: Number(quote.yearLow) || null,
      avg50: Number(quote.priceAvg50) || null, avg200: Number(quote.priceAvg200) || null,
      fromHigh: Number(quote.yearHigh) > 0 && price > 0 ? price / Number(quote.yearHigh) - 1 : null,
    } : {},
    actions: {
      upgrades: [...new Set(actions.filter((a) => a.action.label === 'Upgrade' && recent(a.date)).map((a) => a.firm))],
      downgrades: [...new Set(actions.filter((a) => a.action.label === 'Downgrade' && recent(a.date)).map((a) => a.firm))],
      raises: activity.filter((a) => recent(a.published_at) && a.prev_target && Number(a.price_target) > Number(a.prev_target)).length,
      cuts: activity.filter((a) => recent(a.published_at) && a.prev_target && Number(a.price_target) < Number(a.prev_target)).length,
    },
    insiders: insiderSum,
    funds: holders.length ? { count: holders.length, names: holders.map((h) => h.manager || h.name) } : null,
    bestAnalyst: experts[0] && experts[0].calls >= 3 ? experts[0] : null,
  };
  const story = buildStory(facts);

  // Waaier met koersverwachting: één stip per laatste koersdoel per analist, met het advies van die bank.
  const gradeByFirm = new Map();
  for (const g of grades) {
    const k = String(g.grading_company || '').toLowerCase();
    if (k && !gradeByFirm.has(k)) gradeByFirm.set(k, g.new_grade);
  }
  const yearAgo = new Date(Date.now() - 365 * day).toISOString().slice(0, 10);
  const fan = charts.forecastFan(series.filter((p) => p.date >= yearAgo).concat(price > 0 ? [{ date: new Date().toISOString().slice(0, 10), close: price }] : [])
    .filter((p, i, a) => i === a.length - 1 || p.date !== a[a.length - 1].date),
    latest.filter((t) => Number(t.price_target) > 0).map((t) => {
      const grade = gradeByFirm.get(String(t.analyst_firm || '').toLowerCase());
      const tg = Number(t.price_target);
      const up = price > 0 ? tg / price - 1 : null;
      const lv = av.gradeLevel(grade);
      return {
        target: tg,
        tone: lv >= 4 ? 'pos' : lv !== null && lv <= 2 ? 'neg' : up !== null && up < 0 ? 'neg' : 'pos',
        label: `${t.analyst_name || t.analyst_firm}${t.analyst_name && t.analyst_firm ? ' (' + t.analyst_firm + ')' : ''}\n${fmt.date(t.published_at)}${grade ? ' · ' + grade : ''}\nKoersdoel ${fmt.price(tg)}${t.prev_target && Number(t.prev_target) !== tg ? ' (was ' + fmt.price(t.prev_target) + ')' : ''}${up !== null ? ' · ' + fmt.pct(up) : ''}`,
      };
    }));

  // SEO: titel, omschrijving, canonieke link en gestructureerde data.
  const name = facts.name;
  const canonical = `${config.publicUrl.replace(/\/$/, '')}/aandeel/${encodeURIComponent(symbol)}`;
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'WebPage', name: `${name} (${symbol}) aandeel`, url: canonical, description: story.description, inLanguage: 'nl-NL',
      about: { '@type': 'Corporation', name, tickerSymbol: symbol, ...(profile && profile.website ? { url: profile.website } : {}) },
      dateModified: new Date().toISOString() },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Aandelen', item: `${config.publicUrl.replace(/\/$/, '')}/aandelen` },
      { '@type': 'ListItem', position: 2, name: `${name} (${symbol})`, item: canonical },
    ] },
  ];
  if (story.faq.length) {
    jsonld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: story.faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) });
  }

  res.render('stock', {
    ratingTrend,
    earningsHist: earningsRows.map(withReaction).reverse().map((h) => ({ ...h, label: er.quarterLabel(h.date) })),
    nextEarn,
    title: `${name} (${symbol}) aandeel: koersdoel en analistenadviezen`,
    seo: { description: story.description, canonical, jsonld, image: profile && profile.image },
    symbol,
    name,
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
    actions,
    rot,
    months,
    compare,
    story,
    fan,
    av,
    timeline,
    targets,
    grades,
    insiders,
    holders,
    watched,
    logo: eodhd.logoUrl(symbol, profile && profile.image),
  });
}));

// ---------- Aandelen per index ----------
const INDEX_SORTS = {
  naam: (a, b) => String(a.name || a.symbol).localeCompare(String(b.name || b.symbol), 'nl'),
  koers: (a, b) => (b.price || 0) - (a.price || 0),
  dag: (a, b) => (b.change_pct ?? -1e9) - (a.change_pct ?? -1e9),
  potentieel: (a, b) => (b.upside ?? -1e9) - (a.upside ?? -1e9),
  adviezen: (a, b) => (b.total || 0) - (a.total || 0),
  verkoop: (a, b) => (b.sells || 0) - (a.sells || 0),
  houd: (a, b) => (b.holds || 0) - (a.holds || 0),
  koop: (a, b) => (b.buys || 0) - (a.buys || 0),
  oordeel: (a, b) => (b.score ?? -1) - (a.score ?? -1),
};

pub.get('/aandelen', wrap(async (req, res) => {
  const idx = indexes.byKey(req.query.index) || indexes.byKey('sp500');
  const sort = INDEX_SORTS[req.query.sort] ? req.query.sort : 'naam';
  const dir = req.query.dir === 'op' ? 'op' : req.query.dir === 'af' ? 'af' : sort === 'naam' ? 'op' : 'af';
  const [raw, counts] = await Promise.all([idx.endpoint ? sq.indexTable(idx.key) : [], safe(sq.indexCounts(), {})]);
  const rows = raw.map((r) => {
    const c = av.counts(r);
    const score = av.ratingScore(c);
    return {
      ...r,
      upside: r.target > 0 && r.price > 0 ? r.target / r.price - 1 : null,
      total: c ? c.total : 0,
      buys: c ? c.strong_buy + c.buy : 0,
      holds: c ? c.hold : 0,
      sells: c ? c.sell + c.strong_sell : 0,
      score,
      verdict: av.ratingLabel(score),
    };
  });
  rows.sort(INDEX_SORTS[sort]);
  const defaultDir = sort === 'naam' ? 'op' : 'af';
  if (dir !== defaultDir) rows.reverse();
  const VIEWS = ['alle', 'vandaag', 'meest', 'minst', 'potentieel'];
  const view = VIEWS.includes(req.query.weergave) ? req.query.weergave : 'alle';
  let list = rows;
  let today = [];
  if (view === 'meest') list = rows.filter((r) => r.total >= 5).sort((a, b) => b.score - a.score || b.total - a.total).slice(0, 30);
  if (view === 'minst') list = rows.filter((r) => r.total >= 5).sort((a, b) => a.score - b.score || b.total - a.total).slice(0, 30);
  if (view === 'potentieel') list = rows.filter((r) => r.upside !== null && r.targets >= 3 && Math.abs(r.upside) < 3).sort((a, b) => b.upside - a.upside).slice(0, 30);
  if (view === 'vandaag' && idx.endpoint) {
    const { grades: g, targets: t } = await sq.indexActions(idx.key, 3);
    const prices = new Map(rows.map((r) => [r.symbol, r]));
    today = av.mergeActions(g, t, null, 150).map((a) => {
      const r = prices.get(a.symbol);
      return { ...a, name: r && r.name, upside: a.to_target && r && r.price > 0 ? a.to_target / r.price - 1 : null };
    });
  }
  const rated = rows.filter((r) => r.total > 0);
  const withUp = rows.filter((r) => r.upside !== null && Math.abs(r.upside) < 3);
  const summary = {
    stocks: rows.length,
    rated: rated.length,
    buyShare: rated.length ? rated.reduce((s, r) => s + r.buys, 0) / rated.reduce((s, r) => s + r.total, 0) : null,
    medianUpside: withUp.length ? withUp.map((r) => r.upside).sort((a, b) => a - b)[Math.floor(withUp.length / 2)] : null,
    topUpside: withUp.filter((r) => r.total >= 5 && r.upside > 0).sort((a, b) => b.upside - a.upside).slice(0, 8),
  };
  const canonical = `${config.publicUrl.replace(/\/$/, '')}/aandelen?index=${idx.key}`;
  res.render('stocks', {
    title: `${idx.label}: koersdoelen en analistenadviezen per aandeel`,
    seo: { description: `Alle aandelen uit de ${idx.label} met koers, gemiddeld koersdoel, potentieel en de verdeling van kopen, houden en verkopen van analisten.`, canonical },
    idx, groups: indexes.GROUPS, counts, rows: list, allCount: rows.length, sort, dir, summary, view, today,
  });
}));

// ---------- Zoekmachines ----------
pub.get('/robots.txt', (req, res) => {
  const base = config.publicUrl.replace(/\/$/, '');
  res.type('text/plain').send(`User-agent: *\nAllow: /aandeel/\nAllow: /aandelen\nDisallow: /mijn\nDisallow: /login\nSitemap: ${base}/sitemap.xml\n`);
});

pub.get('/sitemap.xml', wrap(async (req, res) => {
  const base = config.publicUrl.replace(/\/$/, '');
  const syms = await safe(sq.sitemapSymbols(5000), []);
  const urls = [
    ...indexes.ALL.filter((i) => i.endpoint).map((i) => `<url><loc>${base}/aandelen?index=${i.key}</loc><changefreq>daily</changefreq></url>`),
    ...syms.map((s) => `<url><loc>${base}/aandeel/${encodeURIComponent(s.symbol)}</loc><lastmod>${new Date(s.last).toISOString().slice(0, 10)}</lastmod><changefreq>daily</changefreq></url>`),
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
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

pub.get('/aandeel/:symbol/cijfers/:date', wrap(async (req, res) => {
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
module.exports.publicRouter = pub;
