import { useEffect, useId, useRef } from "react";

export type ConfirmDialogRequest = {
  title: string;
  message?: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
};

/**
 * 替代原生 window.confirm 的确认弹窗。
 *
 * 原生 confirm 在 Electron 中是系统级模态框：无法承载多行结构化信息、样式与设计
 * 系统脱节、且不可键盘/读屏定制。本组件承载「风险档位降仓」「模拟下单等待确认」
 * 这类需要展示多条建议的确认场景。
 *
 * 默认聚焦「取消」——这些确认多用于危险/降级操作，回车误触不应直接生效。
 */
export function ConfirmDialog({
  request,
  onResolve
}: {
  request: ConfirmDialogRequest | null;
  onResolve: (confirmed: boolean) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!request || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Native top-layer modality makes the background inert and contains Tab focus.
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true });
      else {
        const fallback = document.querySelector<HTMLElement>('main h1, main');
        if (fallback) {
          const previous = fallback.getAttribute('tabindex');
          fallback.setAttribute('tabindex', '-1');
          fallback.focus({ preventScroll: true });
          if (previous === null) fallback.removeAttribute('tabindex');
          else fallback.setAttribute('tabindex', previous);
        }
      }
    };
  }, [request]);

  if (!request) return null;
  const tone = request.tone || "default";

  return (
      <dialog
        ref={dialogRef}
        className={`confirm-dialog tone-${tone}`}
        onCancel={event => { event.preventDefault(); onResolve(false); }}
        onMouseDown={event => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onResolve(false);
        }}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={request.message || request.details?.length ? descriptionId : undefined}
      >
        <h2 id={titleId} className="confirm-title">{request.title}</h2>
        <div id={descriptionId} className="confirm-body">
          {request.message && <p>{request.message}</p>}
          {!!request.details?.length && (
            <ul>{request.details.map((item, index) => <li key={index}>{item}</li>)}</ul>
          )}
        </div>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="secondary-btn" onClick={() => onResolve(false)}>
            {request.cancelLabel || "取消"}
          </button>
          <button type="button" className={tone === "danger" ? "danger-btn" : "primary-btn"} onClick={() => onResolve(true)}>
            {request.confirmLabel || "确认"}
          </button>
        </div>
      </dialog>
  );
}
