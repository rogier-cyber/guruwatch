'use strict';

const express = require('express');
const q = require('../lib/queries');
const db = require('../db');
const fmp = require('../lib/fmp');
const eodhd = require('../lib/eodhd');
const ingest = require('../ingest');
const { consensus: calcConsensus, computeScores } = require('../lib/scoring');
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
const gq = require('../lib/guruQueries');
const guru = require('../lib/guru');
const guruCharts = require('../lib/guruCharts');
const viz = require('../lib/vizCharts');
const tr = require('../lib/transcripts');
const tl = require('../lib/translate');
const translate = require('../translate');
const callCharts = require('../lib/callCharts');
const vq = require('../lib/vizQueries');
const cm = require('../lib/community');
const { logoUrl } = require('../lib/logos');

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
  const together = await safe(gq.consensusMoves(8), []);
  res.render('home', { title: 'Overzicht', radarTop, radarBottom, grades, activity, buys, clusters, popular, counts, gradeDays, insiderDays, revisionDays, top, kpi, together, viz });
}));

// ---------- Analisten ----------
router.get('/analisten', wrap(async (req, res) => {
  const tab = ['ranglijst', 'koersdoelen', 'ratings', 'banken', 'radar'].includes(req.query.tab) ? req.query.tab : 'ranglijst';
  const action = ['upgrade', 'downgrade'].includes(req.query.actie) ? req.query.actie : undefined;
  const data = { tab, action, scored: await q.hasGuruScores() };
  if (tab === 'ranglijst') {
    data.leaders = data.scored ? await q.guruLeaderboard({ minCalls: 5, limit: 100 }) : await q.analystLeaderboard({ minCalls: 5, limit: 100 });
    data.dist = data.scored ? await q.scoreDistribution() : [];
    if (data.scored) {
      const [all, firms] = await Promise.all([q.guruLeaderboard({ minCalls: 5, limit: 2000 }), safe(vq.firmExtremes(30, 5), { best: [], worst: [] })]);
      const med = (arr) => { const a = arr.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
      data.buckets = Array.from({ length: 10 }, (_, i) => { const f = data.dist.find((d) => d.b === i + 1); return f ? f.n : 0; });
      data.firms = firms;
      data.kpi = {
        analysts: all.length,
        medHit: med(all.map((a) => Number(a.hit_rate))),
        beat: all.length ? all.filter((a) => Number(a.avg_excess) > 0).length / all.length : null,
        bestFirm: firms.best[0] || null,
      };
      data.mapPoints = all.filter((a) => a.calls >= 10).map((a) => ({ x: Number(a.hit_rate), y: Number(a.avg_excess), calls: a.calls, score: Number(a.score), label: a.name, sub: a.firm, href: `/analist/${a.slug}` }));
      data.viz = viz;
    }
  }
  if (tab === 'koersdoelen') data.targets = await q.latestTargets(150);
  if (tab === 'ratings') data.grades = await q.latestGrades({ limit: 150, action });
  if (tab === 'banken') {
    data.firms = await q.firmStats(60);
    data.firmScores = data.scored ? await q.guruLeaderboard({ kind: 'firm', minCalls: 10, limit: 60 }) : [];
  }
  if (tab === 'radar') {
    const r = await radarData(req.query);
    data.radar = { ...r, rtab: r.tab };
    data.viz = viz;
  }
  res.render('analysts', { title: tab === 'radar' ? 'Analistenradar' : 'Analistenmonitor: elke analist afgerekend op zijn trackrecord', ...data });
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

// Informatiepagina's (footer)
const INFO = { 'over-ons': 'Over Guruwatch', uitleg: 'Uitleg', adverteren: 'Adverteren', disclaimer: 'Disclaimer', privacy: 'Privacyverklaring', contact: 'Contact' };
for (const [page, title] of Object.entries(INFO)) {
  pub.get(`/${page}`, wrap(async (req, res) => {
    const legal = page === 'disclaimer' || page === 'privacy' ? await require('../siteTexts').get(page) : null;
    res.render(`info/${page}`, { title, legal });
  }));
}
pub.get('/over', (req, res) => res.redirect(301, '/over-ons'));

// ---------- Blog (artikelen van guruwatch.nl in onze eigen opmaak) ----------
const blog = require('../blog');
pub.get('/blog', wrap(async (req, res) => {
  const posts = await safe(blog.latest(10), []);
  res.render('blog', { title: 'Blog', posts, seo: { description: 'De blog van Guruwatch: artikelen over aandelen, analisten, beleggersguru\'s en de beurs.' } });
}));
pub.get('/blog/:slug', wrap(async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const post = /^[a-z0-9-]{1,200}$/.test(slug) ? await safe(blog.bySlug(slug)) : null;
  if (!post) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Dit blogartikel bestaat niet (meer).' });
  const more = (await safe(blog.latest(7), [])).filter((p) => p.slug !== slug).slice(0, 6);
  const base = config.publicUrl.replace(/\/$/, '');
  const jsonld = [{ '@context': 'https://schema.org', '@type': 'Article', headline: post.title, datePublished: post.published_at, image: post.image || undefined, publisher: { '@type': 'Organization', name: 'Guruwatch' }, mainEntityOfPage: `${base}/blog/${slug}` }];
  res.render('blog-post', { title: post.title, post, more, seo: { description: post.intro, canonical: `${base}/blog/${slug}`, image: post.image, jsonld } });
}));

router.get('/methode', (req, res) => res.render('method', { title: 'Hoe de GuruScore werkt' }));

// ---------- Insiders ----------
router.get('/insiders', wrap(async (req, res) => {
  const type = ['buy', 'sell', 'all'].includes(req.query.type) ? req.query.type : 'buy';
  const minValue = Number(req.query.min) > 0 ? Number(req.query.min) : undefined;
  const [trades, clusters, flows, buyMap, roles] = await Promise.all([
    q.latestInsiders({ limit: 200, type, minValue }),
    q.insiderClusters(30, 15),
    q.dailyInsiderFlows(60),
    safe(vq.insiderBuyMap(30, 40), []),
    safe(vq.insiderByRole(30), []),
  ]);
  const last30 = flows.slice(-30);
  const sum = (arr, k) => arr.reduce((t, d) => t + (Number(d[k]) || 0), 0);
  const kpi = { buy: sum(last30, 'pos'), sell: sum(last30, 'neg'), clusters: clusters.filter((c) => c.insiders >= 3).length };
  kpi.ratio = kpi.sell > 0 ? kpi.buy / kpi.sell : null;
  // Functies samenvoegen tot een paar herkenbare groepen.
  const group = (t) => {
    const r = String(t || '').toLowerCase();
    if (/chief executive|\bceo\b/.test(r)) return 'CEO';
    if (/chief financial|\bcfo\b/.test(r)) return 'CFO';
    if (/10\s*percent|10%/.test(r)) return 'Grootaandeelhouders';
    if (/officer|president|chief|\bvp\b|vice/.test(r)) return 'Overige directie';
    if (/director|chair/.test(r)) return 'Commissarissen';
    return 'Overig';
  };
  const byRole = new Map();
  for (const r of roles) {
    const g = group(r.type_of_owner);
    const cur = byRole.get(g) || { label: g, buy: 0, sell: 0 };
    cur.buy += Number(r.buy) || 0;
    cur.sell += Number(r.sell) || 0;
    byRole.set(g, cur);
  }
  const roleRows = [...byRole.values()].filter((r) => r.buy > 0).sort((a, b) => b.buy - a.buy);
  // Tegels "Waar kopen insiders?": tooltip met kopers, data, aantal en gemiddelde prijs.
  const maxIns = Math.max(1, ...buyMap.map((b) => b.insiders));
  const buyTiles = buyMap.map((b) => {
    const buyers = Array.isArray(b.buyers) ? b.buyers : [];
    const dates = b.first_date === b.last_date ? fmt.date(b.first_date) : `${fmt.date(b.first_date)} – ${fmt.date(b.last_date)}`;
    const lines = [`${fmt.company(b.name || b.symbol)} (${b.symbol})`,
      `Gekocht voor ${fmt.money(b.value)} door ${b.insiders} ${b.insiders === 1 ? 'insider' : 'insiders'}`,
      ...buyers.slice(0, 4).map((x) => `• ${fmt.person(x.name)}${fmt.role(x.role) ? ` (${fmt.role(x.role)})` : ''}: ${fmt.money(x.value)}`),
      ...(buyers.length > 4 ? [`• en nog ${buyers.length - 4} anderen`] : []),
      `${b.shares >= 1e6 ? (b.shares / 1e6).toFixed(1).replace('.', ',') + ' mln' : fmt.num(Math.round(b.shares))} aandelen · gem. ${b.shares > 0 ? fmt.price(b.value / b.shares) : '–'}`,
      `Transactiedatum ${dates}`];
    return {
      label: b.symbol, value: Math.sqrt(b.value), href: '/aandeel/' + encodeURIComponent(b.symbol), tone: 'buy',
      big: fmt.money(b.value), chgLabel: `${b.insiders} ${b.insiders === 1 ? 'koper' : 'kopers'}`,
      shade: 0.5 + 0.5 * (maxIns > 1 ? (b.insiders - 1) / (maxIns - 1) : 0),
      tip: lines.join('\n'), logo: logoUrl(b.symbol),
    };
  });
  res.render('insiders', { title: 'Insidermonitor: aankopen en verkopen van bestuurders', trades, clusters, type, minValue, flows, buyMap, buyTiles, roleRows, kpi, gc: guruCharts });
}));

router.get('/insider/:cik', wrap(async (req, res) => {
  const cik = String(req.params.cik).replace(/\D/g, '');
  const [person, trades] = await Promise.all([q.insiderPerson(cik), q.latestInsiders({ cik, limit: 200 })]);
  if (!person) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Geen transacties gevonden voor deze insider.' });
  res.render('insider', { title: person.reporting_name, person, trades });
}));

// ---------- Guru's ----------
pub.get('/fondsen', (req, res) => res.redirect(301, '/gurus'));
pub.get('/fonds/:slug', (req, res) => res.redirect(301, `/guru/${encodeURIComponent(req.params.slug)}`));

pub.get('/gurus', wrap(async (req, res) => {
  const [funds, ov, popular, together] = await Promise.all([
    q.fundsList(),
    safe(gq.overview(), { series: [], tops: [] }),
    safe(q.popularAmongFunds(10), []),
    safe(gq.consensusMoves(10), []),
  ]);
  const seriesBy = new Map();
  for (const r of ov.series) {
    if (!seriesBy.has(r.cik)) seriesBy.set(r.cik, []);
    seriesBy.get(r.cik).push(r);
  }
  const topsBy = new Map();
  for (const r of ov.tops) {
    if (!topsBy.has(r.cik)) topsBy.set(r.cik, []);
    topsBy.get(r.cik).push(r);
  }
  const STYLES = ['Alle', 'Value', 'Activist', 'Growth', 'Macro', 'Quality', 'Quant'];
  const style = STYLES.includes(req.query.stijl) ? req.query.stijl : 'Alle';
  const cards = funds
    .filter((f) => f.latest_period)
    .map((f) => {
      const s = seriesBy.get(f.cik) || [];
      const yearAgo = s.length >= 5 ? s[s.length - 5].value : null;
      return { ...f, series: s, tops: topsBy.get(f.cik) || [], growth: yearAgo && f.latest_value ? Number(f.latest_value) / yearAgo - 1 : null,
        stale: Date.now() - new Date(f.latest_period).getTime() > 240 * 864e5 };
    })
    .filter((f) => style === 'Alle' || String(f.style || '').toLowerCase().includes(style.toLowerCase()));
  const base = config.publicUrl.replace(/\/$/, '');
  const totalValue = cards.reduce((t, f) => t + (Number(f.latest_value) || 0), 0);
  res.render('gurus', {
    title: "Gurumonitor: de portefeuilles van de beste beleggers",
    seo: {
      description: `Bekijk wat ${cards.length} bekende beleggers zoals Warren Buffett, Bill Ackman en Mohnish Pabrai kopen en verkopen, op basis van hun 13F-filings bij de SEC.`,
      canonical: `${base}/gurus`,
    },
    cards, popular, together, style, styles: STYLES, totalValue, gc: guruCharts,
  });
}));

pub.get('/guru/:slug', wrap(async (req, res) => {
  let fund = await q.fundBySlug(req.params.slug);
  if (!fund) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Deze guru volgen we (nog) niet.' });
  if (fund.slug !== req.params.slug) return res.redirect(301, `/guru/${fund.slug}`);
  let totals = await gq.fundTotals(fund.cik);
  if (!totals.length) {
    await safe(ingest.refreshFund(fund.cik));
    fund = await q.fundBySlug(fund.slug);
    totals = await gq.fundTotals(fund.cik);
  }
  const hist = await gq.fundHistory(fund.cik, { periods: fund.quant ? 4 : 12, perPeriod: fund.quant ? 100 : 200 });
  const quarters = guru.byPeriod(hist);
  const base = config.publicUrl.replace(/\/$/, '');
  const canonical = `${base}/guru/${fund.slug}`;
  const watched = await q.isWatched(req.user && req.user.id, 'fund', fund.slug);
  const title = `${fund.manager || fund.name}: portefeuille, aankopen en verkopen`;
  if (!quarters.length) {
    return res.render('guru', { title, fund, empty: true, watched, seo: { description: `De portefeuille van ${fund.manager} (${fund.name}).`, canonical } });
  }
  const periods = quarters.map((x) => x.period);
  const selIdx = periods.includes(req.query.kwartaal) ? periods.indexOf(req.query.kwartaal) : periods.length - 1;
  const upto = quarters.slice(0, selIdx + 1);
  const cur = upto[upto.length - 1];
  const prev = upto.length > 1 ? upto[upto.length - 2] : null;
  const mv = guru.moves(upto);
  const tot = new Map(totals.map((t) => [t.period, t]));
  const curTot = tot.get(cur.period) || { value: cur.rows.reduce((s, r) => s + r.value, 0), positions: cur.rows.length };

  // Namen, sectoren, koersen en koersdoelen van de grootste posities.
  const syms = [...new Set([...cur.rows.slice(0, 80), ...mv.sells.slice(0, 20)].map((r) => r.symbol).filter(Boolean))];
  const allSyms = [...new Set(hist.map((r) => r.symbol).filter(Boolean))];
  const [companies, qt] = await Promise.all([safe(gq.companiesFor(allSyms), []), safe(gq.quotesAndTargets(syms), [])]);
  const sectorOf = new Map(companies.filter((c) => c.sector).map((c) => [c.symbol, c.sector]));
  const nameOf = new Map(companies.map((c) => [c.symbol, c.name]));
  const qtOf = new Map(qt.map((x) => [x.symbol, { ...x, upside: x.target > 0 && x.price > 0 ? x.target / x.price - 1 : null }]));
  const pm = new Map((prev ? prev.rows : []).map((r) => [r.symbol || r.cusip, r]));
  const positions = cur.rows.map((r) => {
    const p = pm.get(r.symbol || r.cusip);
    const kind = !prev ? null : !p ? 'new' : r.shares > p.shares * 1.001 ? 'added' : r.shares < p.shares * 0.999 ? 'reduced' : 'same';
    const x = qtOf.get(r.symbol) || {};
    return { ...r, name: nameOf.get(r.symbol) || r.issuer, sector: sectorOf.get(r.symbol) || null, kind, change_pct: p && p.shares ? r.shares / p.shares - 1 : null,
      prev_weight: p ? p.weight : 0, price: x.price, upside: x.upside, targets: x.targets };
  });
  // Tegels "De portefeuille in één oogopslag": korte labels, logo en een tooltip met de details.
  const shareFmt = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',')} mln` : fmt.num(Math.round(n)));
  const tileItems = positions.slice(0, 40).map((p) => {
    const kindTxt = { new: 'Nieuwe positie', added: 'Bijgekocht', reduced: 'Verlaagd', same: 'Ongewijzigd' }[p.kind] || '';
    const prevShares = p.change_pct != null ? p.shares / (1 + p.change_pct) : 0;
    const diff = p.shares - prevShares;
    const lines = [`${fmt.company(p.name)}${p.symbol ? ` (${p.symbol})` : ''}`,
      `Gewicht ${fmt.pct(p.weight, false)} · waarde ${fmt.money(p.value)}`,
      `${shareFmt(p.shares)} aandelen`];
    if (p.kind === 'new') lines.push('Nieuwe positie dit kwartaal');
    else if (p.kind === 'added' || p.kind === 'reduced') lines.push(`${kindTxt}: ${diff > 0 ? '+' : '−'}${shareFmt(Math.abs(diff))} aandelen (${fmt.pct(p.change_pct)})`);
    else if (p.kind === 'same') lines.push('Aantal aandelen ongewijzigd');
    if (p.kind && p.prev_weight != null) lines.push(`Gewicht vorig kwartaal ${p.prev_weight ? fmt.pct(p.prev_weight, false) : '0%'}`);
    lines.push(`13F over ${guruCharts.qLabel(cur.period)}${p.filing_date ? ` · ingediend ${fmt.date(p.filing_date)}` : ''}`);
    const mag = p.change_pct != null ? Math.min(1, Math.abs(p.change_pct) / 0.5) : 1;
    return {
      label: p.symbol || fmt.company(p.issuer).split(' ')[0], value: p.value, weight: p.weight,
      href: p.symbol ? '/aandeel/' + encodeURIComponent(p.symbol) : '#', tone: prev ? p.kind : 'same',
      chgLabel: p.kind === 'new' ? 'nieuw' : (p.kind === 'added' || p.kind === 'reduced') && p.change_pct != null ? fmt.pct(p.change_pct) : '',
      shade: p.kind === 'added' || p.kind === 'reduced' ? 0.55 + 0.45 * mag : null,
      tip: lines.join('\n'), logo: p.symbol ? logoUrl(p.symbol) : null,
    };
  });
  const sectors = guru.sectors(cur.rows, sectorOf);
  // Per sector de aandelen (voor de sectorendonut: hover/tik toont wat erin zit).
  const sectorHoldings = new Map();
  for (const r of cur.rows) {
    const s = (r.symbol && sectorOf.get(r.symbol)) || 'Overig / onbekend';
    if (!sectorHoldings.has(s)) sectorHoldings.set(s, []);
    sectorHoldings.get(s).push({ symbol: r.symbol, name: nameOf.get(r.symbol) || r.issuer, weight: r.weight });
  }
  for (const list of sectorHoldings.values()) list.sort((a, b) => b.weight - a.weight);
  const heat = guru.heatmap(upto, { top: 15, last: 8 });
  heat.rows.forEach((r) => { r.name = nameOf.get(r.symbol) || r.issuer; });
  const valueSeries = totals.filter((t) => t.period <= cur.period).slice(-40);
  // S&P 500 met dezelfde startwaarde, ter vergelijking in "Waarde door de tijd".
  if (valueSeries.length >= 2) {
    const spy = await safe(gq.pricesFor(['SPY'], valueSeries[0].period), []);
    const at = (d) => { let v = null; for (const p of spy) { if (p.date <= d) v = p.close; else break; } return v; };
    const s0 = at(valueSeries[0].period) || (spy[0] && spy[0].date <= valueSeries[0].period.slice(0, 8) + '31' ? spy[0].close : null);
    if (s0) valueSeries.forEach((v) => { const c = at(v.period); v.bench = c ? valueSeries[0].value * (c / s0) : null; });
  }
  const top10 = cur.rows.slice(0, 10).reduce((s, r) => s + r.weight, 0);

  // Bubbels: wat er bijgekocht en verkocht is tegenover het potentieel volgens analisten.
  const bubbles = [];
  if (prev) {
    for (const r of positions.slice(0, 40)) {
      if (!r.symbol || r.upside === null || r.upside === undefined) continue;
      bubbles.push({ x: r.weight - r.prev_weight, y: r.upside, r: Math.max(r.weight, r.prev_weight), label: r.symbol, href: `/aandeel/${encodeURIComponent(r.symbol)}`,
        tone: r.kind === 'new' || r.kind === 'added' ? 'buy' : r.kind === 'reduced' ? 'sell' : 'hold',
        title: `${r.symbol} · ${fmt.company(r.name)}\nGewicht ${fmt.pct(r.prev_weight, false)} → ${fmt.pct(r.weight, false)}\nPotentieel volgens analisten ${fmt.pct(r.upside)}` });
    }
    for (const s of mv.sells.filter((m) => m.kind === 'sold').slice(0, 10)) {
      const x = qtOf.get(s.symbol);
      if (!x || x.upside === null) continue;
      bubbles.push({ x: -s.prev_weight, y: x.upside, r: s.prev_weight, label: s.symbol, href: `/aandeel/${encodeURIComponent(s.symbol)}`, tone: 'sold',
        title: `${s.symbol} · volledig verkocht (was ${fmt.pct(s.prev_weight, false)})\nPotentieel volgens analisten ${fmt.pct(x.upside)}` });
    }
  }

  // Nagebootst rendement: elk kwartaal de 13F-portefeuille kopen op de dag dat die openbaar wordt.
  let perf = null;
  if (!fund.quant && quarters.length >= 2) {
    const perfSyms = [...new Set(quarters.flatMap((x) => x.rows.filter((r) => r.symbol).slice(0, 25).map((r) => r.symbol)))];
    const since = quarters[0].period;
    const rows = await safe(gq.pricesFor([...perfSyms, 'SPY'], since), []);
    const prices = new Map();
    for (const r of rows) {
      if (!prices.has(r.symbol)) prices.set(r.symbol, []);
      prices.get(r.symbol).push(r);
    }
    perf = guru.hypothetical(quarters, prices, prices.get('SPY') || []);
  }

  const name = fund.manager || fund.name;
  const top3 = positions.slice(0, 3).map((p) => `${fmt.company(p.name)} (${fmt.pct(p.weight, false)})`);
  const story = [
    `${name} beheert via ${fund.name} een Amerikaanse aandelenportefeuille van ${fmt.money(curTot.value)} verdeeld over ${curTot.positions} posities, volgens de 13F-filing over ${guruCharts.qLabel(cur.period)}.`,
    top3.length ? `De grootste posities zijn ${top3.slice(0, -1).join(', ')}${top3.length > 1 ? ' en ' : ''}${top3[top3.length - 1]}; samen maken de tien grootste ${fmt.pct(top10, false)} van de portefeuille uit.` : '',
    prev ? `Ten opzichte van het kwartaal ervoor ${mv.buys.filter((m) => m.kind === 'new').length === 1 ? 'kwam er 1 nieuwe positie' : `kwamen er ${mv.buys.filter((m) => m.kind === 'new').length} nieuwe posities`} bij en ${mv.sells.filter((m) => m.kind === 'sold').length === 1 ? 'werd 1 positie' : `werden ${mv.sells.filter((m) => m.kind === 'sold').length} posities`} volledig verkocht.` : '',
    perf ? `Wie de portefeuille sinds ${fmt.date(perf.since)} elk kwartaal had nagebootst, haalde ${fmt.pct(perf.total)} rendement, tegenover ${fmt.pct(perf.benchTotal)} voor de S&P 500.` : '',
  ].filter(Boolean);

  // Volledig verkocht: klassen van één bedrijf (Z + ZG) samen, grootste positie eerst.
  const soldMap = new Map();
  for (const m of mv.sells.filter((x) => x.kind === 'sold')) {
    const name = nameOf.get(m.symbol) || m.issuer;
    const key = (fmt.company(name) || m.symbol || '').toLowerCase();
    const g = soldMap.get(key);
    if (g) { g.prev_weight = (Number(g.prev_weight) || 0) + (Number(m.prev_weight) || 0); if (m.symbol) g.symbols.push(m.symbol); }
    else soldMap.set(key, { ...m, name, prev_weight: Number(m.prev_weight) || 0, symbols: m.symbol ? [m.symbol] : [] });
  }
  const soldList = [...soldMap.values()].sort((a, b) => b.prev_weight - a.prev_weight);
  res.render('guru', {
    title,
    seo: { description: story.slice(0, 2).join(' ').slice(0, 300), canonical, jsonld: [
      { '@context': 'https://schema.org', '@type': 'ProfilePage', name: title, url: canonical, mainEntity: { '@type': 'Person', name, ...(fund.bio ? { description: fund.bio } : {}), worksFor: { '@type': 'Organization', name: fund.name } } },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: "Guru's", item: `${base}/gurus` },
        { '@type': 'ListItem', position: 2, name, item: canonical },
      ] },
    ] },
    fund, name, watched, empty: false, periods, selIdx, cur, prev, curTot, positions, tileItems, sectors, sectorHoldings, heat, mv, valueSeries, top10, bubbles, perf, story, gc: guruCharts,
    sold: soldList,
    nameOf,
  });
}));

// ---------- Aandeel ----------
// "Apple Inc." -> "Apple": zo zoeken beleggers ook ("koersdoel Apple").
const shortName = (n) => String(n || '').replace(/,?\s+(inc\.?|incorporated|corporation|corp\.?|co\.|ltd\.?|limited|plc|n\.v\.|s\.a\.|se|ag|holdings? inc\.?)$/i, '').trim() || n;
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
  const [peerRows, epsRows, inIndexes] = await Promise.all([
    safe(sq.peers(symbol, profile && profile.sector, 8, profile && profile.industry), []),
    safe(sq.epsOutlook(symbol), []),
    safe(sq.indexesOf(symbol), []),
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
  // Tijdlijn: koers van het laatste jaar, koersdoelen van de laatste 6 maanden (oudere doelen zeggen weinig over nu).
  const tlFrom = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const tlTargetsFrom = Date.now() - 182 * 864e5;
  const timeline = charts.both.targetTimeline(series.filter((p) => p.date >= tlFrom), timelineTargets.filter((t) => new Date(t.published_at).getTime() >= tlTargetsFrom));

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
  // Alleen recente cijfers noemen (Rogier): ouder dan ~4 maanden laten we weg.
  const freshE = (r) => r && r.date && Date.now() - new Date(r.date).getTime() < 130 * 864e5;
  const lastE = earningsRows.length && freshE(earningsRows[0]) ? withReaction(earningsRows[0]) : null;
  const revs = income.map((x) => Number(x.revenue)).filter((v) => v > 0);
  const facts = {
    name: shortName(profile ? profile.companyName : symbol),
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

  // Extra feiten voor de vragen en de inleidingen per blok.
  const nowD = new Date();
  facts.forecastYear = nowD.getUTCFullYear() + (nowD.getUTCMonth() >= 9 ? 1 : 0);
  const fyRow = epsRows.find((r) => Number(r.fiscal_date.slice(0, 4)) === facts.forecastYear) || epsRows.find((r) => r.fiscal_date > nowD.toISOString().slice(0, 10));
  if (fyRow && Number.isFinite(fyRow.eps)) {
    const prevRow = epsRows[epsRows.indexOf(fyRow) - 1];
    facts.epsOutlook = { year: Number(fyRow.fiscal_date.slice(0, 4)), eps: fyRow.eps, revenue: fyRow.revenue, analysts: fyRow.analysts,
      growth: prevRow && prevRow.eps > 0 ? fyRow.eps / prevRow.eps - 1 : null };
  }
  if (profile) {
    const dv = Number(profile.lastDividend ?? profile.lastDiv) || 0;
    facts.dividend = { amount: dv, yield: dv > 0 && price > 0 ? dv / price : null };
  }
  const who = (t) => (t.analyst_name && t.analyst_firm ? `${t.analyst_name} van ${t.analyst_firm}` : t.analyst_name || t.analyst_firm || 'een analist');
  const tgtFact = (t) => (t ? { target: Number(t.price_target), who: who(t), date: t.published_at, upside: price > 0 ? Number(t.price_target) / price - 1 : null } : null);
  if (profile) {
    const sentences = String(profile.description || '').match(/[^.!?]+[.!?]+(\s|$)/g) || [];
    facts.about = {
      text: sentences.slice(0, 3).join('').trim() || null,
      industry: profile.industry || null,
      exchange: profile.exchange || profile.exchangeShortName || null,
      country: profile.country || null,
      ceo: profile.ceo || null,
      employees: Number(profile.fullTimeEmployees) || null,
      ipo: profile.ipoDate || null,
      marketCap: Number(profile.marketCap || profile.mktCap) || null,
    };
  }
  facts.highTarget = tgtFact(bull);
  facts.lowTarget = tgtFact(bear);
  const recentActs = actions.filter((a) => recent(a.date));
  facts.recentActions = {
    total: recentActs.length,
    upgrades: recentActs.filter((a) => a.action.label === 'Upgrade').length,
    downgrades: recentActs.filter((a) => a.action.label === 'Downgrade').length,
    raises: facts.actions.raises,
    cuts: facts.actions.cuts,
    last: recentActs[0] ? { label: recentActs[0].action.label, firm: recentActs[0].firm, date: recentActs[0].date } : null,
  };
  facts.analystFirms = [...new Set(latest.map((t) => t.analyst_firm).filter(Boolean))];
  const beatRows = lastE ? earningsRows.map(withReaction).filter((r) => r.surprise !== null && r.surprise !== undefined && Date.now() - new Date(r.date).getTime() < 2 * 365 * 864e5) : [];
  facts.earningsBeats = beatRows.length ? { beats: beatRows.filter((r) => r.surprise > 0).length, total: beatRows.length } : null;
  const last13 = months.slice(-13);
  const tIdx = last13.findIndex((m) => m.mean);
  const rIdx = last13.findIndex((m) => m.ratings);
  const rLast = last13.slice().reverse().find((m) => m.ratings);
  const share = (r) => (r && r.total ? (r.strong_buy + r.buy) / r.total : null);
  facts.monthsTrend = {
    monthsBack: tIdx >= 0 ? last13.length - 1 - tIdx : null,
    targetThen: tIdx >= 0 && tIdx < last13.length - 1 ? last13[tIdx].mean : null,
    targetNow: last13.length ? last13[last13.length - 1].mean : null,
    closeThen: tIdx >= 0 ? last13[tIdx].close : null,
    closeNow: last13.length ? last13[last13.length - 1].close : null,
    ratingsBack: rIdx >= 0 && rLast ? last13.indexOf(rLast) - rIdx : null,
    buyShareThen: rIdx >= 0 && rLast && last13[rIdx] !== rLast ? share(last13[rIdx].ratings) : null,
    buyShareNow: rLast ? share(rLast.ratings) : null,
  };
  facts.rotThen = rot[3] ? { verdict: rot[3].verdict && rot[3].verdict.label, target: rot[3].target } : null;
  facts.rotAll = rot.map((r) => ({ ...r, verdict: r.verdict && r.verdict.label }));
  const peerList = peerRows.map((r) => {
    const pc = av.counts(r);
    const sc = av.ratingScore(pc);
    return { symbol: r.symbol, name: r.name, price: r.price, target: r.target, upside: r.target > 0 && r.price > 0 ? r.target / r.price - 1 : null,
      score: sc, verdict: av.ratingLabel(sc), counts: pc, curated: !!r.curated };
  });
  facts.peers = peerList;
  const crumbIndex = inIndexes.map((k) => indexes.byKey(k)).filter(Boolean)[0] || null;
  const story = buildStory(facts);

  // Waaier met koersverwachting: één stip per laatste koersdoel per analist, met het advies van die bank.
  const gradeByFirm = new Map();
  for (const g of grades) {
    const k = String(g.grading_company || '').toLowerCase();
    if (k && !gradeByFirm.has(k)) gradeByFirm.set(k, g.new_grade);
  }
  const yearAgo = new Date(Date.now() - 365 * day).toISOString().slice(0, 10);
  const fan = charts.both.forecastFan(series.filter((p) => p.date >= yearAgo).concat(price > 0 ? [{ date: new Date().toISOString().slice(0, 10), close: price }] : [])
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
      about: { '@type': 'Corporation', name: (profile && profile.companyName) || name, tickerSymbol: symbol, ...(profile && profile.website ? { url: profile.website } : {}) },
      dateModified: new Date().toISOString() },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Aandelen', item: `${config.publicUrl.replace(/\/$/, '')}/aandelen` },
      ...(crumbIndex ? [{ '@type': 'ListItem', position: 2, name: crumbIndex.label, item: `${config.publicUrl.replace(/\/$/, '')}/aandelen?index=${crumbIndex.key}` }] : []),
      { '@type': 'ListItem', position: crumbIndex ? 3 : 2, name: `${name} (${symbol})`, item: canonical },
    ] },
  ];
  if (story.faq.length) {
    jsonld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: story.faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: String(x.a).replace(/\n\n/g, ' ') } })) });
  }

  const members = await safe(cm.stockSentiment(symbol), null);
  // Laatste earnings call (alleen tonen als die recent is); op de achtergrond nieuwe calls ophalen.
  const transcripts = require('../transcripts');
  transcripts.ensure(symbol).catch(() => {});
  const lastCalls = await safe(transcripts.stored(symbol), []);
  let callTeaser = null;
  if (lastCalls[0] && lastCalls[0].date && Date.now() - new Date(lastCalls[0].date).getTime() < 130 * 864e5) {
    const cur = lastCalls[0];
    const prev = lastCalls[1] || null;
    const cmp = prev ? tr.compare(cur.analysis, prev.analysis) : null;
    const ev = resultsFor(earningsRows, cur.date);
    const nl = await safe(transcripts.nlSummary(symbol, cur.year, cur.quarter));
    // Toon van het management over de laatste calls (oud -> nieuw) voor het lijntje.
    const toneHist = lastCalls.slice(0, 8).reverse().filter((c) => c.analysis && c.analysis.tone)
      .map((c) => ({ label: callLabel(c), v: callCharts.score(c.analysis.tone.mgmt.net) }));
    // Vraag die het meeste antwoord kreeg, als lokkertje naar de call-pagina.
    const ex = (cur.analysis.exchanges || []).slice().sort((x, y) => (y.answerWords || 0) - (x.answerWords || 0))[0] || null;
    callTeaser = {
      cur, prev, cmp, ev, nl, toneHist, ex,
      href: `/aandeel/${encodeURIComponent(symbol)}/earnings-calls/${callSlug(cur)}`,
      story: nl && nl.summary ? [] : tr.story({ a: cur.analysis, cmp, prevLabel: prev ? callLabel(prev) : '', ev }),
    };
  }
  res.render('stock', {
    members,
    callTeaser,
    callCharts,
    tr,
    ratingTrend,
    earningsHist: earningsRows.map(withReaction).reverse().map((h) => ({ ...h, label: er.quarterLabel(h.date) })),
    nextEarn,
    title: story.title,
    fullTitle: true,
    peers: peerList,
    crumbIndex,
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
    topUpside: withUp.filter((r) => r.total >= 5 && r.upside > 0).sort((a, b) => b.upside - a.upside).slice(0, 10),
  };
  const base = config.publicUrl.replace(/\/$/, '');
  const VIEW_TITLES = { alle: 'koersdoelen en analistenadviezen per aandeel', vandaag: 'analistenadviezen van vandaag', meest: 'meest aanbevolen aandelen volgens analisten', minst: 'minst aanbevolen aandelen volgens analisten', potentieel: 'aandelen met het grootste koerspotentieel' };
  const canonical = `${base}/aandelen?index=${idx.key}${view !== 'alle' ? '&weergave=' + view : ''}`;
  const top3 = summary.topUpside.slice(0, 3).map((r) => `${r.name || r.symbol} (${fmt.pct(r.upside)})`);
  const intro = rows.length && summary.rated
    ? `De ${idx.label} telt ${rows.length} aandelen, waarvan ${summary.rated} met adviezen van analisten. ${fmt.pct(summary.buyShare, false)} van alle adviezen is kopen`
      + (summary.medianUpside !== null ? ` en het mediane aandeel heeft volgens het gemiddelde koersdoel ${fmt.pct(summary.medianUpside)} potentieel` : '')
      + '.' + (top3.length ? ` Het meeste potentieel zien analisten bij ${top3.length > 1 ? top3.slice(0, -1).join(', ') + ' en ' + top3[top3.length - 1] : top3[0]}.` : '')
    : null;
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Aandelen', item: `${base}/aandelen` },
      { '@type': 'ListItem', position: 2, name: idx.label, item: `${base}/aandelen?index=${idx.key}` },
    ] },
  ];
  if (list.length && view !== 'vandaag') {
    jsonld.push({ '@context': 'https://schema.org', '@type': 'ItemList', name: `${idx.label}: ${VIEW_TITLES[view]}`,
      itemListElement: list.slice(0, 30).map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: r.name || r.symbol, url: `${base}/aandeel/${encodeURIComponent(r.symbol)}` })) });
  }
  // Lijst 'alle aandelen': maximaal 50 per pagina (?pagina=2), of alles (?pagina=alles).
  const PER = 50;
  const pages = Math.max(1, Math.ceil(list.length / PER));
  const all = req.query.pagina === 'alles';
  const page = all ? 0 : Math.min(pages, Math.max(1, parseInt(req.query.pagina, 10) || 1));
  const pageRows = view === 'alle' && !all ? list.slice((page - 1) * PER, page * PER) : list;
  const pager = view === 'alle' && pages > 1 ? { page, pages, per: PER, total: list.length, all, from: all ? 1 : (page - 1) * PER + 1 } : null;
  res.render('stocks', {
    title: `${idx.label}: ${VIEW_TITLES[view]}`,
    intro,
    seo: { description: intro ? intro.slice(0, 300) : `Alle aandelen uit de ${idx.label} met koers, gemiddeld koersdoel, potentieel en de verdeling van kopen, houden en verkopen van analisten.`, canonical, jsonld },
    idx, groups: indexes.GROUPS, counts, rows: pageRows, allCount: rows.length, sort, dir, summary, view, today, pager,
  });
}));

// ---------- Community: zelf guru worden ----------
pub.get('/community', wrap(async (req, res) => {
  const [leaders, recent, popular, tot] = await Promise.all([
    safe(cm.leaderboard(50), []),
    safe(cm.recentCalls(16), []),
    safe(cm.popularStocks(8), []),
    safe(cm.totals(), { members: 0, calls: 0, stocks: 0 }),
  ]);
  const me = req.user ? await safe(cm.userProfile(req.user.id)) : null;
  res.render('community', {
    title: 'Community',
    leaders, recent, popular, tot, me,
    seo: {
      title: 'Community: word zelf guru · Guruwatch',
      description: 'Geef je eigen koersdoelen af en laat je net als de analisten afrekenen op je trackrecord. Bekijk de ranglijst van de beste beleggers in de Guruwatch-community.',
    },
  });
}));

pub.get('/lid/:handle', wrap(async (req, res) => {
  const member = await cm.byHandle(String(req.params.handle).slice(0, 30));
  if (!member) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Dit lid bestaat niet (meer).' });
  const [calls, score] = await Promise.all([cm.callsForUser(member.id), safe(cm.memberScore(member.id))]);
  const open = calls.filter((c) => !c.complete);
  const done = calls.filter((c) => c.complete);
  const lives = open.map((c) => c.live).filter(Number.isFinite);
  const stats = {
    calls: calls.length,
    open: open.length,
    live: lives.length ? lives.reduce((a, b) => a + b, 0) / lives.length : null,
    atTarget: open.filter((c) => c.progress >= 1).length,
    bulls: calls.filter((c) => c.direction > 0).length,
  };
  const isMe = !!(req.user && req.user.id === member.id);
  res.render('member', {
    title: member.handle, member, calls, open, done, score, stats, isMe,
    undoMinutes: cm.UNDO_MINUTES,
    seo: { title: `${member.handle}: koersdoelen en trackrecord · Guruwatch`, description: `Alle koersdoelen van ${member.handle} in de Guruwatch-community, met hoe ze ervoor staan.` },
  });
}));

router.get('/community/nieuw', wrap(async (req, res) => {
  const symbol = String(req.query.aandeel || '').toUpperCase().slice(0, 15);
  const me = await cm.userProfile(req.user.id);
  let price = null;
  let name = null;
  if (symbol && SYMBOL_RE.test(symbol)) {
    price = await safe(cm.currentPrice(symbol));
    const c = await safe(db.one('SELECT name FROM companies WHERE symbol = $1', [symbol]));
    name = c && c.name;
  }
  res.render('community-new', { title: 'Geef je koersdoel', me, symbol, price, name, error: req.query.fout || null, form: {} });
}));

router.post('/community/voorspelling', wrap(async (req, res) => {
  const symbol = String(req.body.symbol || '').trim().toUpperCase().slice(0, 15);
  const target = Number(String(req.body.target || '').replace(',', '.'));
  const note = String(req.body.note || '').trim().slice(0, 280);
  let me = await cm.userProfile(req.user.id);
  const fail = async (msg) => {
    const price = SYMBOL_RE.test(symbol) ? await safe(cm.currentPrice(symbol)) : null;
    res.status(400).render('community-new', { title: 'Geef je koersdoel', me, symbol, price, name: null, error: msg, form: { target: req.body.target, note, handle: req.body.handle } });
  };
  if (!me.handle) {
    const handle = String(req.body.handle || '').trim();
    if (!cm.validHandle(handle)) return fail('Kies een naam van 3 tot 20 tekens (letters, cijfers of _).');
    const r = await cm.setProfile(req.user.id, { handle, bio: null });
    if (r.error) return fail(r.error);
    me = await cm.userProfile(req.user.id);
  }
  if (!SYMBOL_RE.test(symbol)) return fail('Vul een geldig tickersymbool in, bijvoorbeeld AAPL.');
  if (!(await safe(cm.currentPrice(symbol)))) {
    const qt = await safe(fmp.quote(symbol));
    if (qt && qt.price > 0) await db.query('INSERT INTO quotes (symbol, price, change_pct) VALUES ($1, $2, $3) ON CONFLICT (symbol) DO UPDATE SET price = EXCLUDED.price, updated_at = now()', [symbol, qt.price, qt.changePercentage ?? null]);
  }
  const r = await cm.addCall(req.user.id, { symbol, target, note });
  if (r.error) return fail(r.error);
  res.redirect(`/lid/${encodeURIComponent(me.handle)}?nieuw=${r.id}`);
}));

router.post('/community/profiel', wrap(async (req, res) => {
  const handle = String(req.body.handle || '').trim();
  const bio = String(req.body.bio || '').trim().slice(0, 200);
  if (!cm.validHandle(handle)) return res.redirect('/community?fout=naam');
  const r = await cm.setProfile(req.user.id, { handle, bio });
  if (r.error) return res.redirect('/community?fout=bezet');
  res.redirect(`/lid/${encodeURIComponent(handle)}`);
}));

router.post('/community/intrekken', wrap(async (req, res) => {
  const id = Number(req.body.id);
  const me = await cm.userProfile(req.user.id);
  if (Number.isInteger(id)) await cm.withdrawCall(req.user.id, id);
  res.redirect(me && me.handle ? `/lid/${encodeURIComponent(me.handle)}` : '/community');
}));

// ---------- Zoekmachines ----------
pub.get('/robots.txt', (req, res) => {
  const base = config.publicUrl.replace(/\/$/, '');
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /mijn\nDisallow: /volg\nDisallow: /status\nDisallow: /community/nieuw\nDisallow: /zoek\nDisallow: /login\nSitemap: ${base}/sitemap.xml\n`);
});

pub.get('/sitemap.xml', wrap(async (req, res) => {
  const base = config.publicUrl.replace(/\/$/, '');
  const syms = await safe(sq.sitemapSymbols(5000), []);
  const urls = [
    ...indexes.ALL.filter((i) => i.endpoint).map((i) => `<url><loc>${base}/aandelen?index=${i.key}</loc><changefreq>daily</changefreq></url>`),
    `<url><loc>${base}/gurus</loc><changefreq>weekly</changefreq></url>`,
    `<url><loc>${base}/community</loc><changefreq>daily</changefreq></url>`,
    ...(await safe(q.fundsList(), [])).filter((f) => f.latest_period).map((f) => `<url><loc>${base}/guru/${f.slug}</loc><changefreq>weekly</changefreq></url>`),
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

// Suggesties onder de zoekbalk tijdens het typen (aandelen, analisten, guru's).
const US_EX = /^(NASDAQ|NYSE|AMEX|NYSE ?ARCA|NYSEARCA|CBOE|BATS)$/i;
router.get('/zoek/suggesties', wrap(async (req, res) => {
  const term = String(req.query.q || '').trim().slice(0, 40);
  res.set('Cache-Control', 'private, max-age=60');
  if (!term) return res.json({ stocks: [], analysts: [], gurus: [] });
  const up = term.toUpperCase();
  const lower = term.toLowerCase();
  const [local, analysts, allFunds] = await Promise.all([
    db.many(
      `SELECT symbol, name, market_cap FROM companies
       WHERE symbol ILIKE $1 OR name ILIKE $2
       ORDER BY (symbol = $3) DESC, (symbol ILIKE $1) DESC, (name ILIKE $4) DESC, market_cap DESC NULLS LAST
       LIMIT 8`,
      [`${up}%`, `%${term}%`, up, `${term}%`]
    ).catch(() => []),
    q.analystSearch(term, 4).catch(() => []),
    q.fundsList().catch(() => []),
  ]);
  let stocks = local.map((c) => ({ symbol: c.symbol, name: fmt.company(c.name) }));
  if (stocks.length < 6 && term.length >= 2) {
    const [a, b] = await Promise.all([safe(fmp.searchSymbol(term), []), safe(fmp.searchName(term), [])]);
    const seen = new Set(stocks.map((x) => x.symbol));
    const extra = [...a, ...b]
      .filter((x) => x && x.symbol && !seen.has(x.symbol) && seen.add(x.symbol))
      .sort((x, y) => (US_EX.test(y.exchangeShortName || y.exchange || '') ? 1 : 0) - (US_EX.test(x.exchangeShortName || x.exchange || '') ? 1 : 0)
        || (y.symbol.toUpperCase() === up) - (x.symbol.toUpperCase() === up));
    stocks = stocks.concat(extra.slice(0, 8 - stocks.length).map((x) => ({ symbol: x.symbol, name: fmt.company(x.name || ''), ex: x.exchangeShortName || x.exchange || '' })));
  }
  const gurus = allFunds
    .filter((f) => `${f.name} ${f.manager || ''}`.toLowerCase().includes(lower))
    .slice(0, 4)
    .map((f) => ({ slug: f.slug, name: f.manager || f.name, fund: f.name }));
  res.json({
    stocks: stocks.slice(0, 8),
    analysts: analysts.map((a) => ({ slug: a.slug, name: a.name, firm: a.firm })),
    gurus,
  });
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

// ---------- Earnings calls (transcripts) ----------
const callLabel = (r) => `Q${r.quarter} ${r.year}`;
const callSlug = (r) => `${r.year}-q${r.quarter}`;

async function loadCalls(symbol) {
  const transcripts = require('../transcripts');
  // Eerst kijken of er nieuwe calls zijn; niet langer dan 9 seconden wachten (de rest volgt op de achtergrond).
  const run = transcripts.ensure(symbol).catch((err) => console.warn('[transcripts]', symbol, err.message));
  await Promise.race([run, new Promise((r) => setTimeout(r, 9000))]);
  const rows = await transcripts.stored(symbol);
  return rows.map((r) => ({
    ...r,
    label: callLabel(r),
    short: `Q${r.quarter} '${String(r.year).slice(2)}`,
    slug: callSlug(r),
    href: `/aandeel/${encodeURIComponent(symbol)}/earnings-calls/${callSlug(r)}`,
    dateTxt: r.date ? fmt.date(r.date) : '',
  }));
}

// Analisten uit de calls koppelen aan onze eigen analistenpagina's (zelfde naam).
async function analystLinks(names) {
  if (!names.length) return new Map();
  const rows = await safe(db.many(
    `SELECT a.slug, a.name, a.firm, g.score::float8 AS score FROM analysts a
     LEFT JOIN guru_scores g ON g.kind = 'analyst' AND g.ref = a.id::text
     WHERE lower(a.name) = ANY($1)`,
    [names.map((n) => n.toLowerCase())]
  ), []);
  return new Map(rows.map((r) => [r.name.toLowerCase(), r]));
}

// Kwartaalcijfers en koersreactie die bij een call horen (cijfers 0-5 dagen voor of op de dag van de call).
function resultsFor(events, date) {
  if (!date) return null;
  const t = new Date(date).getTime();
  const ev = events.find((e) => { const d = (t - new Date(e.date).getTime()) / 864e5; return d >= -2 && d <= 5; });
  return ev ? withReaction(ev) : null;
}

pub.get('/aandeel/:symbol/earnings-calls', wrap(async (req, res) => {
  const symbol = String(req.params.symbol).toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Ongeldig tickersymbool.' });
  const [calls, company, events] = await Promise.all([loadCalls(symbol), safe(db.one('SELECT name FROM companies WHERE symbol = $1', [symbol])), safe(eq.reactions({ symbol, limit: 12 }), [])]);
  const name = (company && company.name) || symbol;
  for (const c of calls) c.ev = resultsFor(events, c.date);
  const asc = calls.slice().reverse();
  const latest = calls[0] || null;
  const prev = calls[1] || null;
  const cmp = latest && prev ? tr.compare(latest.analysis, prev.analysis) : null;
  const who = ['mgmt', 'analysts'].includes(req.query.wie) ? req.query.wie : 'all';
  // Alle analisten over alle calls: hoe vaak aanwezig, hoeveel vragen, waarover.
  const agg = new Map();
  for (const c of calls) {
    for (const a of c.analysis.analysts || []) {
      if (!agg.has(a.name)) agg.set(a.name, { name: a.name, firm: a.firm, calls: [], questions: 0, topics: {} });
      const g = agg.get(a.name);
      if (!g.firm && a.firm) g.firm = a.firm;
      g.calls.push(c.label);
      g.questions += a.questions;
      for (const t of a.topics) g.topics[t] = (g.topics[t] || 0) + 1;
    }
  }
  const links = await analystLinks([...agg.keys()]);
  const analysts = [...agg.values()]
    .map((a) => ({ ...a, link: links.get(a.name.toLowerCase()) || null, top: tr.topTopics(a.topics, 3).map(tr.topicLabel), inLatest: latest ? (latest.analysis.analysts || []).some((x) => x.name === a.name) : false }))
    .sort((a, b) => b.calls.length - a.calls.length || b.questions - a.questions)
    .slice(0, 40);
  const latestRow = latest ? await safe(require('../transcripts').content(symbol, latest.year, latest.quarter)) : null;
  const latestFull = latestRow ? tr.analyze(latestRow.content, { full: true }) : latest && latest.analysis;
  const latestNl = latestRow && latestRow.nl;
  if (latestRow && latestFull && !tl.nlFits(latestNl, latestFull.exchanges || [])) translate.queue(symbol, latest.year, latest.quarter);
  const summary = latest ? tr.story({ a: latest.analysis, cmp, prevLabel: prev ? prev.label : '', ev: latest.ev }) : [];
  if (latestNl && latestFull && latestFull.exchanges) latestFull.exchanges = tl.applyNl(latestFull.exchanges, latestNl);
  const stale = latest && latest.date ? Date.now() - new Date(latest.date).getTime() > 200 * 864e5 : false;
  res.render('calls', {
    title: `${name} (${symbol}) earnings calls: toon, onderwerpen en vragen van analisten`,
    seo: { canonical: `${config.publicUrl.replace(/\/$/, '')}/aandeel/${encodeURIComponent(symbol)}/earnings-calls`, description: latest ? `Analyse van ${calls.length} earnings calls van ${name}: toon van management en analisten, welke onderwerpen opkomen en welke analisten vragen stellen. Laatste call: ${latest.label}.` : `Earnings calls van ${name}.` },
    symbol, name, calls, asc, latest, prev, cmp, who, analysts, stale, tr, callCharts, summary, latestFull, nl: latestNl || null, fullText: config.transcriptsFullText,
  });
}));

pub.get('/aandeel/:symbol/earnings-calls/:call', wrap(async (req, res) => {
  const symbol = String(req.params.symbol).toUpperCase();
  const m = String(req.params.call).match(/^(\d{4})-q([1-4])$/i);
  if (!SYMBOL_RE.test(symbol) || !m) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Onbekende call.' });
  const calls = await loadCalls(symbol);
  const i = calls.findIndex((c) => c.year === Number(m[1]) && c.quarter === Number(m[2]));
  if (i < 0) return res.status(404).render('error', { title: 'Niet gevonden', message: `Geen transcript van ${symbol} voor Q${m[2]} ${m[1]}.` });
  const call = calls[i];
  const prev = calls[i + 1] || null;
  const company = await safe(db.one('SELECT name FROM companies WHERE symbol = $1', [symbol]));
  const name = (company && company.name) || symbol;
  const cmp = prev ? tr.compare(call.analysis, prev.analysis) : null;
  // Volledige vragenronde (vraag + antwoorden) uit de opgeslagen tekst.
  const [row, events] = await Promise.all([require('../transcripts').content(symbol, call.year, call.quarter), safe(eq.reactions({ symbol, limit: 12 }), [])]);
  const full = row ? tr.analyze(row.content, { full: true }) : call.analysis;
  const nl = (row && row.nl) || null;
  if (row && !tl.nlFits(nl, full.exchanges || [])) translate.queue(symbol, call.year, call.quarter);
  const turns = config.transcriptsFullText && row ? tr.parseTurns(row.content) : null;
  const ev = resultsFor(events, call.date);
  const summary = tr.story({ a: full, cmp, prevLabel: prev ? prev.label : '', ev });
  const fullText = config.transcriptsFullText;
  if (nl && full.exchanges) full.exchanges = tl.applyNl(full.exchanges, nl);
  const links = await analystLinks((call.analysis.analysts || []).map((a) => a.name));
  res.render('call', {
    title: `${name} (${symbol}) earnings call ${call.label}`,
    seo: { description: `Earnings call van ${name} over ${call.label}${call.dateTxt ? ' (' + call.dateTxt + ')' : ''}: toon, onderwerpen en alle vragen van analisten.` },
    symbol, name, call, prev, cmp, turns, links, calls, tr, full, ev, summary, fullText, nl,
  });
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
  const timeline = charts.both.targetTimeline(series, around.filter((t) => new Date(t.published_at) <= new Date(to)), { markers: [{ date, label: 'Cijfers' }], height: 300 });
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

// Radar (onderdeel van de analistenpagina, tab=radar&radar=...).
async function radarData(query) {
  const req = { query };
  const tab = RADAR_TABS.includes(req.query.radar) ? req.query.radar : 'momentum';
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

  return data;
}

// De oude radarpagina is opgegaan in de analistenpagina.
router.get('/radar', (req, res) => {
  const p = new URLSearchParams({ tab: 'radar' });
  if (RADAR_TABS.includes(req.query.tab)) p.set('radar', req.query.tab);
  for (const k of ['dagen', 'min', 'sort', 'sector', 'cap']) if (req.query[k]) p.set(k, String(req.query[k]));
  res.redirect(301, `/analisten?${p}`);
});

// ---------- Status ----------
router.get('/status', wrap(async (req, res) => {
  const [jobs, counts] = await Promise.all([q.jobStatus(), q.counts()]);
  res.render('status', { title: 'Status', jobs, counts });
}));

module.exports = router;
module.exports.publicRouter = pub;
