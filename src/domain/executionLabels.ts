export const executionStatusLabel = (value: unknown) => {
  const status = String(value || "WAIT").toUpperCase();
  if (status === "PASS" || status === "APPROVED") return "允许执行";
  if (status === "BLOCK" || status === "BLOCKED" || status === "REJECTED") {
    return "不可执行（风险否决）";
  }
  return "等待条件确认";
};

export const tradeSignalLabel = (value: unknown) => {
  const signal = String(value || "WAIT").toUpperCase();
  if (signal === "BUY_AGGRESSIVE") return "强势买入条件满足";
  if (signal === "BUY") return "买入条件满足";
  if (signal === "SELL") return "退出或回避";
  if (signal === "HOLD") return "继续观察";
  if (signal === "BLOCK") return "不可执行（风险否决）";
  return "等待条件确认";
};
