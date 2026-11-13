import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";

/**
 * AI 打分榜的勾选：勾几只就只给这几只打分，也可以把勾选的移除/删除。
 * 勾选只在本页有效（换数据日或清单变了会自动去掉不在表里的）。
 */
export function useRowSelection(codes: string[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const key = codes.join(",");
  useEffect(() => {
    const present = new Set(key ? key.split(",") : []);
    setSelected(current => {
      const next = new Set([...current].filter(code => present.has(code)));
      return next.size === current.size ? current : next;
    });
  }, [key]);
  const toggle = useCallback((code: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  }), []);
  const setMany = useCallback((list: string[], on: boolean) => setSelected(current => {
    const next = new Set(current);
    for (const code of list) { if (on) next.add(code); else next.delete(code); }
    return next;
  }), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const list = useMemo(() => codes.filter(code => selected.has(code)), [codes, selected]);
  return { selected, list, toggle, setMany, clear };
}

type Selection = ReturnType<typeof useRowSelection>;

/** 表头：勾选/取消本页全部。 */
export function AiSelectAllHeader({ selection, pageCodes }: { selection: Selection; pageCodes: string[] }) {
  const all = pageCodes.length > 0 && pageCodes.every(code => selection.selected.has(code));
  const some = !all && pageCodes.some(code => selection.selected.has(code));
  return <th scope="col" className="ai-select-col">
    <input type="checkbox" aria-label="勾选本页全部股票" checked={all} ref={node => { if (node) node.indeterminate = some; }}
      disabled={!pageCodes.length} onChange={() => selection.setMany(pageCodes, !all)} />
  </th>;
}

/** 每行第一格：勾选框 + 移除按钮（点这一格不会打开个股页）。 */
export function AiSelectCell({ selection, code, name, removeLabel, onRemove, removeDisabled = false }: {
  selection: Selection; code: string; name: string; removeLabel: string; onRemove?: (() => void) | undefined; removeDisabled?: boolean;
}) {
  return <td className="ai-select-col" onClick={event => event.stopPropagation()}>
    <span className="ai-select-cell">
      <input type="checkbox" aria-label={`勾选 ${name}`} checked={selection.selected.has(code)} onChange={() => selection.toggle(code)} />
      {onRemove && <button type="button" className="ai-row-remove" disabled={removeDisabled} title={`${removeLabel}：${name}`} aria-label={`${removeLabel} ${name}`} onClick={onRemove}><X size={13} /></button>}
    </span>
  </td>;
}

/** 表格上方一行：已勾选几只、移除勾选、取消勾选；有被移除的股票时可恢复。 */
export function AiSelectionBar({ selection, removeLabel, onRemoveSelected, removedCount = 0, onRestore, hint, removeDisabled = false }: {
  selection: Selection; removeLabel: string; onRemoveSelected: () => void; removedCount?: number; onRestore?: (() => void) | undefined; hint: string; removeDisabled?: boolean;
}) {
  const count = selection.list.length;
  return <div className="ai-selection-bar" role="group" aria-label="勾选操作">
    <span role="status" aria-live="polite">{count ? <b>已勾选 {count} 只</b> : hint}</span>
    {count > 0 && <>
      <button type="button" className="secondary-btn danger-btn" disabled={removeDisabled} onClick={onRemoveSelected}><Trash2 size={14} />{removeLabel}勾选的 {count} 只</button>
      <button type="button" className="secondary-btn" onClick={selection.clear}>取消勾选</button>
    </>}
    {removedCount > 0 && onRestore && <span className="ai-selection-removed">已移除 {removedCount} 只
      <button type="button" className="link-btn" disabled={removeDisabled} onClick={onRestore}><RotateCcw size={13} />恢复</button></span>}
  </div>;
}

/** 已返回的模型不足时，股票仍列在待补打范围里。旧结果没有模型明细时按单模型处理。 */
export function scoringCoverage(ranking: AiRanking | null, codes: string[], expectedModels: number) {
  const current = new Set(codes);
  const items = (ranking?.items || []).filter(item => current.has(item.code));
  const answered = items.filter(item => !item.fallback);
  const complete = new Set(answered.filter(item => (item.scores?.length ?? 1) >= expectedModels).map(item => item.code));
  return { complete, answered: answered.length, missing: codes.length - complete.size, fallback: items.length - answered.length };
}

/** 勾选优先；已有结果时只补齐缺失股票，主进程按模型跳过已经打过的项。 */
export function scoreAction({ selected, scored, total, answered = scored.size }: {
  selected: string[]; scored: Set<string>; total: string[]; answered?: number;
}) {
  if (selected.length) return { label: `给勾选的 ${selected.length} 只打分`, force: true, only: selected };
  const unscored = total.filter(code => !scored.has(code));
  if (!answered) return { label: "AI 打分", force: false, only: undefined };
  if (unscored.length) return { label: `补齐 ${unscored.length} 只打分`, force: false, only: unscored };
  return { label: "全部重新打分", force: true, only: undefined };
}

export function AiScoringCoverage({ coverage, expectedModels }: {
  coverage: ReturnType<typeof scoringCoverage>; expectedModels: number;
}) {
  return <small className="ai-selection-note" role="status">已齐 {coverage.complete.size} 只
    {expectedModels > 1 ? `（${expectedModels} 套模型）` : ""}
    {coverage.missing > 0 ? ` · 还差 ${coverage.missing} 只` : ""}
    {coverage.fallback > 0 ? ` · ${coverage.fallback} 只仅有基础分` : ""}</small>;
}
