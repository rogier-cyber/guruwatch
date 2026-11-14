'use strict';

const { Pool } = require('pg');
const config = require('./config');

function sslFor(url) {
  if (!url) return false;
  if (/localhost|127\.0\.0\.1/.test(url) && !/sslmode=require/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: sslFor(config.databaseUrl),
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

async function query(text, params) {
  return pool.query(text, params);
}

async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

module.exports = { pool, query, one, many };
