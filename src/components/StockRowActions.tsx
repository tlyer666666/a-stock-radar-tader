import type { MouseEvent } from "react";
import { Bell, Bookmark, BookmarkCheck, ClipboardPlus } from "lucide-react";

export type StockRowActionsProps = {
  security: Security;
  isFavorite?: boolean | undefined;
  isPlanned?: boolean | undefined;
  onToggleFavorite?: ((security: Security) => void) | undefined;
  onOpenMonitor?: ((security: Security) => void) | undefined;
  onAddPlan?: ((security: Security) => void) | undefined;
  compact?: boolean | undefined;
  className?: string | undefined;
};

export default function StockRowActions({
  security,
  isFavorite = false,
  isPlanned = false,
  onToggleFavorite,
  onOpenMonitor,
  onAddPlan,
  compact = false,
  className
}: StockRowActionsProps) {
  if (!onToggleFavorite && !onOpenMonitor && !onAddPlan) return null;

  const stop = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const iconSize = compact ? 11 : 12;

  return (
    <div
      className={`stock-row-actions${compact ? " is-compact" : ""}${className ? ` ${className}` : ""}`}
      style={{ display: "inline-flex", alignItems: "center", gap: compact ? 3 : 6, flexWrap: compact ? "nowrap" : "wrap", whiteSpace: compact ? "nowrap" : undefined }}
      onClick={stop}
    >
      {onToggleFavorite && (
        <button
          type="button"
          className={`table-action${isFavorite ? " active" : ""}`}
          aria-label={isFavorite ? `移出自选 ${security.name} ${security.code}` : `加入自选 ${security.name} ${security.code}`}
          title={isFavorite ? "移出自选监控" : "加入自选监控"}
          onClick={event => {
            event.stopPropagation();
            onToggleFavorite(security);
          }}
        >
          {isFavorite ? <BookmarkCheck size={iconSize} /> : <Bookmark size={iconSize} />}
          {isFavorite ? "已自选" : "+自选"}
        </button>
      )}
      {onOpenMonitor && (
        <button
          type="button"
          className="table-action"
          aria-label={`为 ${security.name} ${security.code} 设置盯盘预警`}
          title="加入自选并设置实时条件盯盘"
          onClick={event => {
            event.stopPropagation();
            onOpenMonitor(security);
          }}
        >
          <Bell size={iconSize} />
          +盯盘
        </button>
      )}
      {onAddPlan && (
        <button
          type="button"
          className={`table-action${isPlanned ? " active" : ""}`}
          aria-label={isPlanned ? `编辑 ${security.name} ${security.code} 次日观察计划` : `将 ${security.name} ${security.code} 加入次日观察计划`}
          title={isPlanned ? "已在次日观察计划中，点击可调整参数" : "设定买点与止损并加入次日观察计划"}
          onClick={event => {
            event.stopPropagation();
            onAddPlan(security);
          }}
        >
          <ClipboardPlus size={iconSize} />
          {isPlanned ? "已计划" : "+计划"}
        </button>
      )}
    </div>
  );
}
