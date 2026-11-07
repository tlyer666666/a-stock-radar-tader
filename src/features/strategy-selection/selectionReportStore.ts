/**
 * 策略选股的最新一轮结果在页面之间共享（策略选股页、AI 选股页都读写这里），
 * 切换页面时不必重新选股。另带一个“待交给我的策略编辑器的大白话描述”。
 */
type Listener = () => void;

let latest: unknown = null;
const listeners = new Set<Listener>();
let pendingStrategyText = "";

export function getSelectionReport<T>(): T | null {
  return latest as T | null;
}

export function setSelectionReport<T>(report: T | null): void {
  latest = report;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* 单个页面出错不影响其他页面 */ }
  }
}

export function subscribeSelectionReport(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** AI 选股页「用大白话建策略」：把描述交给策略选股页，打开「我的策略」编辑器后由 AI 配好条件、用户确认保存。 */
export function setPendingStrategyText(text: string): void {
  pendingStrategyText = String(text || "").trim().slice(0, 400);
}

export function takePendingStrategyText(): string {
  const text = pendingStrategyText;
  pendingStrategyText = "";
  return text;
}
