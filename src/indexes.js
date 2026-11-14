'use strict';

// Achtergrondtaak: samenstelling van de Amerikaanse indices bijhouden.
const db = require('./db');
const fmp = require('./lib/fmp');
const { ALL } = require('./lib/indexes');

async function refreshIndexes() {
  const out = {};
  for (const idx of ALL.filter((i) => i.endpoint)) {
    const rows = (await fmp.indexConstituentsNoCache(idx.endpoint))
      .filter((r) => r && r.symbol && /^[A-Z0-9.\-]{1,12}$/.test(r.symbol));
    // Een leeg of half antwoord laat de bestaande lijst staan.
    if (rows.length < 20) { out[idx.key] = `overgeslagen (${rows.length})`; continue; }
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM index_members WHERE index_key = $1', [idx.key]);
      const values = [];
      const ph = rows.map((r, k) => {
        values.push(idx.key, r.symbol, r.name || null, r.sector || null);
        return `($${k * 4 + 1}, $${k * 4 + 2}, $${k * 4 + 3}, $${k * 4 + 4})`;
      });
      await client.query(`INSERT INTO index_members (index_key, symbol, name, sector) VALUES ${ph.join(',')} ON CONFLICT DO NOTHING`, values);
      await client.query('COMMIT');
      out[idx.key] = rows.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  // Nieuwe symbolen meenemen in koersen, koersdoel-historie en adviesverdeling.
  await db.query('INSERT INTO symbol_sync (symbol) SELECT DISTINCT symbol FROM index_members ON CONFLICT DO NOTHING');
  return out;
}

module.exports = { refreshIndexes };
