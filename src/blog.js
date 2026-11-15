'use strict';

// Blog: de laatste artikelen van de oude guruwatch.nl overnemen in onze eigen opmaak.
// Elke paar uur opgehaald en in de database bewaard; lukt het niet, dan blijven de vorige versies staan.
const db = require('./db');
const bp = require('./lib/blogParse');

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; Guruwatch)' };
const get = async (url) => {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} voor ${url}`);
  return res.text();
};

async function refreshBlog({ max = 10 } = {}) {
  const links = bp.listLinks(await get(`${bp.BASE}/Columns/Default.aspx`), max);
  if (!links.length) throw new Error('geen blogartikelen gevonden');
  const known = await db.many('SELECT id, slug FROM blog_posts');
  const linkMap = new Map([...known.map((r) => [r.id, r.slug]), ...links.map((l) => [l.id, l.slug])]);
  const out = { found: links.length, saved: 0, errors: [] };
  for (const l of links) {
    try {
      const a = bp.parseArticle(await get(l.url), linkMap);
      await db.query(
        `INSERT INTO blog_posts (id, slug, title, category, published_at, image, intro, blocks, source_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, title = EXCLUDED.title, category = EXCLUDED.category, published_at = EXCLUDED.published_at,
           image = EXCLUDED.image, intro = EXCLUDED.intro, blocks = EXCLUDED.blocks, source_url = EXCLUDED.source_url, fetched_at = now()`,
        [l.id, l.slug, a.title, a.category, a.published_at, a.image, a.intro, JSON.stringify(a.blocks), l.url]
      );
      out.saved++;
    } catch (err) {
      out.errors.push(`${l.id}: ${err.message}`);
    }
  }
  return out;
}

async function latest(limit = 10) {
  return db.many('SELECT id, slug, title, category, published_at, image, intro FROM blog_posts ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $1', [limit]);
}

async function bySlug(slug) {
  return db.one('SELECT * FROM blog_posts WHERE slug = $1', [slug]);
}

module.exports = { refreshBlog, latest, bySlug };
