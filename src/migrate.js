'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] toegepast: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migratie ${file} mislukt: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
