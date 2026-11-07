import { createPreviewApi } from "./previewApi";

const previewApis = new WeakSet<object>();

export function isPreviewStockApi(): boolean {
  return typeof window !== "undefined" && !!window.stockApi && previewApis.has(window.stockApi);
}

/** Install a preview bridge only after the entry point explicitly allows it. */
export function initializeStockApi(allowPreview: boolean): boolean {
  if (window.stockApi) return true;
  if (allowPreview) {
    window.stockApi = createPreviewApi();
    previewApis.add(window.stockApi);
    console.warn("[A股雷达] preload 桥不可用，已启用预览数据（仅开发/显式预览模式）。");
    return true;
  }
  console.error("[A股雷达] 数据桥（preload）加载失败，应用无法连接本地服务。");
  return false;
}

export function DataBridgeFailure() {
  return (
    <div role="alert" style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--page)", color: "var(--ink-1)", font: "14px/1.7 var(--font-sans)", padding: 32 }}>
      <div style={{ maxWidth: 520 }}>
        <h1 style={{ fontSize: 17, margin: "0 0 12px" }}>应用无法启动：数据桥加载失败</h1>
        <p style={{ margin: "0 0 10px", color: "var(--ink-2)" }}>应用无法连接本地服务，因此没有加载任何行情数据。</p>
        <p style={{ margin: "0 0 10px", color: "var(--ink-2)" }}>请重新启动应用；若反复出现，请检查安装包是否完整（asar 与 dll 是否被安全软件拦截）。</p>
        <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 8, padding: "8px 16px", borderRadius: 6, border: "1px solid var(--line-2)", background: "var(--surface-2)", color: "var(--ink-1)", cursor: "pointer" }}>重新加载</button>
      </div>
    </div>
  );
}
