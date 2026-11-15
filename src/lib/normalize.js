'use strict';

const crypto = require('crypto');

const hash = (...parts) =>
  crypto.createHash('sha1').update(parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('|')).digest('hex');

function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const ts = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const date = (v) => {
  const t = ts(v);
  return t ? t.slice(0, 10) : null;
};

const clean = (s) => {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  return t ? t : null;
};

function analystKey(name, firm) {
  const n = clean(name);
  if (!n) return null;
  return slugify(`${n} ${clean(firm) || ''}`);
}

function mapPriceTarget(r) {
  const symbol = clean(r.symbol);
  const publishedAt = ts(r.publishedDate);
  if (!symbol || !publishedAt) return null;
  const name = clean(r.analystName);
  const firm = clean(r.analystCompany);
  return {
    uid: hash('pt', symbol, publishedAt, name, firm, r.priceTarget, r.newsURL),
    symbol: symbol.toUpperCase(),
    published_at: publishedAt,
    analyst_name: name,
    analyst_firm: firm,
    analyst_slug: analystKey(name, firm),
    // Na een aandelensplitsing: het voor de split aangepaste doel (zelfde schaal als de koers).
    price_target: splitTarget(num(r.priceTarget), num(r.adjPriceTarget), num(r.priceWhenPosted)),
    raw_price_target: num(r.priceTarget),
    adj_price_target: num(r.adjPriceTarget),
    price_when_posted: num(r.priceWhenPosted),
    news_title: clean(r.newsTitle),
    news_url: clean(r.newsURL),
    news_publisher: clean(r.newsPublisher),
  };
}

// Kies het koersdoel op de schaal van de (split-gecorrigeerde) koers. FMP geeft naast het originele doel een
// split-gecorrigeerd doel; we nemen dat als het dichter bij de koers van dat moment ligt (of die koers ontbreekt).
function splitTarget(raw, adj, pwp) {
  if (!(adj > 0) || !(raw > 0) || Math.abs(adj / raw - 1) <= 0.01) return raw ?? adj ?? null;
  if (!(pwp > 0)) return adj;
  return Math.abs(Math.log(adj / pwp)) < Math.abs(Math.log(raw / pwp)) ? adj : raw;
}

function mapGrade(r) {
  const symbol = clean(r.symbol);
  const publishedAt = ts(r.publishedDate);
  if (!symbol || !publishedAt) return null;
  return {
    uid: hash('gr', symbol, publishedAt, r.gradingCompany, r.newGrade, r.newsURL),
    symbol: symbol.toUpperCase(),
    published_at: publishedAt,
    grading_company: clean(r.gradingCompany),
    previous_grade: clean(r.previousGrade),
    new_grade: clean(r.newGrade),
    action: clean(r.action),
    price_when_posted: num(r.priceWhenPosted),
    news_title: clean(r.newsTitle),
    news_url: clean(r.newsURL),
    news_publisher: clean(r.newsPublisher),
  };
}

function mapInsider(r) {
  const symbol = clean(r.symbol);
  if (!symbol) return null;
  return {
    uid: hash('in', symbol, r.reportingCik, r.transactionDate, r.transactionType, r.securitiesTransacted, r.price, r.securitiesOwned, r.url),
    symbol: symbol.toUpperCase(),
    filing_date: ts(r.filingDate),
    transaction_date: date(r.transactionDate),
    reporting_cik: clean(r.reportingCik),
    reporting_name: clean(r.reportingName),
    type_of_owner: clean(r.typeOfOwner),
    transaction_type: clean(r.transactionType),
    acquisition_or_disposition: clean(r.acquisitionOrDisposition),
    securities_transacted: num(r.securitiesTransacted),
    price: num(r.price),
    securities_owned: num(r.securitiesOwned),
    security_name: clean(r.securityName),
    form_type: clean(r.formType),
    url: clean(r.url),
  };
}

// Zet 13F-regels om naar posities met gewicht; voegt dubbele CUSIP-regels samen.
function mapHoldings(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    const cusip = clean(r.securityCusip) || clean(r.cusip);
    if (!cusip) continue;
    const putCall = (clean(r.putCallShare) || '').toLowerCase() === 'share' ? '' : clean(r.putCallShare) || '';
    const key = `${cusip}|${putCall}`;
    const prev = byKey.get(key);
    const shares = num(r.shares) || 0;
    const value = num(r.value) || 0;
    if (prev) {
      prev.shares += shares;
      prev.value += value;
    } else {
      byKey.set(key, {
        cusip,
        put_call: putCall,
        symbol: clean(r.symbol) ? clean(r.symbol).toUpperCase() : null,
        issuer: clean(r.nameOfIssuer),
        title_of_class: clean(r.titleOfClass),
        shares,
        value,
        filing_date: date(r.filingDate),
      });
    }
  }
  const list = [...byKey.values()];
  const total = list.reduce((s, h) => s + (h.put_call ? 0 : h.value), 0);
  for (const h of list) h.weight = total > 0 && !h.put_call ? h.value / total : 0;
  list.sort((a, b) => b.value - a.value);
  return { holdings: list, total };
}

// Vergelijk twee kwartalen: nieuw, verhoogd, verlaagd, verkocht.
function diffHoldings(current, previous) {
  const prev = new Map(previous.map((h) => [`${h.cusip}|${h.put_call || ''}`, h]));
  const seen = new Set();
  const out = current.map((h) => {
    const k = `${h.cusip}|${h.put_call || ''}`;
    seen.add(k);
    const p = prev.get(k);
    const prevShares = p ? Number(p.shares) : 0;
    const shares = Number(h.shares);
    let change = 'unchanged';
    if (!p) change = 'new';
    else if (shares > prevShares * 1.001) change = 'added';
    else if (shares < prevShares * 0.999) change = 'reduced';
    const changePct = p && prevShares > 0 ? (shares - prevShares) / prevShares : null;
    return { ...h, prev_shares: prevShares, change, change_pct: changePct };
  });
  const sold = previous
    .filter((h) => !seen.has(`${h.cusip}|${h.put_call || ''}`))
    .map((h) => ({ ...h, prev_shares: Number(h.shares), shares: 0, value: 0, weight: 0, change: 'sold', change_pct: -1 }));
  return { positions: out, sold };
}

// Score van een koersdoel: is de koers sinds publicatie de goede kant op gegaan?
function scoreTarget({ price_target, price_when_posted, current_price }) {
  const pt = Number(price_target);
  const p0 = Number(price_when_posted);
  const p1 = Number(current_price);
  if (!(pt > 0 && p0 > 0 && p1 > 0)) return null;
  const expected = (pt - p0) / p0;
  const realized = (p1 - p0) / p0;
  const direction = Math.sign(expected) || 1;
  return {
    expected,
    realized,
    directional: realized * direction,
    correct: realized * direction > 0,
    hit: direction > 0 ? p1 >= pt : p1 <= pt,
  };
}

module.exports = {
  splitTarget, hash, slugify, num, ts, date, clean, analystKey, mapPriceTarget, mapGrade, mapInsider, mapHoldings, diffHoldings, scoreTarget };
