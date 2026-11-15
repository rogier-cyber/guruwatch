'use strict';

// Zet een HTML-pagina van IEX Media om naar platte tekst in alinea's (zonder HTML, dus veilig om te tonen).
// start/end: tekst waarmee de inhoud begint en vóór welke tekst die ophoudt.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euml: 'ë', eacute: 'é', egrave: 'è', iuml: 'ï', ouml: 'ö', uuml: 'ü', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', copy: '©', euro: '€', bull: '•', agrave: 'à', aacute: 'á', ccedil: 'ç' };

function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  return decode(String(html).replace(/\r/g, '')
    .replace(/<(script|style|noscript|svg|head|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote)>/gi, '\n\n')
    .replace(/<(li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Kopje: "2. Gebruik van de dienst", "Wijzigingen" (kort, zonder leestekens aan het eind, geen adres of e-mail).
function isHead(l) {
  return l.length < 60 && /^(\d+\.\s+)?[A-Z]/.test(l) && !/[.;:,]$/.test(l) && !/[:@]|\d{4}|B\.V\./.test(l) && !/^\d+\s/.test(l);
}

// Alinea's: [{ head: bool, lines: [..] }]. Een kopje is een korte regel als "2. Gebruik van de dienst".
function extract(html, { start, end, replace = [] } = {}) {
  let t = htmlToText(html);
  if (start) { const i = t.indexOf(start); if (i < 0) return null; t = t.slice(i); }
  if (end) { const j = t.indexOf(end); if (j > 0) t = t.slice(0, j); }
  for (const [a, b] of replace) t = t.replace(a, b);
  const paras = t.trim().split(/\n\n+/).map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean)).filter((l) => l.length);
  return paras.map((lines) => ({ lines, head: lines.length === 1 && isHead(lines[0]) }));
}

module.exports = { htmlToText, extract, decode, isHead };
