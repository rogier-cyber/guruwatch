// Community: leden geven zelf koersdoelen af en worden net als analisten beoordeeld.
'use strict';

const db = require('../db');

const HANDLE_RE = /^[a-z0-9_]{3,20}$/i;
const MAX_PER_DAY = 10;
const SAME_STOCK_DAYS = 7;
const UNDO_MINUTES = 60;
const MAX_UPSIDE = 3; // max +300% / -75%

function validHandle(h) {
  return HANDLE_RE.test(String(h || ''));
}

async function userProfile(userId) {
  return db.one('SELECT id, handle, bio FROM users WHERE id = $1', [userId]);
}

async function byHandle(handle) {
  return db.one('SELECT id, handle, bio, created_at FROM users WHERE lower(handle) = lower($1)', [handle]);
}

async function setProfile(userId, { handle, bio }) {
  const taken = await db.one('SELECT id FROM users WHERE lower(handle) = lower($1) AND id <> $2', [handle, userId]);
  if (taken) return { error: 'Deze naam is al bezet. Kies een andere.' };
  await db.query('UPDATE users SET handle = $2, bio = $3 WHERE id = $1', [userId, handle, bio || null]);
  return { ok: true };
}

// Huidige koers: eerst de actuele quote, anders de laatste slotkoers.
async function currentPrice(symbol) {
  const r = await db.one(
    `SELECT coalesce((SELECT price FROM quotes WHERE symbol = $1 AND price > 0),
                     (SELECT close FROM prices WHERE symbol = $1 ORDER BY date DESC LIMIT 1))::float8 AS price`,
    [symbol]
  );
  return r && r.price > 0 ? r.price : null;
}

/** Nieuwe voorspelling, met de spelregels. Geeft {id} of {error}. */
async function addCall(userId, { symbol, target, note }) {
  const price = await currentPrice(symbol);
  if (!price) return { error: `We hebben (nog) geen koers voor ${symbol}. Kies een Amerikaans aandeel dat we volgen.` };
  const t = Number(target);
  if (!(t > 0)) return { error: 'Vul een geldig koersdoel in.' };
  const up = t / price - 1;
  if (Math.abs(up) < 0.01) return { error: 'Je koersdoel ligt vrijwel op de huidige koers. Kies een doel dat minstens 1% afwijkt.' };
  if (up > MAX_UPSIDE || up < -0.75) return { error: 'Dat koersdoel is wel erg extreem. Houd het tussen −75% en +300% van de huidige koers.' };
  const today = await db.one(`SELECT count(*)::int AS n FROM member_calls WHERE user_id = $1 AND published_at > now() - interval '1 day'`, [userId]);
  if (today.n >= MAX_PER_DAY) return { error: `Je kunt maximaal ${MAX_PER_DAY} voorspellingen per dag doen.` };
  const recent = await db.one(
    `SELECT published_at FROM member_calls WHERE user_id = $1 AND symbol = $2 AND published_at > now() - ($3::int * interval '1 day') ORDER BY published_at DESC LIMIT 1`,
    [userId, symbol, SAME_STOCK_DAYS]
  );
  if (recent) return { error: `Je gaf deze week al een koersdoel voor ${symbol}. Een nieuw doel kan ${SAME_STOCK_DAYS} dagen na het vorige.` };
  const row = await db.one(
    `INSERT INTO member_calls (user_id, symbol, price_target, price_when_posted, note, direction)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, symbol, t, price, note ? String(note).slice(0, 280) : null, up > 0 ? 1 : -1]
  );
  await db.query('INSERT INTO symbol_sync (symbol) VALUES ($1) ON CONFLICT DO NOTHING', [symbol]).catch(() => {});
  return { id: row.id, price };
}

// Intrekken mag alleen het eerste uur (tikfout), daarna telt elke voorspelling mee.
async function withdrawCall(userId, id) {
  const r = await db.query(
    `DELETE FROM member_calls WHERE id = $1 AND user_id = $2 AND published_at > now() - ($3::int * interval '1 minute')`,
    [id, userId, UNDO_MINUTES]
  );
  return r.rowCount > 0;
}

const CALL_COLS = `mc.id, mc.symbol, mc.price_target::float8 AS target, mc.price_when_posted::float8 AS p0, mc.note, mc.published_at,
  mc.direction, mc.hit, mc.ret::float8 AS ret, mc.excess::float8 AS excess, mc.days_to_hit, mc.horizon_end, mc.complete, mc.evaluated_at,
  (SELECT c.name FROM companies c WHERE c.symbol = mc.symbol) AS name,
  coalesce((SELECT q.price FROM quotes q WHERE q.symbol = mc.symbol AND q.price > 0),
           (SELECT p.close FROM prices p WHERE p.symbol = mc.symbol ORDER BY p.date DESC LIMIT 1))::float8 AS price_now`;

// Voortgang richting het koersdoel (0 = start, 1 = doel gehaald) en rendement in de richting van de call.
function withLive(c) {
  const live = c.price_now > 0 && c.p0 > 0 ? c.direction * (c.price_now / c.p0 - 1) : null;
  const span = c.target - c.p0;
  const progress = c.price_now > 0 && span ? (c.price_now - c.p0) / span : null;
  const ageDays = Math.floor((Date.now() - new Date(c.published_at).getTime()) / 864e5);
  return { ...c, live, progress, ageDays, upside: c.p0 > 0 ? c.target / c.p0 - 1 : null };
}

async function callsForUser(userId, limit = 200) {
  const rows = await db.many(`SELECT ${CALL_COLS} FROM member_calls mc WHERE mc.user_id = $1 ORDER BY mc.published_at DESC LIMIT $2`, [userId, limit]);
  return rows.map(withLive);
}

async function recentCalls(limit = 20) {
  const rows = await db.many(
    `SELECT ${CALL_COLS}, u.handle FROM member_calls mc JOIN users u ON u.id = mc.user_id
     WHERE u.handle IS NOT NULL ORDER BY mc.published_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map(withLive);
}

// Ranglijst: GuruScore zodra er beoordeelde calls zijn, anders het live rendement.
async function leaderboard(limit = 50) {
  const rows = await db.many(
    `WITH live AS (
       SELECT mc.user_id, count(*)::int AS calls,
              avg(mc.direction * (coalesce(q.price, mc.price_when_posted) / mc.price_when_posted - 1))::float8 AS live_ret,
              avg(CASE WHEN (mc.direction > 0 AND q.price >= mc.price_target) OR (mc.direction < 0 AND q.price <= mc.price_target) THEN 1 ELSE 0 END)::float8 AS at_target,
              max(mc.published_at) AS last_at
       FROM member_calls mc LEFT JOIN quotes q ON q.symbol = mc.symbol
       GROUP BY mc.user_id
     )
     SELECT u.handle, u.bio, live.calls, live.live_ret, live.at_target, live.last_at,
            g.score::float8 AS score, g.calls AS scored_calls, g.hit_rate::float8 AS hit_rate, g.avg_excess::float8 AS avg_excess
     FROM live JOIN users u ON u.id = live.user_id
     LEFT JOIN guru_scores g ON g.kind = 'member' AND g.ref = u.id::text
     WHERE u.handle IS NOT NULL
     ORDER BY g.score DESC NULLS LAST, live.live_ret DESC NULLS LAST, live.calls DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function memberScore(userId) {
  return db.one(`SELECT score::float8 AS score, calls, hit_rate::float8 AS hit_rate, avg_excess::float8 AS avg_excess, rank FROM guru_scores WHERE kind = 'member' AND ref = $1`, [String(userId)]);
}

// Wat denken leden van één aandeel? Laatste koersdoel per lid in de afgelopen 12 maanden.
async function stockSentiment(symbol) {
  const r = await db.one(
    `WITH latest AS (
       SELECT DISTINCT ON (user_id) user_id, price_target, direction FROM member_calls
       WHERE symbol = $1 AND published_at > now() - interval '365 days'
       ORDER BY user_id, published_at DESC
     )
     SELECT count(*)::int AS members, count(*) FILTER (WHERE direction > 0)::int AS bulls,
            count(*) FILTER (WHERE direction < 0)::int AS bears, avg(price_target)::float8 AS avg_target
     FROM latest`,
    [symbol]
  );
  return r || { members: 0, bulls: 0, bears: 0, avg_target: null };
}

async function popularStocks(limit = 8) {
  return db.many(
    `SELECT mc.symbol, (SELECT c.name FROM companies c WHERE c.symbol = mc.symbol) AS name,
            count(DISTINCT mc.user_id)::int AS members,
            count(*) FILTER (WHERE mc.direction > 0)::int AS bulls, count(*) FILTER (WHERE mc.direction < 0)::int AS bears
     FROM member_calls mc WHERE mc.published_at > now() - interval '90 days'
     GROUP BY mc.symbol ORDER BY members DESC, count(*) DESC LIMIT $1`,
    [limit]
  );
}

async function totals() {
  return db.one(
    `SELECT (SELECT count(*) FROM users WHERE handle IS NOT NULL)::int AS members,
            (SELECT count(*) FROM member_calls)::int AS calls,
            (SELECT count(DISTINCT symbol) FROM member_calls)::int AS stocks`
  );
}

module.exports = {
  HANDLE_RE, MAX_PER_DAY, SAME_STOCK_DAYS, UNDO_MINUTES,
  validHandle, userProfile, byHandle, setProfile, currentPrice, addCall, withdrawCall,
  callsForUser, recentCalls, leaderboard, memberScore, stockSentiment, popularStocks, totals, withLive,
};
