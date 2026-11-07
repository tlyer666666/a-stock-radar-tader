export { tradeSignalLabel } from "../../domain/executionLabels";

export const limitPoolProviderLabel = (providers: string[] = []) => {
  const hasThs = providers.some((item) => String(item).startsWith("ths"));
  const hasEastmoney = providers.some((item) => String(item).startsWith("eastmoney"));
  if (hasThs && hasEastmoney) return "同花顺主源 · 东方财富补全校验";
  if (hasThs) return "同花顺";
  if (hasEastmoney) return "东方财富";
  if (providers.some((item) => String(item).startsWith("tencent"))) return "腾讯";
  if (providers.some((item) => String(item).startsWith("preview"))) return "预览数据";
  return "公开行情";
};
