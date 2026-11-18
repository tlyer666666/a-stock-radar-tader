import { useState } from "react";
import { Minus, Square, X } from "lucide-react";

type WindowControlAction = "minimize" | "toggle-maximize" | "close";

export function WindowTitleBar() {
  const [maximized, setMaximized] = useState(false);
  const platform = window.stockApi.getPlatform?.() || "win32";

  const runControl = async (action: WindowControlAction) => {
    try {
      const result = await window.stockApi.controlWindow(action);
      if (action === "toggle-maximize" && result.ok) setMaximized(result.maximized);
    } catch {
      // Window chrome must remain independent from market data and navigation.
    }
  };

  return (
    <div
      className="window-dragbar"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("[data-window-controls]")) return;
        void runControl("toggle-maximize");
      }}
    >
      <span className={platform === "darwin" ? "window-title-macos" : undefined}>A股雷达</span>
      {platform !== "darwin" && <div className="window-controls" data-window-controls>
        <button
          type="button"
          className="window-control window-control-minimize"
          onClick={() => void runControl("minimize")}
          data-window-action="minimize"
          title="最小化"
          aria-label="最小化窗口"
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`window-control window-control-toggle-maximize ${maximized ? "is-maximized" : ""}`}
          onClick={() => void runControl("toggle-maximize")}
          data-window-action="toggle-maximize"
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
        >
          <Square aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-control window-control-close"
          onClick={() => void runControl("close")}
          data-window-action="close"
          title="关闭"
          aria-label="关闭窗口"
        >
          <X aria-hidden="true" />
        </button>
      </div>}
    </div>
  );
}
