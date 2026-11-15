'use strict';

// Eigen logo's (public/logos/US/<TICKER>.webp, 64px), aangeleverd vanuit Yieldmatrix.
// Ontbreekt een logo, dan vallen we terug op EODHD.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'public', 'logos', 'US');
let have = new Set();
try {
  have = new Set(fs.readdirSync(DIR).filter((f) => f.endsWith('.webp')).map((f) => f.slice(0, -5)));
} catch (err) {
  have = new Set();
}

const external = (s) => `https://eodhd.com/img/logos/US/${encodeURIComponent(s)}.png`;

function logoUrl(symbol) {
  const s = String(symbol || '').toUpperCase();
  return have.has(s) ? `/static/logos/US/${encodeURIComponent(s)}.webp` : external(s);
}

module.exports = { logoUrl, hasLogo: (s) => have.has(String(s || '').toUpperCase()), count: () => have.size };
