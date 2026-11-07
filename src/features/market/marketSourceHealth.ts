// 行情来源健康度 → 界面提示。
// 规则：同花顺免费行情正常时不打扰；它不可用但有接力时给一条状态提示；三路都不可用时给告警。
// 仍处于「尚未请求」（idle）的线路不算故障，避免刚启动时误报。

export type SourceHealthNotice = {
  tone: "relay" | "down";
  /** 同一故障期内保持不变，用于「关闭提示」只关掉当前这一次故障。 */
  key: string;
  message: string;
};

const LABELS: Record<string, string> = {
  fuyao: "同花顺扶摇行情",
  ths_free: "同花顺免费行情",
  eastmoney: "东方财富",
  tencent: "腾讯"
};

const failing = (entry?: MarketSourceHealthEntry) => entry?.status === "open" || entry?.status === "degraded";

function retryText(entry: MarketSourceHealthEntry | undefined, now: number) {
  const retryAt = Date.parse(String(entry?.retryAt || ""));
  if (!Number.isFinite(retryAt) || retryAt <= now) return "正在自动重试";
  const seconds = Math.max(1, Math.round((retryAt - now) / 1000));
  return `${seconds} 秒后自动重试`;
}

export function describeSourceHealth(health: MarketSourceHealth | null | undefined, now = Date.now()): SourceHealthNotice | null {
  const quotes = Array.isArray(health?.quotes) ? health!.quotes : [];
  const byId = new Map(quotes.map((entry) => [entry.id, entry]));
  const ths = byId.get("ths_free");
  const relays = ["eastmoney", "tencent"].map((id) => byId.get(id));
  const workingRelay = relays.find((entry) => entry?.status === "ok");
  const allDown = quotes.length > 0 && quotes.every((entry) => failing(entry));
  if (allDown) {
    return {
      tone: "down",
      key: `down:${quotes.map((entry) => entry.lastFailAt || "").join("|").slice(0, 80)}`,
      message: `行情三路暂均不可用（${quotes.map((entry) => LABELS[entry.id] || entry.name).join("、")}），${retryText(ths, now)}；页面保留最后一次成功的数据。`
    };
  }
  // 配置了扶摇时它是报价首选：扶摇不可用而同花顺免费行情正常，也给一条接力提示。
  const fuyao = byId.get("fuyao");
  if (failing(fuyao) && !failing(ths)) {
    const reason = String(fuyao?.lastError || "").replace(/\s+/g, " ").slice(0, 48);
    return {
      tone: "relay",
      key: `relay-fuyao:${fuyao?.lastFailAt || ""}`,
      message: `同花顺扶摇行情暂不可用${reason ? `（${reason}）` : ""}，已由同花顺免费行情接力，${retryText(fuyao, now)}；恢复后自动切回。`
    };
  }
  if (!failing(ths)) return null;
  const reason = String(ths?.lastError || "").replace(/\s+/g, " ").slice(0, 48);
  const relay = workingRelay ? (LABELS[workingRelay.id] || workingRelay.name) : "备用线路";
  return {
    tone: "relay",
    key: `relay:${ths?.lastFailAt || ""}`,
    message: `同花顺免费行情暂不可用${reason ? `（${reason}）` : ""}，已由${relay}接力，${retryText(ths, now)}；恢复后自动切回。`
  };
}

export function sourceStatusLabel(entry?: MarketSourceHealthEntry) {
  if (!entry || entry.status === "idle") return "待首次请求";
  if (entry.status === "ok") return "正常";
  if (entry.status === "open") return "连续失败 · 暂停重试中";
  return "最近一次失败";
}
