import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Home, LogIn, LogOut, RefreshCw } from "lucide-react";

import { whenVisible } from "../../visiblePolling";

type Bounds = { x: number; y: number; width: number; height: number };
type Action = "home" | "login" | "reload" | "back" | "external" | "logout";

/** 占位区域与可见区域（滚动容器、窗口）的交集：网页视图不会盖到导航栏或标题栏上。 */
export function visibleBounds(rect: Bounds, clips: Bounds[]): Bounds | null {
  let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
  for (const clip of clips) {
    left = Math.max(left, clip.x); top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.width); bottom = Math.min(bottom, clip.y + clip.height);
  }
  const width = Math.floor(right - left), height = Math.floor(bottom - top);
  return width >= 50 && height >= 50 ? { x: Math.round(left), y: Math.round(top), width, height } : null;
}

function scrollClips(element: HTMLElement): Bounds[] {
  const clips: Bounds[] = [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }];
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden)/.test(`${style.overflow}${style.overflowY}${style.overflowX}`)) {
      const rect = node.getBoundingClientRect();
      clips.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
  }
  return clips;
}

/**
 * 「沪深港通」：同花顺数据中心沪深港通网页原样嵌入（北向/南向资金、陆股通指数成分股资金流向、成交榜）。
 * 网页在独立会话里运行，同花顺账号由用户在网页里自己登录；登录状态保存在本机，软件不读取账号信息。
 */
export default function HsgtWebView() {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.thsWeb;
  const frame = useRef<HTMLDivElement | null>(null);
  const shown = useRef(false);
  const lastBounds = useRef("");
  const revision = useRef(0);
  const [state, setState] = useState<ThsWebState | null>(null);
  const [busy, setBusy] = useState(false);

  const measure = useCallback((): Bounds | null => {
    const element = frame.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return visibleBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, scrollClips(element));
  }, []);

  const sync = useCallback(() => {
    if (!api) return;
    // Native child surfaces sit above HTML regardless of their CSS z-index.
    const overlay = document.querySelector('dialog[open], [aria-modal="true"]:not(dialog):not([hidden]), .suggestions, .toast, [role="menu"]:not([hidden]), details[open].limit-columns-settings, details[open].page-heading-help, .ai-framework-picker.is-open, .sector-suggestions:not(:empty), [data-overlay="open"]');
    const bounds = document.hidden || overlay ? null : measure();
    const key = bounds ? JSON.stringify(bounds) : "";
    if (lastBounds.current === key && shown.current === Boolean(bounds)) return;
    const wasShown = shown.current;
    shown.current = Boolean(bounds);
    lastBounds.current = key;
    const ticket = ++revision.current;
    const action = !bounds ? api.hide() : wasShown ? api.setBounds({bounds}) : api.show({bounds});
    void action.then(next => {
      if (revision.current !== ticket) return;
      shown.current = next.open;
      setState(next);
    }).catch(() => {
      if (revision.current !== ticket) return;
      // Keep a failed hide eligible for retry too.
      shown.current = wasShown;
      lastBounds.current = "retry";
    });
  }, [api, measure]);

  useLayoutEffect(() => {
    if (!api) return;
    let frameRequest = 0;
    const schedule = () => {
      if (!frameRequest) frameRequest = requestAnimationFrame(() => { frameRequest = 0; sync(); });
    };
    sync();
    const observer = new ResizeObserver(schedule);
    if (frame.current) observer.observe(frame.current);
    const overlays = new MutationObserver(schedule);
    overlays.observe(document.body, {childList:true,subtree:true,attributes:true,attributeFilter:["open","hidden","aria-modal","class"]});
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frameRequest);
      observer.disconnect();
      overlays.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      revision.current++;
      shown.current = false;
      lastBounds.current = "";
      void api.hide().catch(() => {});
    };
  }, [api, sync]);

  useEffect(() => {
    if (!api) return;
    let pending = false, mounted = true;
    const poll = whenVisible(async () => {
      if (pending) return;
      sync();
      if (!shown.current) return;
      const ticket = revision.current;
      pending = true;
      try {
        const current = await api.state();
        if (mounted && ticket === revision.current) {
          setState(current);
          if (!current.open) { shown.current = false; lastBounds.current = ""; }
        }
      } catch { /* Retry on the next visible poll. */ }
      finally { pending = false; }
    });
    const timer = window.setInterval(poll, 5000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [api, sync]);

  const run = async (action: Action) => {
    if (!api || busy) return;
    setBusy(true);
    try { setState(await api.command({ action })); } catch { /* 网页操作失败时保留当前页面 */ } finally { setBusy(false); }
  };

  if (!api) return <div className="hsgt-workspace">
    <div className="page-heading"><div className="page-heading-identity"><h1>沪深港通</h1></div></div>
    <p className="empty-inline">沪深港通网页只在桌面版里打开（浏览器预览不嵌入同花顺网页）。</p>
  </div>;

  return <div className="hsgt-workspace">
    <div className="page-heading">
      <div className="page-heading-identity"><h1>沪深港通</h1></div>
      <div className="heading-actions hsgt-actions">
        <button type="button" className="secondary-btn" onClick={() => void run("back")} disabled={busy || !state?.canGoBack}><ArrowLeft size={15} />后退</button>
        <button type="button" className="secondary-btn" onClick={() => void run("home")} disabled={busy}><Home size={15} />沪深港通首页</button>
        <button type="button" className="secondary-btn" onClick={() => void run("reload")} disabled={busy}><RefreshCw size={15} className={state?.loading ? "spin" : ""} />刷新</button>
        <button type="button" className="secondary-btn" onClick={() => void run("login")} disabled={busy}><LogIn size={15} />登录同花顺</button>
        <button type="button" className="secondary-btn" onClick={() => void run("external")} disabled={busy}><ExternalLink size={15} />在浏览器打开</button>
        <button type="button" className="secondary-btn" onClick={() => void run("logout")} disabled={busy} title="清除这个网页里的同花顺登录状态"><LogOut size={15} />退出登录</button>
      </div>
    </div>
    <p className="hsgt-note">同花顺数据中心原网页：北向/南向资金、陆股通指数成分股资金流向、个股成交榜；资金流向曲线如果空白，请先点「登录同花顺」登录账号。账号在网页里自己登录，登录状态只保存在本机。{state?.error ? <b className="hsgt-error"> 页面加载失败：{state.error}，可点「刷新」重试。</b> : null}</p>
    <div ref={frame} className="hsgt-web-frame" aria-label="同花顺沪深港通网页">
      {!state?.open && <span className="empty-inline">正在打开同花顺沪深港通网页…</span>}
    </div>
  </div>;
}
