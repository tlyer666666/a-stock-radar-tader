import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./AppErrorBoundary";
import "./styles.css";
import "./review.css";
import "./terminal-research.css";
import "./terminal-ui.css";
import "./workbench.css";
import "./watch-workspace.css";
import "./stock-chart.css";
import "./terminal-layout.css";
import "./market-workspace.css";
import "./research-workspace.css";
import "./analysis-workspace.css";
import { createPreviewApi } from "./previewApi";

if (!window.stockApi) {
  window.stockApi = createPreviewApi();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
