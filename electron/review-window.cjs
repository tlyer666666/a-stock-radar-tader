'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isAllowedRendererNavigation, normalizeExternalHttpsUrl } = require('./security-policy.cjs');

function createReviewWindowManager({ BrowserWindow, root, packaged, devUrl, hidden = false, openExternal, onError = () => {} }) {
  let reviewWindow, pending;
  const file = path.join(root, 'dist', 'review', 'review.html');
  const target = packaged ? pathToFileURL(file).href : new URL('review.html', `${devUrl.replace(/\/$/, '')}/`).href;
  const getWebContents = () => reviewWindow && !reviewWindow.isDestroyed() && !reviewWindow.webContents.isDestroyed() ? reviewWindow.webContents : undefined;
  const safeExternal = url => {
    const safe = normalizeExternalHttpsUrl(url);
    if (safe) Promise.resolve().then(() => openExternal(safe)).catch(onError);
  };
  return {
    getWebContents,
    // 主窗口切换主题时即时推送到已打开的复盘窗口，避免副屏常驻窗口主题滞后。
    broadcastTheme(theme) {
      const contents = getWebContents();
      if (!contents) return false;
      try {
        contents.send('review-window:theme-changed', theme);
        return true;
      } catch {
        return false;
      }
    },
    open() {
      if (pending) return pending;
      if (reviewWindow && !reviewWindow.isDestroyed()) {
        if (!hidden) { if (reviewWindow.isMinimized()) reviewWindow.restore(); reviewWindow.show(); reviewWindow.focus(); }
        return Promise.resolve({ ok: true });
      }
      const created = new BrowserWindow({
        title: 'A股雷达 专业复盘', width: 1280, height: 880, minWidth: 800, minHeight: 600, show: false,
        webPreferences: { preload: path.join(root, 'electron', 'review-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !packaged }
      });
      reviewWindow = created;
      created.on('closed', () => { if (reviewWindow === created) reviewWindow = undefined; });
      created.webContents.setWindowOpenHandler(({ url }) => { safeExternal(url); return { action: 'deny' }; });
      created.webContents.on('will-navigate', (event, url) => { if (!isAllowedRendererNavigation(url, target)) { event.preventDefault(); safeExternal(url); } });
      created.webContents.on('render-process-gone', () => { if (!created.isDestroyed()) created.destroy(); });
      pending = Promise.resolve().then(() => packaged ? created.loadFile(file) : created.loadURL(target)).then(() => {
        if (!created.isDestroyed() && !hidden) created.show();
        return { ok: true };
      }).catch(error => {
        if (!created.isDestroyed()) created.destroy();
        throw error;
      }).finally(() => { pending = undefined; });
      return pending;
    }
  };
}
module.exports = { createReviewWindowManager };
