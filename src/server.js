'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./db');
const { migrate } = require('./migrate');
const auth = require('./auth');
const fmt = require('./lib/format');
const charts = require('./lib/charts');
const ui = require('./lib/ui');
const viz = require('./lib/vizCharts');
const pages = require('./routes/pages');
const ingest = require('./ingest');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(cookieParser());

app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'favicon.ico'), { maxAge: '7d' }));

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(auth.loadUser);

// Edge-cache (Render, instelling "All files"): openbare pagina's voor niet-ingelogde bezoekers
// 60 seconden op de CDN bewaren. Ingelogd, formulieren, persoonlijke paden en ?u=1 nooit.
// Browsers slaan de HTML niet op (max-age=0), zodat terugknop en verversen altijd vers zijn.
const EDGE_TTL = Number(process.env.EDGE_TTL || 60);
const NO_EDGE = /^\/(login|logout|uit|health|mijn|volglijst|volg|status|community\/(nieuw|voorspelling|profiel|intrekken))(\/|$)/;
app.use((req, res, next) => {
  const cacheable = (req.method === 'GET' || req.method === 'HEAD') && !req.user && req.query.u === undefined && !NO_EDGE.test(req.path) && EDGE_TTL > 0;
  res.set('Cache-Control', cacheable ? `public, max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=60` : 'private, no-store');
  next();
});
app.use((req, res, next) => {
  res.locals.fmt = fmt;
  res.locals.charts = charts;
  res.locals.ui = ui;
  res.locals.viz = viz;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.title = 'Guruwatch';
  next();
});

// Eenvoudige CSRF-bescherming voor formulieren: alleen POSTs van onze eigen origin.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin') || req.get('referer') || '';
  const host = req.get('host');
  if (origin && host && !origin.replace(/^https?:\/\//, '').startsWith(host)) return res.status(403).send('Ongeldige herkomst');
  next();
});

// ---------- Inloggen ----------
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', { title: 'Inloggen', step: 'email', email: '', next: safeNext(req.query.next), error: null });
});

app.post('/login', async (req, res, next) => {
  try {
    const nextUrl = safeNext(req.body.next);
    const r = await auth.requestCode(req.body.email);
    if (!r.ok) return res.status(400).render('login', { title: 'Inloggen', step: 'email', email: req.body.email || '', next: nextUrl, error: r.error });
    res.render('login', { title: 'Inloggen', step: 'code', email: r.email, next: nextUrl, error: null });
  } catch (err) {
    console.error('[auth] code versturen mislukt', err.message);
    res.status(500).render('login', { title: 'Inloggen', step: 'email', email: req.body.email || '', next: safeNext(req.body.next), error: 'De mail kon niet worden verstuurd. Probeer het later opnieuw.' });
  }
});

app.post('/login/code', async (req, res, next) => {
  try {
    const nextUrl = safeNext(req.body.next);
    const r = await auth.verifyCode(req.body.email, req.body.code);
    if (!r.ok) return res.status(400).render('login', { title: 'Inloggen', step: 'code', email: req.body.email || '', next: nextUrl, error: r.error });
    auth.setSessionCookie(res, r.token);
    res.redirect(nextUrl);
  } catch (err) {
    next(err);
  }
});

app.post('/logout', async (req, res) => {
  await auth.logout(req, res);
  res.redirect('/login');
});

// Afmelden voor e-mails via de link in de mail (zonder inloggen, met ondertekende link).
app.get('/uit', async (req, res, next) => {
  try {
    const alerts = require('./alerts');
    const userId = Number(req.query.u);
    if (!userId || !alerts.checkUnsub(userId, req.query.t)) return res.status(400).render('error', { title: 'Ongeldige link', message: 'Deze afmeldlink klopt niet.' });
    await db.query('UPDATE user_settings SET briefing = false, instant_email = false, weekly = false WHERE user_id = $1', [userId]);
    res.render('error', { title: 'Afgemeld', message: 'Je krijgt geen e-mails meer van Guruwatch. Je kunt dit altijd weer aanzetten onder Mijn GuruWatch, Meldingen.' });
  } catch (err) {
    next(err);
  }
});

// De hele site is openbaar; alleen persoonlijke functies (volglijst, meldingen,
// eigen voorspellingen, status) vragen om in te loggen.
const PRIVATE = /^\/(mijn|volglijst|volg|status|community\/(nieuw|voorspelling|profiel|intrekken))(\/|$)/;
app.use(pages.publicRouter);
// Niet ingelogd op Mijn GuruWatch: uitleg wat een account oplevert, met direct aanmelden.
app.get('/mijn', (req, res, next) => {
  if (req.user) return next();
  const nextUrl = safeNext(req.query.next);
  res.render('join', { title: 'Mijn GuruWatch: gratis account', next: nextUrl === '/' ? '/mijn' : nextUrl, seo: { description: 'Maak gratis een Guruwatch-account: volg aandelen, analisten, guru\'s en insiders, krijg meldingen en op zaterdag een weekoverzicht.' } });
});
app.use((req, res, next) => (PRIVATE.test(req.path) ? auth.requireUser(req, res, next) : next()), pages);

app.use((req, res) => res.status(404).render('error', { title: 'Niet gevonden', message: 'Deze pagina bestaat niet.' }));

app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.set('Cache-Control', 'private, no-store');
  res.status(500).render('error', { title: 'Er ging iets mis', message: config.isProd ? 'Er ging iets mis. Probeer het zo opnieuw.' : err.message });
});

async function start() {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL ontbreekt. Zet deze in de omgevingsvariabelen.');
    process.exit(1);
  }
  await migrate();
  if (!config.fmpKey) console.warn('[start] FMP_API_KEY ontbreekt: er wordt geen data opgehaald.');
  if (config.ingestEnabled && config.fmpKey) ingest.startScheduler();
  setInterval(() => auth.cleanup().catch(() => {}), 6 * 3600 * 1000);
  app.listen(config.port, () => console.log(`Guruwatch draait op poort ${config.port}`));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Opstarten mislukt:', err);
    process.exit(1);
  });
}

module.exports = { app };
