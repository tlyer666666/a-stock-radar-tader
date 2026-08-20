export type ComparePayload = {
  security: Security;
  quote: Record<string, any>;
  history: Array<Record<string, any>>;
  analysis: Record<string, any>;
  sector?: Record<string, any> | null;
  actualProvider?: string;
  updatedAt?: string;
};

type CompareApi = Pick<
  Window["stockApi"],
  "analyze" | "getQuoteSnapshot" | "getChart"
>;

const reasonMessage = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : String(reason || fallback);

export const selectCompareTargets = <T extends { payload: unknown }>(
  selected: Security[],
  results: Record<string, T | undefined>,
  forceReload: boolean
) => forceReload
  ? selected
  : selected.filter((security) => !results[security.code]?.payload);

export const loadComparePayload = async (
  security: Security,
  api: CompareApi
): Promise<ComparePayload> => {
  try {
    return await api.analyze(security);
  } catch (analysisError) {
    const [snapshotResult, chartResult] = await Promise.allSettled([
      api.getQuoteSnapshot(security),
      api.getChart(security, "101", {
        range: "3m",
        limit: 90,
        adjustment: "front"
      })
    ]);
    if (snapshotResult.status === "rejected" && chartResult.status === "rejected") {
      throw new Error([
        reasonMessage(analysisError, "深度策略分析失败"),
        `实时报价：${reasonMessage(snapshotResult.reason, "请求失败")}`,
        `日线数据：${reasonMessage(chartResult.reason, "请求失败")}`
      ].join("；"));
    }
    const snapshot = snapshotResult.status === "fulfilled" ? snapshotResult.value : null;
    const chart = chartResult.status === "fulfilled" ? chartResult.value : null;
    const fallbackRisks = [
      reasonMessage(analysisError, "该股票当前仅返回基础市场数据"),
      ...(snapshotResult.status === "rejected"
        ? [`实时报价暂不可用：${reasonMessage(snapshotResult.reason, "请求失败")}`]
        : []),
      ...(chartResult.status === "rejected"
        ? [`日线数据暂不可用：${reasonMessage(chartResult.reason, "请求失败")}`]
        : [])
    ];
    return {
      security: snapshot?.security || security,
      quote: snapshot?.quote || {},
      history: Array.isArray(chart?.rows) ? chart.rows : [],
      analysis: {
        trendLabel: "深度策略暂不可用",
        risks: fallbackRisks
      },
      sector: null,
      actualProvider:
        snapshot?.actualProvider || snapshot?.provider || chart?.source || "行情源",
      updatedAt:
        snapshot?.updatedAt || chart?.updatedAt || new Date().toISOString()
    };
  }
};
