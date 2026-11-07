/** Data coverage belongs to a universe; a failed read is not a negative rule match. */
type Coverage = { requested?: number | undefined; processed?: number | undefined; failed?: number | undefined; invalid?: number | undefined; stale?: number | undefined; missing?: number | undefined; benchmarkReady?: boolean | undefined; note?: string | undefined };
export type SelectionCoverageReport = {
  universeSize?: number | undefined; processed?: number | undefined; failed?: number | undefined;
  dataQuality?: { requested?: number | undefined; processed?: number | undefined; invalid?: number | undefined; stale?: number | undefined; missing?: number | undefined; benchmarkReady?: boolean | undefined } | undefined;
  universeCoverage?: { failed?: number | undefined; requestsComplete?: boolean | undefined } | undefined;
  watchlistCoverage?: Coverage | undefined;
};
export type SelectionDataState = { state: "ready" | "partial" | "unavailable" | "empty-universe"; title: string; description: string };
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
const ready: SelectionDataState = { state: "ready", title: "本轮未选出股票", description: "全市场（剔除ST）中当前没有股票同时满足本策略条件。" };

export function selectionDataState(report: SelectionCoverageReport | null | undefined, universe = "limit_pool"): SelectionDataState {
  if (!report) return ready;
  const personal = universe === "watchlist";
  const coverage = personal ? report.watchlistCoverage : undefined;
  // Legacy reports may not describe the custom universe. Do not infer its state
  // from the unrelated limit-up pool or overwrite actual custom picks.
  if (personal && !coverage) return ready;
  const requested = count(personal ? coverage?.requested : report.universeSize ?? report.dataQuality?.requested);
  const processed = count(personal ? coverage?.processed : report.processed ?? report.dataQuality?.processed);
  const failed = count(personal ? coverage?.failed : report.failed) ?? 0;
  const quality = personal ? coverage : report.dataQuality;
  // 稳定资格排除由后端计入 excluded；invalid/stale/missing 在任何股票池都是数据缺口。
  const invalid = (count(quality?.invalid) ?? 0) + (count(quality?.stale) ?? 0) + (count(quality?.missing) ?? 0);
  const benchmarkMissing = (personal ? coverage?.benchmarkReady : report.dataQuality?.benchmarkReady) === false;
  const poolFailed = personal ? 0 : count(report.universeCoverage?.failed) ?? 0;
  if (requested === 0 && poolFailed) return { state: "unavailable", title: "股票名单暂不可用", description: "全市场股票名单读取未完成，尚不能判断是否有符合条件的股票。请查看下方失败诊断，恢复后重新选股。" };
  if (requested === 0) return { state: "empty-universe", title: "当前股票池为空", description: personal ? "自选、观察池与持仓中没有可选股票；添加股票后重新选股。" : "当前来源未提供可选候选；请核对数据日与股票池覆盖情况后重新选股。" };
  if (processed === 0 && (failed > 0 || invalid > 0 || benchmarkMissing)) {
    return { state: "unavailable", title: "行情暂不可用，尚不能完成选股判断", description: `本轮${requested === null ? "" : ` ${requested} 只候选`}没有取得可用于判断的有效行情${failed ? `，其中 ${failed} 只读取失败` : ""}。请查看失败诊断，数据恢复后重新选股；当前状态不代表策略未命中。` };
  }
  if (failed || invalid || poolFailed || benchmarkMissing || (!personal && report.universeCoverage?.requestsComplete === false)) {
    return { state: "partial", title: "可用数据中未选出股票", description: `仅对本轮已取得的有效数据完成筛选；${failed ? `${failed} 只候选读取失败，` : ""}部分来源或必要字段未齐，不能据此判断完整股票池均未命中。` };
  }
  return ready;
}

export function selectionSummaryDataState(report: SelectionCoverageReport | null | undefined, hasPicks: boolean): SelectionDataState {
  const pool = selectionDataState(report);
  const personal = selectionDataState(report, "watchlist");
  const unavailable = pool.state === "unavailable" || personal.state === "unavailable";
  if (!hasPicks && unavailable && !(report?.processed || report?.watchlistCoverage?.processed)) {
    return pool.state === "unavailable" ? pool : personal;
  }
  if (unavailable || pool.state === "partial" || personal.state === "partial") return {
    state: "partial", title: "可用数据中未选出股票",
    description: "部分股票池行情暂不可用，仅对已取得有效数据的股票完成筛选；查看下方各股票池覆盖与失败诊断后重试。"
  };
  return pool.state === "empty-universe" && (report?.watchlistCoverage?.requested || 0) > 0 ? personal : pool;
}
