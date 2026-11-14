'use strict';

// Client voor Financial Modeling Prep (stable API).
// Documentatie: https://site.financialmodelingprep.com/developer/docs
const config = require('../config');
const { TtlCache } = require('./cache');

const BASE = 'https://financialmodelingprep.com/stable';
const cache = new TtlCache(3000);

const MIN = 60 * 1000;

class FmpError extends Error {}

async function request(path, params = {}, { ttl = 5 * MIN, retries = 2 } = {}) {
  if (!config.fmpKey) throw new FmpError('FMP_API_KEY ontbreekt');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const key = `${path}?${qs.toString()}`;
  qs.set('apikey', config.fmpKey);
  const url = `${BASE}/${path}?${qs.toString()}`;

  const run = async () => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new FmpError(`FMP ${path}: HTTP ${res.status}`);
          await sleep(500 * (attempt + 1) ** 2);
          continue;
        }
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new FmpError(`FMP ${path}: geen JSON (${res.status})`);
        }
        if (!res.ok) {
          const msg = (data && (data['Error Message'] || data.message)) || `HTTP ${res.status}`;
          throw new FmpError(`FMP ${path}: ${msg}`);
        }
        if (data && !Array.isArray(data) && data['Error Message']) {
          throw new FmpError(`FMP ${path}: ${data['Error Message']}`);
        }
        return data;
      } catch (err) {
        lastErr = err;
        if (err instanceof FmpError && !/HTTP (429|5\d\d)/.test(err.message)) throw err;
        await sleep(500 * (attempt + 1) ** 2);
      }
    }
    throw lastErr;
  };
  // ttl 0: niet cachen (grote reeksen voor achtergrondtaken).
  return ttl > 0 ? cache.wrap(key, ttl, run) : run();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arr = (x) => (Array.isArray(x) ? x : []);
const first = (x) => (Array.isArray(x) ? x[0] || null : x || null);

module.exports = {
  FmpError,
  request,

  // Bedrijf en koers
  profile: async (symbol) => first(await request('profile', { symbol }, { ttl: 6 * 60 * MIN })),
  quote: async (symbol) => first(await request('quote', { symbol }, { ttl: 1 * MIN })),
  batchQuoteShort: async (symbols) => arr(await request('batch-quote-short', { symbols: symbols.join(',') }, { ttl: 1 * MIN })),
  searchSymbol: async (query) => arr(await request('search-symbol', { query, limit: 20 }, { ttl: 60 * MIN })),
  searchName: async (query) => arr(await request('search-name', { query, limit: 20 }, { ttl: 60 * MIN })),
  historicalLight: async (symbol, from, to) => arr(await request('historical-price-eod/light', { symbol, from, to }, { ttl: 60 * MIN })),

  // Voor achtergrondtaken: zonder cache
  historyNoCache: async (symbol, from, to) => arr(await request('historical-price-eod/light', { symbol, from, to }, { ttl: 0 })),
  ratingHistory: async (symbol) => arr(await request('grades-historical', { symbol, limit: 60 }, { ttl: 6 * 60 * MIN })),
  earningsCalendarNoCache: async (from, to) => arr(await request('earnings-calendar', { from, to }, { ttl: 0 })),
  profileNoCache: async (symbol) => first(await request('profile', { symbol }, { ttl: 0 })),
  estimatesNoCache: async (symbol) => arr(await request('analyst-estimates', { symbol, period: 'annual', page: 0, limit: 10 }, { ttl: 0 })),
  ratingHistoryNoCache: async (symbol) => arr(await request('grades-historical', { symbol, limit: 120 }, { ttl: 0 })),
  priceTargetPageNoCache: async (symbol, page) => arr(await request('price-target-news', { symbol, page, limit: 100 }, { ttl: 0 })),

  // Analisten
  priceTargetLatest: async (page = 0, limit = 100) => arr(await request('price-target-latest-news', { page, limit }, { ttl: 2 * MIN })),
  priceTargetNews: async (symbol, limit = 100, page = 0) => arr(await request('price-target-news', { symbol, page, limit }, { ttl: 30 * MIN })),
  priceTargetConsensus: async (symbol) => first(await request('price-target-consensus', { symbol }, { ttl: 60 * MIN })),
  priceTargetSummary: async (symbol) => first(await request('price-target-summary', { symbol }, { ttl: 60 * MIN })),
  gradesLatest: async (page = 0, limit = 100) => arr(await request('grades-latest-news', { page, limit }, { ttl: 2 * MIN })),
  gradesNews: async (symbol, limit = 100) => arr(await request('grades-news', { symbol, page: 0, limit }, { ttl: 30 * MIN })),
  gradesConsensus: async (symbol) => first(await request('grades-consensus', { symbol }, { ttl: 60 * MIN })),

  // Insiders
  insiderLatest: async (page = 0, limit = 100) => arr(await request('insider-trading/latest', { page, limit }, { ttl: 2 * MIN })),
  insiderBySymbol: async (symbol, limit = 100) => arr(await request('insider-trading/search', { symbol, page: 0, limit }, { ttl: 30 * MIN })),
  insiderStatistics: async (symbol) => arr(await request('insider-trading/statistics', { symbol }, { ttl: 6 * 60 * MIN })),

  // 13F
  institutionalDates: async (cik) => arr(await request('institutional-ownership/dates', { cik }, { ttl: 6 * 60 * MIN })),
  institutionalExtract: async (cik, year, quarter) =>
    arr(await request('institutional-ownership/extract', { cik, year, quarter }, { ttl: 6 * 60 * MIN })),
  holderPerformanceSummary: async (cik) =>
    arr(await request('institutional-ownership/holder-performance-summary', { cik, page: 0 }, { ttl: 6 * 60 * MIN })),
};
