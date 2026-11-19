'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createReviewWindowManager } = require('./review-window.cjs');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function fixture(options = {}) {
  const windows = [];
  class Window extends EventEmitter {
    constructor(config) { super(); this.config = config; this.webContents = new EventEmitter(); this.webContents.isDestroyed = () => this.destroyed; this.webContents.setWindowOpenHandler = value => { this.popup = value; }; windows.push(this); }
    isDestroyed() { return !!this.destroyed; }
    isMinimized() { return false; }
    show() {} focus() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
    loadFile(file) { this.file = file; return options.load?.() || Promise.resolve(); }
  }
  const manager = createReviewWindowManager({ BrowserWindow: Window, root: '/tmp/review-fixture', packaged: true, devUrl: 'http://127.0.0.1:5173', openExternal: () => Promise.resolve(), ...options });
  return { manager, windows };
}
test('review opens once, loads the packaged HTML, and releases its trusted sender on close', async () => {
  const { manager, windows } = fixture();
  const first = manager.open(); assert.equal(manager.open(), first); await first;
  assert.equal(windows.length, 1); assert.match(windows[0].file, /dist[\\/]review[\\/]review\.html$/);
  assert.equal(windows[0].config.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].config.webPreferences.sandbox, true);
  assert.equal(manager.getWebContents(), windows[0].webContents);
  windows[0].destroy(); assert.equal(manager.getWebContents(), undefined);
  await manager.open(); assert.equal(windows.length, 2);
});
test('failed review loading destroys the incomplete window and permits a retry', async () => {
  let count = 0;
  const { manager, windows } = fixture({ load: () => ++count === 1 ? Promise.reject(Error('missing assets')) : Promise.resolve() });
  await assert.rejects(manager.open(), /missing assets/); assert.equal(windows[0].isDestroyed(), true);
  assert.equal(manager.getWebContents(), undefined); await manager.open(); assert.equal(windows.length, 2);
});
test('review rejects local navigation and catches an external opener throwing synchronously', async () => {
  const errors = [];
  const { manager, windows } = fixture({ openExternal() { throw Error('opener failed'); }, onError: error => errors.push(error.message) });
  await manager.open(); const window = windows[0]; let prevented = false;
  window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'file:///etc/passwd');
  assert.equal(prevented, true);
  assert.doesNotThrow(() => window.popup({ url: 'https://example.com/' }));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(errors, ['opener failed']);
});

test('independent review preload exposes only the review read capabilities', async () => {
  let exposed; const calls = []; const listeners = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'review-preload.cjs'), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { exposed = value; } }, ipcRenderer: {
    invoke(channel, ...args) { calls.push([channel, ...args]); return Promise.resolve({ok:true,value:null}); },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); }
  } }) });
  assert.deepEqual(Object.keys(exposed).sort(), ['analyze', 'getProfessionalReview', 'getReviewTheme', 'onThemeChange', 'search']);
  await exposed.search('600000'); await exposed.analyze({ code: '600000' }); await exposed.getProfessionalReview({ refresh: true }); await exposed.getReviewTheme();
  assert.deepEqual(calls.map(row => row[0]), ['review-window:search', 'review-window:analyze', 'review-window:market', 'review-window:theme']);
  // 主题推送：只订阅主进程通道，且退订后不再回调。
  const themes = []; const off = exposed.onThemeChange(theme => themes.push(theme));
  listeners.get('review-window:theme-changed')({}, 'dark');
  off();
  assert.deepEqual(themes, ['dark']);
  assert.equal(listeners.has('review-window:theme-changed'), false);
});

test('review window persists/restores clamped bounds, applies zoom factor, and enforces canOpen guard', async (t) => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-bounds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boundsPath = path.join(dir, 'review-bounds.json');

  // Pre-seed out-of-range bounds to verify clamping on restore
  fs.writeFileSync(boundsPath, JSON.stringify({ x: 9999, y: -200, width: 3000, height: 2000 }));

  let allowed = false;
  const zooms = [];
  const windows = [];
  class BoundsWindow extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.bounds = { x: config.x ?? 0, y: config.y ?? 0, width: config.width, height: config.height };
      this.webContents = new EventEmitter();
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.setZoomFactor = (factor) => zooms.push(factor);
      windows.push(this);
    }
    isDestroyed() { return !!this.destroyed; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    getBounds() { return this.bounds; }
    show() {}
    focus() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
    loadFile() { return Promise.resolve(); }
  }

  const fakeScreen = {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 }, workAreaSize: { width: 1440, height: 900 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 }, workAreaSize: { width: 1440, height: 900 } })
  };
  const manager = createReviewWindowManager({
    BrowserWindow: BoundsWindow,
    screen: fakeScreen,
    root: '/tmp/review-fixture',
    packaged: true,
    devUrl: 'http://127.0.0.1:5173',
    openExternal: () => Promise.resolve(),
    boundsPath,
    canOpen: () => allowed
  });

  // canOpen() === false rejects open()
  await assert.rejects(() => manager.open(), { code: 'REVIEW_WINDOW_BLOCKED' });
  assert.equal(windows.length, 0);

  // Set zoom before open, then allow open and verify clamped restore + zoom
  assert.equal(manager.setZoomFactor(1.25), true);
  assert.equal(manager.setZoomFactor(Number.NaN), false);
  allowed = true;
  await manager.open();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].config.width, 1440);
  assert.equal(windows[0].config.height, 900);
  assert.equal(windows[0].config.x, 0);
  assert.equal(windows[0].config.y, 0);
  assert.ok(zooms.includes(1.25));

  // Runtime setZoomFactor applies immediately
  manager.setZoomFactor(1.5);
  assert.equal(zooms.at(-1), 1.5);

  // Debounced resize/move persists clamped bounds
  windows[0].bounds = { x: 100, y: 80, width: 1000, height: 700 };
  windows[0].emit('resize');
  windows[0].emit('move');
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.deepEqual(JSON.parse(fs.readFileSync(boundsPath, 'utf8')), { x: 100, y: 80, width: 1000, height: 700 });
  manager.closeWindow();
});
