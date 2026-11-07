"use strict";

/**
 * 「沪深港通」板块：把同花顺数据中心的沪深港通网页原样嵌进主窗口。
 *
 * - 网页跑在独立的持久会话（persist:ths-web）里，和软件自身的会话、Cookie 完全分开；
 *   用户在这里自己登录同花顺账号，登录状态保存在本机，软件不读取、不保存账号密码或 Cookie。
 * - 只允许同花顺自家域名在这个视图里打开；其他链接交给系统浏览器（仅 https）。
 * - 不注入任何脚本、不开 Node、沙箱运行；网页申请的权限（摄像头、通知等）一律拒绝。
 * - 视图位置由渲染进程按占位区域上报（CSS 像素），这里按主窗口缩放换算后贴到主窗口上。
 */
const { normalizeExternalHttpsUrl } = require("./security-policy.cjs");
const guardedPartitions = new WeakSet();
const THS_WEB_PARTITION = "persist:ths-web";
const PAGES = Object.freeze({
  hsgt: "https://data.10jqka.com.cn/hgt/hgtb/",
  login: "https://upass.10jqka.com.cn/login?redir=" + encodeURIComponent("https://data.10jqka.com.cn/hgt/hgtb/")
});
const ALLOWED_HOST_SUFFIXES = ["10jqka.com.cn", "thsi.cn", "10jqka.com", "hexin.cn"];

function allowedThsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function normalizeBounds(input, limits = null) {
  const keys = ["x", "y", "width", "height"];
  if (!input || typeof input !== "object" || keys.some(key => !Number.isFinite(Number(input[key])))) return null;
  let { x, y, width, height } = Object.fromEntries(keys.map(key => [key, Math.round(Number(input[key]))]));
  x = Math.max(0, x); y = Math.max(0, y);
  if (limits) { width = Math.min(width, Math.max(0, limits.width - x)); height = Math.min(height, Math.max(0, limits.height - y)); }
  if (width < 50 || height < 50) return null;
  return { x, y, width, height };
}

function createThsWebViewManager({ WebContentsView, session, getWindow, openExternal = () => {}, onError = () => {} }) {
  let view = null;
  let attachedTo = null;
  let loadedPage = "";
  let lastError = "";
  let loadGeneration = 0;
  let pendingUrl = ""; // 正在导航的目标：导航失败时页面地址还没切换，需按目标地址认领错误

  const windowReady = () => {
    const win = getWindow();
    return win && !win.isDestroyed() ? win : null;
  };
  const safeExternal = url => {
    const safe = normalizeExternalHttpsUrl(url);
    if (safe) Promise.resolve().then(() => openExternal(safe)).catch(onError);
  };

  function ensureView() {
    if (view && !view.webContents.isDestroyed()) return view;
    const partition = session.fromPartition(THS_WEB_PARTITION);
    if (!guardedPartitions.has(partition)) {
      partition.on("will-download", event => event.preventDefault());
      guardedPartitions.add(partition);
    }
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_, __, callback) => callback(false));
    view = new WebContentsView({
      webPreferences: { partition: THS_WEB_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false }
    });
    const createdView = view;
    const contents = createdView.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (view !== createdView) return { action: "deny" };
      // 同花顺页面里弹出的同站页面（登录框、个股页）就在本视图打开；站外链接交给系统浏览器。
      if (allowedThsUrl(url)) void loadUrl(url);
      else safeExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (view !== createdView) { event.preventDefault(); return; }
      const target = typeof url === "string" ? url : event.url;
      if (allowedThsUrl(target)) { loadGeneration++; lastError = ""; pendingUrl = String(target || ""); return; }
      event.preventDefault();
      safeExternal(target);
    });
    contents.on("will-redirect", (event, url) => {
      if (!allowedThsUrl(typeof url === "string" ? url : event.url)) event.preventDefault();
    });
    contents.on("did-fail-load", (_, code, description, url, isMainFrame) => {
      if (view === createdView && (url === contents.getURL() || (pendingUrl && url === pendingUrl)) && isMainFrame !== false && code !== -3) lastError = `${description || "加载失败"}（${code}）`;
    });
    contents.on("did-finish-load", () => { if (view === createdView) lastError = ""; });
    contents.on("render-process-gone", () => {
      if (view !== createdView) return;
      destroyView();
    });
    return view;
  }

  function detach() {
    if (view && attachedTo && !attachedTo.isDestroyed()) {
      try { attachedTo.contentView.removeChildView(view); } catch { /* 窗口已关闭 */ }
    }
    attachedTo = null;
  }

  function destroyView() {
    const previous = view;
    detach();
    view = null;
    loadedPage = "";
    lastError = "";
    loadGeneration++;
    if (previous && !previous.webContents.isDestroyed()) {
      try { previous.webContents.close(); } catch (error) { onError(error); }
    }
  }

  function place(bounds) {
    const win = windowReady();
    if (!win || !view) return false;
    const zoom = Number(win.webContents.getZoomFactor?.()) || 1;
    const [width, height] = win.getContentSize();
    const scaled = bounds && normalizeBounds({ x: bounds.x * zoom, y: bounds.y * zoom, width: bounds.width * zoom, height: bounds.height * zoom }, { width, height });
    if (!scaled) return false;
    if (attachedTo !== win) {
      detach();
      win.contentView.addChildView(view);
      attachedTo = win;
    }
    view.setBounds(scaled);
    return true;
  }

  function loadUrl(target) {
    const owner = view;
    const generation = ++loadGeneration;
    lastError = "";
    pendingUrl = String(target || "");
    return owner.webContents.loadURL(target).catch(error => {
      if (owner === view && generation === loadGeneration && Number(error?.errno) !== -3) lastError = String(error?.message || error);
    });
  }

  function load(page) {
    loadedPage = page in PAGES ? page : "hsgt";
    return loadUrl(PAGES[loadedPage]);
  }

  function state() {
    const contents = view && !view.webContents.isDestroyed() ? view.webContents : null;
    return {
      open: Boolean(contents && attachedTo),
      url: contents ? contents.getURL() : "",
      title: contents ? contents.getTitle() : "",
      loading: contents ? contents.isLoading() : false,
      canGoBack: contents ? contents.navigationHistory?.canGoBack?.() ?? contents.canGoBack?.() ?? false : false,
      error: lastError
    };
  }

  return {
    show({ bounds, page } = {}) {
      ensureView();
      if (!place(bounds)) return state();
      if (!loadedPage || (page && page !== loadedPage && PAGES[page])) void load(page || "hsgt");
      return state();
    },
    setBounds({ bounds } = {}) {
      // 区域被缩放/滚动裁剪到放不下（或无效）时移除原生视图，避免留在旧位置挡住界面。
      if (view && attachedTo && !place(bounds)) detach();
      return state();
    },
    hide() {
      detach();
      return state();
    },
    async command({ action } = {}) {
      if (!view || view.webContents.isDestroyed()) return state();
      const owner = view;
      const contents = view.webContents;
      if (action === "home") await load("hsgt");
      else if (action === "login") await load("login");
      else if (action === "reload") { loadGeneration++; lastError = ""; contents.reload(); }
      else if (action === "back") {
        loadGeneration++; lastError = "";
        if (contents.navigationHistory?.canGoBack?.()) contents.navigationHistory.goBack();
        else if (contents.canGoBack?.()) contents.goBack();
      } else if (action === "external") safeExternal(contents.getURL());
      else if (action === "logout") {
        // 只清除这个嵌入网页自己的会话数据（同花顺登录状态），不影响软件其他数据。
        await session.fromPartition(THS_WEB_PARTITION).clearStorageData();
        if (view !== owner || contents.isDestroyed()) return state();
        await load("hsgt");
      } else throw Object.assign(new TypeError("未知的沪深港通网页操作"), { code: "INVALID_IPC_PAYLOAD" });
      return state();
    },
    state,
    destroy: destroyView
  };
}

module.exports = { createThsWebViewManager, allowedThsUrl, normalizeBounds, THS_WEB_PARTITION, PAGES };
