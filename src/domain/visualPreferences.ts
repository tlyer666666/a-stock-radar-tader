export const UI_SCALE_STORAGE_KEY = "a-stock-radar:ui-scale:v1";
export const COLOR_VISION_STORAGE_KEY = "a-stock-radar:color-vision:v1";
export const DISPLAY_DENSITY_STORAGE_KEY = "astock:display-density:v1";

export const UI_SCALE_PRESETS = [90, 100, 110, 120, 125] as const;
export type UiScale = (typeof UI_SCALE_PRESETS)[number];

export type SettingsCategoryId = "sources" | "monitoring" | "execution" | "strategies" | "ai" | "backup";

const VALID_SETTINGS_CATEGORIES = new Set<SettingsCategoryId>([
  "sources",
  "monitoring",
  "execution",
  "strategies",
  "ai",
  "backup"
]);

export function normalizeSettingsCategory(raw?: string | null): SettingsCategoryId {
  if (!raw) return "sources";
  if (raw === "appearance") return "monitoring";
  if (VALID_SETTINGS_CATEGORIES.has(raw as SettingsCategoryId)) return raw as SettingsCategoryId;
  return "sources";
}

export function normalizeUiScale(raw: unknown): UiScale {
  const n = Number(raw);
  return (UI_SCALE_PRESETS as readonly number[]).includes(n) ? (n as UiScale) : 100;
}

export function stepUiScale(current: number, delta: -1 | 1): UiScale {
  const idx = (UI_SCALE_PRESETS as readonly number[]).indexOf(current);
  if (idx !== -1) {
    const nextIdx = Math.max(0, Math.min(UI_SCALE_PRESETS.length - 1, idx + delta));
    return UI_SCALE_PRESETS[nextIdx]!;
  }
  if (delta > 0) {
    return UI_SCALE_PRESETS.find(v => v > current) ?? UI_SCALE_PRESETS[UI_SCALE_PRESETS.length - 1]!;
  }
  return [...UI_SCALE_PRESETS].reverse().find(v => v < current) ?? UI_SCALE_PRESETS[0]!;
}

export function applyUiScale(scale: number): UiScale {
  const normalized = normalizeUiScale(scale);
  if (typeof window === "undefined" || typeof document === "undefined") return normalized;
  const stockApi = (
    window as {
      stockApi?: {
        setZoomFactor?: ((factor: number) => Promise<unknown>) | undefined;
        getReviewTheme?: (() => Promise<unknown>) | undefined;
      } | undefined;
    }
  ).stockApi;
  const setZoomFactor = stockApi?.setZoomFactor;
  if (typeof setZoomFactor === "function") {
    document.documentElement.style.zoom = "";
    void Promise.resolve(setZoomFactor(normalized / 100)).catch(() => {
      document.documentElement.style.zoom = normalized === 100 ? "" : `${normalized}%`;
    });
  } else if (typeof stockApi?.getReviewTheme === "function") {
    // 独立复盘窗口由主进程统一通过 webContents.setZoomFactor 控制缩放，避免叠加 CSS zoom 造成双重放大。
    document.documentElement.style.zoom = "";
  } else {
    document.documentElement.style.zoom = normalized === 100 ? "" : `${normalized}%`;
  }
  return normalized;
}

export function applySavedVisualPreferences(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  try {
    const rawScale = Number(window.localStorage?.getItem(UI_SCALE_STORAGE_KEY) || "100");
    applyUiScale(rawScale);
    const cvd = window.localStorage?.getItem(COLOR_VISION_STORAGE_KEY) === "cvd" ? "cvd" : "standard";
    document.documentElement.dataset.colorVision = cvd;
    const rawDensity = window.localStorage?.getItem(DISPLAY_DENSITY_STORAGE_KEY);
    if (rawDensity === '"comfortable"' || rawDensity === '"compact"') {
      document.documentElement.dataset.density = rawDensity === '"comfortable"' ? "comfortable" : "compact";
    }
  } catch {
    // ignore storage errors
  }
}
