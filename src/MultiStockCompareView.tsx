import {
  BarChart3,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadSafeLocalJson, saveSafeLocalJson } from "./safeStorage";
import { nullableNumber } from "./numericValue";
import { isUsableSecurityCollection, uniqueSecurities } from "./securitySelection";
import { whenVisible } from "./visiblePolling";
import { createNumberFormatters, fmtMoney } from "./domain/formatters";
import { formatShanghaiTime } from "./dateUtils";

type ComparePayload = {
  security: Security;
  quote: Record<string, any>;
  history: Array<Record<string, any>>;
  analysis: Record<string, any>;
  sector?: Record<string, any> | null;
  actualProvider?: string;
  updatedAt?: string;
};

type CompareResult = {
  loading: boolean;
  error: string;
  payload: ComparePayload | null;
};

const COMPARE_SELECTION_KEY = "a-stock-radar:compare-selection";
let compareSelectionCache: Security[] = [];
let compareResultsCache: Record<string, CompareResult> = {};
let compareSelectionInitialized = false;

// R-01 / S-07：改用 domain/formatters 的统一工厂，只声明本模块口径。
// B-03：金额不再保留本模块私有口径（原「亿 2 位 / 万 0 位、无空格」），改为直接调用
// domain/formatters 的 fmtMoney —— 与涨停池 / 持仓 / 板块 / 炸板观察同一套换算，
// 同一笔成交额在任何页面都是「120.00 万 / 1.23 亿」。
const { number, fmt, pct, unit, money } = createNumberFormatters(nullableNumber, {
  fmtDigits: 2,
  pctDigits: 2,
  money: fmtMoney
});

const providerLabel = (value: unknown) => {
  const provider = String(value || "").toLowerCase();
  if (provider.includes("fuyao") || provider.includes("扶摇")) return "同花顺扶摇行情";
  if (provider.includes("ths") || provider.includes("同花顺")) return "同花顺";
  if (provider.includes("tencent") || provider.includes("腾讯")) return "腾讯行情";
  if (provider.includes("eastmoney") || provider.includes("东方财富")) {
    return "东方财富";
  }
  if (provider.includes("sina") || provider.includes("新浪")) return "新浪行情";
  if (provider.includes("preview")) return "预览";
  return String(value || "行情源待确认");
};

const periodReturn = (history: Array<Record<string, any>>, days: number) => {
  const rows = Array.isArray(history)
    ? history.filter((item) => number(item?.close) > 0)
    : [];
  if (rows.length <= days) return null;
  const latest = number(rows.at(-1)?.close);
  const base = number(rows.at(-(days + 1))?.close);
  return base > 0 ? ((latest / base) - 1) * 100 : null;
};

const restoredCompareSelection = () => {
  if (compareSelectionInitialized) return compareSelectionCache;
  try {
    const persistent = localStorage.getItem(COMPARE_SELECTION_KEY);
    const legacySession = sessionStorage.getItem(COMPARE_SELECTION_KEY);
    const recoverable = localStorage.getItem(`${COMPARE_SELECTION_KEY}:last-good`);
    if (persistent === null && legacySession === null && recoverable === null) {
      return compareSelectionCache;
    }
    let stored = loadSafeLocalJson<unknown>(COMPARE_SELECTION_KEY, null, isUsableSecurityCollection);
    let migrateSession = false;
    if (stored === null && legacySession !== null) {
      try {
        const legacy: unknown = JSON.parse(legacySession);
        if (isUsableSecurityCollection(legacy)) { stored = legacy; migrateSession = true; }
      } catch { /* An invalid legacy session cannot hide a valid persistent backup. */ }
    }
    compareSelectionInitialized = true;
    compareSelectionCache = uniqueSecurities(stored).slice(0, 6);
    if (migrateSession && saveSafeLocalJson(COMPARE_SELECTION_KEY, compareSelectionCache, isUsableSecurityCollection)) {
      sessionStorage.removeItem(COMPARE_SELECTION_KEY);
    }
  } catch {
    compareSelectionCache = [];
  }
  return compareSelectionCache;
};

function MetricCell({
  children,
  tone = ""
}: {
  children: React.ReactNode;
  tone?: "up" | "down" | "good" | "risk" | "";
}) {
  return <div role="cell" className={`compare-cell ${tone}`}>{children}</div>;
}

export default function MultiStockCompareView({
  candidates,
  live,
  onOpen
}: {
  candidates: Security[];
  live: boolean;
  onOpen: (security: Security) => void;
}) {
  const candidateList = useMemo(
    () => uniqueSecurities(candidates).slice(0, 120),
    [candidates]
  );
  const [selected, setSelected] = useState<Security[]>(restoredCompareSelection);
  const [results, setResults] =
    useState<Record<string, CompareResult>>(() => compareResultsCache);
  const [query, setQuery] = useState("");
  const [remoteCandidates, setRemoteCandidates] = useState<Security[]>([]);
  const [remoteQuery, setRemoteQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [searchState, setSearchState] = useState<"idle" | "pending" | "ready" | "empty" | "error">("idle");
  const [searchError, setSearchError] = useState("");
  const [searchRetryToken, setSearchRetryToken] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const previousReloadToken = useRef(reloadToken);
  const initializedSelection = useRef(
    compareSelectionInitialized || selected.length > 0
  );
  const searchTimer = useRef(0);
  const searchRequestId = useRef(0);
  const analysisRequestId = useRef(0);

  useEffect(() => {
    if (initializedSelection.current || selected.length || !candidateList.length) return;
    initializedSelection.current = true;
    compareSelectionInitialized = true;
    setSelected(candidateList.slice(0, Math.min(4, candidateList.length)));
  }, [candidateList, selected.length]);

  const signature = selected.map((item) => item.code).join(",");
  const savedSelectionSignature = useRef(signature);

  useEffect(() => {
    compareSelectionInitialized = true;
    compareSelectionCache = selected;
    if (savedSelectionSignature.current === signature) return;
    try {
      if (saveSafeLocalJson(COMPARE_SELECTION_KEY, selected, isUsableSecurityCollection)) {
        savedSelectionSignature.current = signature;
        sessionStorage.removeItem(COMPARE_SELECTION_KEY);
      }
    } catch {
      // Cross-restart persistence is a convenience; storage failures do not block analysis.
    }
  }, [signature]);

  useEffect(() => {
    compareResultsCache = results;
  }, [results]);

  useEffect(() => {
    const requestId = ++analysisRequestId.current;
    if (!selected.length) {
      setResults({});
      return;
    }
    const forceReload = previousReloadToken.current !== reloadToken;
    previousReloadToken.current = reloadToken;
    const targets = forceReload
      ? selected
      : selected.filter((security) => {
          const existing = results[security.code];
          return !existing?.payload;
        });
    setResults((current) => {
      const targetCodes = new Set(targets.map((security) => security.code));
      const selectedCodes = new Set(selected.map(security => security.code));
      const next = Object.fromEntries(
        Object.entries(current).filter(([code]) => selectedCodes.has(code)).map(([code, result]) => [
          code,
          result.loading && !targetCodes.has(code) ? { ...result, loading: false } : result
        ])
      );
      for (const security of targets) {
        next[security.code] = {
          loading: true,
          error: "",
          payload: current[security.code]?.payload || null
        };
      }
      return next;
    });
    if (!targets.length) return;
    const publish = (code: string, result: CompareResult) => {
      if (requestId !== analysisRequestId.current) return;
      setResults((current) => requestId === analysisRequestId.current
        ? { ...current, [code]: result }
        : current);
    };
    const analyzeSecurity = async (security: Security): Promise<ComparePayload> => {
      try {
        return await window.stockApi.analyze(security);
      } catch (analysisError) {
        const [snapshot, chart] = await Promise.all([
          window.stockApi.getQuoteSnapshot(security),
          window.stockApi.getChart(security, "101", {
            range: "3m",
            limit: 90,
            adjustment: "front"
          })
        ]);
        const history = chart?.rows || [];
        return {
          security: snapshot?.security || security,
          quote: snapshot?.quote || {},
          history,
          analysis: {
            trendLabel: "深度策略暂不可用",
            risks: [
              analysisError instanceof Error
                ? analysisError.message
                : "该股票当前仅返回行情与日线数据"
            ]
          },
          sector: null,
          actualProvider:
            snapshot?.actualProvider || snapshot?.provider || chart?.source || "行情源",
          updatedAt: snapshot?.updatedAt || new Date().toISOString()
        };
      }
    };
    for (const security of targets) {
      void analyzeSecurity(security).then(
        (payload) => publish(security.code, { loading: false, error: "", payload }),
        (error) => publish(security.code, {
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          payload: null
        })
      );
    }
    return () => {
      if (requestId === analysisRequestId.current) {
        analysisRequestId.current += 1;
      }
    };
    // Results are intentionally omitted: selection changes only analyze missing stocks,
    // while reloadToken explicitly requests a full recalculation.
  }, [signature, reloadToken]);

  useEffect(() => {
    if (!live || !selected.length) return;
    let active = true;
    let busy = false;
    const refreshQuotes = async () => {
      if (busy) return;
      busy = true;
      try {
        await Promise.allSettled(selected.map(async (security) => {
          const snapshot = await window.stockApi.getQuoteSnapshot(security);
          if (!active) return;
          setResults((current) => {
            const existing = current[security.code];
            if (!active || !existing?.payload) return current;
            return {
              ...current,
              [security.code]: {
                ...existing,
                payload: {
                  ...existing.payload,
                  quote: { ...existing.payload.quote, ...(snapshot?.quote || {}) },
                  actualProvider: snapshot?.actualProvider || existing.payload.actualProvider,
                  updatedAt: snapshot?.updatedAt || new Date().toISOString()
                }
              }
            };
          });
        }));
      } finally {
        busy = false;
      }
    };
    const refreshQuotesWhenVisible = whenVisible(refreshQuotes);
    const timer = window.setInterval(refreshQuotesWhenVisible, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, signature]);

  useEffect(() => {
    const requestId = ++searchRequestId.current;
    window.clearTimeout(searchTimer.current);
    const normalized = query.trim();
    setRemoteQuery(normalized);
    setRemoteCandidates([]);
    setSearchError("");
    if (!normalized || composing) {
      setSearchState("idle");
      return;
    }
    // Pending includes the debounce delay, so an empty list is never presented
    // as a completed no-match result while the remote request is still pending.
    setSearchState("pending");
    searchTimer.current = window.setTimeout(async () => {
      try {
        const rows = await window.stockApi.search(normalized);
        if (requestId === searchRequestId.current) {
          const candidates = uniqueSecurities(
            (Array.isArray(rows) ? rows : []).filter(
              (item: any) => !item?.assetType || item.assetType === "stock"
            )
          ).slice(0, 12);
          setRemoteCandidates(candidates);
          setSearchState(candidates.length ? "ready" : "empty");
        }
      } catch (error) {
        if (requestId === searchRequestId.current) {
          setRemoteCandidates([]);
          setSearchError(error instanceof Error ? error.message : "暂时无法连接搜索服务");
          setSearchState("error");
        }
      }
    }, 220);
    return () => {
      window.clearTimeout(searchTimer.current);
      if (requestId === searchRequestId.current) searchRequestId.current += 1;
    };
  }, [query, composing, searchRetryToken]);

  const filteredCandidates = useMemo(() => {
    if (composing) return [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return candidateList.slice(0, 20);
    const local = candidateList.filter((item: any) =>
      [item.name, item.code, item.industry, item.marketName]
        .join(" ")
        .toLowerCase()
        .includes(normalized)
    );
    return uniqueSecurities([...local, ...(remoteQuery === query.trim() ? remoteCandidates : [])]).slice(0, 30);
  }, [candidateList, query, remoteCandidates, remoteQuery, composing]);

  const addSecurity = (security: Security) => {
    if (selected.some((item) => item.code === security.code)) {
      setQuery("");
      return;
    }
    if (selected.length >= 6) return;
    setSelected((current) => [...current, security]);
    setQuery("");
  };

  const removeSecurity = (code: string) => {
    setSelected((current) => current.filter((item) => item.code !== code));
  };

  const resultFor = (security: Security) => results[security.code];
  const columnsStyle = {
    "--compare-columns": Math.max(1, selected.length)
  } as React.CSSProperties;

  const rows: Array<{
    label: string;
    render: (payload: ComparePayload, security: Security) => React.ReactNode;
  }> = [
    {
      label: "最新行情",
      render: (payload) => {
        // E-01：0 / 缺失 / 非数的最新价不是“真的 0 元”，不得格式化成 0.00 并染成涨红。
        const latest = nullableNumber(payload.quote?.latest);
        const changePercent = nullableNumber(payload.quote?.changePct);
        const priceAvailable = latest !== null && latest > 0;
        const tone = !priceAvailable || changePercent === null ? "" : changePercent >= 0 ? "up" : "down";
        return (
          <div className="compare-primary-value">
            <b>{priceAvailable ? fmt(latest) : "--"}</b>
            <span className={tone}>{priceAvailable ? pct(changePercent) : "--"}</span>
          </div>
        );
      }
    },
    {
      label: "1 / 3 / 5日",
      render: (payload) => (
        <span>
          {pct(periodReturn(payload.history, 1), 1)} /{" "}
          {pct(periodReturn(payload.history, 3), 1)} /{" "}
          {pct(periodReturn(payload.history, 5), 1)}
        </span>
      )
    },
    {
      label: "MRS / 等级",
      render: (payload) => (
        <span>
          <b>{fmt(payload.analysis?.mrs, 0)}</b> / {payload.analysis?.grade || "--"}
        </span>
      )
    },
    {
      label: "策略信号",
      render: (payload) => {
        const signal =
          payload.analysis?.tradePlan?.signal ||
          payload.analysis?.actionSignal ||
          "WAIT";
        const signalLabel = /^BUY_AGGRESSIVE$/.test(signal)
          ? "强势买入条件满足"
          : /^BUY$/.test(signal)
            ? "买入条件满足"
            : /^SELL$/.test(signal)
              ? "退出或回避"
              : "等待条件确认";
        return (
          <span className={/^BUY/.test(signal) ? "compare-signal-buy" : "compare-signal-wait"}>
            {signalLabel} · 匹配 {unit(payload.analysis?.strategyMatchRate, 0, "%")}
          </span>
        );
      }
    },
    {
      label: "趋势 / 均线",
      render: (payload) => (
        <span>
          {payload.analysis?.trendLabel || "--"}
          <small className="compare-essential-metric">MA5 {fmt(payload.analysis?.ma5)} · MA10 {fmt(payload.analysis?.ma10)}</small>
          <small className="compare-essential-metric">MA20 {fmt(payload.analysis?.ma20)}</small>
        </span>
      )
    },
    {
      label: "量价 / 流动性",
      render: (payload) => (
        <span>
          量能 {unit(payload.analysis?.volumeRatio, 2, "x")} ·
          换手 {unit(payload.quote?.turnover, 2, "%")}
          <small>成交额 {money(payload.quote?.amount)}</small>
        </span>
      )
    },
    {
      label: "支撑 / 成本",
      render: (payload) => (
        <span>
          距支撑 {pct(payload.analysis?.supportDistance, 1)}
          <small className="compare-essential-metric">关键位 {fmt(payload.analysis?.limitEvent?.low)}</small>
          <small className="compare-essential-metric">AVWAP {fmt(payload.analysis?.avwap)}</small>
        </span>
      )
    },
    {
      label: "板块强度",
      render: (payload) => (
        <span>
          {payload.quote?.industry || payload.sector?.name || "--"} ·{" "}
          {unit(payload.analysis?.sectorScore, 0, "分")}
          <small>相对板块 {pct(payload.analysis?.rsSector, 1)}</small>
        </span>
      )
    },
    {
      label: "历史复核",
      render: (payload) => {
        const edge = payload.analysis?.historicalEdge || {};
        return (
          <span>
            样本 {fmt(edge.sampleCount, 0)} · 5日胜率 {unit(edge.winRate5, 1, "%")}
            <small>
              {/* B-08：历史边界统一「两位小数 + 显式正负号」，不再与 1 位小数混排。 */}
              平均 {pct(edge.average5, 2)} · 最差回撤 {pct(edge.worstMdd5, 2)}
            </small>
          </span>
        );
      }
    },
    {
      label: "风险项",
      render: (payload) => {
        const risks = Array.isArray(payload.analysis?.risks)
          ? payload.analysis.risks.slice(0, 2)
          : [];
        return (
          <span className={risks.length ? "compare-risk-copy" : "compare-safe-copy"}>
            {risks.length ? risks.join("；") : "当前未发现硬否决"}
          </span>
        );
      }
    }
  ];

  return (
    <div className="multi-compare-view">
      <header className="page-heading compare-workspace-toolbar">
        <div className="compare-workspace-title">
          <span className="eyebrow">MULTI-STOCK MATRIX</span>
          <h1>多股同列</h1>
        </div>
        <label className="compare-toolbar-search">
          <Search size={16} />
          <input aria-label="搜索对比股票" aria-controls={query || !selected.length ? "compare-search-results" : undefined} aria-describedby="compare-search-status" value={query}
            onChange={(event) => { searchRequestId.current += 1; setRemoteCandidates([]); setSearchError(""); setSearchState(event.target.value.trim() ? "pending" : "idle"); setQuery(event.target.value); }}
            onCompositionStart={() => { searchRequestId.current += 1; window.clearTimeout(searchTimer.current); setRemoteCandidates([]); setSearchState("idle"); setComposing(true); }}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => { if (event.key === "Enter" && (composing || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}
            placeholder="输入名称/代码，或从候选池添加" />
          {searchState === "pending" && <LoaderCircle className="spin" size={14} aria-hidden="true" />}
        </label>
        <div className="heading-actions">
          <button
            className="primary-btn"
            onClick={() => setReloadToken((value) => value + 1)}
            disabled={!selected.length}
          >
            <RefreshCw size={17} />
            刷新全部分析
          </button>
        </div>
      </header>

      <section className="panel compare-selector-panel">
        <div className="compare-selector-head">
          <div>
            <BarChart3 size={18} />
            <span>对比标的</span>
            <em>{selected.length}/6</em>
          </div>
        </div>
        <div className="compare-selected-chips">
          {selected.map((security) => (
            <button key={security.code} onClick={() => removeSecurity(security.code)}>
              <span>{security.name}<small>{security.code}</small></span>
              <X size={14} />
            </button>
          ))}
          {!selected.length && <span className="compare-empty-tip">请至少添加 1 只股票</span>}
        </div>
        <div id="compare-search-status" role={searchState === "error" ? "alert" : "status"} aria-atomic="true">
          {composing ? "正在输入，完成后搜索。" : !query.trim() ? "" :
            searchState === "pending" ? "正在搜索远程股票，本地匹配可先选择。" :
            searchState === "error" ? `远程搜索失败：${searchError}。${filteredCandidates.length ? "本地匹配仍可选择。" : "请重试或更换搜索词。"}` :
            searchState === "empty" ? (filteredCandidates.length ? "远程未找到更多匹配，本地匹配仍可选择。" : "未找到匹配股票，请尝试其他名称或代码。") :
            searchState === "ready" ? `找到 ${filteredCandidates.length} 只匹配股票。` : ""}
        </div>
        {searchState === "error" && query.trim() && !composing && (
          <button className="secondary-btn" type="button" onClick={() => { setSearchState("pending"); setSearchRetryToken(value => value + 1); }}>重试远程搜索</button>
        )}
        {(query || !selected.length) && (
          <div id="compare-search-results" className="compare-candidate-list" role="region" aria-label="股票搜索结果" aria-busy={searchState === "pending"}>
            {filteredCandidates.map((security: any) => {
              const active = selected.some((item) => item.code === security.code);
              return (
                <button
                  key={security.code}
                  onClick={() => addSecurity(security)}
                  disabled={active || (!active && selected.length >= 6)}
                >
                  <Plus size={14} />
                  <span><b>{security.name}</b><small>{security.code} · {security.industry || security.marketName || "A股"}</small></span>
                  <em>{active ? "已添加" : "加入同列"}</em>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {!!selected.length && (
        <div className="compare-matrix-scroll" role="region" aria-label="多股指标对比" tabIndex={0}>
        <section className="panel compare-matrix" style={columnsStyle} role="table" aria-label="多股指标对比表" aria-colcount={selected.length + 1} aria-rowcount={rows.length + 1}>
          <div className="compare-header-row" role="row">
            <div className="compare-metric-label" role="columnheader">指标</div>
            {selected.map((security) => {
              const result = resultFor(security);
              const quote = result?.payload?.quote;
              const latest = nullableNumber(quote?.latest);
              const changePercent = nullableNumber(quote?.changePct);
              // 无有效价格或涨跌幅缺失时不给方向箭头，避免用红色箭头冒充“上涨”。
              const up = latest !== null && latest > 0 && changePercent !== null ? changePercent >= 0 : null;
              return (
                <div className="compare-stock-head" role="columnheader" key={security.code}>
                  <button onClick={() => onOpen(result?.payload?.security || security)}>
                    <span>{security.name}<small>{security.code}</small></span>
                    {result?.loading ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : result?.error ? (
                      <CircleAlert size={17} />
                    ) : up === null ? null : up ? (
                      <TrendingUp size={17} />
                    ) : (
                      <TrendingDown size={17} />
                    )}
                    <ChevronRight size={15} />
                  </button>
                  <small>
                    {providerLabel(result?.payload?.actualProvider)} ·{" "}
                    {/* B-04：行情时间始终按北京时间显示（跨时区机器不再跟随系统时区）。 */}
                    {formatShanghaiTime(result?.payload?.updatedAt)}
                  </small>
                </div>
              );
            })}
          </div>
          {rows.map((row) => (
            <div className="compare-metric-row" role="row" key={row.label}>
              <div className="compare-metric-label" role="rowheader">{row.label}</div>
              {selected.map((security) => {
                const result = resultFor(security);
                if (result?.loading && !result.payload) {
                  return (
                    <MetricCell key={`${row.label}-${security.code}`}>
                      <span className="compare-loading-copy"><LoaderCircle className="spin" size={14} />分析中</span>
                    </MetricCell>
                  );
                }
                if (result?.error || !result?.payload) {
                  return (
                    <MetricCell key={`${row.label}-${security.code}`} tone="risk">
                      <span>{result?.error || "暂无数据"}</span>
                    </MetricCell>
                  );
                }
                return (
                  <MetricCell key={`${row.label}-${security.code}`}>
                    {row.render(result.payload, security)}
                  </MetricCell>
                );
              })}
            </div>
          ))}
        </section>
        </div>
      )}

    </div>
  );
}
