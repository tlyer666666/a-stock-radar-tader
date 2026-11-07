'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
// The HTML entry owns one ordered global sheet; lazy pages may ship referenced sheets.
function verifyStylesheets(files, read) {
  const html = read('dist/index.html');
  const links = (html.match(/<link\b[^>]*>/gi) || []).filter(tag => /\brel=["']stylesheet["']/i.test(tag));
  if (links.length !== 1) throw Error(`Expected one ordered main stylesheet, found ${links.length}`);
  const href = links[0].match(/\bhref=["']([^"']+)["']/i)?.[1] || '';
  const main = path.posix.normalize(path.posix.join('dist', href));
  if (!main.startsWith('dist/assets/') || !main.endsWith('.css') || !files.includes(main)) throw Error(`Missing main stylesheet: ${href}`);
  const references = new Set();
  for (const script of files.filter(file => /^dist\/assets\/.*\.js$/.test(file))) {
    for (const match of read(script).matchAll(/["']([^"'\\]+\.css)["']/g)) {
      references.add(path.posix.normalize(path.posix.join(path.posix.dirname(script), match[1])));
      references.add(path.posix.normalize(path.posix.join('dist', match[1])));
    }
  }
  for (const css of files.filter(file => /^dist\/assets\/.*\.css$/.test(file))) {
    if (css !== main && !references.has(css)) throw Error(`Unreferenced lazy stylesheet: ${css}`);
  }
}
function verifyReviewBuild(input) {
  if (input === '--packaged') {
    const product = require('../package.json').build.productName;
    const platform = process.platform === 'darwin' ? `mac${process.arch === 'arm64' ? '-arm64' : ''}` : `${process.platform === 'win32' ? 'win' : 'linux'}${process.arch === 'x64' ? '' : `-${process.arch}`}-unpacked`;
    input = path.join(root, 'release-builder', platform, process.platform === 'darwin' ? `${product}.app` : 'resources/app.asar');
  }
  let read, files;
  if (input) {
    const archive = input.endsWith('.app') ? path.join(path.resolve(input), 'Contents', 'Resources', 'app.asar') : path.resolve(input);
    const builderRequire = createRequire(require.resolve('electron-builder'));
    const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar');
    files = asar.listPackage(archive).map(file => file.replace(/^\//, ''));
    read = file => asar.extractFile(archive, file).toString();
    for (const file of ['electron/failed-board-history.cjs', 'electron/review-preload.cjs', 'electron/review-window.cjs']) if (!files.includes(file)) throw Error(`Missing packaged module: ${file}`);
  } else {
    files = fs.readdirSync(path.join(root, 'dist', 'review')).map(file => `dist/review/${file}`);
    read = file => fs.readFileSync(path.join(root, file), 'utf8');
  }
  for (const name of ['review.html', 'review-module.js', 'review-style.css']) {
    const file = `dist/review/${name}`;
    if (!files.includes(file) || !read(file).trim()) throw Error(`Missing independent review artifact: ${file}`);
  }
  const html = read('dist/review/review.html');
  if (!html.includes('./review-module.js') || !html.includes('./review-style.css') || html.includes('/src/') || html.includes('__CSP_CONNECT_SRC__')) throw Error('Review HTML must reference packaged relative assets and a resolved CSP');
  if (input) {
    verifyStylesheets(files, read);
  }
  return { passed: true, source: input || 'dist/review', reviewAssets: 3 };
}
if (require.main === module) console.log(JSON.stringify(verifyReviewBuild(process.argv[2])));
module.exports = { verifyReviewBuild, verifyStylesheets };
