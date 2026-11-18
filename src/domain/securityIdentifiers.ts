export type ExchangeCode = "SH" | "SZ" | "BJ";

const SH_PREFIX_RE = /^(?:6\d{5}|900\d{3}|5\d{5}|11[0138]\d{3})$/;
const BJ_CODE_RE = /^(?:(?:43|83|87|88)\d{4}|920\d{3})$/;
const SH_CONVERTIBLE_RE = /^11[0138]\d{3}$/;
const SZ_CONVERTIBLE_RE = /^12[35678]\d{3}$/;

export function cleanSecurityCode(code: string): string {
  return String(code || "").trim();
}

export function inferAssetType(code: string): NonNullable<Security["assetType"]> {
  const clean = cleanSecurityCode(code);
  if (/^5\d{5}$/.test(clean) || /^159\d{3}$/.test(clean)) return "etf";
  if (SH_CONVERTIBLE_RE.test(clean) || SZ_CONVERTIBLE_RE.test(clean)) return "convertibleBond";
  return "stock";
}

export function inferExchange(code: string): ExchangeCode {
  const clean = cleanSecurityCode(code);
  if (BJ_CODE_RE.test(clean)) return "BJ";
  if (SH_PREFIX_RE.test(clean)) return "SH";
  return "SZ";
}

export function inferSecid(code: string): string {
  const clean = cleanSecurityCode(code);
  const exchange = inferExchange(clean);
  return `${exchange === "SH" ? "1" : "0"}.${clean}`;
}

export function inferMarketName(code: string): string {
  const clean = cleanSecurityCode(code);
  if (/^68[89]\d{3}$/.test(clean)) return "科创板";
  if (/^30[012]\d{3}$/.test(clean)) return "创业板";
  if (BJ_CODE_RE.test(clean)) return "北交所";
  if (/^5\d{5}$/.test(clean)) return "沪市ETF";
  if (/^159\d{3}$/.test(clean)) return "深市ETF";
  if (SH_CONVERTIBLE_RE.test(clean)) return "沪市转债";
  if (SZ_CONVERTIBLE_RE.test(clean)) return "深市转债";
  return inferExchange(clean) === "SH" ? "沪A" : "深A";
}

export function inferSecurityMeta(
  code: string
): Pick<Security, "code" | "name" | "secid" | "thscode" | "marketName" | "assetType"> {
  const clean = cleanSecurityCode(code);
  const exchange = inferExchange(clean);
  return {
    code: clean,
    name: clean,
    secid: `${exchange === "SH" ? "1" : "0"}.${clean}`,
    thscode: `${clean}.${exchange}`,
    marketName: inferMarketName(clean),
    assetType: inferAssetType(clean)
  };
}
