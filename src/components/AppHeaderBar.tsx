import { FormEvent, type MutableRefObject, type RefObject } from "react";
import {
  Bell,
  Command,
  Eye,
  EyeOff,
  LoaderCircle,
  Monitor,
  Moon,
  Radar,
  RefreshCw,
  Search,
  Sun,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import DisplayDensityControl from "./terminal/DisplayDensityControl";
import type { CopilotAlertItem, resolveMarketSessionPhase } from "../copilotBriefing";
import type { AnalysisPayload } from "../features/market/analysisTypes";
import type { WorkspaceView as View } from "../workspaceView";
import { canRefreshAnalysis } from "../workspaceExperience";

const themeOptions = [
  { id: "light" as const, label: "白天", icon: Sun },
  { id: "dark" as const, label: "黑夜", icon: Moon },
  { id: "system" as const, label: "跟随系统", icon: Monitor }
];

type AppHeaderBarProps = {
  workspaceLabel: string;
  view: View;
  dashboardMode: "pool" | "analysis";
  researchView: boolean;
  live: boolean;
  onToggleLive: () => void;
  loading: boolean;
  payload: AnalysisPayload | null;
  onRefreshAnalysis: () => void;
  settings: Settings;
  onSetTheme: (theme: "light" | "dark" | "system") => void;
  onToggleNewsVoice: () => void;
  onOpenPalette: () => void;
  privacyMask: boolean;
  onTogglePrivacyMask: () => void;
  query: string;
  setQuery: (value: string) => void;
  suggestions: Security[];
  setSuggestions: (items: Security[]) => void;
  searching: boolean;
  setSearching: (value: boolean) => void;
  searchError: string;
  setSearchError: (value: string) => void;
  searchComplete: boolean;
  setSearchComplete: (value: boolean) => void;
  searchComposing: boolean;
  setSearchComposing: (value: boolean) => void;
  searchComposingRef: MutableRefObject<boolean>;
  searchEditVersion: MutableRefObject<number>;
  searchRequestId: MutableRefObject<number>;
  searchTimer: MutableRefObject<number | undefined>;
  searchBoxRef: RefObject<HTMLFormElement | null>;
  onSearchSubmit: (event: FormEvent) => void;
  onFetchSuggestions: (text: string, requestId: number) => Promise<Security[] | null>;
  onSelectSuggestion: (item: Security) => void;
  copilotRef: RefObject<HTMLDivElement | null>;
  copilotOpen: boolean;
  setCopilotOpen: React.Dispatch<React.SetStateAction<boolean>>;
  copilotPhase: ReturnType<typeof resolveMarketSessionPhase>;
  copilotAlerts: CopilotAlertItem[];
  onCopilotSelect: (item: CopilotAlertItem) => void;
  holdingsCount: number;
  favoritesCount: number;
  awaitingNotesCount: number;
  tItemsCount: number;
  onNavigateView: (next: View) => void;
  hasMonitorAlerts?: boolean | undefined;
  onClearMonitorAlerts?: (() => void) | undefined;
};

export function renderAppHeaderBar({
  workspaceLabel,
  view,
  dashboardMode,
  researchView,
  live,
  onToggleLive,
  loading,
  payload,
  onRefreshAnalysis,
  settings,
  onSetTheme,
  onToggleNewsVoice,
  onOpenPalette,
  privacyMask,
  onTogglePrivacyMask,
  query,
  setQuery,
  suggestions,
  setSuggestions,
  searching,
  setSearching,
  searchError,
  setSearchError,
  searchComplete,
  setSearchComplete,
  searchComposing,
  setSearchComposing,
  searchComposingRef,
  searchEditVersion,
  searchRequestId,
  searchTimer,
  searchBoxRef,
  onSearchSubmit,
  onFetchSuggestions,
  onSelectSuggestion,
  copilotRef,
  copilotOpen,
  setCopilotOpen,
  copilotPhase,
  copilotAlerts,
  onCopilotSelect,
  holdingsCount,
  favoritesCount,
  awaitingNotesCount,
  tItemsCount,
  onNavigateView,
  hasMonitorAlerts,
  onClearMonitorAlerts
}: AppHeaderBarProps) {
  return (
    <header className="topbar">
      <div className="workspace-location">{workspaceLabel}</div>
      <form ref={searchBoxRef} className="search-box" onSubmit={onSearchSubmit}>
        <Search size={18} />
        <input
          id="global-security-search"
          value={query}
          onCompositionStart={() => {
            searchComposingRef.current = true;
            setSearchComposing(true);
            searchEditVersion.current += 1;
            searchRequestId.current += 1;
            window.clearTimeout(searchTimer.current);
            setSuggestions([]);
            setSearching(false);
            setSearchError("");
            setSearchComplete(false);
          }}
          onCompositionEnd={() => {
            searchComposingRef.current = false;
            setSearchComposing(false);
          }}
          onChange={(e) => {
            searchEditVersion.current += 1;
            searchRequestId.current += 1;
            setSuggestions([]);
            setSearchError("");
            setSearchComplete(false);
            setQuery(e.target.value);
          }}
          onKeyDown={(event) => {
            if (searchComposingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              if (event.key === "Enter") event.preventDefault();
              return;
            }
            if (event.key === "Escape") {
              searchEditVersion.current += 1;
              setQuery("");
              setSuggestions([]);
            } else if (event.key === "ArrowDown" && suggestions.length > 0) {
              event.preventDefault();
              document.querySelector<HTMLButtonElement>("#global-security-suggestions button")?.focus();
            }
          }}
          placeholder="搜索 A股、ETF、可转债（代码 / 名称 / 拼音）"
          role="combobox"
          aria-label="证券搜索：A股、ETF、可转债"
          aria-expanded={suggestions.length > 0}
          aria-controls="global-security-suggestions"
        />
        {searching && <LoaderCircle size={16} className="spin" />}
        {query && !searching && (
          <button type="button" onClick={() => { searchEditVersion.current += 1; setQuery(""); }} aria-label="清空证券搜索"><X size={15} /></button>
        )}
        {query.trim() && !searchComposing && suggestions.length === 0 && (searching || searchError || searchComplete) && (
          <div className="suggestions security-search-feedback" role={searchError ? "alert" : "status"} aria-live="polite">
            <p>{searching ? "正在搜索证券…" : searchError || `未找到“${query.trim()}”，请检查名称、代码或拼音`}</p>
            {searchError && (
              <button
                type="button"
                onClick={() => {
                  window.clearTimeout(searchTimer.current);
                  void onFetchSuggestions(query.trim(), ++searchRequestId.current);
                }}
              >
                重试搜索
              </button>
            )}
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="suggestions" id="global-security-suggestions" role="listbox">
            {suggestions.map((item) => (
              <button
                key={item.secid}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => onSelectSuggestion(item)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setQuery("");
                    document.querySelector<HTMLInputElement>("#global-security-search")?.focus();
                    return;
                  }
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  const options = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button") || [])];
                  const currentIndex = options.indexOf(event.currentTarget);
                  const nextIndex = event.key === "ArrowDown"
                    ? (currentIndex + 1) % options.length
                    : (currentIndex - 1 + options.length) % options.length;
                  options[nextIndex]?.focus();
                }}
              >
                <span><b>{item.name}</b><small>{item.code}</small></span>
                <em>{item.marketName}</em>
              </button>
            ))}
          </div>
        )}
      </form>
      <div className="top-actions">
        {researchView && <span className="trend-header-rule">策略驱动选股</span>}
        <DisplayDensityControl />
        <div className="theme-switch" aria-label="界面主题">
          {themeOptions.map((item) => (
            <button
              key={item.id}
              type="button"
              className={(settings.theme || "system") === item.id ? "active" : ""}
              onClick={() => onSetTheme(item.id)}
              title={item.label}
              aria-label={item.label}
              aria-pressed={(settings.theme || "system") === item.id}
            >
              <item.icon size={15} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        {!researchView && (
          <>
            <button className={`live-toggle ${live ? "on" : ""}`} onClick={onToggleLive} aria-pressed={live}>
              <span />
              {live ? "实时刷新" : "已暂停"}
            </button>
            {canRefreshAnalysis(view, dashboardMode) && (
              <button className="icon-button" onClick={onRefreshAnalysis} disabled={!payload || loading} title="刷新当前股票" aria-label="刷新当前股票">
                <RefreshCw size={18} className={loading ? "spin" : ""} />
              </button>
            )}
            <button
              type="button"
              className={`icon-button ${settings.newsVoiceEnabled === false ? "" : "voice-on"}`}
              aria-pressed={settings.newsVoiceEnabled !== false}
              aria-label={settings.newsVoiceEnabled === false ? "开启重大资讯自动播报" : "关闭重大资讯自动播报"}
              onClick={onToggleNewsVoice}
              title={settings.newsVoiceEnabled === false ? "开启重大资讯自动播报" : "关闭重大资讯自动播报"}
            >
              {settings.newsVoiceEnabled === false ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
          </>
        )}
        <button
          type="button"
          className="icon-button quick-palette-trigger"
          onClick={onOpenPalette}
          title="全局快速跳转 (⌘K / Ctrl+K)"
          aria-label="全局快速跳转"
        >
          <Command size={15} />
        </button>
        <button
          type="button"
          className={`icon-button privacy-mask-btn${privacyMask ? " active" : ""}`}
          onClick={onTogglePrivacyMask}
          aria-pressed={privacyMask}
          title={privacyMask ? "已隐藏持仓金额（点击恢复）" : "隐藏持仓与盈亏金额（脱敏模式）"}
          aria-label={privacyMask ? "关闭金额脱敏" : "开启金额脱敏"}
        >
          {privacyMask ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        <button
          type="button"
          className={`cockpit-jump-btn${view === "cockpit" ? " active" : ""}`}
          onClick={() => onNavigateView("cockpit")}
          title={`${copilotPhase.label} · 进入今日驾驶舱`}
          aria-label="今日驾驶舱"
        >
          <Radar size={15} />
          <span>{copilotPhase.label}</span>
        </button>
        <div className="copilot-inbox-wrap" ref={copilotRef}>
          <button
            type="button"
            className={`icon-button copilot-bell-btn ${copilotOpen ? "open" : ""}`}
            onClick={() => setCopilotOpen(open => !open)}
            title="智能副驾驶简报与预警收件箱"
            aria-label="智能副驾驶简报与预警收件箱"
            aria-expanded={copilotOpen}
            aria-haspopup="dialog"
          >
            <Bell size={18} />
            {copilotAlerts.length > 0 && <span className="copilot-badge">{copilotAlerts.length > 9 ? "9+" : copilotAlerts.length}</span>}
          </button>
          {copilotOpen && (
            <section className="copilot-popover" role="dialog" data-overlay="open" aria-label="智能副驾驶简报">
              <header className="copilot-popover-head">
                <div>
                  <strong>{copilotPhase.label}</strong>
                  <small>{copilotPhase.tip}</small>
                </div>
                <div className="copilot-head-actions">
                  {hasMonitorAlerts && onClearMonitorAlerts && (
                    <button type="button" className="link-btn" onClick={onClearMonitorAlerts}>清空盯盘已读</button>
                  )}
                  <button
                    type="button"
                    className="copilot-close-btn"
                    onClick={() => {
                      setCopilotOpen(false);
                      copilotRef.current?.querySelector<HTMLButtonElement>(".copilot-bell-btn")?.focus({ preventScroll: true });
                    }}
                    aria-label="关闭简报"
                  >
                    <X size={15} />
                  </button>
                </div>
              </header>
              <div className="copilot-stats-row">
                <span>持仓 {holdingsCount}</span>
                <span>自选 {favoritesCount}</span>
                <span>待提醒 {awaitingNotesCount}</span>
                <span>做T {tItemsCount}</span>
              </div>
              <div className="copilot-alert-list">
                {copilotAlerts.length === 0 ? (
                  <p className="copilot-empty">当前暂无触发的预警或风险提示</p>
                ) : (
                  copilotAlerts.map(item => (
                    <button key={item.id} type="button" className={`copilot-alert-item ${item.kind}`} onClick={() => onCopilotSelect(item)}>
                      <em>{item.tag}</em>
                      <span>
                        <b>{item.title}</b>
                        <small>{item.detail}</small>
                      </span>
                    </button>
                  ))
                )}
              </div>
              <footer className="copilot-popover-actions">
                <button type="button" className="secondary-btn" onClick={() => { setCopilotOpen(false); onNavigateView("cockpit"); }}>今日驾驶舱</button>
                <button type="button" className="secondary-btn" onClick={() => { setCopilotOpen(false); onNavigateView("news"); }}>资讯中心</button>
                <button type="button" className="secondary-btn" onClick={() => { setCopilotOpen(false); onNavigateView("review"); }}>智能复盘</button>
                <button type="button" className="secondary-btn" onClick={() => { setCopilotOpen(false); onNavigateView("ai-agent"); }}>AI 问股</button>
                <button type="button" className="secondary-btn" onClick={() => { setCopilotOpen(false); onNavigateView("t-assistant"); }}>做T助手</button>
                <button type="button" className="secondary-btn" onClick={() => { setCopilotOpen(false); onNavigateView("notes"); }}>随心记</button>
              </footer>
            </section>
          )}
        </div>
      </div>
    </header>
  );
}

export function AppHeaderBar(props: AppHeaderBarProps) {
  return renderAppHeaderBar(props);
}
