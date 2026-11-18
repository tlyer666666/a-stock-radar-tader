'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isAllowedRendererNavigation, normalizeExternalHttpsUrl } = require('./security-policy.cjs');

function createReviewWindowManager({ BrowserWindow, screen, root, packaged, devUrl, hidden = false, openExternal, onError = () => {} }) {
  let reviewWindow, pending;
  let resolvedScreen = screen;
  if (!resolvedScreen) {
    try {
      const electronMod = require('electron');
      if (electronMod && typeof electronMod === 'object' && typeof electronMod.screen?.getPrimaryDisplay === 'function') {
        resolvedScreen = electronMod.screen;
      }
    } catch { /* plain Node unit-test environment */ }
  }
  const file = path.join(root, 'dist', 'review', 'review.html');
  const target = packaged ? pathToFileURL(file).href : new URL('review.html', `${devUrl.replace(/\/$/, '')}/`).href;
  const getWebContents = () => reviewWindow && !reviewWindow.isDestroyed() && !reviewWindow.webContents.isDestroyed() ? reviewWindow.webContents : undefined;
  const safeExternal = url => {
    const safe = normalizeExternalHttpsUrl(url);
    if (safe) Promise.resolve().then(() => openExternal(safe)).catch(onError);
  };
  return {
    getWebContents,
    closeWindow() {
      const current = reviewWindow;
      reviewWindow = undefined;
      if (!current || current.isDestroyed()) return false;
      try {
        current.destroy();
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    },
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
      let workArea;
      try { workArea = resolvedScreen?.getPrimaryDisplay?.()?.workAreaSize; } catch { workArea = undefined; }
      const workWidth = Number(workArea?.width) > 0 ? Number(workArea.width) : 1280;
      const workHeight = Number(workArea?.height) > 0 ? Number(workArea.height) : 880;
      const width = Math.min(1280, workWidth);
      const height = Math.min(880, workHeight);
      const created = new BrowserWindow({
        title: 'A股雷达 专业复盘', width, height, minWidth: Math.min(800, width), minHeight: Math.min(600, height), show: false,
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
