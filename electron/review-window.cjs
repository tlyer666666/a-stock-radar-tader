'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { isAllowedRendererNavigation, normalizeExternalHttpsUrl } = require('./security-policy.cjs');

const BOUNDS_SAVE_DEBOUNCE_MS = 250;
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2.5;

function normalizeZoomFactor(factor) {
  const numeric = Number(factor);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM_FACTOR, Math.round(numeric * 100) / 100));
}

function createReviewWindowManager({ BrowserWindow, screen, root, packaged, devUrl, hidden = false, openExternal, onError = () => {}, boundsPath = null, canOpen = null }) {
  let reviewWindow, pending;
  let zoomFactor = 1;
  let boundsSaveTimer = null;
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
  const clearBoundsTimer = () => {
    if (boundsSaveTimer) {
      clearTimeout(boundsSaveTimer);
      boundsSaveTimer = null;
    }
  };
  const resolveWorkArea = (candidate = null) => {
    let display = null;
    try {
      if (candidate && Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && typeof resolvedScreen?.getDisplayMatching === 'function') {
        display = resolvedScreen.getDisplayMatching({
          x: Math.round(candidate.x),
          y: Math.round(candidate.y),
          width: Math.max(1, Math.round(candidate.width || 1280)),
          height: Math.max(1, Math.round(candidate.height || 880))
        });
      }
      if (!display) display = resolvedScreen?.getPrimaryDisplay?.();
    } catch {
      display = null;
    }
    const area = display?.workArea;
    const size = display?.workAreaSize;
    const width = Number(area?.width || size?.width) > 0 ? Number(area?.width || size?.width) : 1280;
    const height = Number(area?.height || size?.height) > 0 ? Number(area?.height || size?.height) : 880;
    const x = Number.isFinite(Number(area?.x)) ? Number(area.x) : 0;
    const y = Number.isFinite(Number(area?.y)) ? Number(area.y) : 0;
    return { x, y, width, height };
  };
  const clampBounds = (candidate) => {
    const workArea = resolveWorkArea(candidate);
    const minWidth = Math.min(800, workArea.width);
    const minHeight = Math.min(600, workArea.height);
    const desiredWidth = Number.isFinite(Number(candidate?.width)) && Number(candidate.width) > 0
      ? Number(candidate.width)
      : Math.min(1280, workArea.width);
    const desiredHeight = Number.isFinite(Number(candidate?.height)) && Number(candidate.height) > 0
      ? Number(candidate.height)
      : Math.min(880, workArea.height);
    const width = Math.round(Math.max(minWidth, Math.min(workArea.width, desiredWidth)));
    const height = Math.round(Math.max(minHeight, Math.min(workArea.height, desiredHeight)));
    const hasPosition = candidate && Number.isFinite(Number(candidate.x)) && Number.isFinite(Number(candidate.y));
    if (!hasPosition) {
      return { width, height, minWidth, minHeight };
    }
    const maxX = Math.max(workArea.x, workArea.x + workArea.width - width);
    const maxY = Math.max(workArea.y, workArea.y + workArea.height - height);
    const x = Math.round(Math.max(workArea.x, Math.min(maxX, Number(candidate.x))));
    const y = Math.round(Math.max(workArea.y, Math.min(maxY, Number(candidate.y))));
    return { x, y, width, height, minWidth, minHeight };
  };
  const readSavedBounds = () => {
    if (typeof boundsPath !== 'string' || !boundsPath.trim()) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(boundsPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const width = Number(parsed.width);
      const height = Number(parsed.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      return {
        width,
        height,
        ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {})
      };
    } catch {
      return null;
    }
  };
  const persistBoundsNow = (win) => {
    if (typeof boundsPath !== 'string' || !boundsPath.trim()) return;
    if (!win || win.isDestroyed?.() || typeof win.getBounds !== 'function') return;
    if (win.isMinimized?.() || win.isMaximized?.()) return;
    try {
      const raw = win.getBounds();
      if (!raw || typeof raw !== 'object') return;
      const clamped = clampBounds(raw);
      const payload = {
        x: Number.isFinite(clamped.x) ? clamped.x : 0,
        y: Number.isFinite(clamped.y) ? clamped.y : 0,
        width: clamped.width,
        height: clamped.height
      };
      const dir = path.dirname(boundsPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(dir, `.${path.basename(boundsPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, boundsPath);
        if (process.platform !== 'win32') {
          try { fs.chmodSync(boundsPath, 0o600); } catch { /* ignore */ }
        }
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    } catch {
      // Bounds persistence is best-effort and must not disrupt the window.
    }
  };
  const scheduleBoundsSave = (win) => {
    if (typeof boundsPath !== 'string' || !boundsPath.trim()) return;
    clearBoundsTimer();
    boundsSaveTimer = setTimeout(() => {
      boundsSaveTimer = null;
      if (reviewWindow === win) persistBoundsNow(win);
    }, BOUNDS_SAVE_DEBOUNCE_MS);
    boundsSaveTimer?.unref?.();
  };
  const applyZoom = (contents) => {
    if (contents && !contents.isDestroyed?.() && typeof contents.setZoomFactor === 'function') {
      try { contents.setZoomFactor(zoomFactor); } catch { /* ignore */ }
    }
  };
  return {
    getWebContents,
    setZoomFactor(factor) {
      const normalized = normalizeZoomFactor(factor);
      if (normalized === null) return false;
      zoomFactor = normalized;
      applyZoom(getWebContents());
      return true;
    },
    closeWindow() {
      clearBoundsTimer();
      const current = reviewWindow;
      reviewWindow = undefined;
      pending = undefined;
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
      if (typeof canOpen === 'function' && !canOpen()) {
        return Promise.reject(Object.assign(new Error('当前状态不允许打开复盘窗口'), { code: 'REVIEW_WINDOW_BLOCKED' }));
      }
      if (pending && reviewWindow && !reviewWindow.isDestroyed()) return pending;
      if (reviewWindow && !reviewWindow.isDestroyed()) {
        if (!hidden) { if (reviewWindow.isMinimized()) reviewWindow.restore(); reviewWindow.show(); reviewWindow.focus(); }
        return Promise.resolve({ ok: true });
      }
      const initial = clampBounds(readSavedBounds());
      const created = new BrowserWindow({
        title: 'A股雷达 专业复盘',
        width: initial.width,
        height: initial.height,
        ...(Number.isFinite(initial.x) && Number.isFinite(initial.y) ? { x: initial.x, y: initial.y } : {}),
        minWidth: initial.minWidth,
        minHeight: initial.minHeight,
        show: false,
        webPreferences: { preload: path.join(root, 'electron', 'review-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !packaged }
      });
      reviewWindow = created;
      applyZoom(created.webContents);
      let currentPending;
      created.on('resize', () => scheduleBoundsSave(created));
      created.on('move', () => scheduleBoundsSave(created));
      created.on('closed', () => {
        clearBoundsTimer();
        if (reviewWindow === created) reviewWindow = undefined;
        if (pending === currentPending) pending = undefined;
      });
      created.webContents.setWindowOpenHandler(({ url }) => { safeExternal(url); return { action: 'deny' }; });
      created.webContents.on('will-navigate', (event, url) => { if (!isAllowedRendererNavigation(url, target)) { event.preventDefault(); safeExternal(url); } });
      created.webContents.on('render-process-gone', () => { if (!created.isDestroyed()) created.destroy(); });
      currentPending = Promise.resolve().then(() => {
        if (created.isDestroyed()) return { ok: false };
        return (packaged ? created.loadFile(file) : created.loadURL(target)).then(() => {
          if (created.isDestroyed()) return { ok: false };
          applyZoom(created.webContents);
          if (!hidden) created.show();
          return { ok: true };
        });
      }).catch(error => {
        if (!created.isDestroyed()) created.destroy();
        throw error;
      }).finally(() => {
        if (pending === currentPending) pending = undefined;
      });
      pending = currentPending;
      return currentPending;
    }
  };
}
module.exports = { createReviewWindowManager };
