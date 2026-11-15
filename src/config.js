'use strict';

const fs = require('fs');
const path = require('path');

// Lokaal: lees .env.local (geschreven door `neon env pull`/`neon deploy`) en .env.
// Op Render komen variabelen uit de omgeving en wint die altijd.
for (const name of ['.env.local', '.env']) {
  const envFile = path.join(__dirname, '..', name);
  if (!fs.existsSync(envFile)) continue;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;

module.exports = {
  port: Number(env.PORT) || 3000,
  isProd: env.NODE_ENV === 'production',
  // Pooled verbinding (Neon -pooler) voor de app zelf.
  databaseUrl: env.DATABASE_URL || '',
  // Directe verbinding voor migraties (advisory locks werken niet via de pooler).
  databaseUrlUnpooled: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || '',
  fmpKey: env.FMP_API_KEY || '',
  eodhdKey: env.EODHD_API_KEY || '',
  resendKey: env.RESEND_API_KEY || '',
  mailFrom: env.MAIL_FROM || 'Guruwatch <onboarding@resend.dev>',
  // Publiek adres voor links in e-mails (Render zet RENDER_EXTERNAL_URL zelf).
  publicUrl: env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${Number(env.PORT) || 3000}`,
  sessionSecret: env.SESSION_SECRET || 'dev-secret-change-me',
  allowedEmails: (env.ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Volledige tekst van earnings call transcripts tonen. Rogier (2026-11-15): voluit tonen, de FMP-displaylicentie
  // regelt hij bij de officiële lancering. Uitzetten kan met TRANSCRIPTS_FULL_TEXT=false.
  transcriptsFullText: (env.TRANSCRIPTS_FULL_TEXT || 'true').toLowerCase() !== 'false',
  ingestEnabled: (env.INGEST_ENABLED || 'true').toLowerCase() !== 'false',
};
