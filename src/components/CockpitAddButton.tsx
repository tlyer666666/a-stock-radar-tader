import { useCallback, useState, type ReactNode } from "react";
import { ClipboardPlus } from "lucide-react";
import QuickPlanModal, { usePlannedCodes, type QuickPlanTarget } from "./QuickPlanModal";

type CockpitSecurity = Pick<Security, "code" | "name" | "secid">;

/** 纯展示的「+驾驶舱」按钮：已加入状态和打开弹窗都由外部提供，适合在长列表里大量渲染。 */
export function CockpitAddTrigger({ security, source, referencePrice, className = "table-action", planned, onOpen }: {
  security: CockpitSecurity;
  source: string;
  referencePrice?: number | null | undefined;
  className?: string | undefined;
  planned: boolean;
  onOpen: (target: QuickPlanTarget) => void;
}) {
  if (!/^\d{6}$/.test(security.code)) return null;
  return <button
    type="button"
    className={`${className}${planned ? " active" : ""}`}
    aria-label={planned ? `调整 ${security.name} ${security.code} 的驾驶舱计划` : `将 ${security.name} ${security.code} 加入今日驾驶舱`}
    title={planned ? "已在今日驾驶舱，点击可调整买点与止损" : "一键加入今日驾驶舱（按现价设买入区 -1%~+2%、止损 -6%，保留 5 个交易日）"}
    onClick={event => {
      event.stopPropagation();
      onOpen({ code: security.code, name: security.name, secid: security.secid, referencePrice, source });
    }}
  >
    <ClipboardPlus size={12} />
    {planned ? "已在驾驶舱" : "+驾驶舱"}
  </button>;
}

/**
 * 列表宿主共用一份已加入状态和一个弹窗：每页只读一次计划存储、只注册一组监听，
 * 行内只渲染 CockpitAddTrigger，避免每行各挂一套 usePlannedCodes + QuickPlanModal。
 */
export function useCockpitAdd(onShowToast?: (message: string) => void): {
  plannedCodes: Set<string>;
  open: (target: QuickPlanTarget) => void;
  modal: ReactNode;
} {
  const [plannedCodes, setPlannedCodes] = usePlannedCodes();
  const [target, setTarget] = useState<QuickPlanTarget | null>(null);
  const open = useCallback((next: QuickPlanTarget) => setTarget(next), []);
  const modal = <QuickPlanModal
    target={target}
    onClose={() => setTarget(null)}
    onSaved={res => { setPlannedCodes(prev => new Set(prev).add(res.code)); onShowToast?.(res.message); }}
    onError={message => onShowToast?.(message)}
  />;
  return { plannedCodes, open, modal };
}

export default function CockpitAddButton({ security, source, referencePrice, className = "table-action", onShowToast }: {
  security: CockpitSecurity;
  source: string;
  referencePrice?: number | null | undefined;
  className?: string | undefined;
  onShowToast?: ((message: string) => void) | undefined;
}) {
  const cockpit = useCockpitAdd(onShowToast);
  if (!/^\d{6}$/.test(security.code)) return null;
  return <>
    <CockpitAddTrigger
      security={security}
      source={source}
      referencePrice={referencePrice}
      className={className}
      planned={cockpit.plannedCodes.has(security.code)}
      onOpen={cockpit.open}
    />
    {cockpit.modal}
  </>;
}
