import React from "react";
import { createRoot, type Root } from "react-dom/client";
import AppErrorBoundary from "./AppErrorBoundary";
import ProfessionalReview from "./ProfessionalReview";
import { createPreviewApi } from "./previewApi";
import "./review.css";
import "./terminal-research.css";
import "./terminal-ui.css";
import "./terminal-layout.css";
import "./analysis-workspace.css";

let mountedRoot: Root | null = null;

export function mountProfessionalReview(container: Element): () => void {
  if (mountedRoot) {
    throw new Error("专业复盘模块已经挂载；请先卸载再重新挂载。");
  }
  if (!window.stockApi) window.stockApi = createPreviewApi();
  const root = createRoot(container);
  mountedRoot = root;
  root.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <ProfessionalReview />
      </AppErrorBoundary>
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
