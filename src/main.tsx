import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { HsgtOverlayProvider } from "./features/hsgt/overlayContext";
import AppErrorBoundary from "./components/AppErrorBoundary";
import "./styles/index.css";
import { DataBridgeFailure, initializeStockApi } from "./runtimeBridge";
import { allowPreviewRuntime } from "./runtimePreview";

// A production bridge failure must remain visible; only development and
// the explicit ?preview=1 entry may install the browser preview bridge.
const root = ReactDOM.createRoot(document.getElementById("root")!);
const renderRoot = (apiAvailable: boolean) => {
  root.render(
    <React.StrictMode>
      {apiAvailable ? (
        <AppErrorBoundary>
          <HsgtOverlayProvider>
            <App />
          </HsgtOverlayProvider>
        </AppErrorBoundary>
      ) : <DataBridgeFailure />}
    </React.StrictMode>
  );
};

if (window.stockApi) {
  renderRoot(true);
} else if (allowPreviewRuntime()) {
  void import("./previewApi")
    .then(({ createPreviewApi }) => renderRoot(initializeStockApi(true, createPreviewApi)))
    .catch(() => renderRoot(initializeStockApi(false)));
} else {
  renderRoot(initializeStockApi(false));
}
