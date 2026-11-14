'use strict';

const fs = require('fs');
const path = require('path');

// Lokaal: lees .env als die bestaat (op Render komen variabelen uit de omgeving).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;

module.exports = {
  port: Number(env.PORT) || 3000,
  isProd: env.NODE_ENV === 'production',
  databaseUrl: env.DATABASE_URL || '',
  fmpKey: env.FMP_API_KEY || '',
  eodhdKey: env.EODHD_API_KEY || '',
  resendKey: env.RESEND_API_KEY || '',
  mailFrom: env.MAIL_FROM || 'Guruwatch <onboarding@resend.dev>',
  sessionSecret: env.SESSION_SECRET || 'dev-secret-change-me',
  allowedEmails: (env.ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  ingestEnabled: (env.INGEST_ENABLED || 'true').toLowerCase() !== 'false',
};
