import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./AppErrorBoundary";
import "./styles/index.css";
import { DataBridgeFailure, initializeStockApi } from "./runtimeBridge";
import { allowPreviewRuntime } from "./runtimePreview";

// A production bridge failure must remain visible; only development and
// the explicit ?preview=1 entry may install the browser preview bridge.
const apiAvailable = initializeStockApi(allowPreviewRuntime());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {apiAvailable ? (
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    ) : <DataBridgeFailure />}
  </React.StrictMode>
);
