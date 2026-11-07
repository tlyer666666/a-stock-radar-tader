import React from "react";
import { createRoot, type Root } from "react-dom/client";
import AppErrorBoundary from "./AppErrorBoundary";
import ProfessionalReview from "./ProfessionalReview";
import { DataBridgeFailure, initializeStockApi } from "./runtimeBridge";
import { allowPreviewRuntime } from "./runtimePreview";
import "./styles/review-index.css";

let mountedRoot: Root | null = null;

export function mountProfessionalReview(container: Element): () => void {
  if (mountedRoot) {
    throw new Error("专业复盘模块已经挂载；请先卸载再重新挂载。");
  }
  const apiAvailable = !!window.stockApi || initializeStockApi(allowPreviewRuntime());
  const root = createRoot(container);
  mountedRoot = root;
  root.render(
    <React.StrictMode>
      {apiAvailable ? (
        <AppErrorBoundary>
          <ProfessionalReview />
        </AppErrorBoundary>
      ) : <DataBridgeFailure />}
    </React.StrictMode>
  );
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    root.unmount();
    if (mountedRoot === root) mountedRoot = null;
  };
}

const standaloneHost = document.getElementById("root");
if (standaloneHost) mountProfessionalReview(standaloneHost);

if (document.body?.hasAttribute('data-standalone-review') && window.stockApi) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let mode = 'system';
  const apply = () => {
    const theme = mode === 'system' ? media.matches ? 'dark' : 'light' : mode;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  };
  const applyMode = (next: string) => {
    mode = ['dark', 'light'].includes(next) ? next : 'system';
    apply();
  };
  const sync = () => { void window.stockApi.getReviewTheme?.().then(result => applyMode(result.theme)).catch(apply); };
  apply(); sync();
  media.addEventListener('change', apply);
  // 主窗口切换主题时由主进程推送；焦点同步保留为主进程未推送时的兜底。
  const unsubscribeTheme = window.stockApi.onThemeChange?.(applyMode);
  window.addEventListener('focus', sync);
  window.addEventListener('pagehide', () => {
    media.removeEventListener('change', apply);
    window.removeEventListener('focus', sync);
    unsubscribeTheme?.();
  }, { once: true });
}
