export const UI_SCALE_STORAGE_KEY = "a-stock-radar:ui-scale:v1";
export const COLOR_VISION_STORAGE_KEY = "a-stock-radar:color-vision:v1";
export const DISPLAY_DENSITY_STORAGE_KEY = "astock:display-density:v1";

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

export function applySavedVisualPreferences(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  try {
    const rawScale = Number(window.localStorage?.getItem(UI_SCALE_STORAGE_KEY) || "100");
    const scale = [90, 100, 110, 120].includes(rawScale) ? rawScale : 100;
    document.documentElement.style.zoom = scale === 100 ? "" : `${scale}%`;
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
