import React from "react";
import { createRoot, type Root } from "react-dom/client";
import AppErrorBoundary from "./AppErrorBoundary";
import ProfessionalReview from "./ProfessionalReview";
import { createPreviewApi } from "./previewApi";
import "./review.css";

let mountedRoot: Root | null = null;

export function mountProfessionalReview(container: Element): () => void {
  if (mountedRoot) {
    throw new Error("专业复盘模块已经挂载；请先卸载再重新挂载。");
  }
  if (!window.stockApi) window.stockApi = createPreviewApi();
  mountedRoot = createRoot(container);
  mountedRoot.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <ProfessionalReview />
      </AppErrorBoundary>
    </React.StrictMode>
  );
  return () => {
    mountedRoot?.unmount();
    mountedRoot = null;
  };
}

const standaloneHost = document.getElementById("root");
if (standaloneHost) mountProfessionalReview(standaloneHost);
