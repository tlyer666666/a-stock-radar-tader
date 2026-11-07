import { nullableNumber } from "../numericValue";

/** Nonpositive placeholder values are not evidence of a listed company's market cap. */
export function marketCapitalization(quote: {totalMarketCap?: unknown; missingFields?: unknown} | undefined, fallback?: unknown) {
  const missing = Array.isArray(quote?.missingFields) && quote.missingFields.includes("totalMarketCap");
  const current = missing ? null : nullableNumber(quote?.totalMarketCap);
  if (current !== null && current > 0) return current;
  const prior = nullableNumber(fallback);
  return prior !== null && prior > 0 ? prior : null;
}
