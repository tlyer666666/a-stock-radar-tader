import {
  normalizeStockMonitorConfig,
  type StockMonitorConfig
} from "../../stockMonitorRules";

export type HoldingTradeSide = "buy" | "sell";

export const HOLDING_TRADES_STORAGE_KEY = "a-stock-radar:holding-trades:v1";
export const MAX_HOLDING_TRADES = 300;

export type HoldingTradeRecord = {
  id: string;
  tradedAt: string;
  code: string;
  name: string;
  side: HoldingTradeSide;
  shares: number;
  price: number;
  realizedPnl: number | null;
  note?: string | undefined;
};

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
  diluteCost?: boolean | undefined;
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
  availableShares?: number | undefined;
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

  const nextCost = input.diluteCost
    ? Math.max(0.001, roundPrice((existing.shares * existing.costPrice - shares * price) / remainingShares))
    : existing.costPrice;

  const nextItem: HoldingItem = {
    ...existing,
    shares: remainingShares,
    costPrice: nextCost,
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
    costPrice: nextCost,
    realizedPnl,
    summary: `${existing.name} 已减仓 ${shares} 股 @ ${price.toFixed(2)}，剩余 ${remainingShares} 股（${input.diluteCost ? "摊薄成本" : "成本"} ${nextCost.toFixed(3)}）`
  };
}

const defaultTradeStorage = (): Pick<Storage, "getItem" | "setItem"> | null => {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

function isValidHoldingTradeRecord(value: unknown): value is HoldingTradeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.tradedAt === "string" &&
    Number.isFinite(Date.parse(r.tradedAt)) &&
    typeof r.code === "string" &&
    /^\d{6}$/.test(r.code) &&
    typeof r.name === "string" &&
    (r.side === "buy" || r.side === "sell") &&
    typeof r.shares === "number" &&
    Number.isSafeInteger(r.shares) &&
    r.shares > 0 &&
    typeof r.price === "number" &&
    Number.isFinite(r.price) &&
    r.price > 0 &&
    (r.realizedPnl === null || (typeof r.realizedPnl === "number" && Number.isFinite(r.realizedPnl)))
  );
}

export function loadHoldingTrades(storage: Pick<Storage, "getItem"> | null = defaultTradeStorage()): HoldingTradeRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(HOLDING_TRADES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records)
        ? (parsed as { records: unknown[] }).records
        : [];
    return list.filter(isValidHoldingTradeRecord).slice(0, MAX_HOLDING_TRADES);
  } catch {
    return [];
  }
}

export function appendHoldingTradeRecord(
  input: Omit<HoldingTradeRecord, "id" | "tradedAt"> & { id?: string | undefined; tradedAt?: string | undefined },
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultTradeStorage()
): HoldingTradeRecord[] {
  const tradedAt = input.tradedAt && Number.isFinite(Date.parse(input.tradedAt)) ? input.tradedAt : new Date().toISOString();
  const record: HoldingTradeRecord = {
    id: input.id || `${input.code}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    tradedAt,
    code: String(input.code || "").trim(),
    name: String(input.name || input.code || "").trim().slice(0, 24) || String(input.code || ""),
    side: input.side,
    shares: Math.floor(Number(input.shares)),
    price: roundPrice(Number(input.price)),
    realizedPnl: typeof input.realizedPnl === "number" && Number.isFinite(input.realizedPnl)
      ? Math.round(input.realizedPnl * 100) / 100
      : null,
    ...(input.note ? { note: String(input.note).trim().slice(0, 160) } : {})
  };
  if (!isValidHoldingTradeRecord(record)) return loadHoldingTrades(storage);
  const previous = loadHoldingTrades(storage).filter(item => item.id !== record.id);
  const next = [record, ...previous].slice(0, MAX_HOLDING_TRADES);
  if (storage) {
    try {
      storage.setItem(HOLDING_TRADES_STORAGE_KEY, JSON.stringify(next));
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("a-stock-radar:holding-trades-updated"));
      }
    } catch {
      // ignore storage quota or synthetic test environment restrictions
    }
  }
  return next;
}

export function clearHoldingTrades(storage: Pick<Storage, "setItem"> | null = defaultTradeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(HOLDING_TRADES_STORAGE_KEY, JSON.stringify([]));
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("a-stock-radar:holding-trades-updated"));
    }
  } catch {
    // ignore storage errors
  }
}

export function summarizeHoldingTrades(records: HoldingTradeRecord[]): {
  totalCount: number;
  sellCount: number;
  winCount: number;
  cumulativeRealizedPnl: number;
} {
  let sellCount = 0;
  let winCount = 0;
  let cumulativeRealizedPnl = 0;
  for (const r of records) {
    if (r.side === "sell" && typeof r.realizedPnl === "number" && Number.isFinite(r.realizedPnl)) {
      sellCount += 1;
      if (r.realizedPnl > 0) winCount += 1;
      cumulativeRealizedPnl += r.realizedPnl;
    }
  }
  return {
    totalCount: records.length,
    sellCount,
    winCount,
    cumulativeRealizedPnl: Math.round(cumulativeRealizedPnl * 100) / 100
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

const parseNonNegativeNumber = (token: string): number => {
  const cleaned = token.trim().replace(/,/g, "").replace(/[股元¥￥]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return Number.NaN;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
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
    if (/(?:^(?:证券代码|股票代码|代码|名称|stock)|证券代码|股票代码|股票余额|持仓余额|可用余额|成本价)/i.test(trimmed) && !/\d{6}/.test(trimmed)) return;

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
      if (remaining.length > 0 && Number.isNaN(parseNonNegativeNumber(remaining[0] || ""))) {
        name = remaining.shift()!.slice(0, 24);
      }
    }

    const n0 = parsePositiveNumber(remaining[0] ?? "");
    const n1 = parseNonNegativeNumber(remaining[1] ?? "");
    const n2 = parsePositiveNumber(remaining[2] ?? "");
    const isBrokerMultiCol =
      remaining.length >= 3 &&
      Number.isSafeInteger(n0) &&
      n0 >= 1 &&
      Number.isSafeInteger(n1) &&
      n1 >= 0 &&
      n1 <= n0 &&
      Number.isFinite(n2) &&
      n2 > 0 &&
      (n1 === 0 || n1 === n0 || (n1 >= 100 && (n2 < n1 || n1 % 100 === 0)));

    const shares = n0;
    const costPrice = isBrokerMultiCol ? n2 : parsePositiveNumber(remaining[1] ?? "");
    const availableShares = isBrokerMultiCol ? n1 : undefined;

    if (!Number.isSafeInteger(shares) || shares <= 0 || !Number.isFinite(costPrice) || costPrice <= 0) {
      errors.push(`第 ${index + 1} 行（${code}）缺少有效的数量或成本价，格式示例：600519 贵州茅台 200 1480.5`);
      return;
    }

    const note = isBrokerMultiCol
      ? remaining
          .slice(3)
          .filter(tok => !/^[-+]?[\d,]+(?:\.\d+)?(?:[%元股¥￥])?$/.test(tok.trim()))
          .join(" ")
          .slice(0, 160)
      : remaining.slice(2).join(" ").slice(0, 160);
    byCode.set(code, {
      line: index + 1,
      code,
      name: name || code,
      shares,
      ...(availableShares !== undefined ? { availableShares } : {}),
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
