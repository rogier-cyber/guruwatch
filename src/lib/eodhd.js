'use strict';

// EODHD: aanvulling voor logo's en historische koersen.
const config = require('../config');
const { TtlCache } = require('./cache');

const cache = new TtlCache(500);

const logos = require('./logos');

function logoUrl(symbol, profileImage) {
  // Eerst ons eigen logo, dan het FMP-profiel, dan EODHD.
  if (logos.hasLogo(symbol)) return logos.logoUrl(symbol);
  if (profileImage) return profileImage;
  return logos.logoUrl(symbol);
}

async function eod(symbol, from) {
  if (!config.eodhdKey) return null;
  const key = `${symbol}:${from}`;
  return cache.wrap(key, 60 * 60 * 1000, async () => {
    const ticker = symbol.includes('.') ? symbol : `${symbol}.US`;
    const url = `https://eodhd.com/api/eod/${encodeURIComponent(ticker)}?from=${from}&period=d&fmt=json&api_token=${config.eodhdKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`EODHD ${ticker}: HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data.map((d) => ({ date: d.date, close: d.adjusted_close ?? d.close })) : null;
  });
}

module.exports = { logoUrl, eod };
