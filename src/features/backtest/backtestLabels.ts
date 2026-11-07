export const overfitRiskLabel = (value: unknown) => {
  const risk = String(value || "").toLowerCase();
  if (risk === "low") return "低";
  if (risk === "medium" || risk === "moderate") return "中等";
  if (risk === "high") return "高";
  if (risk === "insufficient") return "样本不足";
  return risk ? "待人工复核" : "--";
};
