'use strict';

const express = require('express');
const q = require('../lib/queries');
const fmp = require('../lib/fmp');
const eodhd = require('../lib/eodhd');
const ingest = require('../ingest');
const { scoreTarget } = require('../lib/normalize');

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const SYMBOL_RE = /^[A-Z0-9.\-^]{1,15}$/;
const safe = (p, fallback = null) => p.then((v) => v ?? fallback).catch((err) => {
  console.warn('[page] databron faalde:', err.message);
  return fallback;
});

router.get('/', wrap(async (req, res) => {
  const [grades, targets, buys, clusters, popular, counts] = await Promise.all([
    q.latestGrades({ limit: 12 }),
    q.latestTargets(12),
    q.latestInsiders({ limit: 12, type: 'buy' }),
    q.insiderClusters(30, 8),
    q.popularAmongFunds(8),
    q.counts(),
  ]);
  res.render('home', { title: 'Overzicht', grades, targets, buys, clusters, popular, counts });
}));

// ---------- Analisten ----------
router.get('/analisten', wrap(async (req, res) => {
  const tab = ['ranglijst', 'koersdoelen', 'ratings', 'banken'].includes(req.query.tab) ? req.query.tab : 'ranglijst';
  const action = ['upgrade', 'downgrade'].includes(req.query.actie) ? req.query.actie : undefined;
  const data = { tab, action };
  if (tab === 'ranglijst') data.leaders = await q.analystLeaderboard({ minCalls: 5, limit: 100 });
  if (tab === 'koersdoelen') data.targets = await q.latestTargets(150);
  if (tab === 'ratings') data.grades = await q.latestGrades({ limit: 150, action });
  if (tab === 'banken') data.firms = await q.firmStats(60);
  res.render('analysts', { title: 'Analisten', ...data });
}));

router.get('/analist/:slug', wrap(async (req, res) => {
  const analyst = await q.analystBySlug(req.params.slug);
  if (!analyst) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Deze analist kennen we (nog) niet.' });
  const [score, targets, watched] = await Promise.all([
    q.analystScore(analyst.id),
    q.analystTargets(analyst.id),
    q.isWatched(req.user && req.user.id, 'analyst', analyst.slug),
  ]);
  for (const t of targets) t.score = scoreTarget(t);
  const symbols = [...new Set(targets.map((t) => t.symbol))];
  res.render('analyst', { title: analyst.name, analyst, score, targets, symbols, watched });
}));

router.get('/bank/:firm', wrap(async (req, res) => {
  const firm = req.params.firm;
  const [grades, leaders] = await Promise.all([q.latestGrades({ firm, limit: 150 }), q.analystLeaderboard({ firm, minCalls: 3, limit: 50 })]);
  res.render('firm', { title: firm, firm, grades, leaders });
}));

// ---------- Insiders ----------
router.get('/insiders', wrap(async (req, res) => {
  const type = ['buy', 'sell', 'all'].includes(req.query.type) ? req.query.type : 'buy';
  const minValue = Number(req.query.min) > 0 ? Number(req.query.min) : undefined;
  const [trades, clusters] = await Promise.all([q.latestInsiders({ limit: 200, type, minValue }), q.insiderClusters(30, 15)]);
  res.render('insiders', { title: 'Insider trades', trades, clusters, type, minValue });
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
  res.render('stock', {
    title: profile ? `${profile.companyName} (${symbol})` : symbol,
    symbol,
    profile,
    quote,
    consensus,
    gradesConsensus,
    history: sortedHistory,
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
router.get('/volglijst', wrap(async (req, res) => {
  const items = await q.watchlist(req.user.id);
  const stocks = items.filter((i) => i.kind === 'stock').map((i) => i.ref);
  const [grades, insiders, funds] = await Promise.all([
    stocks.length ? Promise.all(stocks.map((s) => q.latestGrades({ symbol: s, limit: 5 }))).then((x) => x.flat()) : [],
    stocks.length ? Promise.all(stocks.map((s) => q.latestInsiders({ symbol: s, limit: 5 }))).then((x) => x.flat()) : [],
    q.fundsList(),
  ]);
  grades.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  insiders.sort((a, b) => new Date(b.filing_date) - new Date(a.filing_date));
  const fundMap = new Map(funds.map((f) => [f.slug, f]));
  res.render('watchlist', { title: 'Volglijst', items, grades: grades.slice(0, 30), insiders: insiders.slice(0, 30), fundMap });
}));

router.post('/volg', wrap(async (req, res) => {
  const kind = String(req.body.kind || '');
  const ref = String(req.body.ref || '').slice(0, 100);
  if (!['stock', 'analyst', 'fund'].includes(kind) || !ref) return res.status(400).send('Ongeldig verzoek');
  await q.toggleWatch(req.user.id, kind, kind === 'stock' ? ref.toUpperCase() : ref);
  const back = String(req.body.back || '/volglijst');
  res.redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/volglijst');
}));

// ---------- Status ----------
router.get('/status', wrap(async (req, res) => {
  const [jobs, counts] = await Promise.all([q.jobStatus(), q.counts()]);
  res.render('status', { title: 'Status', jobs, counts });
}));

module.exports = router;
