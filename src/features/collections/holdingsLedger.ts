import {
  normalizeStockMonitorConfig,
  type StockMonitorConfig
} from "../../stockMonitorRules";

export type HoldingTradeSide = "buy" | "sell";

export type HoldingTradeInput = {
  items: HoldingItem[];
  code: string;
  name?: string | undefined;
  secid?: string | undefined;
  thscode?: string | undefined;
  marketName?: string | undefined;
  side: HoldingTradeSide;
  shares: number;
  price: number;
  note?: string | undefined;
  now?: string | undefined;
};

export type HoldingTradeResult =
  | {
      ok: true;
      nextItems: HoldingItem[];
      action: "opened" | "added" | "reduced" | "closed";
      remainingShares: number;
      costPrice: number;
      realizedPnl: number | null;
      summary: string;
    }
  | { ok: false; error: string };

export type ParsedHoldingRow = {
  line: number;
  code: string;
  name: string;
  shares: number;
  costPrice: number;
  note: string;
};

import { inferSecurityMeta } from "../../domain/securityIdentifiers";

export { inferSecurityMeta };

export type HoldingsPasteParseResult = {
  entries: ParsedHoldingRow[];
  errors: string[];
};

export function maskSensitiveText(value: string, masked: boolean, fallback = "***"): string {
  return masked ? fallback : value;
}

const roundPrice = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * 按真实交易记录重算持仓数量与加权摊薄成本价：
 * - 加仓：合并原有持仓与本次买入股数，重新计算每股持仓成本。
 * - 减仓：扣减对应股数并估算当笔已实现盈亏；若剩余 <= 0 视为清仓移除。
 */
export function applyHoldingTrade(input: HoldingTradeInput): HoldingTradeResult {
  const code = String(input.code || "").trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "请输入 6 位证券代码" };

  const rawShares = Number(input.shares);
  if (!Number.isFinite(rawShares) || !Number.isSafeInteger(rawShares) || rawShares <= 0) {
    return { ok: false, error: "成交股数必须是大于 0 的整数" };
  }
  const shares = rawShares;

  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: "成交均价必须大于 0" };
  }

  const now = input.now || new Date().toISOString();
  const existing = input.items.find(item => item.code === code);
  const noteTrimmed = typeof input.note === "string" ? input.note.trim().slice(0, 160) : "";

  if (input.side === "buy") {
    const meta = inferSecurityMeta(code);
    const totalShares = existing ? existing.shares + shares : shares;
    const weightedCost = existing
      ? roundPrice((existing.shares * existing.costPrice + shares * price) / totalShares)
      : roundPrice(price);
    const resolvedName = String(input.name || existing?.name || code).trim().slice(0, 24) || code;
    const resolvedThscode = existing?.thscode || input.thscode || meta.thscode;
    const resolvedMarketName = existing?.marketName || input.marketName || meta.marketName;
    const nextItem: HoldingItem = {
      ...meta,
      ...(existing || {}),
      code,
      name: resolvedName,
      secid: existing?.secid || input.secid || meta.secid,
      ...(resolvedThscode ? { thscode: resolvedThscode } : {}),
      ...(resolvedMarketName ? { marketName: resolvedMarketName } : {}),
      shares: totalShares,
      costPrice: weightedCost,
      note: noteTrimmed || existing?.note || "",
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    const nextItems = [...input.items.filter(item => item.code !== code), nextItem]
      .sort((left, right) => left.code.localeCompare(right.code));
    const action = existing ? "added" : "opened";
    return {
      ok: true,
      nextItems,
      action,
      remainingShares: totalShares,
      costPrice: weightedCost,
      realizedPnl: null,
      summary: existing
        ? `${resolvedName} 已加仓 ${shares} 股 @ ${price.toFixed(2)}，总计 ${totalShares} 股，摊薄成本 ${weightedCost.toFixed(3)}`
        : `${resolvedName} 已建仓 ${totalShares} 股，成本 ${weightedCost.toFixed(3)}`
    };
  }

  if (!existing) {
    return { ok: false, error: `持仓中没有 ${code}，无法执行减仓卖出` };
  }

  if (shares > existing.shares) {
    return { ok: false, error: `卖出股数（${shares} 股）不能超过当前持仓（${existing.shares} 股）` };
  }

  const realizedPnl = Math.round((price - existing.costPrice) * shares * 100) / 100;
  const remainingShares = existing.shares - shares;

  if (remainingShares === 0) {
    const nextItems = input.items.filter(item => item.code !== code);
    return {
      ok: true,
      nextItems,
      action: "closed",
      remainingShares: 0,
      costPrice: existing.costPrice,
      realizedPnl,
      summary: `${existing.name} 已清仓卖出 ${existing.shares} 股 @ ${price.toFixed(2)}，估算实现盈亏 ${realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(2)} 元`
    };
  }

  const nextItem: HoldingItem = {
    ...existing,
    shares: remainingShares,
    note: noteTrimmed || existing.note || "",
    updatedAt: now
  };
  const nextItems = [...input.items.filter(item => item.code !== code), nextItem]
    .sort((left, right) => left.code.localeCompare(right.code));
  return {
    ok: true,
    nextItems,
    action: "reduced",
    remainingShares,
    costPrice: existing.costPrice,
    realizedPnl,
    summary: `${existing.name} 已减仓 ${shares} 股 @ ${price.toFixed(2)}，剩余 ${remainingShares} 股（成本 ${existing.costPrice.toFixed(3)}）`
  };
}

const stripCodeDecorators = (token: string): string => {
  const cleaned = token.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, "").replace(/^[01]\./, "");
  return /^\d{6}$/.test(cleaned) ? cleaned : "";
};

const parsePositiveNumber = (token: string): number => {
  const cleaned = token.trim().replace(/,/g, "").replace(/[股元¥￥]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return Number.NaN;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
};

function splitHoldingColumns(line: string): string[] {
  // Prefer tab columns first so formatted thousands like `1,200` inside a TSV cell stay intact.
  if (line.includes("\t")) {
    return line
      .split(/\t+/)
      .flatMap(cell => cell.trim().split(/[;；，、|]+|\s{2,}/))
      .map(part => part.trim())
      .filter(Boolean);
  }
  const normalized = line
    .replace(/,\s+/g, "\t")
    .replace(/[，、;|]+/g, "\t");
  const commaDelimitedHeaderOrCode = /^\s*(?:(?:[01]\.)?\d{6}(?:\.(?:SH|SZ|BJ))?|[^,\t]+,\s*(?:[01]\.)?\d{6}(?:\.(?:SH|SZ|BJ))?)\s*,/i.test(normalized);
  if (!normalized.includes("\t") && normalized.includes(",") && (!/\s/.test(normalized) || commaDelimitedHeaderOrCode)) {
    return normalized.split(",").map(part => part.trim()).filter(Boolean);
  }
  return normalized
    .split(/[\t\s]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

/**
 * 解析多行文本导入（支持空格、制表符 TSV、中英文逗号 CSV）。
 * 常见格式：
 * - `600519 贵州茅台 200 1480.5`
 * - `600519,200,1480.5`
 * - `东方财富\t300059\t1,200股\t21.8元 核底仓`
 */
export function parseHoldingsPaste(rawText: string): HoldingsPasteParseResult {
  const lines = String(rawText || "").split(/\r?\n/);
  const byCode = new Map<string, ParsedHoldingRow>();
  const errors: string[] = [];

  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    if (/^(证券代码|股票代码|代码|名称|stock)/i.test(trimmed) && !/\d{6}/.test(trimmed)) return;

    const rawTokens = splitHoldingColumns(trimmed);
    const tokens = rawTokens.length >= 4 && /^(?:序号)?\d{1,3}[.)、]?$/.test(rawTokens[0] || "") && !stripCodeDecorators(rawTokens[0] || "")
      ? rawTokens.slice(1)
      : rawTokens;

    let codeIndex = -1;
    let code = "";
    for (let i = 0; i < Math.min(2, tokens.length); i += 1) {
      const candidate = stripCodeDecorators(tokens[i] || "");
      if (candidate) {
        code = candidate;
        codeIndex = i;
        break;
      }
    }

    if (!code) {
      errors.push(`第 ${index + 1} 行未识别到 6 位股票代码：${trimmed.slice(0, 32)}`);
      return;
    }

    let name = "";
    let remaining: string[];
    if (codeIndex === 1) {
      name = tokens[0]!.slice(0, 24);
      remaining = tokens.slice(2);
    } else {
      remaining = tokens.slice(1);
      if (remaining.length > 0 && Number.isNaN(parsePositiveNumber(remaining[0] || ""))) {
        name = remaining.shift()!.slice(0, 24);
      }
    }

    const sharesToken = remaining[0] ?? "";
    const priceToken = remaining[1] ?? "";
    const shares = parsePositiveNumber(sharesToken);
    const costPrice = parsePositiveNumber(priceToken);

    if (!Number.isSafeInteger(shares) || shares <= 0 || !Number.isFinite(costPrice) || costPrice <= 0) {
      errors.push(`第 ${index + 1} 行（${code}）缺少有效的数量或成本价，格式示例：600519 贵州茅台 200 1480.5`);
      return;
    }

    const note = remaining.slice(2).join(" ").slice(0, 160);
    byCode.set(code, {
      line: index + 1,
      code,
      name: name || code,
      shares,
      costPrice: roundPrice(costPrice),
      note
    });
  });

  return {
    entries: [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code)),
    errors
  };
}

export function mergeImportedHoldings(
  existing: HoldingItem[],
  entries: ParsedHoldingRow[],
  resolvedNames?: Record<string, Security>,
  now = new Date().toISOString()
): HoldingItem[] {
  const byCode = new Map(existing.map(item => [item.code, item]));
  for (const row of entries) {
    const prev = byCode.get(row.code);
    const looked = resolvedNames?.[row.code];
    const meta = inferSecurityMeta(row.code);
    const resolvedName = looked?.name || (row.name !== row.code ? row.name : "") || prev?.name || row.code;
    byCode.set(row.code, {
      ...meta,
      ...(prev || {}),
      ...(looked || {}),
      code: row.code,
      name: resolvedName,
      secid: looked?.secid || prev?.secid || meta.secid,
      shares: row.shares,
      costPrice: row.costPrice,
      note: row.note || prev?.note || "",
      createdAt: prev?.createdAt || now,
      updatedAt: now
    });
  }
  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
}

/**
 * 为持仓生成快捷止损盯盘规则：
 * - 若有有效参考价（现价或成本价），生成 `latest <= 参考价*(1+stopPct/100)` 条件。
 * - 否则降级为当日跌幅 `changePct <= stopPct` 预警。
 */
export function buildStopLossMonitorConfig(
  referencePrice: number | null | undefined,
  stopPct = -5,
  existing?: StockMonitorConfig | null
): StockMonitorConfig | null {
  const pct = Number.isFinite(stopPct) && stopPct < 0 && stopPct > -50 ? stopPct : -5;
  const ref = Number(referencePrice);
  const stopCondition = Number.isFinite(ref) && ref > 0
    ? {
        id: `quick-stop-price-${Math.abs(pct)}`,
        field: "latest" as const,
        operator: "lte" as const,
        value: Math.max(0.01, Math.round(ref * (1 + pct / 100) * 100) / 100)
      }
    : {
        id: `quick-stop-pct-${Math.abs(pct)}`,
        field: "changePct" as const,
        operator: "lte" as const,
        value: pct
      };

  const preserved = (existing?.conditions || []).filter(item => !item.id.startsWith("quick-stop-"));
  const conditions = [stopCondition, ...preserved].slice(0, 6);
  return normalizeStockMonitorConfig({
    enabled: true,
    mode: existing?.mode || "any",
    cooldownMinutes: existing?.cooldownMinutes || 15,
    conditions
  });
}

export function computeMonitorStopPrice(config: StockMonitorConfig | null | undefined): number | null {
  if (!config?.enabled) return null;
  const priceRules = config.conditions
    .filter(item => item.field === "latest" && item.operator === "lte" && item.value > 0)
    .map(item => item.value);
  if (!priceRules.length) return null;
  return Math.max(...priceRules);
}
