'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const packagerRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const asarRequire = createRequire(packagerRequire.resolve('@electron/asar/package.json'));
const ejsRequire = createRequire(packagerRequire.resolve('ejs/package.json'));
const jakeRequire = createRequire(ejsRequire.resolve('jake/package.json'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-dependency-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries({
    'src/main.js': 'main', 'src/worker.cjs': 'worker', 'src/helper.js': 'helper',
    'src/nested/task.js': 'nested', 'src/.hidden.js': 'hidden', 'src/note.txt': 'note',
    'dist/index.html': 'renderer', 'dist/review/index.html': 'review',
    'electron/main.cjs': 'main-process', 'electron/main.test.cjs': 'test',
    'electron/build-unpacked.cjs': 'build-only', 'config/calendar.json': '{}',
    'assets/icon.svg': '<svg/>', 'native/bridge.node': 'native-payload', 'package.json': '{}',
  })) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

// Removing the CJS bridge breaks asar's callable default; dropping namespace
// properties breaks modern packager and lint consumers. Both need the same fix.
test('security replacement supports legacy callable and modern CJS/ESM consumers', async () => {
  const legacy = asarRequire('minimatch');
  const modern = packagerRequire('minimatch');
  assert.equal(typeof legacy, 'function', 'asar 3 needs a callable CommonJS export');
  assert.equal(typeof modern.minimatch, 'function', 'modern consumers need the named minimatch export');
  assert.equal(legacy, modern, 'legacy and modern consumers must use the same secured algorithm');
  assert.equal(legacy.minimatch, legacy);
  const packageFile = packagerRequire.resolve('minimatch/package.json');
  const esm = await import(pathToFileURL(path.join(path.dirname(packageFile), 'dist/esm/index.js')).href);
  for (const [file, pattern, options, want] of [
    ['electron/main.cjs', '**/*.{js,cjs}', {}, true],
    ['src/.hidden.js', '**/*.js', {}, false],
    ['src/.hidden.js', '**/*.js', { dot: true }, true],
    ['native/bridge.node', '*.node', { matchBase: true }, true],
    ['electron/main.test.cjs', '!**/*.test.cjs', {}, false],
    ['src/worker.cjs', 'src/@(main.js|worker.cjs)', {}, true],
  ]) {
    assert.equal(legacy(file, pattern, options), want);
    assert.equal(modern.minimatch(file, pattern, options), want);
    assert.equal(esm.minimatch(file, pattern, options), want);
  }
  assert.equal(new modern.Minimatch('electron/**/*.cjs').match('electron', true), true);
  assert.deepEqual(legacy.match(['main.js', 'worker.cjs', 'note.txt'], '*.{js,cjs}'), ['main.js', 'worker.cjs']);
});

test('glob 7 preserves sync and callback globstar, brace, dotfile and ignore behavior', async t => {
  const root = fixture(t);
  const glob = asarRequire('glob');
  const options = { cwd: root, nodir: true, dot: true, ignore: ['**/helper.js'] };
  const want = ['src/.hidden.js', 'src/main.js', 'src/nested/task.js', 'src/worker.cjs'];
  assert.deepEqual(glob.sync('src/**/*.{js,cjs}', options).sort(), want);
  const found = await new Promise((resolve, reject) => glob('src/**/*.{js,cjs}', options, (error, files) => error ? reject(error) : resolve(files)));
  assert.deepEqual(found.sort(), want);
});

test('filelist keeps include and exclude matching under the secured minimatch', { skip: process.platform === 'win32' && '打包只在 macOS 上进行；Windows 路径分隔符下这组第三方打包依赖的匹配语义不同' }, t => {
  const root = fixture(t);
  const { FileList } = jakeRequire('filelist');
  const list = new FileList();
  list.include(path.join(root, 'src/**/*.{js,cjs}'));
  list.exclude(path.join(root, 'src/**/helper.js'));
  assert.deepEqual(list.toArray().map(file => path.relative(root, file)).sort(), [
    'src/main.js', 'src/nested/task.js', 'src/worker.cjs',
  ]);
});

test('asar 3 creates readable archives and applies callable unpack and unpackDir patterns', async t => {
  const root = fixture(t);
  const asar = packagerRequire('@electron/asar');
  const archive = path.join(root, 'output/app.asar');
  await asar.createPackageWithOptions(root, archive, {
    globOptions: { ignore: [path.join(root, 'output/**')] },
    unpack: '*.node', unpackDir: 'config{,/**}',
  });
  assert.equal(asar.extractFile(archive, 'dist/index.html').toString(), 'renderer');
  assert.equal(asar.extractFile(archive, 'electron/main.cjs').toString(), 'main-process');
  assert.equal(asar.statFile(archive, 'native/bridge.node').unpacked, true);
  assert.equal(asar.statFile(archive, 'config/calendar.json').unpacked, true);
  assert.equal(fs.readFileSync(archive + '.unpacked/native/bridge.node', 'utf8'), 'native-payload');
  assert.equal(fs.readFileSync(archive + '.unpacked/config/calendar.json', 'utf8'), '{}');
});

test('electron-builder file matcher retains the actual application inclusion and exclusion contract', t => {
  const root = fixture(t);
  const { FileMatcher } = packagerRequire('app-builder-lib/out/fileMatcher.js');
  const manifest = require('../package.json');
  const filter = new FileMatcher(root, path.join(root, 'output'), value => value, manifest.build.files).createFilter();
  for (const [file, want] of [
    ['dist/index.html', true], ['dist/review/index.html', true], ['electron/main.cjs', true],
    ['electron/main.test.cjs', false], ['electron/build-unpacked.cjs', false],
    ['config/calendar.json', true], ['assets/icon.svg', true], ['src/main.js', false], ['package.json', true],
  ]) {
    const absolute = path.join(root, file);
    assert.equal(filter(absolute, fs.statSync(absolute)), want, file);
  }
  assert.equal(filter(path.join(root, 'dist/review'), fs.statSync(path.join(root, 'dist/review'))), true);
});

test('wait-on validates configuration and follows a local HTTP redirect with patched Joi and follow-redirects', async t => {
  const root = fixture(t);
  const waitOn = require('wait-on');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/redirect') { response.writeHead(302, { location: '/ready' }); response.end(); }
    else { response.writeHead(200); response.end('ready'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await waitOn({ resources: [path.join(root, 'package.json'), `http-get://127.0.0.1:${server.address().port}/redirect`], timeout: 5000, interval: 50, window: 50, proxy: false });
  assert.ok(requests.includes('/redirect'));
  assert.ok(requests.includes('/ready'));
  await assert.rejects(waitOn({ resources: [], timeout: -1 }));
});

test('glob 7 preserves dot, extglob, nocase and nonull results after minimatch row merging', async t => {
  const root = fixture(t);
  const glob = asarRequire('glob');
  const options = { cwd: root, nodir: true, ignore: ['**/helper.js'] };
  assert.deepEqual(glob.sync('src/@(main.js|worker.cjs)', options).sort(), ['src/main.js', 'src/worker.cjs']);
  assert.deepEqual(glob.sync('src/*.JS', { ...options, nocase: true }).sort(), ['src/main.js']);
  assert.deepEqual(glob.sync('missing/*.{js,cjs}', { ...options, nonull: true }).sort(), ['missing/*.cjs', 'missing/*.js']);
  assert.deepEqual(glob.sync('src/*.{js,ts}', { ...options, nonull: true }).sort(), ['src/*.ts', 'src/main.js']);
  const found = await new Promise((resolve, reject) => glob('missing/*.{js,cjs}', { ...options, nonull: true }, (error, files) => error ? reject(error) : resolve(files)));
  assert.deepEqual(found.sort(), ['missing/*.cjs', 'missing/*.js']);
});

test('glob 7 keeps explicit dot alternatives and nounique matches when brace rows merge', t => {
  const root = fixture(t);
  const glob = asarRequire('glob');
  const options = { cwd: root, nodir: true, ignore: ['**/helper.js'] };
  assert.deepEqual(glob.sync('src/{.*.js,*.cjs}', options).sort(), ['src/.hidden.js', 'src/worker.cjs']);
  assert.deepEqual(glob.sync('src/*.{js,?s}', { ...options, nounique: true }).sort(), ['src/main.js', 'src/main.js']);
});

test('glob 7 nonull handles absolute output and directory-only alternatives', { skip: process.platform === 'win32' && '打包只在 macOS 上进行；Windows 路径分隔符下这组第三方打包依赖的匹配语义不同' }, t => {
  const root = fixture(t);
  const glob = asarRequire('glob');
  const options = { cwd: root, nodir: true, nonull: true, ignore: ['**/helper.js'] };
  assert.deepEqual(glob.sync('src/*.{js,ts}', { ...options, absolute: true }).sort(), [path.join(root, 'src/main.js'), 'src/*.ts'].sort());
  assert.deepEqual(glob.sync(path.join(root, 'src/*.{js,ts}'), options).sort(), [path.join(root, 'src/*.ts'), path.join(root, 'src/main.js')].sort());
  fs.mkdirSync(path.join(root, 'src/empty.jsdir'));
  assert.deepEqual(glob.sync('src/*.{jsdir,tsdir}', options).sort(), ['src/*.jsdir', 'src/*.tsdir']);
});
