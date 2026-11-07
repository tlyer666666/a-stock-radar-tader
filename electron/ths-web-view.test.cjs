'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createThsWebViewManager, allowedThsUrl, normalizeBounds, THS_WEB_PARTITION, PAGES } = require('./ths-web-view.cjs');

function harness(options = {}) {
  const log = { loads: [], external: [], cleared: 0, permissions: [] };
  const listeners = {};
  let url = '';
  const contents = {
    isDestroyed: () => false,
    loadURL: async (target) => { log.loads.push(target); url = target; return options.loadURL?.(target); },
    getURL: () => url, getTitle: () => '沪股通', isLoading: () => false,
    navigationHistory: { canGoBack: () => true, goBack: () => log.loads.push('back') },
    reload: () => log.loads.push('reload'),
    setWindowOpenHandler: (handler) => { listeners.open = handler; },
    on: (name, handler) => { listeners[name] = handler; },
    close: () => {}
  };
  class FakeView {
    constructor(options) { log.viewOptions = options; this.webContents = contents; }
    setBounds(bounds) { log.bounds = bounds; }
  }
  const partition = {
    on: (name, listener) => { (log.sessionHandlers ||= []).push([name, listener]); },
    setPermissionCheckHandler: (handler) => log.permissions.push(handler()),
    setPermissionRequestHandler: (handler) => handler(null, 'media', (allowed) => log.permissions.push(allowed)),
    clearStorageData: async () => { log.cleared += 1; await options.clearStorageData?.(); }
  };
  const children = new Set();
  const win = { isDestroyed: () => false, getContentSize: () => [1400, 900], webContents: { getZoomFactor: () => 1 },
    contentView: { addChildView: (view) => children.add(view), removeChildView: (view) => children.delete(view) } };
  const manager = createThsWebViewManager({ WebContentsView: FakeView, session: { fromPartition: (name) => { log.partition = name; return partition; } },
    getWindow: () => win, openExternal: (target) => log.external.push(target) });
  return { manager, log, listeners, children };
}

test('only THS hosts may load inside the embedded view', () => {
  assert.equal(allowedThsUrl('https://data.10jqka.com.cn/hgt/hgtb/'), true);
  assert.equal(allowedThsUrl('https://upass.10jqka.com.cn/login'), true);
  assert.equal(allowedThsUrl('https://s.thsi.cn/x.js'), true);
  assert.equal(allowedThsUrl('https://evil10jqka.com.cn/'), false);
  assert.equal(allowedThsUrl('https://example.com/'), false);
  assert.equal(allowedThsUrl('file:///etc/passwd'), false);
  assert.equal(allowedThsUrl('http://data.10jqka.com.cn/report'), false);
  assert.equal(allowedThsUrl('https://a:b@data.10jqka.com.cn/'), false);
});

test('bounds are rounded, clipped to the window and rejected when too small', () => {
  assert.deepEqual(normalizeBounds({ x: 10.4, y: 20.6, width: 2000, height: 300 }, { width: 1400, height: 900 }), { x: 10, y: 21, width: 1390, height: 300 });
  assert.equal(normalizeBounds({ x: 0, y: 0, width: 20, height: 300 }), null);
  assert.equal(normalizeBounds({ x: 'a', y: 0, width: 200, height: 300 }), null);
});

test('the view runs in its own sandboxed session, denies permissions and opens the THS page once', async () => {
  const { manager, log, children } = harness();
  const state = manager.show({ bounds: { x: 200, y: 120, width: 900, height: 600 } });
  assert.equal(log.partition, THS_WEB_PARTITION);
  assert.equal(log.viewOptions.webPreferences.partition, THS_WEB_PARTITION);
  assert.equal(log.viewOptions.webPreferences.sandbox, true);
  assert.equal(log.viewOptions.webPreferences.nodeIntegration, false);
  assert.equal(log.viewOptions.webPreferences.preload, undefined, 'no script is injected into the THS page');
  assert.deepEqual(log.permissions, [false, false]);
  assert.equal(children.size, 1);
  assert.deepEqual(log.bounds, { x: 200, y: 120, width: 900, height: 600 });
  assert.deepEqual(log.loads, [PAGES.hsgt]);
  assert.equal(state.open, true);
  manager.show({ bounds: { x: 200, y: 120, width: 900, height: 600 } });
  assert.equal(log.loads.length, 1, 'returning to the section keeps the page and the login');
  manager.hide();
  assert.equal(children.size, 0);
});

test('off-site links go to the system browser; THS popups stay in the view; logout clears only this session', async () => {
  const { manager, log, listeners } = harness();
  manager.show({ bounds: { x: 0, y: 0, width: 900, height: 600 } });
  let prevented = false;
  listeners['will-navigate']({ preventDefault: () => { prevented = true; } }, 'https://example.com/ad');
  assert.equal(prevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log.external, ['https://example.com/ad']);
  assert.deepEqual(listeners.open({ url: 'https://stockpage.10jqka.com.cn/600519/' }), { action: 'deny' });
  assert.equal(log.loads.at(-1), 'https://stockpage.10jqka.com.cn/600519/');
  await manager.command({ action: 'logout' });
  assert.equal(log.cleared, 1);
  assert.equal(log.loads.at(-1), PAGES.hsgt);
  await manager.command({ action: 'login' });
  assert.equal(log.loads.at(-1), PAGES.login);
  await assert.rejects(manager.command({ action: 'eval' }), { code: 'INVALID_IPC_PAYLOAD' });
});

test('embedded session denies downloads after view recreation, and never opens credential-bearing external URLs', async () => {
  const { manager, log, listeners } = harness();
  const bounds = { x: 0, y: 0, width: 200, height: 200 };
  manager.show({ bounds });
  listeners.open({ url: 'https://user:pass@offsite.test/x' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log.external, []);
  manager.destroy(); manager.show({ bounds });
  const handlers = log.sessionHandlers.filter(([name]) => name === 'will-download');
  assert.equal(handlers.length, 1);
  let cancelled = false;
  handlers[0][1]({ preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
});

test('a rejected load from a destroyed view cannot contaminate its replacement', async () => {
  const bounds = {x: 0, y: 0, width: 900, height: 600};
  let fail;
  const snapshots=[];
  class View {constructor(){this.webContents={isDestroyed:()=>false,setWindowOpenHandler(){},on(){},close(){},getURL:()=>'',getTitle:()=>'',isLoading:()=>false,
    loadURL:()=>snapshots.length===1?new Promise((_r,reject)=>{fail=reject;}):Promise.resolve()};snapshots.push(this);}setBounds(){}}
  const win={isDestroyed:()=>false,getContentSize:()=>[1000,800],webContents:{getZoomFactor:()=>1},contentView:{addChildView(){},removeChildView(){}}};
  const m=createThsWebViewManager({WebContentsView:View,getWindow:()=>win,session:{fromPartition:()=>({on(){},setPermissionCheckHandler(){},setPermissionRequestHandler(){}})}});
  m.show({bounds});m.destroy();m.show({bounds});fail(Error('old failed load'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(m.state().error,'');m.destroy();
});

test('an older navigation rejection cannot replace a newer successful page state', async () => {
  let rejectHome;
  class View {constructor(){this.webContents={isDestroyed:()=>false,setWindowOpenHandler(){},on(){},close(){},getURL:()=>PAGES.login,getTitle:()=>'',isLoading:()=>false,
    loadURL:url=>url===PAGES.hsgt?new Promise((_r,reject)=>{rejectHome=reject;}):Promise.resolve()};}setBounds(){}}
  const win={isDestroyed:()=>false,getContentSize:()=>[1000,800],webContents:{getZoomFactor:()=>1},contentView:{addChildView(){},removeChildView(){}}};
  const m=createThsWebViewManager({WebContentsView:View,getWindow:()=>win,session:{fromPartition:()=>({on(){},setPermissionCheckHandler(){},setPermissionRequestHandler(){}})}});
  m.show({bounds:{x:0,y:0,width:900,height:600}});await m.command({action:'login'});rejectHome(Error('old home failed'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(m.state().error,'');m.destroy();
});


test('an old popup callback is inert after destruction and replacement', async () => {
  const { manager, listeners, log } = harness();
  const bounds = { x: 0, y: 0, width: 900, height: 600 };
  manager.show({ bounds });
  const oldPopup = listeners.open;
  manager.destroy();
  assert.doesNotThrow(() => oldPopup({ url: PAGES.login }));
  manager.show({ bounds });
  const count = log.loads.length;
  oldPopup({ url: PAGES.login });
  assert.equal(log.loads.length, count);
  manager.destroy();
});

test('reload invalidates failures from an earlier load while current failures still surface', async () => {
  let rejectHome;
  const { manager } = harness({ loadURL: () => new Promise((_resolve, reject) => { rejectHome = reject; }) });
  const bounds = { x: 0, y: 0, width: 900, height: 600 };
  manager.show({ bounds });
  rejectHome(Error('current load failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(manager.state().error, /current load failure/);
  const next = manager.command({ action: 'home' });
  await manager.command({ action: 'reload' });
  rejectHome(Error('superseded failure')); await next;
  assert.equal(manager.state().error, '');
  manager.destroy();
});

test('finishing an old logout cannot navigate a replacement view', async () => {
  let finishClear;
  const { manager, log } = harness({ clearStorageData: () => new Promise(resolve => { finishClear = resolve; }) });
  const bounds = { x: 0, y: 0, width: 900, height: 600 };
  manager.show({ bounds });
  const logout = manager.command({ action: 'logout' });
  manager.destroy(); manager.show({ bounds });
  await manager.command({ action: 'login' });
  finishClear(); await logout;
  assert.equal(log.loads.at(-1), PAGES.login);
  manager.destroy();
});

test('1.6.52: bounds that no longer fit remove the native view instead of leaving it at the old position', () => {
  const { manager, children } = harness();
  manager.show({ bounds: { x: 200, y: 120, width: 900, height: 600 } });
  assert.equal(children.size, 1);
  manager.setBounds({ bounds: { x: 200, y: 120, width: 20, height: 10 } });
  assert.equal(children.size, 0);
  manager.setBounds({ bounds: { x: 200, y: 120, width: 900, height: 600 } });
  assert.equal(children.size, 0, 'a later valid size does not silently re-attach; show() does');
});

test('1.6.52: a failed in-page navigation is reported even before the address commits', () => {
  const { manager, listeners } = harness();
  manager.show({ bounds: { x: 0, y: 0, width: 900, height: 600 } });
  listeners['will-navigate']({ preventDefault() {} }, 'https://data.10jqka.com.cn/hgt/sgtb/');
  listeners['did-fail-load']({}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://data.10jqka.com.cn/hgt/sgtb/', true);
  assert.match(manager.state().error || '', /ERR_NAME_NOT_RESOLVED/);
});
