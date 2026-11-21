import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ClipboardPlus, X } from "lucide-react";
import { addToCockpit, emitAppToast, COCKPIT_TOAST_ACTION } from "../features/cockpit/cockpitAdd";
import { inferSecid } from "../domain/securityIdentifiers";
import {
  TREND_PLAN_STORAGE_KEY,
  readTrendPlans,
  saveQuickObservationPlan,
  writeTrendPlans,
  type SavedTrendPlan
} from "../trendWorkspace";

function readActivePlan(code: string): SavedTrendPlan | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return readTrendPlans(window.localStorage).plans.find(plan => !plan.archivedAt && plan.candidate.security.code === code) || null;
  } catch {
    return null;
  }
}

function readPlannedCodeSet(): Set<string> {
  try {
    if (typeof window === "undefined" || !window.localStorage) return new Set();
    return new Set(
      readTrendPlans(window.localStorage)
        .plans.filter(plan => !plan.archivedAt)
        .map(plan => plan.candidate.security.code)
    );
  } catch {
    return new Set();
  }
}

export function usePlannedCodes(enabled = true) {
  const [plannedCodes, setPlannedCodes] = useState<Set<string>>(() => (enabled ? readPlannedCodeSet() : new Set()));

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const sync = (event?: Event) => {
      if (event && "key" in event) {
        const storageEvent = event as StorageEvent;
        if (storageEvent.key !== null && storageEvent.key !== TREND_PLAN_STORAGE_KEY) return;
      }
      setPlannedCodes(readPlannedCodeSet());
    };
    window.addEventListener("storage", sync);
    window.addEventListener("a-stock-radar:trend-plans-updated", sync);
    return () => {
      if (typeof window.removeEventListener === "function") {
        window.removeEventListener("storage", sync);
        window.removeEventListener("a-stock-radar:trend-plans-updated", sync);
      }
    };
  }, [enabled]);

  return [plannedCodes, setPlannedCodes] as const;
}

export type QuickPlanTarget = {
  code: string;
  name: string;
  secid?: string | undefined;
  referencePrice?: number | null | undefined;
  atr?: number | null | undefined;
  asOf?: string | undefined;
  defaultNote?: string | undefined;
  source?: string | undefined;
};

export type QuickPlanModalProps = {
  target: QuickPlanTarget | null;
  onClose: () => void;
  onSaved?: ((result: { code: string; name: string; created: boolean; message: string }) => void) | undefined;
  onError?: ((message: string) => void) | undefined;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** 无 ATR 时的默认止损比例，与一键加入驾驶舱（AGENTS.md：止损 -6%）保持一致。 */
const DEFAULT_STOP_RATIO = 0.94;

export function computeDefaults(refPrice: number | null | undefined, atr: number | null | undefined) {
  const ref = Number(refPrice);
  if (!Number.isFinite(ref) || ref <= 0) {
    return { buyLow: "", buyHigh: "", stopPrice: "", targetPrice: "" };
  }
  const hasAtr = typeof atr === "number" && Number.isFinite(atr) && atr > 0 && atr < ref * 0.4;
  const stop = hasAtr
    ? round2(Math.max(0.01, ref - atr * 1.5))
    : round2(Math.max(0.01, ref * DEFAULT_STOP_RATIO));
  const buyLow = round2(Math.max(stop + 0.01, ref * 0.99));
  const buyHigh = round2(Math.max(buyLow, ref * 1.02));
  const target = hasAtr
    ? round2(ref + atr * 3)
    : round2(ref * 1.1);
  return {
    buyLow: buyLow.toFixed(2),
    buyHigh: buyHigh.toFixed(2),
    stopPrice: stop.toFixed(2),
    targetPrice: target.toFixed(2)
  };
}

export function QuickPlanDialogContent({
  target,
  onClose,
  onSaved,
  onError
}: {
  target: QuickPlanTarget;
  onClose: () => void;
  onSaved?: QuickPlanModalProps["onSaved"];
  onError?: QuickPlanModalProps["onError"];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [existingPlan] = useState(() => readActivePlan(target.code));
  const initialDefaults = (() => {
    const saved = existingPlan?.candidate.plan;
    if (!saved) return computeDefaults(target.referencePrice, target.atr);
    return {
      buyLow: (saved.minEntry ?? saved.maxEntry).toFixed(2),
      buyHigh: saved.maxEntry.toFixed(2),
      stopPrice: saved.stop.toFixed(2),
      targetPrice: existingPlan?.reviewDraft?.fields.targetPrice || ""
    };
  })();
  const [buyLow, setBuyLow] = useState(initialDefaults.buyLow);
  const [buyHigh, setBuyHigh] = useState(initialDefaults.buyHigh);
  const [stopPrice, setStopPrice] = useState(initialDefaults.stopPrice);
  const [targetPrice, setTargetPrice] = useState(initialDefaults.targetPrice);
  const [note, setNote] = useState(existingPlan?.reviewDraft?.fields.note || target.defaultNote || "");
  const [formError, setFormError] = useState("");
  const [fetchedRef, setFetchedRef] = useState<number | null>(
    typeof target.referencePrice === "number" && Number.isFinite(target.referencePrice) && target.referencePrice > 0
      ? target.referencePrice
      : null
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open && typeof dialog.showModal === "function") {
      dialog.showModal();
    }
    return () => {
      if (dialog.open && typeof dialog.close === "function") {
        dialog.close();
      }
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    if (fetchedRef !== null) return undefined;
    if (typeof window === "undefined" || typeof window.stockApi?.getQuoteSnapshot !== "function") return undefined;
    let active = true;
    const sec: Security = {
      code: target.code,
      name: target.name,
      secid: target.secid || inferSecid(target.code),
      assetType: "stock"
    };
    void window.stockApi.getQuoteSnapshot(sec).then(snap => {
      if (!active) return;
      const latest = Number(snap?.quote?.latest ?? snap?.quote?.price ?? snap?.quote?.preClose);
      if (!Number.isFinite(latest) || latest <= 0) return;
      setFetchedRef(latest);
      const next = computeDefaults(latest, target.atr);
      setBuyLow(prev => prev || next.buyLow);
      setBuyHigh(prev => prev || next.buyHigh);
      setStopPrice(prev => prev || next.stopPrice);
      setTargetPrice(prev => prev || next.targetPrice);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [fetchedRef, target.atr, target.code, target.name, target.secid]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (typeof window === "undefined" || !window.localStorage) {
      setFormError("当前环境不支持本地存储");
      return;
    }
    const low = Number(buyLow);
    const high = Number(buyHigh);
    const stop = Number(stopPrice);
    const take = targetPrice.trim() ? Number(targetPrice) : Number.NaN;

    if (!Number.isFinite(low) || low <= 0 || !Number.isFinite(high) || high <= 0) {
      setFormError("请填写有效的低吸与最高参考买入价");
      return;
    }
    if (low > high) {
      setFormError("买入区间下限不能高于上限");
      return;
    }
    if (!Number.isFinite(stop) || stop <= 0) {
      setFormError("请填写有效的止损价");
      return;
    }
    if (stop >= low) {
      setFormError("止损价应低于买入区间下限");
      return;
    }
    if (targetPrice.trim() && (!Number.isFinite(take) || take <= high)) {
      setFormError("目标价应高于买入区间上限");
      return;
    }

    const refPrice = fetchedRef ?? round2((low + high) / 2);
    const stopPctRaw = refPrice > 0 ? ((refPrice - stop) / refPrice) * 100 : 5;
    const stopPercent = Number.isFinite(stopPctRaw) && stopPctRaw > 1 && stopPctRaw <= 20 ? stopPctRaw : 5;
    const trimmedNote = note.trim().slice(0, 120);
    const reasonParts = [
      `区间 ${low.toFixed(2)}~${high.toFixed(2)}`,
      `止损 ${stop.toFixed(2)}`,
      ...(Number.isFinite(take) ? [`目标 ${take.toFixed(2)}`] : []),
      ...(trimmedNote ? [trimmedNote] : [])
    ];
    const reason = reasonParts.join(" · ");

    const res = saveQuickObservationPlan(window.localStorage, {
      code: target.code,
      name: target.name,
      secid: target.secid || inferSecid(target.code),
      referencePrice: refPrice,
      asOf: target.asOf,
      reason,
      stopPercent,
      source: target.source
    });

    if (!res.ok) {
      setFormError(res.error);
      onError?.(res.error);
      return;
    }

    // Patch the saved plan with the user's explicit buyLow/buyHigh/stopPrice/targetPrice/note.
    const read = readTrendPlans(window.localStorage);
    if (!read.error && read.plans.length > 0) {
      const riskPct = Math.max(0.5, round2(((high - stop) / high) * 100));
      const updatedPlans: SavedTrendPlan[] = read.plans.map(plan => {
        if (plan.id !== res.plan.id) return plan;
        const existingFields = plan.reviewDraft?.fields || {};
        const existingChecks = plan.reviewDraft?.checks || {};
        return {
          ...plan,
          candidate: {
            ...plan.candidate,
            evidence: [
              {
                label: "驾驶舱观察计划",
                passed: true,
                value: reason.slice(0, 60),
                rule: "手动设定入场区间、止损与目标位"
              }
            ],
            plan: {
              entryType: plan.candidate.plan?.entryType || "close-confirmation",
              stop: round2(stop),
              minEntry: round2(low),
              maxEntry: round2(high),
              maxRiskPercent: riskPct,
              holdingDays: plan.candidate.plan?.holdingDays || "3~10 个交易日"
            }
          },
          reviewDraft: {
            fields: {
              ...existingFields,
              ...(Number.isFinite(take) ? { targetPrice: take.toFixed(2) } : {}),
              ...(trimmedNote ? { note: trimmedNote } : {})
            },
            checks: existingChecks
          }
        };
      });
      writeTrendPlans(window.localStorage, updatedPlans);
    }

    const message = res.created
      ? `${target.name}（${target.code}）已加入今日驾驶舱`
      : `已更新 ${target.name}（${target.code}）的驾驶舱计划`;
    emitAppToast(message, COCKPIT_TOAST_ACTION);
    onSaved?.({ code: target.code, name: target.name, created: res.created, message });
    onClose();
  };

  const riskPercentPreview = (() => {
    const high = Number(buyHigh);
    const stop = Number(stopPrice);
    if (!Number.isFinite(high) || !Number.isFinite(stop) || high <= 0 || stop <= 0 || stop >= high) return null;
    return (((high - stop) / high) * 100).toFixed(2);
  })();

  const rrPreview = (() => {
    const low = Number(buyLow);
    const stop = Number(stopPrice);
    const take = Number(targetPrice);
    if (!Number.isFinite(low) || !Number.isFinite(stop) || !Number.isFinite(take) || low <= stop || take <= low) return null;
    return ((take - low) / (low - stop)).toFixed(2);
  })();

  return (
    <dialog
      ref={dialogRef}
      className="quick-plan-dialog"
      aria-labelledby={titleId}
      style={{
        padding: 0,
        border: "1px solid var(--border, rgba(148, 163, 184, 0.28))",
        borderRadius: 12,
        background: "var(--surface, var(--panel-bg, #161b26))",
        color: "var(--text, inherit)",
        width: "min(460px, 92vw)",
        maxWidth: "92vw",
        boxShadow: "0 18px 48px rgba(0, 0, 0, 0.35)"
      }}
      onMouseDown={event => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        ) {
          onClose();
        }
      }}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onClick={event => event.stopPropagation()}
    >
      <form onSubmit={handleSubmit} style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ClipboardPlus size={18} />
            <div>
              <h3 id={titleId} style={{ margin: 0, fontSize: 16 }}>
                {existingPlan ? "调整驾驶舱计划" : "加入今日驾驶舱"} · {target.name} <small style={{ opacity: 0.72 }}>{target.code}</small>
              </h3>
              <small style={{ opacity: 0.7 }}>
                {existingPlan
                  ? `已在今日驾驶舱 · 加入于 ${existingPlan.savedAt.slice(0, 10)}，改完点保存`
                  : fetchedRef !== null
                  ? `参考价 ${fetchedRef.toFixed(2)} 元${target.atr && target.atr > 0 ? ` · ATR 预填止损` : " · 默认 -6% 止损"}`
                  : "请填写参考买入区间与止损位"}
              </small>
            </div>
          </div>
          <button type="button" className="secondary-btn" aria-label="关闭驾驶舱计划弹窗" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span>低吸参考价 (buyLow)</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label="买入区间下限"
              value={buyLow}
              onChange={event => { setBuyLow(event.target.value); setFormError(""); }}
              placeholder="如 14.50"
              autoFocus
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span>最高入场价 (buyHigh)</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label="买入区间上限"
              value={buyHigh}
              onChange={event => { setBuyHigh(event.target.value); setFormError(""); }}
              placeholder="如 15.00"
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span>防守止损价 (stopPrice)</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label="止损价"
              value={stopPrice}
              onChange={event => { setStopPrice(event.target.value); setFormError(""); }}
              placeholder="如 13.80"
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span>预期目标价 (targetPrice)</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label="目标价"
              value={targetPrice}
              onChange={event => { setTargetPrice(event.target.value); setFormError(""); }}
              placeholder="如 16.50（可选）"
            />
          </label>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <span>观察备注 (note)</span>
          <input
            type="text"
            aria-label="观察计划备注"
            value={note}
            onChange={event => setNote(event.target.value)}
            maxLength={120}
            placeholder="开盘承接条件、板块联动或减仓纪律（可选）"
          />
        </label>

        {(riskPercentPreview || rrPreview) && (
          <div style={{ fontSize: 12, opacity: 0.8, display: "flex", gap: 14 }}>
            {riskPercentPreview && <span>上限止损风险：<b>{riskPercentPreview}%</b></span>}
            {rrPreview && <span>估算盈亏比：<b>{rrPreview}:1</b></span>}
          </div>
        )}

        {formError && <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger, #ef4444)" }}>{formError}</p>}

        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="secondary-btn" onClick={onClose}>取消</button>
          <button type="submit" className="primary-btn">
            <ClipboardPlus size={15} />{existingPlan ? "保存调整" : "加入驾驶舱"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function OneClickCockpitAdd({ target, onClose, onSaved, onError, onNeedDialog }: {
  target: QuickPlanTarget;
  onClose: () => void;
  onSaved?: QuickPlanModalProps["onSaved"];
  onError?: QuickPlanModalProps["onError"];
  onNeedDialog: () => void;
}) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (typeof window === "undefined" || !window.localStorage) {
      onError?.("当前环境不支持本地存储");
      onClose();
      return;
    }
    void addToCockpit(window.localStorage, target, target.source || "手动加入").then(result => {
      if (result.ok) {
        emitAppToast(result.message, COCKPIT_TOAST_ACTION);
        onSaved?.({ code: target.code, name: target.name, created: result.created, message: result.message });
        onClose();
        return;
      }
      onError?.(result.message);
      onNeedDialog();
    });
  }, [onClose, onError, onNeedDialog, onSaved, target]);
  return null;
}

function QuickPlanFlow({ target, onClose, onSaved, onError }: QuickPlanModalProps & { target: QuickPlanTarget }) {
  const [dialog, setDialog] = useState(() => readActivePlan(target.code) !== null);
  const openDialog = useRef(() => setDialog(true)).current;
  if (!dialog) return <OneClickCockpitAdd target={target} onClose={onClose} onSaved={onSaved} onError={onError} onNeedDialog={openDialog} />;
  return createPortal(<QuickPlanDialogContent target={target} onClose={onClose} onSaved={onSaved} onError={onError} />, document.body);
}

export default function QuickPlanModal({ target, onClose, onSaved, onError }: QuickPlanModalProps) {
  if (!target || typeof document === "undefined") return null;
  return <QuickPlanFlow key={`${target.code}:${target.referencePrice ?? ""}`} target={target} onClose={onClose} onSaved={onSaved} onError={onError} />;
}
