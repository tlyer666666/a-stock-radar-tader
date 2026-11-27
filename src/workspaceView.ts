export const WORKSPACE_VIEWS = [
  "cockpit",
  "dashboard",
  "previous-limit-up-failed",
  "favorites",
  "holdings",
  "watchlist",
  "sectors",
  "beijing",
  "bonds",
  "etf",
  "hsgt",
  "news",
  "announcements",
  "settings",
  "backtest",
  "review",
  "signals",
  "ai-picks",
  "ai-agent",
  "t-assistant",
  "notes",
  "decision",
  "trend-screener",
  "compare"
] as const;

export type WorkspaceView = typeof WORKSPACE_VIEWS[number];
