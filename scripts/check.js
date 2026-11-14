'use strict';

// "Build" voor deze app: geen bundling nodig, wel controleren dat alle code laadt
// en dat de templates compileren.
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const walk = (dir, ext) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
  });

let n = 0;
for (const file of walk(path.join(root, 'src'), '.js')) {
  require(file);
  n++;
}
let v = 0;
for (const file of walk(path.join(root, 'views'), '.ejs')) {
  ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
  v++;
}
console.log(`ok: ${n} modules geladen, ${v} templates gecompileerd`);
process.exit(0);
