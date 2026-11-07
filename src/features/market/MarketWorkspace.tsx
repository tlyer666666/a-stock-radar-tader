import { marketCapitalization } from "../../domain/marketCapitalization";
import LimitUpPool from "../dashboard/LimitUpPool";
import { AiStockReviewPanel } from "../ai-picks/AiStockReviewPanel";
import LimitEcologyPanel from "../dashboard/LimitEcologyPanel";
import ConsecutiveBoardLadder from "../../ConsecutiveBoardLadder";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  Activity, BarChart3, Bookmark, BookmarkCheck, CheckCircle2, ChevronLeft,
  CircleAlert, CircleDot, Database, ExternalLink, Gauge, Layers3,
  LineChart, LoaderCircle, Newspaper, RefreshCw, ShieldAlert, ShieldCheck,
  SlidersHorizontal, Target, TrendingDown, TrendingUp, Zap
} from "lucide-react";
import {
  EmptyInline, ErrorState, Fact, LoadingState, Metric, PageHeading, PanelTitle, ReturnBar
} from "../../components/terminal/TerminalPrimitives";
import { fmt, fmtMoney, nullableNumber, subtractNullable } from "../../domain/formatters";
import { clampNumber, normalizeRiskProfile, riskProfileLabel } from "../../domain/settings";
import { paperCloseReasonLabel, type PaperClosedPosition, type PaperPosition } from "../../domain/paperSimulationTypes";
import { tradeSignalLabel } from "../../domain/executionLabels";
import { limitPoolProviderLabel } from "./marketLabels";
import { whenVisible } from "../../visiblePolling";
import { formatShanghaiDateTime } from "../../dateUtils";
import { averageAt, calculateBollingerBands, calculatePriceMovingAverages } from "../../priceChartSeries";
import TimeShareChart from "./TimeShareChart";

function MiniBar({ label, value }: { label: string; value: number }) {
  return <div className="mini-bar"><span>{label}<b>{value}</b></span><i><em style={{ width: `${value}%` }} /></i></div>;
}

// F-02: 这个组件的 icon 会被立即解引用渲染（<Icon size={19} />），
// 但 props 原本是 any —— 少传 icon 时编译器看不见，运行时会白屏。
// 补上显式类型后，必填项由类型系统守住。
type IconComponent = ComponentType<{ size?: number | string; className?: string }>;

function SignalCard({ icon: Icon, label, value, detail, good }: {
  icon: IconComponent;
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  good?: boolean;
}) {
  return <div className={`panel signal-card ${good ? "positive" : "negative"}`}><div><Icon size={19} /></div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

/**
 * 「一键平掉所有当前标的」必须走全平回调（closeAllPaperTrades）。
 * 未接线时回退到旧的“只平当前标的”，保证旧调用方/旧测试行为不变（向后兼容）。
 * 抽成纯函数是为了在没有 DOM 的测试环境里也能断言按钮实际绑定的回调。
 */
export const resolvePaperCloseAllHandler = (
  closeAll: ((reason?: PaperClosedPosition["closeReason"]) => void) | undefined,
  closeCurrent: ((reason?: PaperClosedPosition["closeReason"]) => void) | undefined
) => (typeof closeAll === "function" ? closeAll : closeCurrent);

export function Dashboard({
  live,
  payload,
  loading,
  error,
  isWatched,
  onToggleWatch,
  onDiscover,
  discovering,
  limitUps,
  limitPoolMeta,
  onOpen,
  onAdd,
  isFavorite,
  settings,
  analysisTarget,
  mode,
  backLabel,
  onBack,
  onOpenBacktest,
  executionDecisionLog,
  onClearExecutionDecisionLog,
  paperSummary,
  paperExecutionReadiness,
  paperCurrentPositions,
  canPaperTrade,
  latestExecutionDecision,
  executePaperTrade,
  closePaperTradeForCurrent,
  closePaperTradeForCode,
  closeAllPaperTrades,
  onRetry
}: any) {
  const [showFullExecutionDecisionLog, setShowFullExecutionDecisionLog] = useState(false);
  if (mode === "analysis" && !payload) {
    const targetName = typeof analysisTarget === "string"
      ? analysisTarget
      : analysisTarget?.name || analysisTarget?.code || "所选股票";
    const targetCode = typeof analysisTarget === "string" ? analysisTarget : analysisTarget?.code;
    return (
      <>
        <PageHeading
          eyebrow="SECURITY ANALYSIS"
          title={`个股复盘 · ${targetName}`}
          description={targetCode && targetCode !== targetName ? `正在读取 ${targetCode} 的最新有效数据` : "正在读取最新有效数据"}
          actions={(
            <button type="button" className="secondary-btn analysis-back-btn" onClick={onBack}>
              <ChevronLeft size={17} />
              {backLabel}
            </button>
          )}
        />
        {loading
          ? <LoadingState />
          : error
            ? <ErrorState message={error} onRetry={onRetry} />
            : <EmptyInline text="请选择股票后生成个股复盘。" />}
      </>
    );
  }
  if (mode === "pool" || !payload) {
    return (
      <div className="limit-pool-workspace">
        <PageHeading
          eyebrow="LIMIT-UP RADAR"
          title="涨停池"
          description={limitPoolMeta?.dataDate
            ? `数据日 ${limitPoolMeta.dataDate} · ${limitPoolMeta.count}只 · 最近核对 ${new Date(limitPoolMeta.checkedAt).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })} · ${limitPoolProviderLabel(limitPoolMeta.providers)}`
            : "每只涨停股同步显示实时行情、封板质量与结构判断；点击“分析”进入完整个股复盘。"}
          actions={<button className="primary-btn" onClick={onDiscover} disabled={discovering}>{discovering ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}刷新涨停池</button>}
        />
        {/* 涨停生态各块（涨停结构、连板天梯、涨停原因、热榜、龙虎榜、异动、AI 解读）放在最上面一字排开，点开看详情。 */}
        <LimitEcologyPanel onOpen={onOpen} live={live} />
        {/* 连板梯队与涨停池同源（同一份涨停池快照），放在涨停监控右侧随池子一起刷新。 */}
        {/* 开盘前（或当日涨停池还没取到）只显示一行说明，不把空的连板梯队撑满整行。 */}
        {limitUps.length ? <div className="limit-pool-columns">
          <LimitUpPool items={limitUps} meta={limitPoolMeta} onOpen={onOpen} onAdd={onAdd} isFavorite={isFavorite} />
          <aside className="limit-ladder-sidebar"><ConsecutiveBoardLadder rows={limitUps} onOpen={onOpen} /></aside>
        </div> : <p className="limit-pool-empty" role="status">当日涨停池还没有数据：交易日开盘后自动刷新，也可以点右上角「刷新涨停池」。涨停池和连板梯队有数据后显示在这里。</p>}
        {loading ? <LoadingState /> : error ? <ErrorState message={error} /> : limitUps.length ? <EmptyInline text="请选择涨停池股票查看详细分析。" /> : null}
      </div>
    );
  }
  const { quote, analysis: a, sector, history, announcements, security } = payload;
  const assetLabel = a.isSearchOnlyAsset
    ? String(a.assetLabel || quote.assetLabel || (security.assetType === "etf" ? "ETF" : "可转债"))
    : "";
  const isGeneralStock = !assetLabel && !a.limitEvent;
  // E-01：0 / 缺失 / 非数的最新价不是“真的 0 元”，不得格式化成 0.00 并染成涨红。
  const latestPrice = nullableNumber(quote.latest);
  const changePercent = nullableNumber(quote.changePct);
  const priceAvailable = latestPrice !== null && latestPrice > 0;
  const up = priceAvailable && changePercent !== null && changePercent >= 0;
  const scoreTone = a.mrs >= 75 ? "good" : a.mrs >= 60 ? "warn" : "risk";
  const signal =
    a.grade === "S" ? "主线核心" : a.grade === "A" ? "主线回踩" : a.grade === "B" ? "等待确认" : "风险观察";
  const tradePlan = a.tradePlan || {};
  const tradeProjection = a.tradeProjection?.projection || {};
  const executionPolicy = a.executionPolicy || {};
  // R-01 修复（同源）：服务端 analysis.historicalEdge 是对象而非数字。
  // 原实现 `Number.isFinite(a.historicalEdge) ? … : null` 对对象恒为 false → 永远 null
  // → 显示「待计算」，而 passed 又可能为 true，造成矛盾。
  // 取 average5（平均 5 日收益%）作为展示数值，passed 用对象的权威判定。
  const edgeObject = a.historicalEdge && typeof a.historicalEdge === "object" ? a.historicalEdge : null;
  const historicalEdge = edgeObject
    ? (Number.isFinite(edgeObject.average5) ? edgeObject.average5 : Number.isFinite(edgeObject.winRate5) ? edgeObject.winRate5 : null)
    : Number.isFinite(a.historicalEdge) ? a.historicalEdge : null;
  const historicalEdgePassed = a.qualification?.historicalEdgePassed === true
    || (edgeObject?.passed === true);
  const qualityIndex = Number.isFinite(a.qualityIndex) ? a.qualityIndex : null;
  const marketCap = marketCapitalization(quote, a.marketCap);
  const marketCapInBn = marketCap === null ? null : marketCap / 1e8;
  const marketCapPassed =
    settings.minMarketCap <= 0 || (marketCap !== null && marketCap >= settings.minMarketCap * 1e8);
  const hasTradePlan = tradePlan.signal === "BUY" || tradePlan.signal === "BUY_AGGRESSIVE";
  const killReasons: string[] = Array.isArray(tradePlan.killSwitchReasons)
    ? tradePlan.killSwitchReasons.filter((reason: unknown): reason is string => typeof reason === "string")
    : [];
  const killReasonsText = killReasons
    .filter((reason) => !(hasTradePlan && reason === "未触发买入信号"))
    .slice(0, 3)
    .join("；");
  const executionFillRate = clampNumber(tradePlan.executionFillRatePercent, 0, 100, 100);
  const minExecutionRate = clampNumber(
    executionPolicy.minExecutionRatePercent ?? settings.minExecutionRatePercent,
    40,
    100,
    90
  );
  const minProjectedNetEdge = clampNumber(executionPolicy.minProjectedNetEdgePercent ?? settings.minProjectedNetEdgePercent, -2, 10, 0.2);
  const minExpectancy = clampNumber(executionPolicy.minExpectancyPoints ?? settings.minExpectancyPoints, -2, 5, 0.2);
  const minPaperWinRatePercent = clampNumber(settings.minPaperWinRatePercent ?? 52, 40, 90, 52);
  const minPaperRiskRewardRatio = clampNumber(settings.minPaperRiskRewardRatio ?? 1.15, 1, 3, 1.15);
  const executionRiskProfile = normalizeRiskProfile(executionPolicy.riskProfile);
  const executionRiskProfileLabel = riskProfileLabel(executionRiskProfile);
  const quoteAmount = Number(quote.amount);
  const turnoverPercent = Number(quote.turnover);
  const updatedAtSeconds = Number.isFinite(Date.parse(payload.updatedAt))
    ? Math.max(0, Math.round((Date.now() - Date.parse(payload.updatedAt)) / 1000))
    : null;
  const marketReadinessPolicy = {
    minTurnoverPercent: clampNumber(settings.minTurnoverPercent ?? 0.4, 0, 20, 0.4),
    minQuoteAmount: clampNumber(settings.minQuoteAmount ?? 1200000, 0, 1_000_000_000, 1200000),
    maxQuoteAgeSeconds: clampNumber(settings.maxQuoteAgeSeconds ?? 480, 30, 1800, 480)
  };
  const riskControlsPass = [
    {
      name: "市值过滤",
      ok: marketCapPassed,
      value: `${marketCapInBn !== null ? `${fmt(marketCapInBn)}亿` : "未知"}`
    },
    {
      name: "行情新鲜度",
      ok: updatedAtSeconds === null ? true : updatedAtSeconds <= marketReadinessPolicy.maxQuoteAgeSeconds,
      value: `${updatedAtSeconds === null ? "未知" : `${updatedAtSeconds}s / 阈值 ${marketReadinessPolicy.maxQuoteAgeSeconds}s`}`
    },
    {
      name: "成交额门槛",
      ok: Number.isFinite(quoteAmount) ? quoteAmount >= marketReadinessPolicy.minQuoteAmount : false,
      value: `${Number.isFinite(quoteAmount) ? fmtMoney(quoteAmount) : "未知"} / 阈值 ${fmtMoney(marketReadinessPolicy.minQuoteAmount)}`
    },
    {
      name: "换手率门槛",
      ok: Number.isFinite(turnoverPercent) ? turnoverPercent >= marketReadinessPolicy.minTurnoverPercent : false,
      value: `${Number.isFinite(turnoverPercent) ? `${turnoverPercent.toFixed(2)}%` : "未知"} / 阈值 ${marketReadinessPolicy.minTurnoverPercent}%`
    },
    {
      name: "历史边界",
      ok: historicalEdgePassed,
      value: historicalEdge !== null ? `${historicalEdge}%` : "待计算"
    },
    {
      name: "当日风险限额",
      ok: (executionPolicy.maxDailyRiskPercent || 0) > 0,
      value: `${executionPolicy.maxDailyRiskPercent || "--"}%`
    },
    {
      name: "成交率",
      ok: executionFillRate >= minExecutionRate,
      value: `${executionFillRate.toFixed(1)}% / 阈值 ${minExecutionRate}%`
    },
    {
      name: "最小预期净收益",
      ok: Number.isFinite(tradeProjection.projectedNetEdge) && tradeProjection.projectedNetEdge >= minProjectedNetEdge,
      value: `${minProjectedNetEdge}%`
    },
    {
      name: "最小期望值",
      ok: Number.isFinite(tradeProjection.expectancyPoints) && tradeProjection.expectancyPoints >= minExpectancy,
      value: `${minExpectancy}`
    },
    {
      name: "组合仓位上限",
      ok: (executionPolicy.maxPortfolioRiskPercent || 0) > 0,
      value: `${executionPolicy.maxPortfolioRiskPercent || "--"}%`
    },
    {
      name: "行业集中度",
      ok: Number.isFinite(executionPolicy.maxSectorExposurePercent ?? 45)
        ? paperSummary.currentSectorExposurePercent <= Number(executionPolicy.maxSectorExposurePercent ?? 45)
        : true,
      value: `${paperSummary.currentSectorName || "未知行业"} ${paperSummary.currentSectorExposurePercent.toFixed(1)}% / ${executionPolicy.maxSectorExposurePercent || "--"}%`
    },
    {
      name: "日内交易上限",
      ok: !paperSummary.dailyTradeSignal.blockedByDailyLimit,
      value: `${paperSummary.dailyTradeSignal.todayTradeCount}/${paperSummary.dailyTradeSignal.maxDailyTrades} 笔`
    },
    {
      name: "日内胜率",
      ok: paperSummary.dailyTradeSignal.todayClosedCount === 0 || paperSummary.dailyTradeSignal.todayWinRate >= minPaperWinRatePercent,
      value: `${paperSummary.dailyTradeSignal.todayClosedCount > 0 ? `${paperSummary.dailyTradeSignal.todayWinRate.toFixed(1)}%` : "--"} / 阈值 ${minPaperWinRatePercent}%`
    },
    {
      name: "风险收益比",
      ok: Number.isFinite(Number(tradeProjection.riskReward)) && Number(tradeProjection.riskReward) >= minPaperRiskRewardRatio,
      value: `风险收益比 ${tradeProjection.riskReward ?? "--"} / 阈值 ${minPaperRiskRewardRatio}`
    },
    {
      name: "仓位限额",
      ok: Number.isFinite(tradePlan.positionSizePercent) && Number(tradePlan.positionSizePercent) > 0,
      value: `${tradePlan.positionSizePercent ?? 0}%`
    }
  ];
  const paperExecutionButtonClass = `primary-btn paper-trade-btn ${
    paperExecutionReadiness.level === "wait" ? "paper-trade-btn--wait" : ""
  }`;
  const executionDecisionRows = Array.isArray(executionDecisionLog)
    ? (showFullExecutionDecisionLog ? executionDecisionLog : executionDecisionLog.slice(0, 5))
    : [];
  const hasMoreExecutionDecisionLog = Array.isArray(executionDecisionLog) && executionDecisionLog.length > 5;

  return (
    <div className="terminal-analysis-layout">
      <PageHeading
        eyebrow={assetLabel
          ? `${assetLabel} · 实时行情`
          : `${quote.industry || "A股"} · 涨停股 · ${payload.actualProvider === "ths" ? "同花顺实时" : payload.actualProvider === "ths_free" ? "同花顺免费实时" : "免费实时行情"}`}
        title={
          <span className="stock-title">
            {quote.name}<small>{quote.code}</small>
            <em className={`market-pill ${security.thscode?.endsWith("SH") ? "sh" : "sz"}`}>
              {security.thscode?.split(".")[1] || "A"}
            </em>
          </span>
        }
        description={`数据更新于 ${new Date(payload.updatedAt).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`}
        actions={
          <>
<button className="secondary-btn analysis-back-btn" onClick={onBack}>
              <ChevronLeft size={17} />
              {backLabel}
            </button>
            <button className="secondary-btn" onClick={onToggleWatch}>
              {isWatched ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
              {isWatched ? "已加入自选" : "加入自选"}
            </button>
            <button className="secondary-btn" onClick={() => onOpenBacktest(security)}>
              <LineChart size={17} />
              运行回测
            </button>
            <button className="primary-btn" onClick={onRetry} disabled={loading}>
              {loading ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
              刷新个股
            </button>
          </>
        }
      />

      {payload.warning && <div className="warning-banner"><CircleAlert size={17} />{payload.warning}</div>}

      <MarketDataStatusPanel
        federation={payload.dataFederation}
        actualProvider={payload.actualProvider}
        updatedAt={payload.updatedAt}
      />


      <section className="hero-grid">
        <div className="price-card panel">
          <div className="price-block">
            <span>最新价</span>
            <strong className={priceAvailable ? (up ? "red" : "green") : ""}>{priceAvailable ? fmt(latestPrice) : "--"}</strong>
            {priceAvailable ? (
              <div className={changePercent === null ? "" : up ? "red" : "green"}>
                {changePercent === null ? null : up ? <TrendingUp size={17} /> : <TrendingDown size={17} />}
                {changePercent === null
                  ? "涨跌幅待补"
                  : <>{up ? "+" : ""}{fmt(quote.change)} &nbsp; {up ? "+" : ""}{fmt(changePercent)}%</>}
              </div>
            ) : (
              <div>暂无有效行情</div>
            )}
          </div>
          <div className="quote-grid">
            <Metric label="今开" value={fmt(quote.open)} />
            <Metric label="最高" value={fmt(quote.high)} tone="red" />
            <Metric label="最低" value={fmt(quote.low)} tone="green" />
            <Metric label="昨收" value={fmt(quote.preClose)} />
            <Metric label="换手" value={`${fmt(quote.turnover)}%`} />
            <Metric label="成交额" value={fmtMoney(quote.amount)} />
          </div>
        </div>

        <div className={`score-card panel ${scoreTone}`}>
          <div className="score-ring" style={{ "--score": `${a.mrs * 3.6}deg` } as any}>
            <div><strong>{a.mrs}</strong><span>MRS</span></div>
          </div>
          <div className="score-copy">
            <span className="grade">等级 {a.grade}</span>
            <h3>{signal}</h3>
            <p>{assetLabel
              ? `${assetLabel} · 技术结构与多周期 K 线`
              : a.limitEvent
                ? `${a.exactNode || a.nextNode || "观察期"} · ${a.trendLabel}`
                : "近60个交易日暂无涨停事件 · 通用行情分析"}</p>
          </div>
          <div className="score-components">
            <MiniBar label="个股结构" value={a.structureScore} />
            <MiniBar label="板块强度" value={a.sectorScore} />
            <MiniBar label="资讯驱动" value={a.infoScore} />
          </div>
        </div>
      </section>

      {!assetLabel && <AiStockReviewPanel security={{ code: quote.code || security.code, name: quote.name || security.name }} />}

      <section className="content-grid">
        <TrendChartPanel
          live={live}
          security={security}
          dailyHistory={history}
          eventDate={a.limitEvent?.date}
          support={a.limitEvent?.low}
          trendLabel={a.trendLabel}
        />

        <div className="panel node-panel">
          <PanelTitle
            title={assetLabel ? "行情结构" : isGeneralStock ? "通用行情结构" : "事件观察窗"}
            subtitle={assetLabel
              ? "主动搜索专属，不进入涨停观察池"
              : isGeneralStock
                ? "手工搜索、自选、持仓与多股同列均可分析"
                : "按交易日计算"}
            icon={Target}
          />
          {assetLabel ? (
            <div className="asset-search-scope-note">
              <b>{assetLabel} 行情已接入</b>
              <span>支持实时价格、分时与多周期 K 线；涨停日、T+节点和连板数据不适用于该标的。</span>
            </div>
          ) : isGeneralStock ? (
            <div className="asset-search-scope-note">
              <b>普通 A 股行情与技术分析已接入</b>
              <span>近期没有涨停事件，因此不生成 T+ 节点和封板质量；实时行情、趋势、量价、板块比较与回测仍可正常使用。</span>
            </div>
          ) : (
            <>
              <Timeline daysSince={a.daysSince} />
              <div className="event-facts">
                <Fact label="涨停日期" value={a.limitEvent?.date || "未识别"} />
                <Fact label="关键支撑" value={a.limitEvent ? `¥ ${fmt(a.limitEvent.low)}` : "--"} />
                <Fact label="距支撑位" value={`${a.supportDistance >= 0 ? "+" : ""}${fmt(a.supportDistance)}%`} tone={a.heldSupport ? "good" : "risk"} />
                <Fact label="锚定均价" value={a.avwap ? `¥ ${fmt(a.avwap)}` : "--"} />
              </div>
            </>
          )}
        </div>
      </section>

      <section className="signal-grid">
        {assetLabel ? (
          <SignalCard icon={ShieldCheck} label="标的范围" value="搜索专属" detail="默认池隐藏，不触发涨停策略" good />
        ) : isGeneralStock ? (
          <SignalCard icon={ShieldCheck} label="涨停事件" value="近60日未识别" detail="仅跳过涨停事件因子，不影响通用行情分析" good />
        ) : (
          <SignalCard icon={ShieldCheck} label="关键位防守" value={a.heldSupport ? "支撑有效" : "支撑失效"} detail={`观察期最低价 ${a.limitEvent ? fmt(Math.min(...history.filter((x: any) => x.date >= a.limitEvent.date).map((x: any) => x.low))) : "--"}`} good={a.heldSupport} />
        )}
        <SignalCard icon={Activity} label="量价状态" value={a.volumeRatio < 0.8 ? "缩量整理" : a.volumeRatio < 1.5 ? "量能温和" : "量能放大"} detail={`量能倍数 ${fmt(a.volumeRatio)} · 相对换手 ${fmt(a.relativeTurnover)}`} good={a.volumeRatio < 1.5} />
        <SignalCard icon={TrendingUp} label="均线趋势" value={a.trendLabel} detail={`MA5-MA20 发散 ${fmt(a.divergence)}%`} good={a.maBull && a.slopesUp} />
        {assetLabel ? (
          <SignalCard icon={Gauge} label="市场参照" value="中性比较" detail="不纳入涨停板块强度排名" good />
        ) : (
          <SignalCard icon={Gauge} label="相对板块" value={`${a.rsSector >= 0 ? "+" : ""}${fmt(a.rsSector)}%`} detail={`个股3日 ${fmt(a.stockReturn3)}%`} good={a.rsSector >= 0} />
        )}
      </section>

      {a.limitEvent ? <FirstBoardQualityPanel quality={a.firstBoardQuality} /> : null}

      <section className="panel strategy-status-panel">
        <PanelTitle
          title="当前策略组合"
          subtitle="逐项显示实际结果；风险否决始终执行"
          icon={SlidersHorizontal}
          badge={a.alertQualified ? "已达到提醒条件" : `${a.strategyMatched || 0} / ${a.strategyTotal || settings?.selectedStrategies?.length || 0} 符合`}
        />
        <div className={`qualification-strip ${a.alertQualified ? "qualified" : "waiting"}`}>
          {a.alertQualified ? <CheckCircle2 size={18} /> : <CircleDot size={18} />}
          <div>
            <b>{a.alertQualified ? "策略、分数、节点和风险过滤均通过" : "当前未触发提醒"}</b>
            <small>
              匹配率 {a.strategyMatchRate || 0}% · MRS {a.mrs}/{a.qualification?.alertScore || settings?.alertScore} ·
              {a.qualification?.exactNodesOnly ? ` 节点 ${a.exactNode || "未到"}` : " 节点不限"} ·
              风险否决 {a.qualification?.riskVetoPassed ? "通过" : "未通过"}
            </small>
          </div>
        </div>
        <div className="strategy-result-grid">
          {(a.strategyResults || []).map((item: any) => (
            <div className={`strategy-result ${item.matched ? "matched" : "missed"}`} key={item.id}>
              <span>{item.matched ? "✓" : "×"}</span>
              <div><b>{item.label}</b><small>{item.detail}</small></div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel execution-plan-panel">
        <PanelTitle
          title="执行计划与风控"
          subtitle="基于策略与账户风控规则输出可执行动作"
          icon={Target}
          badge={qualityIndex === null ? "未生成执行计划" : `质量评分 ${qualityIndex}`}
        />
        <div className={`qualification-strip ${hasTradePlan ? "qualified" : "waiting"}`}>
          {hasTradePlan ? <CheckCircle2 size={18} /> : <CircleDot size={18} />}
          <div>
            <b>执行信号：{tradeSignalLabel(tradePlan.signal)}</b>
            <small>
              历史边界 {historicalEdge !== null ? `${historicalEdge}%` : "--"}，
              {historicalEdgePassed ? "历史通过" : "历史未通过"}，市值 {marketCap === null ? "未知" : marketCapPassed ? "通过" : "未通过"}
            </small>
          </div>
        </div>
        <div className="fact-grid">
          <h4>执行约束</h4>
          {(riskControlsPass || []).map((item) => (
            <Fact key={item.name} label={item.name} value={item.ok ? `✅ ${item.value}` : `❌ ${item.value}`} />
          ))}
        </div>
        <div className="execution-grid">
          <div>
            <h4>仓位与风控</h4>
            <div className="fact-grid">
              <Fact label="最大仓位" value={`${tradePlan.maxPositionPercent ?? "--"}%`} />
              <Fact label="建议仓位" value={`${tradePlan.positionSizePercent ?? "--"}%`} />
              <Fact label="单笔风险占比" value={`${tradePlan.atRiskPercent ?? "--"}%`} />
              <Fact label="止损位" value={tradePlan.stopLossPrice ? fmtMoney(tradePlan.stopLossPrice) : "--"} />
              <Fact label="止盈位" value={tradePlan.takeProfitPrice ? fmtMoney(tradePlan.takeProfitPrice) : "--"} />
              <Fact label="止损距离" value={tradePlan.stopLossDistancePercent ? `${fmt(tradePlan.stopLossDistancePercent)}%` : "--"} />
              <Fact label="止盈距离" value={tradePlan.takeProfitDistancePercent ? `${fmt(tradePlan.takeProfitDistancePercent)}%` : "--"} />
              <Fact label="风险收益比" value={tradePlan.riskReward ?? "--"} />
              <Fact label="Kelly系数" value={tradePlan.halfKellyFraction !== undefined ? fmt(tradePlan.halfKellyFraction) : "--"} />
              <Fact label="Kelly仓位建议" value={tradePlan.kellyPositionPercent !== undefined ? `${fmt(tradePlan.kellyPositionPercent)}%` : "--"} />
              <Fact label="Kill 开关" value={tradePlan.killSwitchTriggered ? "触发" : "未触发"} />
              <Fact label="Kill原因" value={killReasonsText || "--"} />
            </div>
          </div>
          <div>
            <h4>收益与概率</h4>
            <div className="fact-grid">
              <Fact label="目标策略" value={tradeProjection.strategyLabel || "--"} />
              <Fact label="预期回报" value={tradeProjection.expectedReturnPercent !== undefined ? `${fmt(tradeProjection.expectedReturnPercent)}%` : "--"} />
              <Fact label="净收益率" value={tradeProjection.projectedNetEdge !== undefined ? `${fmt(tradeProjection.projectedNetEdge)}%` : "--"} />
              <Fact label="期望值" value={tradeProjection.expectancyPoints !== undefined ? `${fmt(tradeProjection.expectancyPoints)}` : "--"} />
              <Fact label="预期成交率" value={tradeProjection.executionFillRatePercent !== undefined ? `${fmt(tradeProjection.executionFillRatePercent)}%` : "--"} />
              <Fact label="风控安全系数" value={tradeProjection.rrSafety !== undefined ? `${fmt(tradeProjection.rrSafety)}` : "--"} />
              <Fact label="TP概率" value={tradeProjection.probabilityTakeProfit !== undefined ? `${fmt(tradeProjection.probabilityTakeProfit)}%` : "--"} />
              <Fact label="SL概率" value={tradeProjection.probabilityStopLoss !== undefined ? `${fmt(tradeProjection.probabilityStopLoss)}%` : "--"} />
              <Fact label="超时概率" value={tradeProjection.probabilityTimeExit !== undefined ? `${fmt(tradeProjection.probabilityTimeExit)}%` : "--"} />
              <Fact label="Kelly仓位" value={tradeProjection.kellyPositionPercent !== undefined ? `${fmt(tradeProjection.kellyPositionPercent)}%` : "--"} />
              <Fact label="半Kelly" value={tradeProjection.kellyHalfFraction !== undefined ? fmt(tradeProjection.kellyHalfFraction) : "--"} />
              <Fact label="预计持仓期" value={`${tradeProjection.estimatedHoldingBars ?? 0} 根`} />
            </div>
          </div>
          <div>
            <h4>约束与执行开关</h4>
            <div className="fact-grid">
              <Fact label="风险档位" value={executionRiskProfileLabel} />
              <Fact label="日内风险上限" value={`${executionPolicy.maxDailyRiskPercent ?? "--"}%`} />
              <Fact label="最大持仓窗口" value={`${executionPolicy.maxHoldingBars ?? "--"} 根`} />
              <Fact label="单笔滑点+佣金" value={tradePlan.projectedCommissionPercent !== undefined ? `${tradePlan.projectedCommissionPercent}%` : "--"} />
              <Fact label="最小成交率" value={`${executionPolicy.minExecutionRatePercent ?? "--"}%`} />
              <Fact label="最大持仓数" value={`${executionPolicy.maxOpenPositions ?? "--"} 只`} />
              <Fact label="追踪止损" value={`${executionPolicy.trailingStopPercent ?? "--"}%`} />
              <Fact label="时间衰减" value={executionPolicy.timeDecayPerBarPercent !== undefined ? `${executionPolicy.timeDecayPerBarPercent}%` : "--"} />
              <Fact label="连续亏损停手" value={`${executionPolicy.maxConsecutiveLossesForStop ?? "--"} 笔`} />
              <Fact label="减仓步幅" value={`${executionPolicy.lossStreakStepPercent ?? "--"}% / 笔`} />
              <Fact label="组合仓位上限" value={`${executionPolicy.maxPortfolioRiskPercent ?? "--"}%`} />
              <Fact label="行业仓位上限" value={`${executionPolicy.maxSectorExposurePercent ?? "--"}%`} />
            </div>
          </div>
          <div>
            <h4>纸面模拟执行</h4>
            <div className="paper-trade-controls">
              <div className="paper-trade-actions">
                <button
                  className={paperExecutionButtonClass}
                  onClick={executePaperTrade}
                  disabled={!canPaperTrade}
                  title={
                    paperExecutionReadiness.level === "block"
                      ? paperExecutionReadiness.summary
                      : paperExecutionReadiness.level === "wait"
                        ? `${paperExecutionReadiness.recommendation}（可继续确认）`
                        : "按当前执行计划模拟开仓"
                  }
                >
                  模拟下单
                </button>
                <button
                  className="secondary-btn"
                  onClick={() => closePaperTradeForCurrent("MANUAL")}
                  disabled={!paperCurrentPositions.length}
                >
                  平掉当前标的
                </button>
              </div>
              <div className="execution-decision-log panel">
                <div className="execution-decision-log-head">
                  <strong>执行决策日志</strong>
                  <div className="execution-decision-log-actions">
                    {!!hasMoreExecutionDecisionLog && (
                      <button
                        className="secondary-btn ghost-btn"
                        onClick={() => setShowFullExecutionDecisionLog((current) => !current)}
                      >
                        {showFullExecutionDecisionLog ? "收起" : "展开"}
                      </button>
                    )}
                    {!!executionDecisionLog.length && (
                      <button
                        className="secondary-btn ghost-btn danger-btn"
                        onClick={onClearExecutionDecisionLog}
                        title="清空决策日志"
                      >
                        清空
                      </button>
                    )}
                  </div>
                </div>
                {!executionDecisionRows.length ? (
                  <div className="execution-decision-empty">暂无决策记录</div>
                ) : (
                  <div className="execution-decision-list">
                    {executionDecisionRows.map((decision: any) => (
                      <div className={`execution-decision-item execution-decision-item--${decision.level}`} key={decision.id}>
                        <b>
                          {decision.securityCode || "--"} · {decision.summary}
                        </b>
                        <span>
                          来源：{decision.source} · 等级：{decision.level.toUpperCase()} · 结果：{decision.result}
                        </span>
                        {decision.reasons?.length ? <small>{decision.reasons.join("；")}</small> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <small style={{ color: "var(--muted)", display: "block", marginTop: latestExecutionDecision ? 4 : 8, fontSize: 11 }}>
                {paperSummary.portfolioKill
                  ? `组合风控触发：${paperSummary.portfolioKillReasons.join("；")}`
                  : paperSummary.portfolioKillWarning
                  ? `组合风控预警：${paperSummary.portfolioKillReasons.join("；")}`
                  : paperSummary.dailyStopped
                  ? "今日日内风控已触发，停止新开仓。"
                  : paperSummary.lossStreakBlocked
                  ? `日内连续亏损过载，已触发降仓停手（${paperSummary.lossStreakConsecutive || 0}笔）`
                  : paperSummary.lossStreakConsecutive > 0
                  ? `日内连续亏损 ${paperSummary.lossStreakConsecutive} 笔，减仓系数 ${Math.round((paperSummary.lossStreakMultiplier || 1) * 100)}%`
                  : `可用仓位 ${paperCurrentPositions.length} / ${settings.maxOpenPositions}`}
              </small>
            </div>
          </div>
        </div>
      </section>

      <section className="panel paper-sim-panel">
        <PanelTitle
          title="纸面交易日志"
          subtitle="基于模拟资金的持仓与盈亏追踪（不接入真实下单）"
          icon={Bookmark}
          badge={`总交易 ${paperSummary.normalized.totalTradeCount || 0} 笔`}
        />
        <div className={`paper-governance-card ${paperSummary.strategyGovernance.stage}`}>
          <div className="paper-governance-head">
            <div>
              <strong>策略生命周期：{paperSummary.strategyGovernance.status}</strong>
              <small>
                当前档位 {riskProfileLabel(settings.riskProfile)} ·
                策略仓位系数 {Math.round(paperSummary.strategyGovernance.positionMultiplier * 100)}%
              </small>
            </div>
            <span className={`history-state ${
              paperSummary.strategyGovernance.stage === "promoted" ? "ok" :
                paperSummary.strategyGovernance.stage === "candidate" ? "wait" : "bad"
            }`}>
              {paperSummary.strategyGovernance.canPromoteToLive ? "可晋级" : paperSummary.strategyGovernance.stage.toUpperCase()}
            </span>
          </div>
          <div className="paper-governance-progress">
            <div>
              <span>验证进度</span>
              <b>{paperSummary.strategyGovernance.tradeCount}/{paperSummary.strategyGovernance.minimumPromotionTrades} 笔</b>
            </div>
            <em>
              <i style={{
                width: `${Math.min(
                  100,
                  paperSummary.strategyGovernance.tradeCount /
                    paperSummary.strategyGovernance.minimumPromotionTrades * 100
                )}%`
              }} />
            </em>
          </div>
          <div className="paper-governance-metrics">
            <div><span>资格评分</span><b>{paperSummary.strategyGovernance.score}</b></div>
            <div><span>当前策略胜率</span><b>{fmt(paperSummary.strategyGovernance.winRate)}%</b></div>
            <div>
              <span>盈利因子</span>
              <b>{Number.isFinite(paperSummary.strategyGovernance.profitFactor) ? fmt(paperSummary.strategyGovernance.profitFactor) : "∞"}</b>
            </div>
            <div><span>策略最大回撤</span><b>{fmt(paperSummary.strategyGovernance.maxDrawdownPercent)}%</b></div>
            <div><span>平均模拟成交率</span><b>{fmt(paperSummary.strategyGovernance.averageExecutionFillRatePercent)}%</b></div>
            <div><span>最近10笔盈亏</span><b>{fmtMoney(paperSummary.strategyGovernance.recentTenPnl)}</b></div>
          </div>
          <small className="paper-governance-reasons">
            {paperSummary.strategyGovernance.reasons.slice(0, 3).join("；")}
            {paperSummary.strategyGovernance.suspendedUntil
              ? `；暂停至 ${new Date(paperSummary.strategyGovernance.suspendedUntil).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`
              : ""}
          </small>
        </div>
        <div className="fact-grid paper-summary-grid">
          <Fact label="账户总资金" value={fmtMoney(paperSummary.equity)} />
          <Fact label="可用资金" value={fmtMoney(paperSummary.normalized.cash)} />
          <Fact label="持仓市值" value={fmtMoney(paperSummary.openValue)} />
          <Fact label="组合占用" value={`${fmt(paperSummary.portfolioRiskPercent)}% / ${paperSummary.maxPortfolioRiskPercent}%`} />
          <Fact label="行业集中度（当前）" value={paperSummary.currentSectorName ? `${paperSummary.currentSectorName} ${paperSummary.currentSectorExposurePercent.toFixed(1)}% / ${paperSummary.maxSectorExposurePercent}%` : "--"} />
          <Fact label="日内风险占用" value={`${(paperSummary.lossPressureRatio * 100).toFixed(2)}% / ${paperSummary.dailyLossLimit > 0 ? "阈值 " + fmt(paperSummary.dailyLossLimit) : "未启用"}`} />
          <Fact label="已实现盈亏" value={fmt(paperSummary.cumulativeRealizedPnl)} />
          <Fact label="累计回报" value={`${fmt(paperSummary.cumulativeReturnPercent)}%（${fmt(paperSummary.cumulativeNetPnl)}）`} />
          <Fact label="持仓未实现盈亏" value={`${fmt(paperSummary.openPnl)}（${fmt(paperSummary.openPnlPercent)}%）`} />
          <Fact label="今日已实现盈亏" value={fmt(paperSummary.normalized.dailyRealizedPnl)} />
          <Fact label="日内交易" value={`${paperSummary.dailyTradeSignal.todayTradeCount}/${paperSummary.dailyTradeSignal.maxDailyTrades}`} />
          <Fact label="今日胜率" value={paperSummary.dailyTradeSignal.todayClosedCount > 0 ? `${fmt(paperSummary.dailyTradeSignal.todayWinRate)}%` : "--"} />
          <Fact label="交易质量阈值" value={`胜率 ${fmt(paperSummary.dailyTradeSignal.todayClosedCount > 0 ? paperSummary.dailyTradeSignal.todayWinRate : 0)}% / RR ${fmt(settings.minPaperRiskRewardRatio ?? 1.15)}`} />
          <Fact label="盈亏比" value={paperSummary.profitFactor === Number.POSITIVE_INFINITY ? "∞" : fmt(paperSummary.profitFactor)} />
          <Fact label="平均持仓时长" value={`${paperSummary.avgHoldingBars.toFixed(1)} 根`} />
          <Fact label="最大回撤" value={`${fmt(paperSummary.maxDrawdownPercent)}%`} />
          <Fact label="连续亏损（当日）" value={`${paperSummary.lossStreakConsecutive || 0} 笔`} />
          <Fact label="减仓系数" value={paperSummary.lossStreakMultiplier !== undefined ? `${fmt(paperSummary.lossStreakMultiplier * 100)}%` : "--"} />
          <Fact label="连续亏损停手" value={paperSummary.lossStreakBlocked ? "是" : "否"} />
          <Fact label="历史胜率" value={paperSummary.closedCount ? `${fmt(paperSummary.winRate)}%` : "--"} />
          <Fact label="日内风险上限" value={paperSummary.dailyLossLimit > 0 ? `${fmt(paperSummary.dailyLossLimit)} 元` : "未启用"} />
          <Fact label="今天是否熔断" value={paperSummary.dailyStopped ? "是" : "否"} />
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="paper-summary-header">
            <h4>当前持仓</h4>
            {paperSummary.normalized.openPositions.length ? (
              <button
                type="button"
                className="secondary-btn"
                title={typeof closeAllPaperTrades === "function" ? "平掉全部持仓" : "未接入全平回调，将只平掉当前标的"}
                onClick={() => resolvePaperCloseAllHandler(closeAllPaperTrades, closePaperTradeForCurrent)?.("MANUAL")}
              >一键平掉所有当前标的</button>
            ) : (
              <small style={{ color: "var(--muted)" }}>暂无持仓</small>
            )}
          </div>
        {paperSummary.normalized.openPositions.length ? (
            <div className="table paper-position-table">
              <div className="th tr"><span>标的</span><span>仓位参数</span><span>持仓/成本</span><span>未实现/原因</span><span>操作</span></div>
              {paperSummary.normalized.openPositions.map((position: PaperPosition) => (
                <div className="tr" key={position.id}>
                  <span className="stock-cell">
                    <button className="table-action" onClick={() => onOpen({ code: position.code, name: position.name, secid: "" } as Security)}> {position.code}</button>
                    <small>{position.name}</small>{position.settlementBlockedReason && <small className="paper-settlement-warning">{position.settlementBlockedReason}</small>}
                  </span>
                  <span>{`${position.shares} 股 · 入场 ${fmt(position.entryPrice)}元`}</span>
                  <span>
                    {`持仓 ${position.holdingBars} 根`}
                    <br />
                    {`止损 ${fmtMoney(position.stopPrice)} / 止盈 ${fmtMoney(position.takePrice)}`}
                  </span>
                  <span>
                    {`最新 ${fmtMoney(position.latestPrice)}`}
                    <br />
                    {`未实 ${fmt(position.latestPrice * position.shares - position.entryPrice * position.shares)}元`}
                  </span>
                  <span>
                    <button className="table-action" onClick={() => closePaperTradeForCode(position.code, "MANUAL")}>平仓</button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <h4 style={{ marginTop: 12 }}>最近平仓</h4>
          {!paperSummary.normalized.closedPositions.length ? (
            <div className="empty-inline">暂无平仓记录</div>
          ) : (
            <div className="table paper-position-table">
              <div className="th tr"><span>时间</span><span>标的</span><span>原因</span><span>盈亏</span><span>平仓价</span></div>
              {paperSummary.normalized.closedPositions.slice(0, 6).map((position: PaperClosedPosition) => (
                <div className="tr" key={`${position.id}-${position.closeTime}`}>
                  <span>{formatShanghaiDateTime(position.closeTime).slice(0, 16).replace(/\//g, "-")}</span>
                  <span>{position.code}</span>
                  <span>{paperCloseReasonLabel(position.closeReason)}</span>
                  <span>{`${fmt(position.realizedPnl)}（${fmt(position.realizedPnlPercent)}%）`}</span>
                  <span>{fmtMoney(position.closePrice)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <HistoricalStatsPanel data={a.historicalStats} />

      <section className="content-grid lower">
        <div className="panel sector-panel">
          <PanelTitle
            title="板块强度"
            subtitle="1 / 3 / 5 日滚动"
            icon={Layers3}
            badge={sector?.state || "暂无数据"}
          />
          {sector ? (
            <>
              <div className="sector-head">
                <div><span>{sector.name}</span><strong>{sector.score ?? "--"}</strong><small>{sector.score == null ? " 评分暂停" : "/ 100"}</small></div>
                <div className="sector-rank">{sector.state}</div>
              </div>
              <div className="return-bars">
                <ReturnBar label="1日超额" value={subtractNullable(sector.returns.r1, sector.benchmarkReturns.r1)} />
                <ReturnBar label="3日超额" value={subtractNullable(sector.returns.r3, sector.benchmarkReturns.r3)} />
                <ReturnBar label="5日超额" value={subtractNullable(sector.returns.r5, sector.benchmarkReturns.r5)} />
              </div>
              <div className="sector-stats">
                <Metric label="上涨广度" value={sector.breadth == null ? "--" : `${fmt(sector.breadth * 100, 0)}%`} />
                <Metric label="涨停家数" value={String(sector.limitUps)} tone="red" />
                <Metric label="成交热度" value={sector.amountHeat == null ? "--" : `${fmt(sector.amountHeat)}x`} />
                <Metric label="5日持续" value={sector.persistence == null ? "--" : `${fmt(sector.persistence * 100, 0)}%`} />
              </div>
            </>
          ) : <EmptyInline text="板块数据暂不可用" />}
        </div>

        <div className="panel news-panel">
          <PanelTitle title="最新公告" subtitle="信息驱动 · 原始披露" icon={Newspaper} badge={`${announcements.length} 条`} />
          {announcements.slice(0, 4).map((item: any) => (
            <button
              className="news-item"
              key={item.art_code}
              onClick={() => window.stockApi.openExternal(`https://data.eastmoney.com/notices/detail/${quote.code}/${item.art_code}.html`)}
            >
              <span className={`news-score ${item.direction}`}>{item.score}</span>
              <span className="news-copy"><b>{item.title}</b><small>{item.category} · {item.display_time?.slice(0, 16)}</small></span>
              <ExternalLink size={15} />
            </button>
          ))}
          {!announcements.length && <EmptyInline text="暂无公告" />}
        </div>
      </section>

      {a.risks.length > 0 && (
        <div className="risk-strip">
          <CircleAlert size={18} />
          <b>风险提示</b>
          {a.risks.map((risk: string) => <span key={risk}>{risk}</span>)}
        </div>
      )}

    </div>
  );
}

function sourceDisplayName(source: any) {
  const id = String(source?.id || "").toLowerCase();
  if (id === "ths") return "同花顺";
  if (id === "eastmoney") return "东方财富";
  if (id === "tencent") return "腾讯";
  if (id === "fuyao") return "同花顺扶摇";
  if (id === "ths_free" || id === "ths-free") return "同花顺免费行情";
  if (id === "sina") return "新浪";
  if (id === "sohu") return "搜狐";
  return String(source?.name || "行情源");
}

// F-02 说明：这个面板只读后端返回的数据字段、不解引用任何可空对象，
// 精确类型需要与后端契约一一对应，待契约固定后再补（保留 any 属已知债）。
function MarketDataStatusPanel({ federation, actualProvider, updatedAt }: any) {
  const sourceRows = Array.isArray(federation?.sources) ? federation.sources : [];
  const byId = new Map(sourceRows.map((source: any) => [String(source?.id || ""), source]));
  const lines = ["ths", "eastmoney", "tencent"].map((id) => byId.get(id) || { id, enabled: false, ok: null });
  const spreadPct = Number(federation?.spreadPct);
  const realtimeCount = Number(federation?.realtimeCount);
  const status = String(federation?.status || "等待校验");
  const needsReview = status.includes("需复核") || (Number.isFinite(spreadPct) && spreadPct > 0.2);
  const isConsistent = !needsReview && Number.isFinite(realtimeCount) && realtimeCount >= 2 && Number.isFinite(spreadPct) && spreadPct <= 0.05;
  const updateTime = Number.isFinite(Date.parse(String(updatedAt || "")))
    ? new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })
    : "--";
  const activeProvider = sourceDisplayName({ id: actualProvider });
  return (
    <section className={`panel market-data-status ${needsReview ? "review" : isConsistent ? "consistent" : "limited"}`}>
      <div className="market-data-status-head">
        <div>
          <span><Database size={16} /> 行情来源与一致性</span>
          <b>行情可信度</b>
          <small>主源、接力和交叉校验均按实际返回状态展示，不把降级行情标成同花顺实时。</small>
        </div>
        <em>{needsReview ? "需人工复核" : isConsistent ? "多源一致" : status}</em>
      </div>
      <div className="market-data-metrics">
        <div><span>当前报价</span><b>{activeProvider}</b><small>{updateTime} 更新</small></div>
        <div><span>实时可用</span><b>{Number.isFinite(realtimeCount) ? `${realtimeCount} 路` : "--"}</b><small>三线并行校验</small></div>
        <div><span>多源价差</span><b>{Number.isFinite(spreadPct) ? `${spreadPct.toFixed(3)}%` : "--"}</b><small>{needsReview ? "超过阈值，已禁止纸面执行" : "不以均价替换主报价"}</small></div>
        <div><span>一致性价格</span><b>{Number(federation?.consensusPrice) > 0 ? fmt(federation.consensusPrice) : "--"}</b><small>仅用于交叉核验</small></div>
      </div>
      <div className="market-data-sources">
        {lines.map((source: any) => {
          const ok = source?.ok === true;
          const disabled = source?.enabled === false;
          const label = ok ? "已校验" : disabled ? "未配置" : "不可用";
          return (
            <div className={`market-data-source ${ok ? "ok" : disabled ? "disabled" : "fail"}`} key={source.id}>
              <span>{sourceDisplayName(source)}</span>
              <b>{ok && Number(source.latest) > 0 ? fmt(source.latest) : "--"}</b>
              <small>{source?.role || label} · {label}{Number.isFinite(Number(source?.latencyMs)) ? ` · ${Math.round(Number(source.latencyMs))}ms` : ""}</small>
            </div>
          );
        })}
      </div>
      {federation?.note && <p className="market-data-note"><CircleAlert size={15} />{federation.note}</p>}
    </section>
  );
}

function FirstBoardQualityPanel({ quality }: any) {
  if (!quality) return null;
  return (
    <section className="panel first-board-panel">
      <PanelTitle
        title="首板质量"
        subtitle="首次封板、开板次数、封单、换手和位置综合评分"
        icon={Zap}
        badge={!quality.available
          ? "数据待补"
          : quality.dataComplete === false
            ? "字段缺失 · 暂停评分"
            : `${quality.score} 分 · ${quality.grade}级`}
      />
      {!quality.available ? (
        <EmptyInline text={quality.summary || "涨停专题字段暂不可用"} />
      ) : (
        <>
          <div className="first-board-summary">
            <div className={`quality-score ${quality.matched ? "good" : "warn"}`}>
              <strong>{quality.dataComplete === false ? "--" : quality.score}</strong><span>/ 100</span><b>{quality.summary}</b>
            </div>
            <div className="quality-keyfacts">
              <Fact label="首次封板" value={quality.firstSealTime || "--"} />
              <Fact label="最后封板" value={quality.lastSealTime || "--"} />
              <Fact label="开板次数" value={`${quality.openBoardCount ?? "--"} 次`} />
              <Fact label="涨停换手" value={`${fmt(quality.turnover)}%`} />
              <Fact
                label="封单/流通市值"
                value={quality.sealFloatRatio == null ? "--" : `${fmt(quality.sealFloatRatio * 100)}%`}
              />
              <Fact label="封单金额" value={fmtMoney(quality.sealedAmount)} />
            </div>
          </div>
          <div className="quality-factor-grid">
            {(quality.factors || []).map((factor: any) => (
              <div className={factor.passed ? "passed" : "missed"} key={factor.id}>
                <span>{factor.label}<b>{factor.value}</b></span>
                <i><em style={{ width: `${factor.maxPoints ? factor.points / factor.maxPoints * 100 : 0}%` }} /></i>
                <small>{factor.points}/{factor.maxPoints}分 · 标准 {factor.threshold}</small>
              </div>
            ))}
          </div>
          {!!quality.risks?.length && (
            <div className="quality-risks"><ShieldAlert size={17} />{quality.risks.map((item: string) => <span key={item}>{item}</span>)}</div>
          )}
        </>
      )}
    </section>
  );
}

function HistoricalStatsPanel({ data }: any) {
  if (!data) return null;
  const value = (number: number | null, suffix = "%") =>
    Number.isFinite(number) ? `${number! >= 0 ? "+" : ""}${fmt(number!)}${suffix}` : "--";
  return (
    <section className="panel historical-stats-panel">
      <PanelTitle
        title="策略历史统计"
        subtitle={`${data.source} · ${data.range || "历史区间不足"} · ${data.entryRule || "严格按当时数据回测"}`}
        icon={BarChart3}
        badge={`${data.totalEvents || 0} 轮涨停事件`}
      />
      <div className="stats-warning">
        <CircleAlert size={16} />
        <span>
          当前为该股票历史回放，不是全市场承诺胜率。1/3/5日分别按已结算样本统计。
          {data.benchmarkAvailable ? " 5日超额收益以中证全指同期表现为基准。" : " 当前缺少全A基准序列，暂不显示超额收益。"}
          {Number(data.rawEventCount || 0) > Number(data.totalEvents || 0)
            ? ` 连板已去重：${data.rawEventCount} 个涨停日归并为 ${data.totalEvents} 轮。`
            : ""}
          {data.untradeableCount ? ` 已剔除 ${data.untradeableCount} 个次日一字涨停不可成交节点。` : ""}
        </span>
      </div>
      <div className="strategy-stats-table">
        <div className="strategy-stat-row stat-head">
          <span>策略</span><span>结算样本</span><span>次日胜率</span><span>3日胜率</span><span>5日胜率</span><span>5日均值/超额</span><span>最差回撤</span><span>置信度</span>
        </div>
        {(data.stats || []).map((item: any) => (
          <div className={`strategy-stat-row ${item.available ? "" : "unavailable"}`} key={item.id}>
            <span><b>{item.label}</b><small>{item.unavailableReason || item.confidenceNote}</small></span>
            <span className="sample-breakdown">
              <b>{item.sampleCount}</b>
              <small>1日 {item.n1 ?? 0} · 3日 {item.n3 ?? 0} · 5日 {item.n5 ?? 0}</small>
            </span>
            <span>{Number.isFinite(item.winRate1) ? `${fmt(item.winRate1, 1)}%` : "--"}</span>
            <span>{Number.isFinite(item.winRate3) ? `${fmt(item.winRate3, 1)}%` : "--"}</span>
            <span className="win-interval">
              {Number.isFinite(item.winRate5) ? `${fmt(item.winRate5, 1)}%` : "--"}
              {Array.isArray(item.winRate5Interval) && (
                <small>95%区间 {fmt(item.winRate5Interval[0], 0)}–{fmt(item.winRate5Interval[1], 0)}%</small>
              )}
            </span>
            <span className={`return-breakdown ${item.average5 >= 0 ? "red" : "green"}`}>
              {value(item.average5)}
              {Number.isFinite(item.averageExcess5) && (
                <small>全A超额 {value(item.averageExcess5)}</small>
              )}
            </span>
            <span className="green">{value(item.worstMdd5)}</span>
            <span><em className={`confidence ${item.confidence}`}>{item.confidence}</em></span>
          </div>
        ))}
      </div>
      <div className="node-stat-grid">
        {(data.nodeStats || []).map((item: any) => (
          <div key={item.node}>
            <span>{item.node}</span><b>{item.sampleCount} 触发 / {item.n5 ?? 0} 结算</b>
            <small>
              5日胜率 {Number.isFinite(item.winRate5) ? `${fmt(item.winRate5, 1)}%` : "--"}
              {" · "}均值 {value(item.average5)}
              {Number.isFinite(item.averageExcess5) ? ` · 超额 ${value(item.averageExcess5)}` : ""}
            </small>
            <em>{item.confidence}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

// 个股图表默认打开分时（与同花顺一致）；用户切到别的周期后，换股时沿用上次选择。
let rememberedChartFrame = "time";
const chartFrameDefaults: Record<string, string> = { time: "1d", "1": "1d", "5": "3d", "15": "10d", "30": "20d", "60": "20d", "120": "1m", "101": "3m", "102": "3y", "103": "10y" };

function TrendChartPanel({ security, dailyHistory, eventDate, support, trendLabel, live = true }: any) {
  const frames: any[] = [
    { value: "time", label: "分时", defaultRange: "1d", ranges: [] },
    { value: "1", label: "1分钟", defaultRange: "1d", ranges: [["1d", "1日"], ["3d", "3日"], ["5d", "5日"], ["10d", "10日"]] },
    { value: "5", label: "5分钟", defaultRange: "3d", ranges: [["1d", "1日"], ["3d", "3日"], ["5d", "5日"], ["10d", "10日"]] },
    { value: "15", label: "15分钟", defaultRange: "10d", ranges: [["5d", "5日"], ["10d", "10日"], ["20d", "20日"], ["30d", "30日"]] },
    { value: "30", label: "30分钟", defaultRange: "20d", ranges: [["10d", "10日"], ["20d", "20日"], ["1m", "1个月"]] },
    { value: "60", label: "60分钟", defaultRange: "20d", ranges: [["10d", "10日"], ["20d", "20日"], ["1m", "1个月"]] },
    { value: "120", label: "120分钟·半日", defaultRange: "1m", ranges: [["10d", "10日"], ["20d", "20日"], ["1m", "1个月"]] },
    { value: "101", label: "日线", defaultRange: "3m", ranges: [["3m", "3个月"], ["6m", "6个月"], ["1y", "1年"], ["3y", "3年"]] },
    { value: "102", label: "周线", defaultRange: "3y", ranges: [["1y", "1年"], ["3y", "3年"], ["5y", "5年"], ["10y", "10年"]] },
    { value: "103", label: "月线", defaultRange: "10y", ranges: [["3y", "3年"], ["5y", "5年"], ["10y", "10年"], ["all", "全部"]] }
  ];
  const [frame, setFrame] = useState(rememberedChartFrame);
  const [range, setRange] = useState(chartFrameDefaults[rememberedChartFrame] || "3m");
  const isTimeShare = frame === "time";
  const [density, setDensity] = useState("120");
  const [adjustment, setAdjustment] = useState("front");
  const [windowOffset, setWindowOffset] = useState(0);
  const chartContext = `${security.secid || security.code}|${frame}|${range}|${adjustment}`;
  // 预置的分析日线只属于“日线·3个月·前复权”这一组合；默认的分时等其他周期首帧显示加载中。
  const [chartSnapshot, setChartSnapshot] = useState<{ context: string; rows: any[]; meta: any; readAt: string }>(() => ({
    context: `${security.secid || security.code}|101|3m|front`,
    rows: Array.isArray(dailyHistory) ? dailyHistory : [],
    meta: { source: "分析日线", adjustment: "前复权", visibleLimit: 90 },
    readAt: ""
  }));
  // A snapshot belongs to one exact security/interval/range/adjustment context.
  // A render after a context switch can never show another context's old data.
  const chartData = chartSnapshot.context === chartContext ? chartSnapshot.rows : [];
  const chartMeta = chartSnapshot.context === chartContext ? chartSnapshot.meta : {};
  const chartReadAt = chartSnapshot.context === chartContext ? chartSnapshot.readAt : "";
  const [chartLoading, setChartLoading] = useState(false);
  const [chartFailure, setChartFailure] = useState<{ context: string; message: string } | null>(null);
  const chartError = chartFailure?.context === chartContext ? chartFailure.message : "";
  const chartRequest = useRef(0);
  const chartPending = useRef<number | null>(null);
  const [indicators, setIndicators] = useState<string[]>(["MA", "VOL"]);
  const indicatorOptions = [
    { id: "MA", label: "MA均线" },
    { id: "BOLL", label: "BOLL" },
    { id: "VOL", label: "成交量" },
    { id: "MACD", label: "MACD" },
    { id: "KDJ", label: "KDJ" },
    { id: "RSI", label: "RSI" }
  ];
  const toggleIndicator = (id: string) => {
    setIndicators((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  // 切换股票时周期/区间要先复位；复位尚未生效的那一轮不发图表请求（以前会用旧区间多请求一次）。
  const pendingReset = useRef<string | null>(null);
  useEffect(() => {
    const nextFrame = rememberedChartFrame, nextRange = chartFrameDefaults[nextFrame] || "3m";
    pendingReset.current = frame !== nextFrame || range !== nextRange ? `${nextFrame}|${nextRange}` : null;
    setFrame(nextFrame);
    setRange(nextRange);
    setWindowOffset(0);
    setChartSnapshot({
      context: `${security.secid || security.code}|101|3m|front`,
      rows: Array.isArray(dailyHistory) ? dailyHistory : [],
      meta: { source: "分析日线", adjustment: "前复权", visibleLimit: 90 },
      readAt: ""
    });
  }, [security.code]);

  const selectedFrame = frames.find((item) => item.value === frame) as any;
  const selectedRange =
    selectedFrame?.ranges?.find((item: string[]) => item[0] === range) ||
    selectedFrame?.ranges?.[0];
  const visibleCount =
    density === "all"
      ? Number(chartMeta.visibleLimit || chartData.length)
      : Number(density);
  const maxWindowOffset = Math.max(0, chartData.length - visibleCount);
  const safeWindowOffset = Math.min(maxWindowOffset, Math.max(0, windowOffset));
  const visibleEndIndex = Math.max(0, chartData.length - safeWindowOffset);
  const visibleStartIndex = Math.max(0, visibleEndIndex - visibleCount);

  const chooseFrame = (nextFrame: any) => {
    rememberedChartFrame = nextFrame.value;
    setFrame(nextFrame.value);
    setRange(nextFrame.defaultRange);
    setWindowOffset(0);
    setChartFailure(null);
  };

  const loadChart = useCallback(async (silent = false) => {
    if (chartPending.current !== null) return;
    const requestId = ++chartRequest.current;
    chartPending.current = requestId;
    if (!silent) setChartLoading(true);
    setChartFailure(null);
    try {
      // 分时：同花顺实时分时接口（后端失败时退回当日 1 分钟线），始终是最新交易日。
      const response = await window.stockApi.getChart(security, isTimeShare ? "time" : frame, isTimeShare
        ? { forceRefresh: !silent }
        : { range, adjustment });
      const rows = Array.isArray(response) ? response : response?.rows || [];
      if (!rows.length) throw new Error(isTimeShare ? "暂无分时数据" : "该周期暂无K线数据");
      if (requestId !== chartRequest.current) return;
      setChartSnapshot({
        context: chartContext, rows,
        meta: Array.isArray(response)
          ? { source: "行情源", adjustment: adjustment === "none" ? "不复权" : "前复权", visibleLimit: rows.length }
          : response,
        readAt: new Date().toISOString()
      });
    } catch (reason) {
      if (requestId !== chartRequest.current) return;
      // Keep the last successful snapshot for this context during refresh failures.
      setChartFailure({ context: chartContext, message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      if (chartPending.current === requestId) chartPending.current = null;
      if (requestId === chartRequest.current) setChartLoading(false);
    }
  }, [security.code, frame, range, adjustment, chartContext, isTimeShare]);

  useEffect(() => {
    if (pendingReset.current && pendingReset.current !== `${frame}|${range}`) return;
    pendingReset.current = null;
    void loadChart(false);
    return () => {
      chartRequest.current += 1;
      chartPending.current = null;
    };
  }, [loadChart]);

  useEffect(() => {
    if (!live) return;
    const seconds = isTimeShare || Number(frame) < 100 ? 10 : frame === "101" ? 30 : 180;
    const timer = window.setInterval(whenVisible(() => loadChart(true)), seconds * 1000);
    return () => window.clearInterval(timer);
  }, [live, frame, isTimeShare, loadChart]);

  useEffect(() => {
    setWindowOffset(0);
  }, [range, density, adjustment]);

  const dataStart = chartData[visibleStartIndex]?.date || "";
  const dataEnd = chartData[Math.max(0, visibleEndIndex - 1)]?.date || "";

  return (
    <div className="panel chart-panel">
      <div className="chart-heading">
        <PanelTitle
          title={isTimeShare ? "分时走势" : "K线趋势结构"}
          subtitle={isTimeShare ? `分时 · 当日 · 不复权 · ${chartMeta.source || "行情源"}` : `${selectedFrame?.label || frame} · ${selectedRange?.[1] || range} · ${chartMeta.adjustment || "前复权"} · ${chartMeta.source || "行情源"}`}
          icon={LineChart}
          badge={trendLabel}
        />
        <div className="timeframe-tabs">
          {frames.map((item) => (
            <button
              key={item.value}
              className={frame === item.value ? "active" : ""}
              onClick={() => chooseFrame(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className={chartLoading ? "chart-loading" : ""}>
        {!isTimeShare && <><div className="chart-control-row">
          <div className="range-tabs">
            <span>日期范围</span>
            {(selectedFrame?.ranges || []).map((item: [string, string]) => (
              <button
                key={item[0]}
                className={range === item[0] ? "active" : ""}
                onClick={() => setRange(item[0])}
              >
                {item[1]}
              </button>
            ))}
          </div>
          <div className="chart-density">
            <span>显示K线</span>
            {["60", "90", "120", "all"].map((item) => (
              <button
                key={item}
                className={density === item ? "active" : ""}
                onClick={() => setDensity(item)}
              >
                {item === "all" ? "范围内全部" : item}
              </button>
            ))}
          </div>
          <div className="adjustment-tabs">
            <span>复权</span>
            <button className={adjustment === "front" ? "active" : ""} onClick={() => setAdjustment("front")}>前复权</button>
            <button className={adjustment === "none" ? "active" : ""} onClick={() => setAdjustment("none")}>不复权</button>
          </div>
        </div>
        <div className="indicator-selector">
          <span className="indicator-selector-label">技术指标</span>
          {indicatorOptions.map((item) => (
            <button
              key={item.id}
              className={indicators.includes(item.id) ? "active" : ""}
              aria-pressed={indicators.includes(item.id)}
              title={`${indicators.includes(item.id) ? "隐藏" : "显示"}${item.label}`}
              onClick={() => toggleIndicator(item.id)}
            >
              {indicators.includes(item.id) && <CheckCircle2 size={15} />}
              <span>{item.label}</span>
            </button>
          ))}
          <em>{dataStart ? `${dataStart} 至 ${dataEnd}` : ""}</em>
        </div>
        </>}
        {!isTimeShare && maxWindowOffset > 0 && (
          <div className="chart-window-slider">
            <span>历史窗口</span>
            <small>更早</small>
            <input
              type="range"
              min="0"
              max={maxWindowOffset}
              value={maxWindowOffset - safeWindowOffset}
              onChange={(event) =>
                setWindowOffset(maxWindowOffset - Number(event.target.value))
              }
            />
            <small>最新</small>
            <button onClick={() => setWindowOffset(0)} disabled={safeWindowOffset === 0}>
              回到最新
            </button>
          </div>
        )}
        {chartError && chartData.length > 0 && <div className="chart-refresh-warning" role="status"><CircleAlert size={16} /><span>刷新失败：{chartError}。保留上次有效数据，行情截止 {chartData[chartData.length - 1]?.date || "未提供"}{chartReadAt ? `；最近成功读取 ${new Date(chartReadAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}` : ""}。</span><button type="button" onClick={() => loadChart(true)}>重试刷新</button></div>}
        <div className="kline-composite-chart">
          {chartError && !chartData.length ? (
            <div className="chart-error"><CircleAlert size={18} />{chartError}<button onClick={() => loadChart(false)}>重试</button></div>
          ) : isTimeShare ? (
            <TimeShareChart rows={chartData} preClose={Number.isFinite(Number(chartMeta.preClose)) ? Number(chartMeta.preClose) : null}
              assetType={security.assetType} unitsPerLot={chartMeta.unitsPerLot} volumeUnit={chartMeta.volumeUnit} />
          ) : (
            <>
              <MemoizedPriceChart
                history={chartData}
                eventDate={eventDate}
                support={support}
                indicators={indicators}
                visibleCount={visibleCount}
                interval={frame}
                windowOffset={safeWindowOffset}
              />
              <div className="indicator-stack">
                {["VOL", "MACD", "KDJ", "RSI"]
                  .filter((item) => indicators.includes(item))
                  .map((item) => (
                    <IndicatorChart
                      key={item}
                      type={item}
                      history={chartData}
                      visibleCount={visibleCount}
                      windowOffset={safeWindowOffset}
                    />
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
      {chartMeta.note && <div className="chart-note"><CircleAlert size={14} />{chartMeta.note}</div>}
      {isTimeShare ? <div className="chart-legend">
        <span><i className="line time-share-price-key" />价格</span>
        <span><i className="line time-share-average-key" />均价</span>
        <span><i className="line time-share-preclose-key" />昨收</span>
      </div> : <div className="chart-legend">
        <span><i className="candle rise" />上涨K</span>
        <span><i className="candle fall" />下跌K</span>
        {indicators.includes("MA") && <><span><i className="line ma5" />MA5</span><span><i className="line ma10" />MA10</span><span><i className="line ma20" />MA20</span><span><i className="line ma60" />MA60</span></>}
        {indicators.includes("BOLL") && <span><i className="line boll" />BOLL(20,2)</span>}
        <span><i className="line support" />涨停日最低 {support ? fmt(support) : "--"}</span>
      </div>}
    </div>
  );
}

function linePoints(values: number[], x: (index: number) => number, y: (value: number) => number) {
  return values
    .map((value, index) => Number.isFinite(value) ? `${x(index)},${y(value)}` : "")
    .filter(Boolean)
    .join(" ");
}

function PriceChart({
  history,
  eventDate,
  support,
  indicators = [],
  visibleCount = 120,
  interval = "101",
  windowOffset = 0
}: any) {
  const fullData = Array.isArray(history) ? history : [];
  const windowSize = Math.max(20, Number(visibleCount) || 120);
  const safeOffset = Math.min(
    Math.max(0, fullData.length - windowSize),
    Math.max(0, Number(windowOffset) || 0)
  );
  const endIndex = Math.max(0, fullData.length - safeOffset);
  const startIndex = Math.max(0, endIndex - windowSize);
  const data = fullData.slice(startIndex, endIndex);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const fullMaValues = useMemo(() => calculatePriceMovingAverages(fullData), [fullData]);
  const showBoll = indicators.includes("BOLL");
  const fullBollBands = useMemo(
    () => calculateBollingerBands(fullData, fullMaValues.ma20, showBoll),
    [fullData, fullMaValues.ma20, showBoll]
  );
  const maValues = {
    ma5: fullMaValues.ma5.slice(startIndex, endIndex),
    ma10: fullMaValues.ma10.slice(startIndex, endIndex),
    ma20: fullMaValues.ma20.slice(startIndex, endIndex),
    ma60: fullMaValues.ma60.slice(startIndex, endIndex)
  };
  const bollMid = fullMaValues.ma20.slice(startIndex, endIndex);
  const bollUpper = fullBollBands.upper.slice(startIndex, endIndex);
  const bollLower = fullBollBands.lower.slice(startIndex, endIndex);
  if (!data.length) return <div className="empty-inline">暂无K线数据</div>;
  const width = 760;
  const height = 270;
  const pad = 22;
  let rawMin = Infinity;
  let rawMax = -Infinity;
  const includeScaleValue = (value: number) => {
    if (!Number.isFinite(value)) return;
    rawMin = Math.min(rawMin, value);
    rawMax = Math.max(rawMax, value);
  };
  data.forEach((item: any) => { includeScaleValue(item.high); includeScaleValue(item.low); });
  if (showBoll) {
    bollUpper.forEach(includeScaleValue);
    bollLower.forEach(includeScaleValue);
  }
  const supportInScale = Number.isFinite(Number(support)) &&
    Number(support) >= rawMin * 0.85 &&
    Number(support) <= rawMax * 1.15;
  const min = Math.min(rawMin, supportInScale ? Number(support) : Infinity) * 0.997;
  const max = Math.max(rawMax, supportInScale ? Number(support) : -Infinity) * 1.003;
  const slot = (width - pad * 2) / Math.max(1, data.length);
  const candleWidth = Math.max(1.5, Math.min(7, slot * 0.62));
  const x = (i: number) => pad + slot * i + slot / 2;
  const y = (value: number) => pad + ((max - value) / Math.max(0.01, max - min)) * (height - pad * 2);
  const exactEventIndexes = data
    .map((item: any, index: number) =>
      String(item.date || "").slice(0, 10) === String(eventDate || "").slice(0, 10)
        ? index
        : -1
    )
    .filter((index: number) => index >= 0);
  let eventIndexes = exactEventIndexes;
  if (!eventIndexes.length && ["102", "103"].includes(String(interval)) && eventDate) {
    const targetTime = new Date(String(eventDate).slice(0, 10)).getTime();
    const fallbackIndex = data.findIndex(
      (item: any) => new Date(String(item.date || "").slice(0, 10)).getTime() >= targetTime
    );
    if (fallbackIndex >= 0) {
      const currentEnd = new Date(String(data[fallbackIndex].date || "").slice(0, 10)).getTime();
      const priorEnd = fallbackIndex > 0
        ? new Date(String(data[fallbackIndex - 1].date || "").slice(0, 10)).getTime()
        : currentEnd - (String(interval) === "102" ? 8 : 32) * 86400000;
      if (targetTime > priorEnd && targetTime <= currentEnd) eventIndexes = [fallbackIndex];
    }
  }
  const shortDate = (value: string) => value?.length > 10 ? value.slice(5, 16) : value;
  const selectedIndex = hoverIndex ?? data.length - 1;
  const selected = data[selectedIndex];
  const axisValues = [0, 0.25, 0.5, 0.75, 1].map((ratio) => max - (max - min) * ratio);
  const dateTickIndexes = [...new Set(
    [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
      Math.min(data.length - 1, Math.round((data.length - 1) * ratio))
    )
  )];
  const handleMove = (event: any) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.9999, (event.clientX - rect.left) / rect.width));
    setHoverIndex(Math.min(data.length - 1, Math.floor(ratio * data.length)));
  };
  return (
    <div className="chart-wrap">
      <div className="chart-ohlc-strip">
        <b>{selected?.date || "--"}</b>
        <span>开 <em>{fmt(Number(selected?.open))}</em></span>
        <span>高 <em className="red">{fmt(Number(selected?.high))}</em></span>
        <span>低 <em className="green">{fmt(Number(selected?.low))}</em></span>
        <span>收 <em>{fmt(Number(selected?.close))}</em></span>
        <span>涨跌 <em className={Number(selected?.changePct) >= 0 ? "red" : "green"}>{Number(selected?.changePct) >= 0 ? "+" : ""}{fmt(Number(selected?.changePct))}%</em></span>
        <span>量 <em>{fmtMoney(Number(selected?.volume || 0))}</em></span>
        <span>额 <em>{fmtMoney(Number(selected?.amount || 0))}</em></span>
        <span>换手 <em>{fmt(Number(selected?.turnover || 0))}%</em></span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="股票K线行情"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio, index) => (
          <g key={ratio}>
            <line
              x1={pad}
              x2={width - pad}
              y1={pad + (height - pad * 2) * ratio}
              y2={pad + (height - pad * 2) * ratio}
              className="grid-line"
            />
            <text
              x={width - pad + 2}
              y={pad + (height - pad * 2) * ratio + 4}
              className="chart-axis-text"
            >
              {fmt(axisValues[index] ?? rawMin)}
            </text>
          </g>
        ))}
        {supportInScale && <line x1={pad} x2={width - pad} y1={y(Number(support))} y2={y(Number(support))} className="support-line" />}
        {eventIndexes.length > 0 && eventIndexes[0] !== undefined && (
          <rect
            x={Math.max(pad, x(eventIndexes[0]) - slot / 2)}
            y={pad}
            width={Math.max(slot, x(eventIndexes.at(-1)!) - x(eventIndexes[0]) + slot)}
            height={height - pad * 2}
            className="event-zone"
          />
        )}
        {data.map((item: any, index: number) => {
          const rising = item.close >= item.open;
          const bodyTop = y(Math.max(item.open, item.close));
          const bodyBottom = y(Math.min(item.open, item.close));
          return (
            <g key={`${item.date}-${index}`} className={rising ? "k-rise" : "k-fall"}>
              <line x1={x(index)} x2={x(index)} y1={y(item.high)} y2={y(item.low)} className="wick" />
              <rect
                x={x(index) - candleWidth / 2}
                y={bodyTop}
                width={candleWidth}
                height={Math.max(1.2, bodyBottom - bodyTop)}
                className="candle-body"
              />
            </g>
          );
        })}
        {indicators.includes("BOLL") && (
          <>
            <polyline points={linePoints(bollUpper, x, y)} className="path boll-upper-path" />
            <polyline points={linePoints(bollMid, x, y)} className="path boll-mid-path" />
            <polyline points={linePoints(bollLower, x, y)} className="path boll-lower-path" />
          </>
        )}
        {indicators.includes("MA") && (
          <>
            <polyline points={linePoints(maValues.ma60, x, y)} className="path ma60-path" />
            <polyline points={linePoints(maValues.ma20, x, y)} className="path ma20-path" />
            <polyline points={linePoints(maValues.ma10, x, y)} className="path ma10-path" />
            <polyline points={linePoints(maValues.ma5, x, y)} className="path ma5-path" />
          </>
        )}
        {hoverIndex !== null && selected && (
          <>
            <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={pad} y2={height - pad} className="chart-crosshair" />
            <line x1={pad} x2={width - pad} y1={y(Number(selected.close))} y2={y(Number(selected.close))} className="chart-crosshair" />
            <circle cx={x(selectedIndex)} cy={y(Number(selected.close))} r="3" className="chart-crosshair-dot" />
          </>
        )}
      </svg>
      {!supportInScale && Number.isFinite(Number(support)) && (
        <div className={`support-offscale ${Number(support) < rawMin ? "below" : "above"}`}>
          涨停支撑 {fmt(Number(support))} {Number(support) < rawMin ? "↓" : "↑"}
        </div>
      )}
      <div className="chart-labels">
        {dateTickIndexes.map((index) => <span key={index}>{shortDate(data[index]?.date)}</span>)}
      </div>
    </div>
  );
}

const MemoizedPriceChart = memo(PriceChart);

function ema(values: number[], period: number) {
  const multiplier = 2 / (period + 1);
  return values.map((value, index, result) =>
    index === 0 ? value : value * multiplier + (result[index - 1] ?? value) * (1 - multiplier)
  );
}

/** RSI：与原实现同口径（最近 period 个涨跌的简单平均），用前缀和做到 O(n)。 */
function rsiValues(data: any[], period: number) {
  const gains = [0], losses = [0];
  for (let i = 1; i < data.length; i += 1) {
    const change = data[i].close - data[i - 1].close;
    gains.push(gains[i - 1]! + (change >= 0 ? change : 0));
    losses.push(losses[i - 1]! + (change < 0 ? -change : 0));
  }
  return data.map((_: any, index: number) => {
    const start = Math.max(1, index - period + 1);
    if (start > index) return 100;
    const count = index - start + 1;
    const avgGain = (gains[index]! - gains[start - 1]!) / count;
    const avgLoss = (losses[index]! - losses[start - 1]!) / count;
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  });
}

/** KDJ(9,3,3)：九日高低点直接循环取，不再每根 K 线 slice + map 分配临时数组。 */
function kdjValues(data: any[]) {
  let k = 50;
  let d = 50;
  const result = { k: [] as number[], d: [] as number[], j: [] as number[] };
  data.forEach((item: any, index: number) => {
    let low = Infinity, high = -Infinity;
    for (let i = Math.max(0, index - 8); i <= index; i += 1) {
      const row = data[i];
      if (row.low < low) low = row.low;
      if (row.high > high) high = row.high;
    }
    const rsv = high === low ? 50 : ((item.close - low) / (high - low)) * 100;
    k = (2 * k + rsv) / 3;
    d = (2 * d + k) / 3;
    result.k.push(k);
    result.d.push(d);
    result.j.push(3 * k - 2 * d);
  });
  return result;
}

type IndicatorSeries = { bars: number[]; series: Array<{ name: string; values: number[]; className: string }>; fixedRange: [number, number] | null };

/** 整段历史的指标序列，只依赖（历史, 指标类型）；拖动窗口时只做切片。 */
function fullIndicatorSeries(fullData: any[], type: string): IndicatorSeries {
  if (type === "VOL") {
    return { bars: fullData.map((item: any) => Number(item.volume || 0)), fixedRange: null, series: [
      { name: "VOL MA5", values: fullData.map((_: any, i: number) => averageAt(fullData, 5, i, "volume")), className: "indicator-yellow" },
      { name: "VOL MA10", values: fullData.map((_: any, i: number) => averageAt(fullData, 10, i, "volume")), className: "indicator-blue" }
    ] };
  }
  if (type === "MACD") {
    const closes = fullData.map((item: any) => item.close);
    const fast = ema(closes, 12);
    const slow = ema(closes, 26);
    const dif = fast.map((value, index) => value - (slow[index] ?? value));
    const dea = ema(dif, 9);
    return { bars: dif.map((value, index) => (value - (dea[index] ?? value)) * 2), fixedRange: null, series: [
      { name: "DIF", values: dif, className: "indicator-yellow" },
      { name: "DEA", values: dea, className: "indicator-blue" }
    ] };
  }
  if (type === "KDJ") {
    const kdj = kdjValues(fullData);
    return { bars: [], fixedRange: null, series: [
      { name: "K", values: kdj.k, className: "indicator-yellow" },
      { name: "D", values: kdj.d, className: "indicator-blue" },
      { name: "J", values: kdj.j, className: "indicator-purple" }
    ] };
  }
  return { bars: [], fixedRange: [0, 100], series: [
    { name: "RSI6", values: rsiValues(fullData, 6), className: "indicator-yellow" },
    { name: "RSI12", values: rsiValues(fullData, 12), className: "indicator-blue" },
    { name: "RSI24", values: rsiValues(fullData, 24), className: "indicator-purple" }
  ] };
}

const IndicatorChart = memo(function IndicatorChart({
  type,
  history,
  visibleCount = 120,
  windowOffset = 0
}: {
  type: string;
  history: any[];
  visibleCount?: number;
  windowOffset?: number;
}) {
  const fullData = useMemo(() => (Array.isArray(history) ? history : []), [history]);
  const computed = useMemo(() => fullIndicatorSeries(fullData, type), [fullData, type]);
  const windowSize = Math.max(20, Number(visibleCount) || 120);
  const safeOffset = Math.min(
    Math.max(0, fullData.length - windowSize),
    Math.max(0, Number(windowOffset) || 0)
  );
  const endIndex = Math.max(0, fullData.length - safeOffset);
  const startIndex = Math.max(0, endIndex - windowSize);
  const data = fullData.slice(startIndex, endIndex);
  if (data.length < 2) return null;
  const width = 760;
  const height = 105;
  const pad = 22;
  const slot = (width - pad * 2) / data.length;
  const x = (index: number) => pad + slot * index + slot / 2;
  const bars = type === "VOL" ? data.map((item: any) => Number(item.volume || 0)) : computed.bars.slice(startIndex, endIndex);
  const series = computed.series.map((item) => ({ ...item, values: item.values.slice(startIndex, endIndex) }));
  let fixedRange = computed.fixedRange;
  if (type === "KDJ") {
    const visibleJ = series[2]?.values || [];
    fixedRange = [Math.min(-20, ...visibleJ.filter(Number.isFinite)), Math.max(120, ...visibleJ.filter(Number.isFinite))];
  }

  const allValues = [...bars, ...series.flatMap((item) => item.values)].filter(Number.isFinite);
  const rawMin = fixedRange?.[0] ?? Math.min(0, ...allValues);
  const rawMax = fixedRange?.[1] ?? Math.max(1, ...allValues);
  const range = Math.max(0.0001, rawMax - rawMin);
  const y = (value: number) => pad + ((rawMax - value) / range) * (height - pad * 2);
  const zeroY = y(Math.max(rawMin, Math.min(rawMax, 0)));
  const last = (values: number[]) => values.at(-1);

  return (
    <div className="indicator-chart">
      <div className="indicator-chart-head">
        <b>{type}</b>
        {series.map((item) => <span className={item.className} key={item.name}>{item.name} {fmt(last(item.values) || 0)}</span>)}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1={pad} x2={width - pad} y1={zeroY} y2={zeroY} className="indicator-zero" />
        {(type === "KDJ" ? [20, 80] : type === "RSI" ? [20, 50, 80] : [])
          .filter((value) => value >= rawMin && value <= rawMax)
          .map((value) => (
            <line
              key={`${type}-reference-${value}`}
              x1={pad}
              x2={width - pad}
              y1={y(value)}
              y2={y(value)}
              className="indicator-reference"
            />
          ))}
        {bars.map((value, index) => {
          const top = Math.min(y(value), zeroY);
          return (
            <rect
              key={`${type}-${index}`}
              x={x(index) - Math.max(1, slot * 0.28)}
              y={top}
              width={Math.max(1.2, slot * 0.56)}
              height={Math.max(1, Math.abs(y(value) - zeroY))}
              className={type === "VOL"
                ? data[index].close >= data[index].open ? "indicator-bar up" : "indicator-bar down"
                : value >= 0 ? "indicator-bar up" : "indicator-bar down"}
            />
          );
        })}
        {series.map((item) => (
          <polyline key={item.name} points={linePoints(item.values, x, y)} className={`indicator-line ${item.className}`} />
        ))}
      </svg>
    </div>
  );
});

function Timeline({ daysSince }: { daysSince: number | null }) {
  const nodes = [0, 3, 5, 7, 9];
  return (
    <div className="timeline">
      <div className="timeline-track" />
      {nodes.map((node) => {
        const current = daysSince === node;
        const passed = daysSince !== null && daysSince > node;
        return (
          <div className={`timeline-node ${current ? "current" : ""} ${passed ? "passed" : ""}`} key={node}>
            <span>{passed ? "✓" : node === 0 ? "T" : node}</span>
            <b>{node === 0 ? "涨停日" : `T+${node}`}</b>
            {current && <small>当前</small>}
          </div>
        );
      })}
    </div>
  );
}

