'use strict';

// Blogartikelen van de oude guruwatch.nl omzetten naar eigen blokken (zonder netwerk, dus te testen).
// Alleen veilige opmaak blijft over: vet, cursief, links en regeleindes.
const BASE = 'https://www.guruwatch.nl';
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

const decode = (s) => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
  .replace(/&ldquo;|&rdquo;/g, '"').replace(/&euro;/g, '€').replace(/&hellip;/g, '…').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const text = (html) => decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Links in de lijst (nieuwste eerst): [{id, slug, url}].
function listLinks(html, max = 10) {
  const out = [];
  const seen = new Set();
  const re = /\/Columns\/(\d+)\/([A-Za-z0-9-]+)\.aspx/g;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: Number(m[1]), slug: m[2].toLowerCase(), url: `${BASE}/Columns/${m[1]}/${m[2]}.aspx` });
  }
  return out;
}

// "13 november 2026 - 08:35u" -> Date (Nederlandse tijd).
function parseDate(s) {
  const m = String(s).match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})(?:\s*-\s*(\d{1,2}):(\d{2}))?/i);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2].toLowerCase());
  if (mo < 0) return null;
  const iso = `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}T${(m[4] || '12').padStart(2, '0')}:${m[5] || '00'}:00`;
  // Nederland: winter +01:00, zomer +02:00 (ruwe regel: april t/m oktober).
  const tz = mo >= 3 && mo <= 9 ? '+02:00' : '+01:00';
  const d = new Date(iso + tz);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Inline-HTML opschonen. linkMap: oud artikel-id -> eigen slug (alleen artikelen die wij ook hebben).
function inline(html, linkMap) {
  let s = String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const tags = [];
  const tok = (t) => `\u0001${tags.push(t) - 1}\u0002`;
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const own = href.match(/Columns\/(\d+)\//) || href.match(/^\.\.\/(\d+)\//);
    if (own) {
      const slug = linkMap.get(Number(own[1]));
      return slug ? `${tok(`<a href="/blog/${esc(slug)}">`)}${inner}${tok('</a>')}` : inner;
    }
    if (/^https?:\/\//i.test(href)) return `${tok(`<a href="${esc(decode(href))}" target="_blank" rel="noopener nofollow">`)}${inner}${tok('</a>')}`;
    return inner;
  });
  s = s.replace(/<\s*(strong|b)\b[^>]*>/gi, () => tok('<strong>')).replace(/<\s*\/\s*(strong|b)\s*>/gi, () => tok('</strong>'))
    .replace(/<\s*(em|i)\b[^>]*>/gi, () => tok('<em>')).replace(/<\s*\/\s*(em|i)\s*>/gi, () => tok('</em>'))
    .replace(/<br\s*\/?>/gi, () => tok('<br>'));
  s = s.replace(/<[^>]+>/g, '');
  s = esc(decode(s)).replace(/\u0001(\d+)\u0002/g, (_, i) => tags[Number(i)]);
  return s.replace(/\s+/g, ' ').replace(/<strong>\s*<\/strong>|<em>\s*<\/em>/g, '').trim();
}

// Eén artikelpagina -> {title, category, published_at, image, blocks, intro}.
function parseArticle(html, linkMap = new Map()) {
  const start = html.indexOf('class="LeftContent1"');
  if (start < 0) throw new Error('artikel niet gevonden');
  let end = html.indexOf('class="RightContent1"', start);
  if (end < 0) end = html.length;
  const body = html.slice(start, end);
  const title = text((body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const sub = (body.match(/<p class="SubLine"[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
  const category = text((sub.match(/class="category"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '') || null;
  const published = parseDate(text(sub));
  const imgM = body.match(/<figure class="ColumnImage"[\s\S]*?<img[^>]*src="([^"]+)"/i);
  const image = imgM && /^https:\/\//.test(imgM[1]) ? imgM[1] : null;

  const rest = body.replace(/<h1[\s\S]*?<\/h1>/i, '').replace(/<p class="SubLine"[\s\S]*?<\/p>/i, '').replace(/<figure class="ColumnImage"[\s\S]*?<\/figure>/i, '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const blocks = [];
  const re = /<(p|h2|h3|h4|ul|ol|blockquote|figure|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(rest))) {
    const tag = m[1].toLowerCase();
    const inner = m[2];
    if (tag === 'p') {
      const raw = text(inner);
      if (!raw) continue;
      // "Lees ook"-verwijzingen naar artikelen die wij niet hebben weglaten.
      const x = inline(inner, linkMap);
      if (/^lees ook/i.test(raw) && !/href="\/blog\//.test(x)) continue;
      blocks.push({ t: /^lees ook/i.test(raw) ? 'also' : 'p', h: x });
    } else if (tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const x = inline(inner, linkMap);
      if (text(inner)) blocks.push({ t: tag === 'h4' ? 'h3' : 'h2', h: x });
    } else if (tag === 'ul' || tag === 'ol') {
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => inline(li[1], linkMap)).filter(Boolean);
      if (items.length) blocks.push({ t: tag, items });
    } else if (tag === 'blockquote') {
      const x = inline(inner, linkMap);
      if (x) blocks.push({ t: 'quote', h: x });
    } else if (tag === 'figure') {
      const src = (inner.match(/<img[^>]*src="(https:[^"]+)"/i) || [])[1];
      if (src) blocks.push({ t: 'img', src, cap: text((inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i) || [])[1] || '') });
    } else if (tag === 'table') {
      const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => inline(c[1], linkMap)));
      if (rows.length) blocks.push({ t: 'table', rows });
    }
  }
  if (!title || blocks.filter((b) => b.t === 'p').length < 2) throw new Error(`te weinig tekst in "${title}"`);
  const first = blocks.find((b) => b.t === 'p');
  const intro = text(first.h).slice(0, 320);
  return { title, category, published_at: published, image, blocks, intro };
}

module.exports = { listLinks, parseArticle, parseDate, inline, text, BASE };
