import { useEffect, useRef } from "react";
import { useReportHsgtOverlay } from "../features/hsgt/overlayContext";
import type { StockMonitorConfig } from "../stockMonitorRules";
import StockMonitorEditor from "./StockMonitorEditor";

type QuickMonitorModalProps = {
  stock: Security | null;
  config?: StockMonitorConfig | undefined;
  onSave: (security: Security, next: StockMonitorConfig) => boolean | Promise<boolean>;
  onClose: () => void;
};

export function QuickMonitorModal({ stock, config, onSave, onClose }: QuickMonitorModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useReportHsgtOverlay(Boolean(stock));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !stock) return undefined;
    previousFocusRef.current = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    try {
      if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    } catch {
      /* fallback in test/non-dialog environments */
    }
    return () => {
      try {
        if (dialog.open && typeof dialog.close === "function") dialog.close();
      } catch {
        /* ignore close errors */
      }
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (prev && typeof prev.focus === "function" && typeof document !== "undefined" && document.contains(prev)) {
        prev.focus({ preventScroll: true });
      }
    };
  }, [stock]);

  if (!stock) return null;

  return (
    <dialog
      ref={dialogRef}
      className="quick-palette-native-dialog"
      data-overlay="open"
      aria-label={`设置 ${stock.name} 盯盘条件`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="palette-dialog" style={{ maxWidth: 520, padding: 18 }}>
        <StockMonitorEditor
          stock={{ code: stock.code, name: stock.name }}
          config={config}
          onSave={async (next) => {
            const ok = await onSave(stock, next);
            if (ok) onClose();
            return ok;
          }}
          onCancel={onClose}
        />
      </div>
    </dialog>
  );
}
