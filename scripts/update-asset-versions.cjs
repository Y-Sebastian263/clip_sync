// Development helper only; the deployed site remains static and build-free.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
for (const file of ['app.js', 'styles.css']) {
  const hash = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 12);
  const pattern = new RegExp(`"${file.replace('.', '\\.')}([?]v=[^"\\s]+)?"`, 'g');
  html = html.replace(pattern, `"${file}?v=${hash}"`);
}
fs.writeFileSync(htmlPath, html);
