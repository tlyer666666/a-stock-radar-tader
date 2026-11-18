import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Command, Compass, Search, TrendingUp, X, Zap } from "lucide-react";
import { buildPaletteEntries, type PaletteActionItem, type PaletteEntry } from "./quickPaletteModel";
import { inferSecid } from "../../domain/securityIdentifiers";

type QuickPaletteProps = {
  open: boolean;
  onClose: () => void;
  views: PaletteActionItem[];
  commands: PaletteActionItem[];
  holdings: HoldingItem[];
  favorites: WatchItem[];
  watchlist: WatchItem[];
  onNavigateView: (viewId: string) => void;
  onOpenStock: (security: Security) => void;
  onRunCommand: (commandId: string) => void;
};

export default function QuickPaletteModal({
  open,
  onClose,
  views,
  commands,
  holdings,
  favorites,
  watchlist,
  onNavigateView,
  onOpenStock,
  onRunCommand
}: QuickPaletteProps) {
  const [query, setQuery] = useState("");
  const [remoteStocks, setRemoteStocks] = useState<Security[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchGeneration = useRef(0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setRemoteStocks([]);
      setActiveIndex(0);
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed || !window.stockApi?.search) {
      setRemoteStocks([]);
      return;
    }
    const reqId = ++searchGeneration.current;
    const timer = window.setTimeout(() => {
      void window.stockApi
        .search(trimmed)
        .then(res => {
          if (searchGeneration.current !== reqId) return;
          setRemoteStocks(Array.isArray(res) ? res.slice(0, 8) : []);
        })
        .catch(() => {
          if (searchGeneration.current === reqId) setRemoteStocks([]);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const entries = useMemo(
    () =>
      buildPaletteEntries({
        query,
        views,
        commands,
        holdings,
        favorites,
        watchlist,
        remoteStocks
      }),
    [query, views, commands, holdings, favorites, watchlist, remoteStocks]
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query, entries.length]);

  const executeEntry = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    onClose();
    if (entry.kind === "stock") onOpenStock(entry.security);
    else if (entry.kind === "view") onNavigateView(entry.viewId);
    else onRunCommand(entry.commandId);
  };

  if (!open) return null;

  return (
    <div
      className="quick-palette-backdrop"
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="quick-palette-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="全局快速跳转"
      >
        <div className="quick-palette-head">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex(i => (entries.length ? (i + 1) % entries.length : 0));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex(i => (entries.length ? (i - 1 + entries.length) % entries.length : 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (entries[activeIndex]) executeEntry(entries[activeIndex]);
                else if (/^\d{6}$/.test(query.trim())) {
                  const code = query.trim();
                  onClose();
                  onOpenStock({ code, name: code, secid: inferSecid(code) });
                }
              }
            }}
            placeholder="输入股票代码/名称、工作区（如 驾驶舱 / 做T / 持仓）或快捷指令…"
            aria-label="搜索跳转目标"
          />
          <kbd className="quick-palette-kbd">ESC</kbd>
          <button type="button" className="quick-palette-close" onClick={onClose} aria-label="关闭快速跳转">
            <X size={15} />
          </button>
        </div>

        <div className="quick-palette-list" role="listbox" aria-label="跳转结果">
          {entries.length === 0 ? (
            <div className="quick-palette-empty">
              未匹配到相关工作区或证券，可直接输入 6 位股票代码按 Enter 打开个股页。
            </div>
          ) : (
            entries.map((entry, idx) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={idx === activeIndex}
                className={`quick-palette-item${idx === activeIndex ? " active" : ""}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => executeEntry(entry)}
              >
                <span className="quick-palette-icon">
                  {entry.kind === "stock" ? <TrendingUp size={15} /> : entry.kind === "command" ? <Zap size={15} /> : <Compass size={15} />}
                </span>
                <span className="quick-palette-main">
                  <b>{entry.title}</b>
                  <small>{entry.subtitle}</small>
                </span>
                {entry.badge && <em className="quick-palette-badge">{entry.badge}</em>}
                <ArrowRight size={14} className="quick-palette-go" />
              </button>
            ))
          )}
        </div>

        <footer className="quick-palette-foot">
          <span><Command size={12} />K / Ctrl+K 打开</span>
          <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
        </footer>
      </section>
    </div>
  );
}
