/** Persisted review snapshots are input data, not trusted component props.
 * Validate the fields rendered by the stock/market/decision views without
 * recalculating historical conclusions or discarding unknown legacy metadata.
 */
type Validator = (value: unknown) => boolean;
type Fields = Record<string, Validator>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text: Validator = value => typeof value === "string";
const flag: Validator = value => typeof value === "boolean";
const numeric: Validator = value => value === null ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
const list = (check: Validator): Validator => value => Array.isArray(value) && value.every(check);
const strings = list(text);
const fields = (schema: Fields, required: string[] = []): Validator => value => record(value) &&
  required.every(key => value[key] !== undefined) &&
  Object.entries(schema).every(([key, check]) => value[key] === undefined || check(value[key]));
const textFields = (...names: string[]): Fields => Object.fromEntries(names.map(name => [name, text]));
const numberFields = (...names: string[]): Fields => Object.fromEntries(names.map(name => [name, numeric]));

const decision = fields({
  ...textFields("version", "asOf", "status", "headline", "stage", "marketGate", "sourceNature"),
  canPlan: flag,
  steps: list(fields({ ...textFields("id", "title", "state"), facts: strings }, ["facts"])),
  limitations: strings,
  scenarios: list(fields(textFields("name", "condition", "response", "confirmation", "invalidation"))),
  metrics: list(fields({ ...textFields("id", "label", "unit", "detail"), value: numeric })),
  context: list(fields({ ...textFields("id", "label", "state"), facts: strings }, ["facts"])),
  observedLevels: list(fields({ ...textFields("id", "label", "asOf", "role", "basis"), ...numberFields("price", "distancePct") })),
  evidence: list(fields({ ...textFields("id", "title", "tone", "detail", "basis"), priority: numeric }))
}, ["steps", "scenarios", "limitations"]);
const factor = fields({
  ...textFields("id", "name", "source", "detail", "status"),
  ...numberFields("score", "weight"), available: flag, passed: flag
}, ["id"]);
const stockSchema = fields({
  security: fields(textFields("code", "name", "secid", "thscode", "marketName", "assetType")),
  quote: fields({ ...textFields("name", "industry", "code"), ...numberFields("latest", "changePct", "amount", "turnover", "volumeRatio", "amplitude") }),
  analysis: fields({ ...textFields("assetLabel", "exactNode", "nextNode"), isSearchOnlyAsset: flag }),
  ...textFields("updatedAt", "verdict", "grade"), score: numeric,
  decision,
  factors: list(factor),
  factorEngine: fields({ ...textFields("note", "providerLabel"), ...numberFields("total", "available", "coverage", "strong", "risk", "weightedScore"), thsActive: flag }),
  certainty: fields({ ...textFields("label", "note"), ...numberFields("score", "passed", "available", "total") }),
  evidence: strings, risks: strings,
  plan: fields({ signal: text, ...numberFields("trigger", "stop", "target", "riskReward", "position"), invalidations: strings }),
  diagnostics: fields({
    ...numberFields("return1", "return3", "return5", "return10", "atrPercent", "recentAmplitude", "compressionRatio", "rangePosition20", "maxDrawdown", "closePosition", "volumeRatio", "relativeTurnover", "low20", "high20"),
    maxDrawdownLabel: text
  }),
  keyLevels: list(fields({ ...textFields("id", "label", "tone", "source"), value: numeric })),
  factorLeaders: fields({ strong: list(factor), risk: list(factor), pending: list(factor) }, ["strong", "risk", "pending"]),
  checklist: fields({ confirmed: strings, risks: strings, pending: strings }, ["confirmed", "risks", "pending"]),
  scenarios: list(fields(textFields("id", "name", "probability", "condition", "action", "invalidation"))),
  legacyDetailUnavailable: flag
});
function validStockSnapshot(value: unknown): boolean {
  if (!record(value) || !stockSchema(value)) return false;
  // The existing legacy adapter fills omitted containers only for snapshots
  // without the full detailed-evidence group. A detailed snapshot bypasses that
  // adapter, so its unconditionally-rendered containers must already exist.
  const detailed = ["diagnostics", "keyLevels", "factorLeaders", "checklist", "scenarios"].every(key => value[key] !== undefined);
  return !detailed || ["factors", "factorEngine", "evidence", "risks", "plan"].every(key => value[key] !== undefined) &&
    record(value.plan) && Array.isArray(value.plan.invalidations);
}

const returns = fields(numberFields("r1", "r3", "r5"));
const marketSchema = fields({
  ...textFields("date", "session", "generatedAt"), score: numeric, decision,
  regime: fields(textFields("tone", "name", "posture")),
  market: fields({ available: flag, ...numberFields("upCount", "downCount", "flatCount", "stockCount", "breadth", "averageReturn") }),
  ecology: fields(numberFields("limitUpCount", "limitDownCount", "failedBoards", "promotionRate", "maxHeight", "firstBoards", "continuationBoards")),
  evidence: strings, riskSignals: strings, sources: strings,
  indices: list(fields({ ...textFields("code", "name", "date", "trend"), ...numberFields("ma5", "ma20", "volumeRatio", "score"), returns }, ["returns"])),
  focusSectors: list(fields({ ...textFields("name", "state", "verdict"), ...numberFields("reviewRank", "poolLimitUps", "limitUps", "breadth", "amountHeat", "score"), returns })),
  leaders: list(fields({ ...textFields("code", "name", "industry", "reason"), consecutiveBoards: numeric })),
  dimensions: value => record(value) && Object.values(value).every(numeric),
  scenarios: list(fields({ ...textFields("id", "tone", "name", "action", "invalidation"), conditions: strings }, ["conditions"])),
  nextPlan: fields({ focus: strings, observe: strings, avoid: strings }),
  methodology: fields(textFields("description", "name", "note"))
}, ["market", "ecology"]);

export type ReviewRecord = {
  id: string; type: "market" | "stock"; title: string; date: string;
  score: number; verdict: string; note: string; createdAt: string; snapshot: any;
};

export function isReviewRecord(value: unknown): value is ReviewRecord {
  if (!record(value) || !["market", "stock"].includes(String(value.type))) return false;
  if (![value.id, value.title, value.date, value.verdict, value.createdAt].every(text)) return false;
  if (value.note !== undefined && !text(value.note)) return false;
  if (value.score !== undefined && !numeric(value.score)) return false;
  return (value.type === "stock" ? validStockSnapshot : marketSchema)(value.snapshot);
}
