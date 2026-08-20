import {
  Activity,
  ArrowLeft,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Database,
  Layers3,
  LoaderCircle,
  Play,
  Search,
  ShieldAlert,
  Target,
  Trash2,
  TrendingUp,
  Users,
  WalletCards,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import "./portfolio-backtest.css";
import { loadSafeLocalJson, saveSafeLocalJson } from "./safeStorage";
import {
  matchesInitialStrategySignature,
  resolvePublishedStrategyUniverse
} from "./portfolioBacktestLogic";

export type PortfolioBacktestStrategyContext = {
  source?: "single_strategy" | "optimized_portfolio" | string;
  strategyEngine?: string;
  strategyId?: string;
  strategyName?: string;
  strategyVersion?: string;
  strategyIds: string[];
  minimumVotes: number;
  securities?: Security[];
  universeSource?: "strategy_current_matches" | "manual";
  universeTotalCount?: number;
};

export type PortfolioBacktestViewProps = {
  initialStrategyContext?: PortfolioBacktestStrategyContext | null;
  initialSecurities?: Security[];
  onBack?: () => void;
  backLabel?: string;
  onOpenSingle?: () => void;
  onOpenSecurity?: (security: Security) => void;
  onResult?: (result: unknown) => void;
};

type StrategyDefinition = {
  id: string;
  name: string;
  detail: string;
  type: "base" | "composite" | string;
  publicationAccepted?: boolean;
  validationStatus?: string;
};

type EquityPoint = {
  date: string;
  equity: number;
  drawdownPercent?: number;
};

type ContributionRow = {
  code: string;
  name: string;
  pnl: number | null;
  contributionPercent: number | null;
  returnPercent: number | null;
  tradeCount: number | null;
  winRatePercent: number | null;
};

type TradeRow = {
  id: string;
  code: string;
  name: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number | null;
  exitPrice: number | null;
  shares: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  strategies: string[];
  exitReason: string;
};

type SignalTimelineRow = {
  id: string;
  date: string;
  code: string;
  name: string;
  strategies: string[];
  executed: boolean;
  pending: boolean;
  statusLabel: string;
  reason: string;
  entryDate: string;
  inferred: boolean;
};

type SignalDateGroup = {
  date: string;
  rows: SignalTimelineRow[];
};

type BasketSource = "strategy_current_matches" | "manual";

const BASKET_STORAGE_KEY = "a-stock-radar-portfolio-backtest-basket-v1";
const SETUP_STORAGE_KEY = "a-stock-radar-portfolio-backtest-setup-v1";
const MAX_BASKET_SIZE = 30;
const HALF_YEAR_LOOKBACK_BARS = 120;
const SIGNAL_DATES_PER_PAGE = 8;

const numberOrNull = (...values: unknown[]) => {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const clamp = (value: unknown, minimum: number, maximum: number, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
};

const normalizeSecurity = (input: any): Security | null => {
  const code = String(input?.code || "").trim();
  if (!/^\d{6}$/.test(code)) return null;
  return {
    ...input,
    code,
    name: String(input?.name || code),
    secid: String(input?.secid || ""),
    thscode: input?.thscode ? String(input.thscode) : undefined,
    marketName: input?.marketName ? String(input.marketName) : undefined,
    assetType: input?.assetType || "stock"
  };
};

const uniqueSecurities = (items: unknown, limit = MAX_BASKET_SIZE) => {
  const source = Array.isArray(items) ? items : [];
  const seen = new Set<string>();
  const rows: Security[] = [];
  for (const item of source) {
    const security = normalizeSecurity(item);
    if (!security || seen.has(security.code)) continue;
    if (security.assetType && security.assetType !== "stock") continue;
    seen.add(security.code);
    rows.push(security);
    if (rows.length >= limit) break;
  }
  return rows;
};

const loadStoredBasket = () => {
  return uniqueSecurities(loadSafeLocalJson<unknown>(BASKET_STORAGE_KEY, []));
};

const loadStoredSetup = (): Record<string, any> => {
  const value = loadSafeLocalJson<unknown>(SETUP_STORAGE_KEY, {});
  return value && typeof value === "object" ? value as Record<string, any> : {};
};

const strategyIdsFrom = (value: unknown) => [
  ...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )
];

const strategyLabelsFrom = (value: unknown, namesById: Map<string, string>) => {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(source.flatMap((item: any) => {
    if (typeof item === "string" || typeof item === "number") {
      const id = String(item).trim();
      return id ? [namesById.get(id) || id] : [];
    }
    const id = String(item?.id || item?.strategyId || "").trim();
    const name = String(item?.name || item?.strategyName || "").trim();
    const label = name || namesById.get(id) || id;
    return label ? [label] : [];
  }))];
};

const normalizeDefinitions = (input: any): StrategyDefinition[] => {
  const rows = Array.isArray(input)
    ? input
    : Array.isArray(input?.strategies)
      ? input.strategies
      : Array.isArray(input?.definitions)
        ? input.definitions
        : [];
  const seen = new Set<string>();
  return rows.flatMap((item: any) => {
    const id = String(item?.id || item?.strategyId || "").trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const publicationAccepted = typeof item?.publicationAccepted === "boolean"
      ? item.publicationAccepted
      : typeof item?.validation?.accepted === "boolean"
        ? item.validation.accepted
        : undefined;
    return [{
      id,
      name: String(item?.name || item?.label || id),
      detail: String(item?.detail || item?.description || "使用历史事件与样本外窗口复核"),
      type: String(item?.type || (item?.components?.length ? "composite" : "base")),
      publicationAccepted,
      validationStatus: String(item?.validation?.status || item?.status || "")
    }];
  });
};

const normalizeEquityCurve = (result: any): EquityPoint[] => {
  const rows = Array.isArray(result?.equityCurve)
    ? result.equityCurve
    : Array.isArray(result?.dailyEquityCurve)
      ? result.dailyEquityCurve
    : Array.isArray(result?.portfolio?.equityCurve)
      ? result.portfolio.equityCurve
      : [];
  return rows.flatMap((item: any, index: number) => {
    const equity = numberOrNull(item?.equity, item?.capital, item?.value, item?.balance);
    if (equity === null) return [];
    return [{
      date: String(item?.date || item?.tradeDate || item?.timestamp || index + 1).slice(0, 10),
      equity,
      drawdownPercent: numberOrNull(item?.drawdownPercent, item?.drawdown) ?? undefined
    }];
  });
};

const normalizeContributions = (result: any): ContributionRow[] => {
  const rows = Array.isArray(result?.contributions)
    ? result.contributions
    : Array.isArray(result?.securityContributions)
      ? result.securityContributions
      : Array.isArray(result?.perSecurity)
        ? result.perSecurity
        : [];
  return rows.map((item: any) => ({
    code: String(item?.code || item?.security?.code || ""),
    name: String(item?.name || item?.security?.name || item?.code || "--"),
    pnl: numberOrNull(item?.netPnl, item?.pnl, item?.profit, item?.realizedPnl),
    contributionPercent: numberOrNull(item?.contributionPercent, item?.contributionPct),
    returnPercent: numberOrNull(item?.averageReturn, item?.returnPercent, item?.returnPct, item?.totalReturnPercent),
    tradeCount: numberOrNull(item?.tradeCount, item?.trades),
    winRatePercent: numberOrNull(item?.winRatePercent, item?.winRate)
  })).sort((left: ContributionRow, right: ContributionRow) =>
    Number(right.pnl ?? Number.NEGATIVE_INFINITY) - Number(left.pnl ?? Number.NEGATIVE_INFINITY)
  );
};

const normalizeTrades = (result: any): TradeRow[] => {
  const rows = Array.isArray(result?.trades)
    ? result.trades
    : Array.isArray(result?.tradeLog)
      ? result.tradeLog
      : [];
  return rows.map((item: any, index: number) => ({
    id: String(item?.id || `${item?.code || "trade"}-${item?.entryDate || index}-${index}`),
    code: String(item?.code || item?.security?.code || ""),
    name: String(item?.name || item?.security?.name || item?.code || "--"),
    signalDate: String(item?.signalDate || item?.matchedDate || item?.triggerDate || "").slice(0, 10),
    entryDate: String(item?.actualEntryDate || item?.entryDate || item?.openedAt || item?.scheduledEntryDate || "").slice(0, 10),
    exitDate: String(item?.actualExitDate || item?.exitDate || item?.closedAt || item?.scheduledExitDate || "").slice(0, 10),
    entryPrice: numberOrNull(item?.entryPrice, item?.buyPrice),
    exitPrice: numberOrNull(item?.exitPrice, item?.sellPrice),
    shares: numberOrNull(item?.shares, item?.quantity),
    pnl: numberOrNull(item?.netPnl, item?.pnl, item?.profit, item?.realizedPnl),
    pnlPercent: numberOrNull(item?.netReturnPercent, item?.pnlPercent, item?.returnPercent, item?.returnPct),
    strategies: strategyIdsFrom(item?.strategyNames || item?.strategyIds || item?.matchedStrategies || (item?.strategyId ? [item.strategyId] : [])),
    exitReason: String(item?.exitReason || item?.closeReason || item?.disposition || "规则退出")
  }));
};

const flattenSignalEntries = (input: unknown, inheritedDate = "", output: any[] = []): any[] => {
  if (Array.isArray(input)) {
    input.forEach((item) => flattenSignalEntries(item, inheritedDate, output));
    return output;
  }
  if (!input || typeof input !== "object") return output;
  const item = input as Record<string, any>;
  const groupDate = String(item.date || item.signalDate || item.tradeDate || item.matchedDate || inheritedDate || "").slice(0, 10);
  const nestedKey = ["signals", "signalEvents", "events", "items", "stocks", "matches", "entries"].find((key) => Array.isArray(item[key]));
  if (nestedKey && !item.code && !item.security?.code && !item.stock?.code) {
    flattenSignalEntries(item[nestedKey], groupDate, output);
    return output;
  }
  if (item.byDate && typeof item.byDate === "object") {
    Object.entries(item.byDate).forEach(([date, rows]) => flattenSignalEntries(rows, date, output));
    return output;
  }
  if (item.code || item.security?.code || item.stock?.code) {
    output.push({ ...item, __groupDate: groupDate });
    return output;
  }
  const datedEntries = Object.entries(item).filter(([key, value]) =>
    /^\d{4}-\d{2}-\d{2}/.test(key) && (Array.isArray(value) || (value && typeof value === "object"))
  );
  datedEntries.forEach(([date, rows]) => flattenSignalEntries(rows, date, output));
  return output;
};

const normalizeSignalTimeline = (
  result: any,
  trades: TradeRow[],
  definitions: StrategyDefinition[],
  basket: Security[]
): SignalTimelineRow[] => {
  const namesById = new Map(definitions.map((item) => [item.id, item.name]));
  const namesByCode = new Map(basket.map((item) => [item.code, item.name]));
  const sources = [
    result?.signalTimeline,
    result?.signalEvents,
    result?.signals,
    result?.strategySignals,
    result?.replay?.signalTimeline,
    result?.replay?.signals,
    result?.portfolio?.signalTimeline
  ];
  let candidates: any[] = [];
  for (const source of sources) {
    const flattened = flattenSignalEntries(source);
    if (flattened.length) {
      candidates = flattened;
      break;
    }
  }

  if (!candidates.length) {
    return trades.map((trade, index) => ({
      id: `inferred-${trade.id}-${index}`,
      date: trade.signalDate || trade.entryDate || "日期未知",
      code: trade.code,
      name: trade.name,
      strategies: trade.strategies,
      executed: true,
      pending: false,
      statusLabel: "已成交",
      reason: "由账户交易记录还原；当前接口未返回未成交信号",
      entryDate: trade.entryDate,
      inferred: true
    }));
  }

  return candidates.map((item, index) => {
    const code = String(item?.code || item?.security?.code || item?.stock?.code || "").trim();
    const date = String(item?.signalDate || item?.date || item?.tradeDate || item?.matchedDate || item?.triggerDate || item?.__groupDate || "").slice(0, 10) || "日期未知";
    const rawStatus = String(item?.executionStatus || item?.execution?.status || item?.status || item?.result || "").toLowerCase();
    const explicitExecuted = item?.executed ?? item?.traded ?? item?.filled ?? item?.execution?.executed;
    const matchingTrade = trades.find((trade) =>
      trade.code === code && (
        Boolean(trade.signalDate && trade.signalDate === date) ||
        Boolean(item?.entryDate && trade.entryDate === String(item.entryDate).slice(0, 10)) ||
        Boolean(item?.tradeId && trade.id === String(item.tradeId))
      )
    );
    const executed = explicitExecuted === true ||
      Boolean(matchingTrade) ||
      /executed|filled|traded|entered|bought|成交|已买入/.test(rawStatus);
    const rejected = explicitExecuted === false ||
      /reject|skip|blocked|unfilled|untradeable|cancel|未成交|拒绝|跳过|不可交易/.test(rawStatus);
    const pending = /pending|waiting|待成交|待入场/.test(rawStatus);
    const reason = String(
      item?.reasonText || item?.rejectionReason || item?.unfilledReason || item?.skipReason ||
      item?.execution?.reasonText || item?.execution?.reason || item?.statusReason || item?.reason || item?.message || ""
    ).trim();
    const strategies = strategyLabelsFrom(
      item?.strategyNames || item?.matchedStrategyNames || item?.matchedStrategies ||
      item?.matchedStrategyIds || item?.strategyIds || item?.strategyId || item?.components,
      namesById
    );
    return {
      id: String(item?.id || item?.signalId || `${date}-${code || "signal"}-${index}`),
      date,
      code,
      name: String(item?.name || item?.security?.name || item?.stock?.name || namesByCode.get(code) || code || "--"),
      strategies,
      executed,
      pending,
      statusLabel: executed
        ? "已成交"
        : pending
          ? /exit|持有期/.test(`${item?.reason || ""}${reason}`)
            ? "结果待观察"
            : "等待下一交易日"
          : rejected
            ? "未成交"
            : "未成交",
      reason: executed
        ? reason || `下一交易日${String(item?.entryDate || item?.actualEntryDate || matchingTrade?.entryDate || "").slice(0, 10) || "按规则"}入场`
        : reason || (pending ? "信号位于回测窗口末端，尚无可用成交日" : "未进入账户（接口未返回具体原因）"),
      entryDate: String(item?.actualEntryDate || item?.entryDate || matchingTrade?.entryDate || "").slice(0, 10),
      inferred: false
    };
  }).sort((left, right) =>
    right.date.localeCompare(left.date) || left.code.localeCompare(right.code) || left.id.localeCompare(right.id)
  );
};

const groupSignalTimeline = (rows: SignalTimelineRow[]): SignalDateGroup[] => {
  const groups = new Map<string, SignalTimelineRow[]>();
  rows.forEach((row) => groups.set(row.date, [...(groups.get(row.date) || []), row]));
  return [...groups.entries()]
    .map(([date, dateRows]) => ({ date, rows: dateRows }))
    .sort((left, right) => right.date.localeCompare(left.date));
};

const formatNumber = (value: unknown, digits = 2) => {
  const number = numberOrNull(value);
  return number === null ? "--" : number.toFixed(digits);
};

const formatPercent = (value: unknown, digits = 2) => {
  const number = numberOrNull(value);
  return number === null ? "--" : `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`;
};

const formatMoney = (value: unknown) => {
  const number = numberOrNull(value);
  if (number === null) return "--";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: Math.abs(number) >= 10_000 ? 0 : 2
  }).format(number);
};

const toneFor = (value: unknown) => {
  const number = numberOrNull(value);
  return number === null ? "" : number >= 0 ? "positive" : "negative";
};

function EquityCurve({ points, startingCapital }: { points: EquityPoint[]; startingCapital: number }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  if (!points.length) {
    return <div className="pbt-empty-chart"><BarChart3 size={28} /><span>接口未返回权益曲线</span></div>;
  }
  const width = 1000;
  const height = 280;
  const bounds = { left: 68, right: 18, top: 24, bottom: 42 };
  const plotWidth = width - bounds.left - bounds.right;
  const plotHeight = height - bounds.top - bounds.bottom;
  const values = points.map((item) => item.equity);
  const rawMinimum = Math.min(...values, startingCapital);
  const rawMaximum = Math.max(...values, startingCapital);
  const padding = Math.max((rawMaximum - rawMinimum) * 0.12, rawMaximum * 0.008, 1);
  const minimum = rawMinimum - padding;
  const maximum = rawMaximum + padding;
  const range = Math.max(1, maximum - minimum);
  const xAt = (index: number) => bounds.left + (points.length === 1 ? plotWidth / 2 : index / (points.length - 1) * plotWidth);
  const yAt = (value: number) => bounds.top + (maximum - value) / range * plotHeight;
  const linePath = points.map((item, index) => `${index ? "L" : "M"}${xAt(index).toFixed(2)},${yAt(item.equity).toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${xAt(points.length - 1)},${bounds.top + plotHeight} L${xAt(0)},${bounds.top + plotHeight} Z`;
  const start = points[0]?.equity || startingCapital;
  const finish = points.at(-1)?.equity || start;
  const rising = finish >= start;
  const active = Math.min(points.length - 1, Math.max(0, hoverIndex ?? points.length - 1));
  const hover = points[active] || points[points.length - 1];
  if (!hover) return null;
  const dateLabelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];

  return (
    <div className="pbt-equity-chart-wrap">
      <div className="pbt-equity-tooltip">
        <span>{hover.date}</span>
        <b>{formatMoney(hover.equity)}</b>
        {hover.drawdownPercent !== undefined && <em>回撤 {formatPercent(hover.drawdownPercent)}</em>}
      </div>
      <svg
        className="pbt-equity-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="共享资金账户权益曲线"
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const localX = (event.clientX - rect.left) / Math.max(1, rect.width) * width;
          const ratio = Math.min(1, Math.max(0, (localX - bounds.left) / plotWidth));
          setHoverIndex(Math.round(ratio * Math.max(0, points.length - 1)));
        }}
      >
        <defs>
          <linearGradient id="pbt-equity-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={rising ? "#e24b5f" : "#39b980"} stopOpacity="0.32" />
            <stop offset="100%" stopColor={rising ? "#e24b5f" : "#39b980"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = bounds.top + ratio * plotHeight;
          const value = maximum - ratio * range;
          return (
            <g key={ratio}>
              <line x1={bounds.left} x2={width - bounds.right} y1={y} y2={y} className="pbt-chart-grid" />
              <text x={bounds.left - 10} y={y + 4} textAnchor="end" className="pbt-chart-axis">{Math.round(value / 1000)}k</text>
            </g>
          );
        })}
        <line
          x1={bounds.left}
          x2={width - bounds.right}
          y1={yAt(startingCapital)}
          y2={yAt(startingCapital)}
          className="pbt-chart-start-line"
        />
        <path d={areaPath} fill="url(#pbt-equity-area)" />
        <path d={linePath} className={rising ? "pbt-equity-line rising" : "pbt-equity-line falling"} />
        {dateLabelIndexes.map((index) => (
          <text key={index} x={xAt(index)} y={height - 13} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} className="pbt-chart-axis">
            {points[index]?.date || "--"}
          </text>
        ))}
        <line x1={xAt(active)} x2={xAt(active)} y1={bounds.top} y2={bounds.top + plotHeight} className="pbt-chart-hover-line" />
        <circle cx={xAt(active)} cy={yAt(hover.equity)} r="5" className={rising ? "pbt-chart-point rising" : "pbt-chart-point falling"} />
      </svg>
    </div>
  );
}

function ResultMetric({ label, value, detail, tone = "" }: { label: string; value: string; detail?: string | undefined; tone?: string }) {
  return (
    <div className={`pbt-result-metric ${tone}`}>
      <span>{label}</span>
      <b>{value}</b>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export default function PortfolioBacktestView({
  initialStrategyContext,
  initialSecurities = [],
  onBack,
  backLabel = "返回",
  onOpenSingle,
  onOpenSecurity,
  onResult
}: PortfolioBacktestViewProps) {
  const storedSetup = useMemo(loadStoredSetup, []);
  const contextStrategyIds = strategyIdsFrom(initialStrategyContext?.strategyIds);
  const [basket, setBasket] = useState<Security[]>(() =>
    initialStrategyContext?.universeSource === "strategy_current_matches" && initialSecurities.length
      ? uniqueSecurities(initialSecurities)
      : uniqueSecurities([...initialSecurities, ...loadStoredBasket()])
  );
  const [basketSource, setBasketSource] = useState<BasketSource>(() =>
    initialStrategyContext?.universeSource === "strategy_current_matches" && initialSecurities.length
      ? "strategy_current_matches"
      : "manual"
  );
  const [strategyUniverseLoading, setStrategyUniverseLoading] = useState(false);
  const [strategyUniverseError, setStrategyUniverseError] = useState("");
  const [strategyUniverseMeta, setStrategyUniverseMeta] = useState<Record<string, any> | null>(null);
  const [definitions, setDefinitions] = useState<StrategyDefinition[]>([]);
  const [definitionLoading, setDefinitionLoading] = useState(true);
  const [definitionError, setDefinitionError] = useState("");
  const [selectedStrategyIds, setSelectedStrategyIds] = useState<string[]>(() =>
    contextStrategyIds.length
      ? contextStrategyIds
      : strategyIdsFrom(storedSetup.strategyIds)
  );
  const [minimumVotes, setMinimumVotes] = useState(() =>
    Math.round(clamp(initialStrategyContext?.minimumVotes ?? storedSetup.minimumVotes, 1, 30, 1))
  );
  const [startingCapital, setStartingCapital] = useState(() =>
    Math.round(clamp(storedSetup.startingCapital, 10_000, 100_000_000, 500_000))
  );
  const [maxPositions, setMaxPositions] = useState(() =>
    Math.round(clamp(storedSetup.maxPositions, 1, 20, 5))
  );
  const lookbackBars = HALF_YEAR_LOOKBACK_BARS;
  const [commissionBps, setCommissionBps] = useState(() =>
    clamp(storedSetup.commissionBps, 0, 60, 7)
  );
  const [slippageBps, setSlippageBps] = useState(() =>
    clamp(storedSetup.slippageBps, 0, 60, 2)
  );
  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<Security[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<any>(null);
  const [signalTimelineExpanded, setSignalTimelineExpanded] = useState(true);
  const [signalTimelinePage, setSignalTimelinePage] = useState(1);
  const requestId = useRef(0);
  const strategyUniverseRequestId = useRef(0);

  const initialSecuritySignature = initialSecurities.map((item) => item.code).join(",");
  const contextSignature = contextStrategyIds.join(",");

  useEffect(() => {
    if (!initialSecurities.length) return;
    strategyUniverseRequestId.current += 1;
    setStrategyUniverseLoading(false);
    setStrategyUniverseError("");
    if (initialStrategyContext?.universeSource === "strategy_current_matches") {
      setBasket(uniqueSecurities(initialSecurities));
      setBasketSource("strategy_current_matches");
      setStrategyUniverseMeta({
        generatedAt: new Date().toISOString(),
        matchedCount: Math.max(initialSecurities.length, Number(initialStrategyContext.universeTotalCount || 0)),
        loadedCount: initialSecurities.length,
        source: "策略信号页本轮命中"
      });
    } else {
      setBasket((current) => uniqueSecurities([...initialSecurities, ...current]));
    }
  }, [initialSecuritySignature]);

  useEffect(() => {
    if (!contextStrategyIds.length) return;
    strategyUniverseRequestId.current += 1;
    setStrategyUniverseLoading(false);
    setStrategyUniverseMeta(null);
    setSelectedStrategyIds(contextStrategyIds);
    setMinimumVotes(Math.min(contextStrategyIds.length, Math.max(1, initialStrategyContext?.minimumVotes || 1)));
  }, [contextSignature, initialStrategyContext?.minimumVotes]);

  useEffect(() => {
    let active = true;
    setDefinitionLoading(true);
    window.stockApi.getStrategyDefinitions()
      .then((response) => {
        if (!active) return;
        const next = normalizeDefinitions(response);
        setDefinitions(next);
        setDefinitionError(next.length ? "" : "策略服务未返回可选策略");
      })
      .catch((reason) => {
        if (active) setDefinitionError(reason instanceof Error ? reason.message : "策略定义加载失败");
      })
      .finally(() => {
        if (active) setDefinitionLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!saveSafeLocalJson(BASKET_STORAGE_KEY, basket)) {
      // 本地存储不可用时仍允许本次回测。
    }
  }, [basket]);

  useEffect(() => {
    if (!saveSafeLocalJson(SETUP_STORAGE_KEY, {
      strategyIds: selectedStrategyIds,
      minimumVotes,
      startingCapital,
      maxPositions,
      lookbackBars,
      commissionBps,
      slippageBps
    })) {
      // 本地存储不可用时仍允许本次回测。
    }
  }, [selectedStrategyIds, minimumVotes, startingCapital, maxPositions, lookbackBars, commissionBps, slippageBps]);

  useEffect(() => {
    setMinimumVotes((current) => Math.min(Math.max(1, current), Math.max(1, selectedStrategyIds.length)));
  }, [selectedStrategyIds.length]);

  useEffect(() => {
    const keyword = searchText.trim();
    if (keyword.length < 2) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const rows = uniqueSecurities(await window.stockApi.search(keyword));
        if (!active) return;
        const existing = new Set(basket.map((item) => item.code));
        setSuggestions(rows.filter((item) => !existing.has(item.code)).slice(0, 8));
        setSuggestionsOpen(true);
        setSearchError("");
      } catch {
        if (active) {
          setSuggestions([]);
          setSearchError("股票搜索暂不可用，请稍后重试");
        }
      } finally {
        if (active) setSearching(false);
      }
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [searchText, basket.map((item) => item.code).join(",")]);

  useEffect(() => () => {
    requestId.current += 1;
    strategyUniverseRequestId.current += 1;
  }, []);

  useEffect(() => {
    setSignalTimelinePage(1);
    setSignalTimelineExpanded(true);
  }, [result]);

  const effectiveDefinitions = useMemo(() => {
    const byId = new Map(definitions.map((item) => [item.id, item]));
    for (const id of selectedStrategyIds) {
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          name: id === initialStrategyContext?.strategyId
            ? initialStrategyContext?.strategyName || id
            : id,
          detail: "由上游策略信号带入，等待策略定义服务补充说明",
          type: selectedStrategyIds.length > 1 ? "composite" : "base"
        });
      }
    }
    return [...byId.values()];
  }, [definitions, selectedStrategyIds, initialStrategyContext?.strategyId, initialStrategyContext?.strategyName]);

  const addSecurity = (security: Security) => {
    if (basket.some((item) => item.code === security.code)) {
      setSearchError("该股票已在篮子中");
      return;
    }
    if (basket.length >= MAX_BASKET_SIZE) {
      setSearchError(`股票篮子最多 ${MAX_BASKET_SIZE} 只`);
      return;
    }
    strategyUniverseRequestId.current += 1;
    setStrategyUniverseLoading(false);
    setBasket((current) => [...current, security]);
    setBasketSource("manual");
    setStrategyUniverseMeta(null);
    setSearchText("");
    setSuggestions([]);
    setSuggestionsOpen(false);
    setSearchError("");
  };

  const toggleStrategy = (id: string) => {
    strategyUniverseRequestId.current += 1;
    setStrategyUniverseLoading(false);
    setSelectedStrategyIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]
    );
    setBasketSource("manual");
    setStrategyUniverseMeta(null);
    setStrategyUniverseError("");
  };

  const loadStrategyUniverse = async () => {
    if (strategyUniverseLoading || !selectedStrategyIds.length) return;
    const currentRequest = ++strategyUniverseRequestId.current;
    const requestedStrategyIds = [...selectedStrategyIds];
    const requestedMinimumVotes = Math.min(
      requestedStrategyIds.length,
      Math.max(1, minimumVotes)
    );
    setStrategyUniverseLoading(true);
    setStrategyUniverseError("");
    try {
      const report = await window.stockApi.scanStrategySignals({
        strategyIds: [],
        historyBars: 720,
        maxUniverse: 300,
        maxStocksPerStrategy: 200,
        minSamples: 120,
        minOutOfSampleSamples: 36,
        minIndependentSignalDays: 60,
        minWalkForwardFoldSamples: 10,
        walkForwardFolds: 4,
        refresh: false
      });
      const { candidates, source } = resolvePublishedStrategyUniverse(
        report,
        requestedStrategyIds,
        requestedMinimumVotes
      );
      const securities = uniqueSecurities(candidates, MAX_BASKET_SIZE);
      if (!securities.length) {
        throw new Error("所选策略在本轮真实候选池中没有股票达到设定票数；系统不会放宽门槛凑数");
      }
      if (currentRequest !== strategyUniverseRequestId.current) return;
      setBasket(securities);
      setBasketSource("strategy_current_matches");
      setStrategyUniverseMeta({
        generatedAt: report?.generatedAt || new Date().toISOString(),
        matchedCount: candidates.length,
        loadedCount: securities.length,
        source,
        validationRange: report?.dataRange || null,
        warning: report?.selectionBiasWarning || ""
      });
      setSearchError("");
    } catch (reason) {
      if (currentRequest === strategyUniverseRequestId.current) {
        setStrategyUniverseError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (currentRequest === strategyUniverseRequestId.current) {
        setStrategyUniverseLoading(false);
      }
    }
  };

  const execute = async () => {
    if (running) return;
    if (basket.length < 1) {
      setError("请至少添加 1 只股票后再回测");
      return;
    }
    if (!selectedStrategyIds.length) {
      setError("请至少选择 1 套策略");
      return;
    }
    const safeVotes = Math.min(selectedStrategyIds.length, Math.max(1, minimumVotes));
    const primaryStrategyId = selectedStrategyIds[0];
    if (!primaryStrategyId) {
      setError("请选择有效策略后再运行回测");
      return;
    }
    const currentRequest = ++requestId.current;
    setRunning(true);
    setError("");
    try {
      const reuseInitialContext = matchesInitialStrategySignature(
        initialStrategyContext,
        selectedStrategyIds,
        safeVotes
      );
      const strategyContext = {
        source: reuseInitialContext
          ? initialStrategyContext?.source || "single_strategy"
          : selectedStrategyIds.length > 1 ? "optimized_portfolio" : "single_strategy",
        strategyEngine: reuseInitialContext
          ? initialStrategyContext?.strategyEngine || "verified-signal-v2"
          : "verified-signal-v2",
        strategyId: reuseInitialContext
          ? initialStrategyContext?.strategyId || primaryStrategyId
          : selectedStrategyIds.length > 1 ? "custom_portfolio_vote" : primaryStrategyId,
        strategyName: reuseInitialContext
          ? initialStrategyContext?.strategyName || primaryStrategyId
          : selectedStrategyIds.length > 1
            ? "自定义多策略投票"
            : effectiveDefinitions.find((item) => item.id === primaryStrategyId)?.name || primaryStrategyId,
        ...(reuseInitialContext && initialStrategyContext?.strategyVersion
          ? { strategyVersion: initialStrategyContext.strategyVersion }
          : {}),
        strategyIds: selectedStrategyIds,
        minimumVotes: safeVotes
      };
      const next = await window.stockApi.runPortfolioBacktest({
        securities: basket,
        universe: basket.map((item) => item.code),
        strategyIds: selectedStrategyIds,
        minimumVotes: safeVotes,
        strategyContext,
        universeSource: basketSource,
        startingCapital,
        maxPositions: Math.min(maxPositions, basket.length),
        lookbackBars,
        commissionBps,
        slippageBps,
        benchmark: "000985",
        accountMode: "shared_cash",
        lotSize: 100
      });
      if (requestId.current !== currentRequest) return;
      setResult(next);
      onResult?.(next);
    } catch (reason) {
      if (requestId.current === currentRequest) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestId.current === currentRequest) setRunning(false);
    }
  };

  const metrics = result?.metrics || {};
  const equityCurve = useMemo(() => normalizeEquityCurve(result), [result]);
  const contributions = useMemo(() => normalizeContributions(result), [result]);
  const trades = useMemo(() => normalizeTrades(result), [result]);
  const signalTimeline = useMemo(
    () => normalizeSignalTimeline(result, trades, effectiveDefinitions, basket),
    [result, trades, effectiveDefinitions, basket]
  );
  const signalDateGroups = useMemo(() => groupSignalTimeline(signalTimeline), [signalTimeline]);
  const signalTimelinePages = Math.max(1, Math.ceil(signalDateGroups.length / SIGNAL_DATES_PER_PAGE));
  const safeSignalTimelinePage = Math.min(signalTimelinePage, signalTimelinePages);
  const visibleSignalDateGroups = signalDateGroups.slice(
    (safeSignalTimelinePage - 1) * SIGNAL_DATES_PER_PAGE,
    safeSignalTimelinePage * SIGNAL_DATES_PER_PAGE
  );
  const validation = result?.validation || {};
  const benchmark = result?.benchmark || {};
  const universe = result?.universe || {};
  const resultUniverseSource = String(
    universe?.selectionMode || result?.universeSource || basketSource
  );
  const dataQuality = result?.dataQuality || {};
  const resultStrategyContext = result?.strategyContext || result?.strategy || {};
  const totalReturn = numberOrNull(metrics.totalReturnPercent, metrics.totalReturn);
  const annualizedReturn = numberOrNull(metrics.cagrPercent, metrics.annualizedReturnPercent, metrics.annualizedReturn);
  const maxDrawdown = numberOrNull(metrics.maxDrawdownPercent, metrics.maxDrawdown);
  const sharpe = numberOrNull(metrics.sharpeRatio, metrics.sharpe);
  const winRate = numberOrNull(metrics.winRatePercent, metrics.winRate);
  const tradeCount = numberOrNull(metrics.completedTrades, metrics.tradeCount, metrics.trades, trades.length);
  const benchmarkReturn = numberOrNull(
    metrics.benchmarkReturnPercent,
    benchmark.totalReturnPercent,
    benchmark.totalReturn,
    benchmark.returnPercent
  );
  const excessReturn = numberOrNull(
    metrics.excessReturnPercent,
    metrics.excessReturn,
    metrics.benchmarkExcessPercent,
    benchmark.cumulativeExcessReturnPercent,
    totalReturn !== null && benchmarkReturn !== null ? totalReturn - benchmarkReturn : null
  );
  const profitFactor = numberOrNull(metrics.profitFactor, metrics.payoffFactor);
  const endingCapital = numberOrNull(result?.account?.endingEquity, metrics.endingCapital, metrics.finalEquity, equityCurve.at(-1)?.equity);
  const usedSecurityCount = numberOrNull(
    universe?.usedCount,
    universe?.processed,
    metrics.securityCount,
    dataQuality.loadedStocks,
    Array.isArray(universe?.usableCodes) ? universe.usableCodes.length : null,
    Array.isArray(universe) ? universe.length : null,
    contributions.length
  );
  const requestedSecurityCount = numberOrNull(
    universe?.requestedCount,
    dataQuality.requestedStocks,
    Array.isArray(universe?.requestedCodes) ? universe.requestedCodes.length : null,
    basket.length
  );
  const failedSecurityCount = numberOrNull(
    universe?.failedCount,
    Array.isArray(dataQuality.failedStocks) ? dataQuality.failedStocks.length : null
  );
  const rawResultStatus = String(result?.status || validation.status || "").toUpperCase();
  const insufficient = rawResultStatus.includes("INSUFFICIENT") ||
    String(validation.reason || "").includes("样本不足");
  const diagnosticPrefix = (requestedSecurityCount ?? basket.length) === 1 ? "单股诊断" : "组合诊断";
  const diagnosticLabel = validation.accepted === true
    ? `${diagnosticPrefix} · 样本外通过`
    : insufficient
      ? `${diagnosticPrefix} · 样本不足`
      : `${diagnosticPrefix} · 待复核`;
  const methodologyText = (() => {
    const methodology = result?.methodology;
    if (typeof methodology === "string") return methodology;
    if (methodology && typeof methodology === "object") {
      if (typeof methodology.summary === "string" && methodology.summary.trim()) {
        return methodology.summary.trim();
      }
      const preferredKeys = [
        "accountMode",
        "capitalModel",
        "eventOrder",
        "signalTiming",
        "entryRule",
        "exitRule",
        "entry",
        "exit",
        "costs",
        "allocationRule",
        "positionSizing",
        "benchmark"
      ];
      const parts = preferredKeys.flatMap((key) => {
        const value = methodology[key];
        if (typeof value === "string" && value.trim()) return [value.trim()];
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
        return [];
      });
      if (parts.length) return [...new Set(parts)].join("；");
    }
    return "组合回测按历史当时可见数据生成信号，并在共享现金账户内顺序撮合；历史结果不代表未来收益。";
  })();
  const validationReasonText = typeof validation.reason === "string" && validation.reason.trim()
    ? validation.reason.trim()
    : Array.isArray(validation.reasons)
      ? validation.reasons.filter((item: unknown): item is string => typeof item === "string" && Boolean(item.trim())).join("；")
      : "";

  return (
    <div className="portfolio-backtest-view">
      <header className="pbt-page-head">
        <div>
          <span>STRATEGY BACKTEST</span>
          <h1>策略回测中心</h1>
          <p>先选择策略并生成对应股票池，再选择单只、部分或全部股票，回放最近半年信号、成交与账户收益。</p>
        </div>
        <div className="pbt-head-actions">
          {onBack && <button className="secondary-btn" onClick={onBack}><ArrowLeft size={16} />{backLabel}</button>}
          {onOpenSingle && <button className="secondary-btn" onClick={onOpenSingle}><Activity size={16} />单股明细回放</button>}
          <button className="primary-btn" disabled={running} onClick={execute}>
            {running ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}
            {running ? "策略回放中" : "执行策略回测"}
          </button>
        </div>
      </header>

      <div className="pbt-account-disclosure">
        <WalletCards size={20} />
        <div>
          <b>共享资金账户口径</b>
          <p>所有股票竞争同一笔起始资金，受最大持仓数、A股 100 股整数手、简化佣金与滑点和同时信号约束；结果不是各股票收益率的简单平均。当前成本模型未覆盖最低佣金及按历史日期变化的税费。</p>
        </div>
      </div>

      <div className="pbt-flow-strip" aria-label="回测流程">
        <span className="active"><b>1</b>选择策略逻辑</span>
        <i>→</i>
        <span className={basketSource === "strategy_current_matches" ? "active" : ""}><b>2</b>生成策略股票池</span>
        <i>→</i>
        <span><b>3</b>单只 / 部分 / 全部</span>
        <i>→</i>
        <span><b>4</b>最近半年逐日回放</span>
      </div>

      <section className="pbt-setup-grid">
        <div className="panel pbt-config-panel">
          <div className="pbt-panel-title">
            <Layers3 size={18} />
            <div><b>策略投票</b><small>多选策略，并设置同股同日最低命中票数</small></div>
            <em>{selectedStrategyIds.length} 已选</em>
          </div>
          {initialStrategyContext?.strategyName && (
            <div className="pbt-upstream-context">
              <CheckCircle2 size={16} />
              <span><b>已预载：{initialStrategyContext.strategyName}</b><small>{initialStrategyContext.strategyVersion || "verified-signal-v2"}</small></span>
            </div>
          )}
          {definitionLoading && <div className="pbt-inline-state"><LoaderCircle className="spin" size={17} />加载策略定义</div>}
          {definitionError && <div className="pbt-inline-state warning"><CircleAlert size={17} />{definitionError}</div>}
          <div className="pbt-strategy-grid">
            {effectiveDefinitions.map((strategy) => {
              const selected = selectedStrategyIds.includes(strategy.id);
              return (
                <button key={strategy.id} className={selected ? "selected" : ""} disabled={strategyUniverseLoading} onClick={() => toggleStrategy(strategy.id)}>
                  <span>{selected ? "✓" : "+"}</span>
                  <div><b>{strategy.name}</b><small>{strategy.detail}</small></div>
                  <em className={strategy.publicationAccepted === true ? "passed" : strategy.publicationAccepted === false ? "review" : ""}>
                    {strategy.type === "composite" ? "组合" : "基础"}
                  </em>
                </button>
              );
            })}
          </div>
          <label className="pbt-vote-setting">
            <span>最低同时命中 <b>{minimumVotes} / {Math.max(1, selectedStrategyIds.length)} 票</b></span>
            <input
              type="range"
              min="1"
              max={Math.max(1, selectedStrategyIds.length)}
              value={Math.min(minimumVotes, Math.max(1, selectedStrategyIds.length))}
              onChange={(event) => {
                strategyUniverseRequestId.current += 1;
                setStrategyUniverseLoading(false);
                setMinimumVotes(Number(event.target.value));
                setBasketSource("manual");
                setStrategyUniverseMeta(null);
              }}
              disabled={!selectedStrategyIds.length || strategyUniverseLoading}
            />
            <small>票数越高，信号更少且更严格；组合回测不会自动放宽门槛凑交易。</small>
          </label>
          <div className="pbt-strategy-universe-action">
            <button
              className="primary-btn"
              disabled={!selectedStrategyIds.length || strategyUniverseLoading}
              onClick={loadStrategyUniverse}
            >
              {strategyUniverseLoading ? <LoaderCircle className="spin" size={16} /> : <Target size={16} />}
              {strategyUniverseLoading ? "正在复核策略股票池" : "按所选策略生成股票池"}
            </button>
            <small>只采用策略信号页已经通过发布复核且本轮真实命中的股票；不会为了产生回测交易而降低门槛。</small>
          </div>
          {strategyUniverseError && (
            <div className="pbt-inline-state warning"><CircleAlert size={17} />{strategyUniverseError}</div>
          )}
        </div>

        <div className="panel pbt-basket-panel">
          <div className="pbt-panel-title">
            <Users size={18} />
            <div>
              <b>{basketSource === "strategy_current_matches" ? "策略对应股票" : "自定义验证股票"}</b>
              <small>策略池可保留单只、部分或全部；手工搜索仅作补充验证，最多 {MAX_BASKET_SIZE} 只</small>
            </div>
            <em>{basket.length} / {MAX_BASKET_SIZE}</em>
          </div>
          {strategyUniverseMeta && (
            <div className="pbt-universe-evidence">
              <CheckCircle2 size={16} />
              <div>
                <b>{strategyUniverseMeta.source} · 命中 {strategyUniverseMeta.matchedCount || basket.length} 只，已带入 {strategyUniverseMeta.loadedCount || basket.length} 只</b>
                <small>
                  生成于 {new Date(strategyUniverseMeta.generatedAt).toLocaleString("zh-CN", { hour12: false })}；执行后按历史信号日重新判断，不用今天的分数代替历史分数。
                </small>
              </div>
            </div>
          )}
          <div className={`pbt-stock-search ${searchError ? "invalid" : ""}`}>
            <Search size={16} />
            <input
              value={searchText}
              onChange={(event) => {
                setSearchText(event.target.value);
                setSearchError("");
                setSuggestionsOpen(true);
              }}
              onFocus={() => setSuggestionsOpen(Boolean(suggestions.length))}
              placeholder="输入股票名称或6位代码添加"
              autoComplete="off"
            />
            {searching && <LoaderCircle className="spin" size={15} />}
            {suggestionsOpen && suggestions.length > 0 && (
              <div className="pbt-stock-suggestions">
                {suggestions.map((item) => (
                  <button key={`${item.code}-${item.secid}`} onClick={() => addSecurity(item)}>
                    <span><b>{item.name}</b><small>{item.code}</small></span>
                    <em>{item.marketName || item.thscode?.split(".")[1] || "A股"}</em>
                  </button>
                ))}
              </div>
            )}
          </div>
          {searchError && <small className="pbt-field-error">{searchError}</small>}
          <div className="pbt-basket-actions">
            <span>当前篮子</span>
            <button disabled={!basket.length} onClick={() => { strategyUniverseRequestId.current += 1; setStrategyUniverseLoading(false); setBasket([]); setBasketSource("manual"); setStrategyUniverseMeta(null); }}><Trash2 size={14} />清空</button>
          </div>
          <div className="pbt-basket-chips">
            {basket.map((item) => (
              <span key={item.code}>
                <b>{item.name}</b><small>{item.code}</small>
                <button aria-label={`删除${item.name}`} onClick={() => { strategyUniverseRequestId.current += 1; setStrategyUniverseLoading(false); setBasketSource("manual"); setStrategyUniverseMeta(null); setBasket((current) => current.filter((row) => row.code !== item.code)); }}><X size={13} /></button>
              </span>
            ))}
            {!basket.length && <div className="pbt-empty-basket"><Database size={23} /><span>先选择策略并生成对应股票池，也可以手工添加单只股票作补充验证</span></div>}
          </div>
        </div>
      </section>

      <section className="panel pbt-account-panel">
        <div className="pbt-panel-title">
          <WalletCards size={18} />
          <div><b>账户与执行假设</b><small>参数会保存在本机，下次继续沿用</small></div>
        </div>
        <div className="pbt-account-fields">
          <label><span>起始资金</span><input type="number" min="10000" max="100000000" step="10000" value={startingCapital} onChange={(event) => setStartingCapital(Math.round(clamp(event.target.value, 10_000, 100_000_000, startingCapital)))} /><small>{formatMoney(startingCapital)}</small></label>
          <label><span>最大同时持仓</span><input type="number" min="1" max="20" value={maxPositions} onChange={(event) => setMaxPositions(Math.round(clamp(event.target.value, 1, 20, maxPositions)))} /><small>实际不超过篮子股票数</small></label>
          <label><span>历史窗口（日线）</span><input type="number" value={lookbackBars} readOnly aria-label="固定最近半年120个交易日" /><small>固定 120 根，约半年</small></label>
          <label><span>佣金（bps/边）</span><input type="number" min="0" max="60" step="0.1" value={commissionBps} onChange={(event) => setCommissionBps(clamp(event.target.value, 0, 60, commissionBps))} /><small>买卖双边计入；不含最低佣金与税费</small></label>
          <label><span>滑点（bps/边）</span><input type="number" min="0" max="60" step="0.1" value={slippageBps} onChange={(event) => setSlippageBps(clamp(event.target.value, 0, 60, slippageBps))} /><small>与佣金分别计算</small></label>
        </div>
      </section>

      {error && <div className="pbt-error-state"><ShieldAlert size={20} /><div><b>策略回测未完成</b><p>{error}</p></div><button onClick={execute}>重试</button></div>}
      {running && (
        <div className="panel pbt-running-state">
          <LoaderCircle className="spin" size={30} />
          <div><b>正在回放最近半年策略信号</b><p>历史数据、策略信号和逐日资金撮合在后台运行；可正常切换其他页面，返回后查看结果。</p></div>
        </div>
      )}

      {!result && !running && !error && (
        <div className="panel pbt-ready-state">
          <BarChart3 size={30} />
          <div><b>配置完成后执行策略回测</b><p>结果将展示账户权益、每个信号日期命中的股票、成交状态和交易明细。</p></div>
        </div>
      )}

      {result && !running && (
        <section className="pbt-results">
          <div className="pbt-result-head">
            <div>
              <span>PORTFOLIO RESULT</span>
              <h2>共享账户回测结果</h2>
              <p>
                {resultStrategyContext.strategyName || initialStrategyContext?.strategyName || `${selectedStrategyIds.length} 策略投票`}
                {resultStrategyContext.minimumVotes || minimumVotes ? ` · 至少 ${resultStrategyContext.minimumVotes || minimumVotes} 票` : ""}
                {result?.generatedAt ? ` · ${new Date(result.generatedAt).toLocaleString("zh-CN", { hour12: false })}` : ""}
              </p>
            </div>
            <span className={`pbt-validation-badge ${validation.accepted === false ? "blocked" : "neutral"}`}>
              {diagnosticLabel}
            </span>
          </div>

          <div className="pbt-result-metrics">
            <ResultMetric label="账户总收益" value={formatPercent(totalReturn)} tone={toneFor(totalReturn)} detail={endingCapital === null ? undefined : `期末 ${formatMoney(endingCapital)}`} />
            <ResultMetric label="年化收益" value={formatPercent(annualizedReturn)} tone={toneFor(annualizedReturn)} />
            <ResultMetric label="最大回撤" value={formatPercent(maxDrawdown)} tone={maxDrawdown !== null && maxDrawdown < -15 ? "warning" : ""} />
            <ResultMetric label="Sharpe" value={formatNumber(sharpe)} detail="账户日收益年化" />
            <ResultMetric label="交易胜率" value={formatPercent(winRate, 1)} />
            <ResultMetric label="完成交易" value={tradeCount === null ? "--" : `${Math.round(tradeCount)} 笔`} />
            <ResultMetric label="基准超额" value={formatPercent(excessReturn)} tone={toneFor(excessReturn)} detail={benchmark.name || "中证全指"} />
            <ResultMetric label="Profit Factor" value={formatNumber(profitFactor)} detail="总盈利 / 总亏损" />
            <ResultMetric label="实际股票覆盖" value={`${usedSecurityCount ?? "--"} / ${requestedSecurityCount ?? basket.length}`} detail={failedSecurityCount ? `失败 ${failedSecurityCount}` : undefined} />
          </div>

          {validationReasonText && (
            <div className={`pbt-validation-note ${validation.accepted === false ? "blocked" : ""}`}>
              {validation.accepted === false ? <ShieldAlert size={18} /> : <CheckCircle2 size={18} />}
              <div><b>组合诊断结论</b><p>{validationReasonText}</p></div>
            </div>
          )}

          <div className="panel pbt-equity-panel">
            <div className="pbt-panel-title">
              <TrendingUp size={18} />
              <div><b>账户权益曲线</b><small>包含空仓现金、并发持仓、整手约束和逐笔成本</small></div>
            </div>
            <EquityCurve points={equityCurve} startingCapital={startingCapital} />
          </div>

          <div className="panel pbt-table-panel pbt-signal-panel">
            <div className="pbt-panel-title">
              <CalendarDays size={18} />
              <div>
                <b>策略信号时间表</b>
                <small>列出测试范围内、在各历史信号日命中所选策略的股票，以及次日是否实际成交</small>
              </div>
              <em>{signalDateGroups.length} 个日期 · {signalTimeline.length} 条信号</em>
              <button
                className="pbt-signal-toggle"
                onClick={() => setSignalTimelineExpanded((current) => !current)}
                aria-expanded={signalTimelineExpanded}
                aria-label={signalTimelineExpanded ? "收起策略信号时间表" : "展开策略信号时间表"}
              >
                {signalTimelineExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                {signalTimelineExpanded ? "收起" : "展开"}
              </button>
            </div>
            {signalTimelineExpanded && (
              <div className="pbt-signal-timeline">
                {signalTimeline.some((row) => row.inferred) && (
                  <div className="pbt-signal-fallback-note">
                    <CircleAlert size={15} />
                    <span>当前结果只提供了成交记录，时间表已还原已成交信号；升级后的接口会同时列出全部未成交信号及原因。</span>
                  </div>
                )}
                {visibleSignalDateGroups.map((group) => {
                  const executedCount = group.rows.filter((row) => row.executed).length;
                  const pendingCount = group.rows.filter((row) => row.pending).length;
                  return (
                    <section className="pbt-signal-day" key={group.date}>
                      <header>
                        <time dateTime={group.date}>{group.date}</time>
                        <span>{group.rows.length} 条命中 · {executedCount} 条成交{pendingCount ? ` · ${pendingCount} 条待观察` : ""}</span>
                      </header>
                      <div className="pbt-signal-rows">
                        {group.rows.map((row, index) => (
                          <div className="pbt-signal-row" key={`${group.date}-${row.code}-${row.id}-${index}`}>
                            <span className="pbt-signal-stock">
                              <b>{row.name}</b>
                              <small>{row.code || "--"}</small>
                            </span>
                            <span className="pbt-signal-strategies" title={row.strategies.join(" / ")}>
                              <b>{row.strategies.slice(0, 3).join(" / ") || "策略投票"}</b>
                              <small>{row.strategies.length > 3 ? `另有 ${row.strategies.length - 3} 项策略命中` : "当日收盘产生信号"}</small>
                            </span>
                            <span className={`pbt-signal-status ${row.executed ? "executed" : row.pending ? "pending" : "rejected"}`}>
                              <b>{row.statusLabel}</b>
                              <small>{row.entryDate && (row.executed || row.pending) ? `实际入场 ${row.entryDate} · ${row.reason}` : row.reason}</small>
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                })}
                {!signalTimeline.length && (
                  <div className="pbt-table-empty">最近半年内没有股票命中当前策略组合</div>
                )}
                {signalDateGroups.length > SIGNAL_DATES_PER_PAGE && (
                  <nav className="pbt-signal-pagination" aria-label="策略信号日期分页">
                    <button
                      onClick={() => setSignalTimelinePage((current) => Math.max(1, current - 1))}
                      disabled={safeSignalTimelinePage <= 1}
                      aria-label="上一页信号日期"
                    ><ChevronLeft size={15} />上一页</button>
                    <span>第 {safeSignalTimelinePage} / {signalTimelinePages} 页，每页 {SIGNAL_DATES_PER_PAGE} 个日期</span>
                    <button
                      onClick={() => setSignalTimelinePage((current) => Math.min(signalTimelinePages, current + 1))}
                      disabled={safeSignalTimelinePage >= signalTimelinePages}
                      aria-label="下一页信号日期"
                    >下一页<ChevronRight size={15} /></button>
                  </nav>
                )}
              </div>
            )}
          </div>

          <div className="panel pbt-table-panel">
            <div className="pbt-panel-title">
              <Users size={18} />
              <div><b>每股账户贡献</b><small>贡献是该股票已结算盈亏占起始资金比例，不是单股独立回测收益</small></div>
              <em>{contributions.length} 只</em>
            </div>
            <div className="pbt-data-table pbt-contribution-table">
              <div className="pbt-tr pbt-th"><span>股票</span><span>账户盈亏</span><span>贡献</span><span>自身收益</span><span>交易数</span><span>胜率</span></div>
              {contributions.map((row) => (
                <button className="pbt-tr" key={row.code} onClick={() => onOpenSecurity?.({ code: row.code, name: row.name, secid: "" })} disabled={!onOpenSecurity}>
                  <span><b>{row.name}</b><small>{row.code}</small></span>
                  <span className={toneFor(row.pnl)}>{formatMoney(row.pnl)}</span>
                  <span className={toneFor(row.contributionPercent)}>{formatPercent(row.contributionPercent)}</span>
                  <span className={toneFor(row.returnPercent)}>{formatPercent(row.returnPercent)}</span>
                  <span>{row.tradeCount === null ? "--" : Math.round(row.tradeCount)}</span>
                  <span>{formatPercent(row.winRatePercent, 1)}</span>
                </button>
              ))}
              {!contributions.length && <div className="pbt-table-empty">接口未返回每股贡献明细</div>}
            </div>
          </div>

          <div className="panel pbt-table-panel">
            <div className="pbt-panel-title">
              <Activity size={18} />
              <div><b>账户交易明细</b><small>按实际入场顺序记录；同时信号会受可用现金和最大持仓数限制</small></div>
              <em>{trades.length} 笔</em>
            </div>
            <div className="pbt-trade-scroll">
              <div className="pbt-data-table pbt-trade-table">
                <div className="pbt-tr pbt-th"><span>股票</span><span>入场 / 退出</span><span>价格</span><span>股数</span><span>盈亏</span><span>策略 / 原因</span></div>
                {trades.map((trade) => (
                  <div className="pbt-tr" key={trade.id}>
                    <span><b>{trade.name}</b><small>{trade.code}</small></span>
                    <span><b>{trade.entryDate || "--"}</b><small>{trade.exitDate || "--"}</small></span>
                    <span><b>{formatNumber(trade.entryPrice)}</b><small>→ {formatNumber(trade.exitPrice)}</small></span>
                    <span>{trade.shares === null ? "--" : Math.round(trade.shares)}</span>
                    <span className={toneFor(trade.pnl)}><b>{formatMoney(trade.pnl)}</b><small>{formatPercent(trade.pnlPercent)}</small></span>
                    <span><b>{trade.strategies.slice(0, 2).join(" / ") || "策略投票"}</b><small>{trade.exitReason}</small></span>
                  </div>
                ))}
                {!trades.length && <div className="pbt-table-empty">没有满足资金、票数与可成交条件的交易</div>}
              </div>
            </div>
          </div>

          <div className="pbt-method-note">
            <CircleAlert size={16} />
            <span>
              {resultUniverseSource === "strategy_current_matches"
                ? "股票范围由所选策略本轮命中生成，不是手工先选股；但当前命中池仍不是完整的历史时点全市场成分，因此保留幸存者偏差提示。"
                : "手选股票篮子存在选择与幸存者偏差，本页结果只用于组合诊断，不能证明策略对全市场有效。"}
              {methodologyText}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
