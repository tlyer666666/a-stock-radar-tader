/** 「我的股票」AI 打分：清单整理和体检数据的文字展示。 */
export const AI_CUSTOM_MAX = 40;

const signed = (value: number | null | undefined, suffix = "%") =>
  value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;

/** 体检数据的几条要点：近 5/20 日涨幅、量比、均线位置、涨停记录。 */
export function profileFacts(profile: Partial<AiStockProfile> | undefined): string[] {
  if (!profile) return [];
  const facts = [`近5日 ${signed(profile.return5)}`, `近20日 ${signed(profile.return20)}`];
  if (profile.volumeRatio !== null && profile.volumeRatio !== undefined) facts.push(`量比 ${profile.volumeRatio.toFixed(2)}`);
  if (profile.trend) facts.push(profile.trend);
  if (profile.consecutiveBoards && profile.consecutiveBoards > 0) facts.push(`${profile.consecutiveBoards}连板`);
  else if (profile.daysSinceLimit !== null && profile.daysSinceLimit !== undefined) facts.push(`距最近涨停 ${profile.daysSinceLimit} 天`);
  if (profile.limitUps20) facts.push(`近20日涨停 ${profile.limitUps20} 次`);
  if (profile.limitReason) facts.push(`涨停原因：${profile.limitReason}`);
  const notices = profile.announcements ? profile.announcements.length : profile.noticeCount;
  if (profile.announcementsAvailable === false) facts.push("公告未取到");
  else if (typeof notices === "number") {
    const negative = profile.announcements ? profile.announcements.filter(item => item.direction === "利空" || item.direction === "多空交织").length : profile.noticeNegative || 0;
    const severe = profile.announcements ? profile.announcements.some(item => item.risk >= 3) : profile.noticeRisk === true;
    facts.push(notices ? `近30天公告 ${notices} 条${negative ? `（利空 ${negative}）` : ""}${severe ? "，有重大风险公告" : ""}` : "近30天无公告");
  }
  return facts;
}

export { signed as signedPercent };

/**
 * 把新股票并进清单：去重、只收 6 位代码、总数不超过 40。
 * 返回新清单，以及新加了几只、因重复或超额没加的有几只。
 */
export function mergeCustomStocks(list: AiCustomStock[], additions: Array<{ code: string; name?: string | undefined }>, max = AI_CUSTOM_MAX) {
  const next = [...list];
  let added = 0, duplicate = 0, overflow = 0;
  for (const item of additions) {
    const code = String(item?.code || "").trim();
    if (!/^\d{6}$/.test(code)) continue;
    if (next.some(existing => existing.code === code)) { duplicate += 1; continue; }
    if (next.length >= max) { overflow += 1; continue; }
    next.push({ code, name: String(item.name || code).replace(/\s+/g, "").slice(0, 12) || code });
    added += 1;
  }
  return { list: next, added, duplicate, overflow };
}

/** 导入结果的一句话提示。 */
export function mergeNotice(source: string, result: { added: number; duplicate: number; overflow: number }) {
  const parts = [`从${source}加入 ${result.added} 只`];
  if (result.duplicate) parts.push(`${result.duplicate} 只已在清单里`);
  if (result.overflow) parts.push(`${result.overflow} 只因清单已满 ${AI_CUSTOM_MAX} 只没加`);
  return `${parts.join("，")}。`;
}
