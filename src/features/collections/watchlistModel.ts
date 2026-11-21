import type { BatchQuote, BatchQuoteResult } from "../../domain/batchQuoteTypes";

export type WatchQuote = {
  latest?: number | null | undefined;
  changePct?: number | null | undefined;
  limitUp?: number | null | undefined;
  tradeStatus?: string | undefined;
};

export type WatchSort = { key: "latest" | "changePct"; dir: "desc" | "asc" } | null;

export function nextWatchSort(current: WatchSort, key: "latest" | "changePct"): WatchSort {
  if (!current || current.key !== key) return { key, dir: "desc" };
  return current.dir === "desc" ? { key, dir: "asc" } : null;
}

const sortValue = (quote: WatchQuote | undefined, key: "latest" | "changePct") => {
  const raw = key === "latest" ? quote?.latest : quote?.changePct;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (key === "latest" && raw <= 0) return null;
  return raw;
};

export function sortWatchItems<T extends { code: string }>(items: readonly T[], quotes: Record<string, WatchQuote>, sort: WatchSort): T[] {
  if (!sort) return items as T[];
  const sign = sort.dir === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    const valueA = sortValue(quotes[a.code], sort.key);
    const valueB = sortValue(quotes[b.code], sort.key);
    if (valueA === null && valueB === null) return 0;
    if (valueA === null) return 1;
    if (valueB === null) return -1;
    return (valueA - valueB) * sign;
  });
}

export function watchQuoteStats<T extends { code: string }>(items: readonly T[], quotes: Record<string, WatchQuote>) {
  let quoted = 0;
  let up = 0;
  let down = 0;
  let flat = 0;
  let limitUp = 0;
  for (const item of items) {
    const quote = quotes[item.code];
    if (!quote) continue;
    const suspended = quote.tradeStatus === "suspended";
    const latest = typeof quote.latest === "number" && Number.isFinite(quote.latest) && quote.latest > 0 ? quote.latest : null;
    if (!suspended && latest === null) continue;
    quoted += 1;
    if (!suspended && typeof quote.changePct === "number" && Number.isFinite(quote.changePct)) {
      if (quote.changePct > 0) up += 1;
      else if (quote.changePct < 0) down += 1;
      else flat += 1;
    } else {
      flat += 1;
    }
    if (latest !== null && typeof quote.limitUp === "number" && Number.isFinite(quote.limitUp) && latest >= quote.limitUp - 1e-6) limitUp += 1;
  }
  return { quoted, up, down, flat, limitUp };
}

export function toWatchQuotes(result: BatchQuoteResult | null | undefined): Record<string, WatchQuote> {
  const out: Record<string, WatchQuote> = {};
  const raw = result?.quotes as Record<string, Partial<BatchQuote>> | Map<string, Partial<BatchQuote>> | undefined;
  const entries: Array<[string, Partial<BatchQuote>]> = raw instanceof Map ? [...raw.entries()] : Object.entries(raw || {});
  for (const [code, quote] of entries) {
    if (!quote || typeof quote !== "object") continue;
    out[String(code)] = {
      latest: quote.latest ?? null,
      changePct: quote.changePct ?? null,
      limitUp: quote.limitUp ?? null,
      tradeStatus: quote.tradeStatus || undefined
    };
  }
  return out;
}
