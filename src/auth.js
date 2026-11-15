'use strict';

// Inloggen met een eenmalige code per e-mail (via Resend).
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const COOKIE = 'gw_session';
const SESSION_DAYS = 90; // blijft ingelogd; elke week gebruik verlengt dit weer
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;

const sha = (s) => crypto.createHmac('sha256', config.sessionSecret).update(String(s)).digest('hex');

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

function isAllowed(email) {
  return !config.allowedEmails.length || config.allowedEmails.includes(email);
}

async function sendMail(to, subject, text, html) {
  if (!config.resendKey) {
    // Lokaal zonder Resend: code in de log zetten.
    console.log(`[mail] (geen RESEND_API_KEY) aan ${to}: ${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function requestCode(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: 'Vul een geldig e-mailadres in.' };
  if (!isAllowed(email)) return { ok: false, error: 'Dit e-mailadres heeft (nog) geen toegang.' };

  const recent = await db.one(
    "SELECT count(*)::int AS n FROM login_codes WHERE email = $1 AND created_at > now() - interval '15 minutes'",
    [email]
  );
  if (recent.n >= 5) return { ok: false, error: 'Te veel codes aangevraagd. Probeer het over een kwartier opnieuw.' };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query(
    `INSERT INTO login_codes (email, code_hash, expires_at) VALUES ($1, $2, now() + interval '${CODE_MINUTES} minutes')`,
    [email, sha(`${email}:${code}`)]
  );
  await sendMail(
    email,
    `Je Guruwatch-inlogcode: ${code}`,
    `Je inlogcode voor Guruwatch is ${code}. De code is ${CODE_MINUTES} minuten geldig.`,
    `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#111">
       <p>Je inlogcode voor Guruwatch:</p>
       <p style="font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>
       <p style="color:#666">De code is ${CODE_MINUTES} minuten geldig. Heb je niets aangevraagd? Dan kun je deze mail negeren.</p>
     </div>`
  );
  return { ok: true, email };
}

async function verifyCode(rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || '').replace(/\D/g, '');
  if (!email || code.length !== 6) return { ok: false, error: 'Vul de 6-cijferige code in.' };

  const row = await db.one(
    `SELECT id, code_hash, attempts FROM login_codes
     WHERE email = $1 AND used_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  if (!row) return { ok: false, error: 'Code verlopen. Vraag een nieuwe code aan.' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Te veel pogingen. Vraag een nieuwe code aan.' };

  const expected = Buffer.from(row.code_hash);
  const given = Buffer.from(sha(`${email}:${code}`));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    await db.query('UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    return { ok: false, error: 'Onjuiste code.' };
  }

  await db.query('UPDATE login_codes SET used_at = now() WHERE id = $1', [row.id]);
  const user = await db.one(
    `INSERT INTO users (email, last_login_at) VALUES ($1, now())
     ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id, email`,
    [email]
  );
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha(token), user.id]
  );
  return { ok: true, token, user };
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    path: '/',
  });
}

async function loadUser(req, res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    try {
      req.user = await db.one(
        `SELECT u.id, u.email, (s.expires_at < now() + interval '${SESSION_DAYS - 7} days') AS renew FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [sha(token)]
      );
      // Sessie verlengen als hij ouder is dan een week: wie de site gebruikt, blijft ingelogd.
      if (req.user && req.user.renew) {
        await db.query(`UPDATE sessions SET expires_at = now() + interval '${SESSION_DAYS} days' WHERE token_hash = $1`, [sha(token)]);
        setSessionCookie(res, token);
      }
      if (req.user) delete req.user.renew;
    } catch (err) {
      console.error('[auth] sessie laden mislukt', err.message);
    }
  }
  res.locals.user = req.user;
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  const back = encodeURIComponent(req.originalUrl || '/');
  // Niet ingelogd: eerst uitleg wat een account oplevert, daarna terug naar wat je wilde doen.
  return res.redirect(`/mijn?next=${back}`);
}

async function logout(req, res) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]).catch(() => {});
  res.clearCookie(COOKIE, { path: '/' });
}

async function cleanup() {
  await db.query("DELETE FROM login_codes WHERE created_at < now() - interval '1 day'");
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
}

module.exports = { sendMail, requestCode, verifyCode, setSessionCookie, loadUser, requireUser, logout, cleanup, normalizeEmail };
