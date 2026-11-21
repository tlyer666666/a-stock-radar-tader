import { inferSecid } from "../../domain/securityIdentifiers";
import { saveQuickObservationPlan } from "../../trendWorkspace";

type PlanStorage = Pick<Storage, "getItem" | "setItem">;

export type CockpitAddTarget = {
  code: string;
  name: string;
  secid?: string | undefined;
  referencePrice?: number | null | undefined;
  asOf?: string | undefined;
  defaultNote?: string | undefined;
};

export type CockpitAddResult = { ok: boolean; created: boolean; message: string };

export const COCKPIT_TOAST_EVENT = "a-stock-radar:toast";
export type AppToastAction = { label: string; view: string };

export function emitAppToast(text: string, action?: AppToastAction): boolean {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function" || typeof CustomEvent !== "function") return false;
  try {
    window.dispatchEvent(new CustomEvent(COCKPIT_TOAST_EVENT, { detail: { text, action } }));
    return true;
  } catch {
    return false;
  }
}

export const COCKPIT_TOAST_ACTION: AppToastAction = { label: "去驾驶舱", view: "cockpit" };

const validPrice = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;

export async function fetchLatestPrice(target: CockpitAddTarget): Promise<number | null> {
  if (typeof window === "undefined" || typeof window.stockApi?.getQuoteSnapshot !== "function") return null;
  try {
    const snapshot = await window.stockApi.getQuoteSnapshot({ code: target.code, name: target.name, secid: target.secid || inferSecid(target.code), assetType: "stock" });
    const latest = Number(snapshot?.quote?.latest ?? snapshot?.quote?.price ?? snapshot?.quote?.preClose);
    return validPrice(latest) ? latest : null;
  } catch {
    return null;
  }
}

export async function addToCockpit(
  storage: PlanStorage,
  target: CockpitAddTarget,
  source: string,
  fetchPrice: (target: CockpitAddTarget) => Promise<number | null> = fetchLatestPrice
): Promise<CockpitAddResult> {
  const label = `${target.name}（${target.code}）`;
  const price = validPrice(target.referencePrice) ? Number(target.referencePrice) : await fetchPrice(target);
  if (!validPrice(price)) return { ok: false, created: false, message: `${label} 暂时取不到现价，未能加入驾驶舱，请稍后再试` };
  const result = saveQuickObservationPlan(storage, {
    code: target.code,
    name: target.name,
    secid: target.secid,
    referencePrice: price,
    asOf: target.asOf,
    reason: target.defaultNote,
    source
  });
  if (!result.ok) return { ok: false, created: false, message: `加入驾驶舱失败：${result.error}` };
  return result.created
    ? { ok: true, created: true, message: `${label} 已加入今日驾驶舱 · 止损 ${result.plan.candidate.plan?.stop.toFixed(2)}` }
    : { ok: true, created: false, message: `${label} 已在今日驾驶舱` };
}

export function cockpitBatchMessage(result: { created: string[]; existing: string[]; missingPrice: string[]; invalid?: string[] }): string {
  const parts = [
    result.created.length ? `新增 ${result.created.length} 只` : "",
    result.existing.length ? `${result.existing.length} 只已在驾驶舱` : "",
    result.missingPrice.length ? `${result.missingPrice.length} 只缺少现价已跳过` : "",
    result.invalid?.length ? `${result.invalid.length} 只代码无效已跳过` : ""
  ].filter(Boolean);
  return parts.length ? `批量加入驾驶舱：${parts.join("，")}` : "没有新增到驾驶舱的股票";
}
