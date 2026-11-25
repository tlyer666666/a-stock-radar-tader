import {
  normalizeStockMonitorConfig,
  type StockMonitorConfig
} from "../../stockMonitorRules";
import { userErrorText } from "../../userErrorText";

export type HoldingTradeSide = "buy" | "sell";

export const HOLDING_TRADES_STORAGE_KEY = "a-stock-radar:holding-trades:v1";
export const MAX_HOLDING_TRADES = 1000;
export const MAX_HOLDINGS_COUNT = 80;

export type HoldingTradeRecord = {
  id: string;
  tradedAt: string;
  code: string;
  name: string;
  side: HoldingTradeSide;
  shares: number;
  price: number;
  realizedPnl: number | null;
  dilutedPnl?: number | undefined;
  note?: string | undefined;
};

export type HoldingTradeArchive = { count: number; sellCount: number; winCount: number; realizedPnl: number; dilutedPnl: number };
export type HoldingTradeLedger = { records: HoldingTradeRecord[]; archived: HoldingTradeArchive };
const EMPTY_ARCHIVE: HoldingTradeArchive = { count: 0, sellCount: 0, winCount: 0, realizedPnl: 0, dilutedPnl: 0 };

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
      dilutedPnl?: number | undefined;
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
const round2 = (value: number): number => Math.round(value * 100) / 100;

export function clampHoldingCostPrice(value: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0.001, roundPrice(numeric)) : 0.001;
}

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
  if (!Number.isFinite(price) || price < 0.001) {
    return { ok: false, error: !Number.isFinite(price) || price <= 0 ? "成交均价必须大于 0" : "成交均价不能低于 0.001 元" };
  }

  const now = input.now || new Date().toISOString();
  const existing = input.items.find(item => item.code === code);
  const noteTrimmed = typeof input.note === "string" ? input.note.trim().slice(0, 160) : "";

  if (input.side === "buy") {
    if (!existing && input.items.length >= MAX_HOLDINGS_COUNT) {
      return { ok: false, error: `最多保存 ${MAX_HOLDINGS_COUNT} 只持仓，请先清仓移除部分股票后再添加` };
    }
    const meta = inferSecurityMeta(code);
    const totalShares = existing ? existing.shares + shares : shares;
    if (!Number.isSafeInteger(totalShares) || totalShares <= 0) {
      return { ok: false, error: "合并后持仓股数超出安全整数范围" };
    }
    const weightedCost = clampHoldingCostPrice(
      existing
        ? (existing.shares * existing.costPrice + shares * price) / totalShares
        : price
    );
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

  const fullClosePnl = round2((price - existing.costPrice) * shares);
  const remainingShares = existing.shares - shares;

  if (remainingShares === 0) {
    const nextItems = input.items.filter(item => item.code !== code);
    return {
      ok: true,
      nextItems,
      action: "closed",
      remainingShares: 0,
      costPrice: existing.costPrice,
      realizedPnl: fullClosePnl,
      summary: `${existing.name} 已清仓卖出 ${existing.shares} 股 @ ${price.toFixed(2)}，估算实现盈亏 ${fullClosePnl >= 0 ? "+" : ""}${fullClosePnl.toFixed(2)} 元`
    };
  }

  const rawNextCost = (existing.shares * existing.costPrice - shares * price) / remainingShares;
  const nextCost = input.diluteCost
    ? clampHoldingCostPrice(rawNextCost)
    : existing.costPrice;
  const realizedPnl = input.diluteCost
    ? (rawNextCost >= 0.001 ? 0 : round2((0.001 - rawNextCost) * remainingShares))
    : fullClosePnl;

  const nextItem: HoldingItem = {
    ...existing,
    shares: remainingShares,
    ...(typeof existing.sellableShares === "number" && Number.isFinite(existing.sellableShares)
      ? { sellableShares: Math.max(0, Math.min(remainingShares, existing.sellableShares - shares)) }
      : {}),
    costPrice: nextCost,
    note: noteTrimmed || existing.note || "",
    updatedAt: now
  };
  const nextItems = [...input.items.filter(item => item.code !== code), nextItem]
    .sort((left, right) => left.code.localeCompare(right.code));
  const summary = input.diluteCost
    ? realizedPnl > 0
      ? `${existing.name} 已减仓 ${shares} 股 @ ${price.toFixed(2)}，剩余 ${remainingShares} 股（盈亏已摊薄剩余成本至 ${nextCost.toFixed(3)}，超出保底部分记实现盈亏 +${realizedPnl.toFixed(2)} 元）`
      : `${existing.name} 已减仓 ${shares} 股 @ ${price.toFixed(2)}，剩余 ${remainingShares} 股（当笔盈亏已用于摊薄剩余成本至 ${nextCost.toFixed(3)}）`
    : `${existing.name} 已减仓 ${shares} 股 @ ${price.toFixed(2)}，剩余 ${remainingShares} 股（成本 ${nextCost.toFixed(3)}）`;
  return {
    ok: true,
    nextItems,
    action: "reduced",
    remainingShares,
    costPrice: nextCost,
    realizedPnl,
    ...(input.diluteCost ? { dilutedPnl: round2(fullClosePnl - realizedPnl) } : {}),
    summary
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
    (r.realizedPnl === null || (typeof r.realizedPnl === "number" && Number.isFinite(r.realizedPnl))) &&
    (r.dilutedPnl === undefined || (typeof r.dilutedPnl === "number" && Number.isFinite(r.dilutedPnl)))
  );
}

const finiteOr = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const countOr = (value: unknown) => Math.max(0, Math.trunc(finiteOr(value)));

function normalizeArchive(value: unknown): HoldingTradeArchive {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_ARCHIVE };
  const raw = value as Record<string, unknown>;
  return { count: countOr(raw.count), sellCount: countOr(raw.sellCount), winCount: countOr(raw.winCount),
    realizedPnl: round2(finiteOr(raw.realizedPnl)), dilutedPnl: round2(finiteOr(raw.dilutedPnl)) };
}

const isSettledSell = (r: HoldingTradeRecord) => r.side === "sell" && (typeof r.realizedPnl === "number" || typeof r.dilutedPnl === "number");

function foldIntoArchive(archive: HoldingTradeArchive, dropped: HoldingTradeRecord[]): HoldingTradeArchive {
  const next = { ...archive };
  for (const r of dropped) {
    next.count += 1;
    if (!isSettledSell(r)) continue;
    next.sellCount += 1;
    if (finiteOr(r.realizedPnl) + finiteOr(r.dilutedPnl) > 0) next.winCount += 1;
    next.realizedPnl = round2(next.realizedPnl + finiteOr(r.realizedPnl));
    next.dilutedPnl = round2(next.dilutedPnl + finiteOr(r.dilutedPnl));
  }
  return next;
}

export function loadHoldingTradeLedger(storage: Pick<Storage, "getItem"> | null = defaultTradeStorage()): HoldingTradeLedger {
  if (!storage) return { records: [], archived: { ...EMPTY_ARCHIVE } };
  try {
    const raw = storage.getItem(HOLDING_TRADES_STORAGE_KEY);
    if (!raw) return { records: [], archived: { ...EMPTY_ARCHIVE } };
    const parsed: unknown = JSON.parse(raw);
    const container = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { records?: unknown; archived?: unknown } : null;
    const list = Array.isArray(parsed) ? parsed : Array.isArray(container?.records) ? container.records : [];
    const valid = list.filter(isValidHoldingTradeRecord);
    return { records: valid.slice(0, MAX_HOLDING_TRADES), archived: foldIntoArchive(normalizeArchive(container?.archived), valid.slice(MAX_HOLDING_TRADES)) };
  } catch {
    return { records: [], archived: { ...EMPTY_ARCHIVE } };
  }
}

export function loadHoldingTrades(storage: Pick<Storage, "getItem"> | null = defaultTradeStorage()): HoldingTradeRecord[] {
  return loadHoldingTradeLedger(storage).records;
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
    ...(typeof input.dilutedPnl === "number" && Number.isFinite(input.dilutedPnl) ? { dilutedPnl: round2(input.dilutedPnl) } : {}),
    ...(input.note ? { note: String(input.note).trim().slice(0, 160) } : {})
  };
  if (!isValidHoldingTradeRecord(record)) return loadHoldingTrades(storage);
  const ledger = loadHoldingTradeLedger(storage);
  const combined = [record, ...ledger.records.filter(item => item.id !== record.id)];
  const next = combined.slice(0, MAX_HOLDING_TRADES);
  const archived = foldIntoArchive(ledger.archived, combined.slice(MAX_HOLDING_TRADES));
  if (!storage) return next;
  try {
    storage.setItem(HOLDING_TRADES_STORAGE_KEY, JSON.stringify({ records: next, archived }));
  } catch (error) {
    throw new Error(`持仓已更新，但这笔成交流水未能保存（${userErrorText(error)}），请勿重复提交本笔交易`, { cause: error });
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("a-stock-radar:holding-trades-updated"));
  }
  return next;
}

export function clearHoldingTrades(storage: Pick<Storage, "setItem"> | null = defaultTradeStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(HOLDING_TRADES_STORAGE_KEY, JSON.stringify({ records: [], archived: EMPTY_ARCHIVE }));
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("a-stock-radar:holding-trades-updated"));
    }
    return true;
  } catch {
    return false;
  }
}

export function summarizeHoldingTrades(records: HoldingTradeRecord[], archived: HoldingTradeArchive = EMPTY_ARCHIVE): {
  totalCount: number;
  sellCount: number;
  winCount: number;
  cumulativeRealizedPnl: number;
  cumulativeDilutedPnl: number;
} {
  const total = foldIntoArchive(normalizeArchive(archived), records);
  return {
    totalCount: total.count,
    sellCount: total.sellCount,
    winCount: total.winCount,
    cumulativeRealizedPnl: total.realizedPnl,
    cumulativeDilutedPnl: total.dilutedPnl
  };
}

const stripCodeDecorators = (token: string): string => {
  const cleaned = token
    .trim()
    .toUpperCase()
    .replace(/^(?:SH|SZ|BJ)(?=\d{6}$)/i, "")
    .replace(/\.(SH|SZ|BJ)$/i, "")
    .replace(/^[01]\./, "");
  return /^\d{6}$/.test(cleaned) ? cleaned : "";
};

const isMarketTag = (token: string): boolean =>
  /^(?:沪A|深A|京A|沪B|深B|沪市|深市|京市|北交所|北证|上海A股|深圳A股|SH|SZ|BJ|SSE|SZSE|BSE)$/i.test(token.trim());

const isShareholderAccountToken = (token: string): boolean =>
  /^[A-Z]?\d{8,12}$/i.test(token.trim());

const isRowSerialToken = (token: string): boolean =>
  /^(?:序号)?\d{1,3}[.)、]?$/.test(token.trim()) && !stripCodeDecorators(token);

const isNumericOrPercentToken = (token: string): boolean =>
  /^[-+]?[\d,]+(?:\.\d+)?(?:[%‰元股手万亿¥￥])?$/.test(token.trim());

const isBrokerNumericSlotToken = (token: string): boolean =>
  isNumericOrPercentToken(token) || /^(?:--|—)$/.test(token.trim());

const hasDecimalPart = (token: string): boolean => /\.\d+/.test(token.trim());

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
  const commaAdjacentToCode = /(?:^|,)\s*(?:(?:SH|SZ|BJ)?\d{6}|[01]\.\d{6}|\d{6}\.(?:SH|SZ|BJ))\s*,|,\s*(?:(?:SH|SZ|BJ)?\d{6}|[01]\.\d{6}|\d{6}\.(?:SH|SZ|BJ))\s*(?:,|$)/i.test(normalized);
  const commaHeaderWithoutThousands = !/\d,\d{3}\b/.test(normalized) && /(?:证券代码|股票代码|代码|持仓|股票余额|数量|成本)/i.test(normalized);
  if (!normalized.includes("\t") && normalized.includes(",") && (!/\s/.test(normalized) || commaAdjacentToCode || commaHeaderWithoutThousands)) {
    return normalized.split(",").map(part => part.trim()).filter(Boolean);
  }
  return normalized
    .split(/[\t\s]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

type HoldingHeaderMap = {
  code: number;
  name?: number | undefined;
  shares: number;
  availableShares?: number | undefined;
  costPrice: number;
  note?: number | undefined;
};

function detectHoldingHeaderColumns(tokens: string[]): HoldingHeaderMap | null {
  if (tokens.length < 3) return null;
  let code = -1;
  let name = -1;
  let shares = -1;
  let availableShares = -1;
  let costPrice = -1;
  let note = -1;
  tokens.forEach((raw, idx) => {
    const t = raw.trim();
    if (!t) return;
    if (code < 0 && !/股东|账户|席位/.test(t) && /(?:证券|股票|标的)?代码|^code$|^symbol$/i.test(t)) {
      code = idx;
      return;
    }
    if (name < 0 && !/市场|账户|股东/.test(t) && /(?:证券|股票|标的)?(?:名称|简称)|^name$/i.test(t)) {
      name = idx;
      return;
    }
    if (availableShares < 0 && !/市值|盈亏|成本|均价|比例/.test(t) && /可用|可卖/.test(t)) {
      availableShares = idx;
      return;
    }
    if (costPrice < 0 && !/市值|金额|盈亏|比例/.test(t) && /成本|买入均价|持仓均价/.test(t)) {
      costPrice = idx;
      return;
    }
    if (
      shares < 0 &&
      !/可用|可卖|冻结|市值|盈亏|成本|比例|占比|成交/.test(t) &&
      /(?:股票|证券|持仓|持股|当前|实际)?(?:余额|数量)|^持仓$|^数量$|^shares$/i.test(t)
    ) {
      shares = idx;
      return;
    }
    if (note < 0 && /^(?:备注|说明|策略备注|note)$/i.test(t)) {
      note = idx;
    }
  });
  if (code >= 0 && shares >= 0 && costPrice >= 0 && code !== shares && shares !== costPrice && code !== costPrice) {
    return {
      code,
      ...(name >= 0 ? { name } : {}),
      shares,
      ...(availableShares >= 0 ? { availableShares } : {}),
      costPrice,
      ...(note >= 0 ? { note } : {})
    };
  }
  return null;
}

const isCandidateHoldingName = (token: string): boolean => {
  const t = token.trim();
  return Boolean(
    t &&
    !stripCodeDecorators(t) &&
    !isMarketTag(t) &&
    !isShareholderAccountToken(t) &&
    !isBrokerNumericSlotToken(t) &&
    !isRowSerialToken(t)
  );
};

function pickAdjacentName(tokens: string[], codeIndex: number): { name: string; nameIndex: number; afterCodeIdx: number } {
  let afterCodeIdx = codeIndex + 1;
  while (afterCodeIdx < tokens.length && isMarketTag(tokens[afterCodeIdx] || "")) {
    afterCodeIdx += 1;
  }
  let name = "";
  let nameIndex = -1;
  if (afterCodeIdx < tokens.length && isCandidateHoldingName(tokens[afterCodeIdx] || "")) {
    name = tokens[afterCodeIdx]!.trim().slice(0, 24);
    nameIndex = afterCodeIdx;
    afterCodeIdx += 1;
  } else {
    for (let left = codeIndex - 1; left >= 0; left -= 1) {
      const leftTok = tokens[left] || "";
      if (isMarketTag(leftTok) || isShareholderAccountToken(leftTok)) continue;
      if (isCandidateHoldingName(leftTok)) {
        name = leftTok.trim().slice(0, 24);
        nameIndex = left;
        break;
      }
      if (afterCodeIdx >= tokens.length) continue;
      break;
    }
  }
  while (
    afterCodeIdx < tokens.length &&
    (isMarketTag(tokens[afterCodeIdx] || "") || isShareholderAccountToken(tokens[afterCodeIdx] || ""))
  ) {
    afterCodeIdx += 1;
  }
  return { name, nameIndex, afterCodeIdx };
}

function tryParseWithHeaderMap(
  rowTokens: string[],
  headerMap: HoldingHeaderMap,
  lineNo: number
): ParsedHoldingRow | null {
  const maxRequired = Math.max(headerMap.code, headerMap.shares, headerMap.costPrice);
  if (rowTokens.length <= maxRequired) return null;
  const code = stripCodeDecorators(rowTokens[headerMap.code] ?? "");
  if (!code) return null;

  const sharesTok = rowTokens[headerMap.shares] ?? "";
  const costTok = rowTokens[headerMap.costPrice] ?? "";
  if (sharesTok.includes("%") || costTok.includes("%")) return null;
  const shares = parsePositiveNumber(sharesTok);
  const costPrice = parsePositiveNumber(costTok);
  if (!Number.isSafeInteger(shares) || shares <= 0 || !Number.isFinite(costPrice) || costPrice < 0.001) {
    return null;
  }

  let availableShares: number | undefined;
  if (headerMap.availableShares !== undefined) {
    if (headerMap.availableShares >= rowTokens.length) return null;
    const availTok = rowTokens[headerMap.availableShares] ?? "";
    if (/^(?:--|—)$/.test(availTok.trim())) {
      availableShares = undefined;
    } else {
      if (availTok.includes("%") || (hasDecimalPart(availTok) && !hasDecimalPart(sharesTok))) return null;
      const parsedAvail = parseNonNegativeNumber(availTok);
      if (!Number.isSafeInteger(parsedAvail) || parsedAvail < 0 || parsedAvail > shares) return null;
      availableShares = parsedAvail;
    }
  }

  let name = "";
  if (headerMap.name !== undefined && headerMap.name < rowTokens.length) {
    const candidateName = rowTokens[headerMap.name] ?? "";
    if (isCandidateHoldingName(candidateName)) {
      name = candidateName.trim().slice(0, 24);
    }
  }
  if (!name) {
    name = pickAdjacentName(rowTokens, headerMap.code).name;
  }

  let note = "";
  if (headerMap.note !== undefined && headerMap.note < rowTokens.length) {
    const rawNote = (rowTokens[headerMap.note] ?? "").trim();
    if (rawNote && !isBrokerNumericSlotToken(rawNote) && !isMarketTag(rawNote) && !isShareholderAccountToken(rawNote)) {
      note = rawNote.slice(0, 160);
    }
  } else {
    const mappedIndices = new Set<number>([
      headerMap.code,
      headerMap.shares,
      headerMap.costPrice,
      ...(headerMap.name !== undefined ? [headerMap.name] : []),
      ...(headerMap.availableShares !== undefined ? [headerMap.availableShares] : [])
    ]);
    const lastMapped = Math.max(...mappedIndices);
    note = rowTokens
      .slice(lastMapped + 1)
      .filter(tok => isCandidateHoldingName(tok))
      .join(" ")
      .slice(0, 160);
  }

  return {
    line: lineNo,
    code,
    name: name || code,
    shares,
    ...(availableShares !== undefined ? { availableShares } : {}),
    costPrice: clampHoldingCostPrice(costPrice),
    note
  };
}

/**
 * 解析多行文本导入（支持空格、制表符 TSV、中英文逗号 CSV、带表头或无表头券商多列导出）。
 * 常见格式：
 * - `600519 贵州茅台 200 1480.5`
 * - `600519,200,1480.5`
 * - `东方财富\t300059\t1,200股\t21.8元 核底仓`
 */
export function parseHoldingsPaste(rawText: string): HoldingsPasteParseResult {
  const lines = String(rawText || "").split(/\r?\n/);
  const byCode = new Map<string, ParsedHoldingRow>();
  const errors: string[] = [];
  let headerMap: HoldingHeaderMap | null = null;

  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    const rawTokens = splitHoldingColumns(trimmed);
    if (!rawTokens.some(tok => Boolean(stripCodeDecorators(tok)))) {
      const detectedHeader = detectHoldingHeaderColumns(rawTokens);
      if (detectedHeader) {
        headerMap = detectedHeader;
        return;
      }
      if (/(?:^(?:证券代码|股票代码|代码|名称|stock)|证券代码|股票代码|股票余额|持仓余额|持仓数量|可用余额|成本价)/i.test(trimmed) && !/\d{6}/.test(trimmed)) {
        return;
      }
    }

    const tokens = rawTokens.length >= 4 && isRowSerialToken(rawTokens[0] || "")
      ? rawTokens.slice(1)
      : rawTokens;

    if (headerMap) {
      const fromRaw = tryParseWithHeaderMap(rawTokens, headerMap, index + 1);
      if (fromRaw) {
        byCode.set(fromRaw.code, fromRaw);
        return;
      }
      if (tokens !== rawTokens) {
        const fromTrimmed = tryParseWithHeaderMap(tokens, headerMap, index + 1);
        if (fromTrimmed) {
          byCode.set(fromTrimmed.code, fromTrimmed);
          return;
        }
      }
    }

    let codeIndex = -1;
    let code = "";
    for (let i = 0; i < tokens.length; i += 1) {
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

    const { name, nameIndex, afterCodeIdx } = pickAdjacentName(tokens, codeIndex);
    const tail = tokens.slice(afterCodeIdx);
    const remaining = tail.length >= 2 || codeIndex < 2
      ? tail
      : tokens.filter((tok, idx) =>
          idx !== codeIndex &&
          idx !== nameIndex &&
          !isMarketTag(tok) &&
          !isShareholderAccountToken(tok)
        );

    let numericSpan = 0;
    while (numericSpan < remaining.length && isBrokerNumericSlotToken(remaining[numericSpan] || "")) {
      numericSpan += 1;
    }

    const tok0 = remaining[0] ?? "";
    const tok1 = remaining[1] ?? "";
    const n0 = !tok0.includes("%") ? parsePositiveNumber(tok0) : Number.NaN;
    const n1 = !tok1.includes("%") ? parseNonNegativeNumber(tok1) : Number.NaN;

    const hasAvailableCol =
      numericSpan >= 3 &&
      !(hasDecimalPart(tok1) && !hasDecimalPart(tok0)) &&
      Number.isSafeInteger(n0) &&
      n0 >= 1 &&
      Number.isSafeInteger(n1) &&
      n1 >= 0 &&
      n1 <= n0;

    const isBrokerMultiCol = hasAvailableCol || numericSpan >= 3;
    const shares = n0;
    const availableShares = hasAvailableCol ? n1 : undefined;

    let costPrice = Number.NaN;
    if (!isBrokerMultiCol) {
      costPrice = !tok1.includes("%") ? parsePositiveNumber(tok1) : Number.NaN;
    } else {
      let costSearchStart = hasAvailableCol ? 2 : 1;
      if (hasAvailableCol && numericSpan >= 4) {
        const tok2 = remaining[2] ?? "";
        const n2 = !tok2.includes("%") ? parseNonNegativeNumber(tok2) : Number.NaN;
        if (
          /^(?:--|—)$/.test(tok2.trim()) ||
          (!hasDecimalPart(tok2) &&
            Number.isSafeInteger(n2) &&
            (n2 === 0 || (n1 + n2 === shares && hasDecimalPart(remaining[3] ?? ""))))
        ) {
          costSearchStart = 3;
        }
      }
      for (let idx = costSearchStart; idx < numericSpan; idx += 1) {
        const candidateTok = remaining[idx] ?? "";
        if (candidateTok.includes("%") || candidateTok.includes("‰")) continue;
        const val = parsePositiveNumber(candidateTok);
        if (!Number.isFinite(val) || val <= 0) continue;

        if (Number.isSafeInteger(shares) && shares >= 10) {
          let isMarketValue = false;
          for (let later = idx + 1; later < numericSpan; later += 1) {
            const laterTok = remaining[later] ?? "";
            if (laterTok.includes("%") || laterTok.includes("‰")) continue;
            const laterVal = parsePositiveNumber(laterTok);
            if (Number.isFinite(laterVal) && laterVal > 0 && laterVal < val) {
              if (Math.abs(val - shares * laterVal) / (shares * laterVal) <= 0.03) {
                isMarketValue = true;
                break;
              }
            }
          }
          if (isMarketValue) continue;

          const nextTok = (remaining[idx + 1] ?? "").trim();
          if (/^[-+]?\d+(?:\.\d+)?%$/.test(nextTok)) {
            const pctAbs = Math.abs(Number(nextTok.replace("%", "")));
            if (Number.isFinite(pctAbs) && pctAbs > 0) {
              let isUnsignedPnl = false;
              for (let later = idx + 2; later < numericSpan; later += 1) {
                const laterTok = remaining[later] ?? "";
                if (laterTok.includes("%") || laterTok.includes("‰")) continue;
                const laterPrice = parsePositiveNumber(laterTok);
                if (Number.isFinite(laterPrice) && laterPrice > 0) {
                  if (Math.abs((val / (shares * laterPrice)) * 100 - pctAbs) <= 1.5) {
                    isUnsignedPnl = true;
                    break;
                  }
                }
              }
              if (isUnsignedPnl) continue;
            }
          }
        }

        costPrice = val;
        break;
      }
    }

    if (!Number.isSafeInteger(shares) || shares <= 0 || !Number.isFinite(costPrice) || costPrice < 0.001) {
      errors.push(`第 ${index + 1} 行（${code}）缺少有效的数量或成本价，格式示例：600519 贵州茅台 200 1480.5`);
      return;
    }

    const note = isBrokerMultiCol
      ? remaining
          .slice(numericSpan)
          .filter(tok => isCandidateHoldingName(tok))
          .join(" ")
          .slice(0, 160)
      : remaining.slice(2).join(" ").slice(0, 160);
    byCode.set(code, {
      line: index + 1,
      code,
      name: name || code,
      shares,
      ...(availableShares !== undefined ? { availableShares } : {}),
      costPrice: clampHoldingCostPrice(costPrice),
      note
    });
  });

  return {
    entries: [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code)),
    errors
  };
}

export type HoldingItemWithSellable = HoldingItem & { sellableShares?: number | undefined };

export function mergeImportedHoldings(
  existing: HoldingItemWithSellable[],
  entries: ParsedHoldingRow[],
  resolvedNames?: Record<string, Security>,
  now = new Date().toISOString()
): HoldingItemWithSellable[] {
  const byCode = new Map<string, HoldingItemWithSellable>(existing.map(item => [item.code, item]));
  for (const row of entries) {
    const prev = byCode.get(row.code);
    const looked = resolvedNames?.[row.code];
    const meta = inferSecurityMeta(row.code);
    const resolvedName = looked?.name || (row.name !== row.code ? row.name : "") || prev?.name || row.code;
    const sellableShares =
      typeof row.availableShares === "number" && Number.isSafeInteger(row.availableShares) && row.availableShares >= 0
        ? row.availableShares
        : prev?.sellableShares !== undefined
          ? Math.min(row.shares, prev.sellableShares)
          : undefined;
    const merged: HoldingItemWithSellable = {
      ...meta,
      ...(prev || {}),
      ...(looked || {}),
      code: row.code,
      name: resolvedName,
      secid: looked?.secid || prev?.secid || meta.secid,
      shares: row.shares,
      ...(sellableShares !== undefined ? { sellableShares } : {}),
      costPrice: row.costPrice,
      note: row.note || prev?.note || "",
      createdAt: prev?.createdAt || now,
      updatedAt: now
    };
    byCode.set(row.code, merged);
  }
  if (byCode.size > MAX_HOLDINGS_COUNT) {
    throw new Error(`最多保存 ${MAX_HOLDINGS_COUNT} 只持仓（合并后共 ${byCode.size} 只），请分批或先清理已清仓股票`);
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
