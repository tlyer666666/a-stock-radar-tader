import {
  Activity,
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

const nullableNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const number = (value: unknown, fallback = 0) => {
  const parsed = nullableNumber(value);
  return parsed === null ? fallback : parsed;
};

const fmt = (value: unknown, digits = 2) => {
  const parsed = nullableNumber(value);
  return parsed === null ? "--" : parsed.toFixed(digits);
};

const pct = (value: unknown, digits = 2) => {
  const parsed = nullableNumber(value);
  return parsed !== null
    ? `${parsed >= 0 ? "+" : ""}${parsed.toFixed(digits)}%`
    : "--";
};

const unit = (value: unknown, digits: number, suffix: string) => {
  const parsed = nullableNumber(value);
  return parsed === null ? "--" : `${parsed.toFixed(digits)}${suffix}`;
};

const money = (value: unknown) => {
  const parsed = nullableNumber(value);
  if (parsed === null) return "--";
  if (Math.abs(parsed) >= 1e8) return `${(parsed / 1e8).toFixed(2)}亿`;
  if (Math.abs(parsed) >= 1e4) return `${(parsed / 1e4).toFixed(0)}万`;
  return parsed.toFixed(0);
};

const providerLabel = (value: unknown) => {
  const provider = String(value || "").toLowerCase();
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

const uniqueSecurities = (items: Security[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const code = String(item?.code || "");
    if (!code || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
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
    const stored = persistent === null && legacySession
      ? JSON.parse(legacySession)
      : loadSafeLocalJson<unknown>(COMPARE_SELECTION_KEY, []);
    compareSelectionInitialized = true;
    if (Array.isArray(stored)) {
      compareSelectionCache = uniqueSecurities(stored).slice(0, 6);
      if (persistent === null) {
        saveSafeLocalJson(COMPARE_SELECTION_KEY, compareSelectionCache);
      }
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
  return <div className={`compare-cell ${tone}`}>{children}</div>;
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
  const [searching, setSearching] = useState(false);
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

  useEffect(() => {
    compareSelectionInitialized = true;
    compareSelectionCache = selected;
    try {
      saveSafeLocalJson(COMPARE_SELECTION_KEY, selected);
      sessionStorage.removeItem(COMPARE_SELECTION_KEY);
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
      setResults((current) => Object.fromEntries(
        Object.entries(current).map(([code, result]) => [
          code,
          result.loading ? { ...result, loading: false } : result
        ])
      ));
      return;
    }
    const forceReload = previousReloadToken.current !== reloadToken;
    previousReloadToken.current = reloadToken;
    const targets = forceReload
      ? selected
      : selected.filter((security) => {
          const existing = results[security.code];
          return !existing?.loading && !existing?.payload;
        });
    setResults((current) => {
      const targetCodes = new Set(targets.map((security) => security.code));
      const next = Object.fromEntries(
        Object.entries(current).map(([code, result]) => [
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
    Promise.allSettled(
      targets.map(async (security) => {
        try {
          return {
            code: security.code,
            payload: await window.stockApi.analyze(security)
          };
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
            code: security.code,
            payload: {
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
            }
          };
        }
      })
    ).then((settled) => {
      if (requestId !== analysisRequestId.current) return;
      setResults((current) => {
        const next = { ...current };
        settled.forEach((item, index) => {
          const security = targets[index];
          if (!security) return;
          if (item.status === "fulfilled") {
            next[security.code] = {
              loading: false,
              error: "",
              payload: item.value.payload
            };
          } else {
            next[security.code] = {
              loading: false,
              error: item.reason instanceof Error ? item.reason.message : String(item.reason),
              payload: null
            };
          }
        });
        return next;
      });
    });
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
      if (busy || document.hidden) return;
      busy = true;
      try {
        const rows = await Promise.allSettled(
          selected.map(async (security) => ({
            code: security.code,
            snapshot: await window.stockApi.getQuoteSnapshot(security)
          }))
        );
        if (!active) return;
        setResults((current) => {
          const next = { ...current };
          rows.forEach((row) => {
            if (row.status !== "fulfilled") return;
            const existing = next[row.value.code];
            if (!existing?.payload) return;
            next[row.value.code] = {
              ...existing,
              payload: {
                ...existing.payload,
                quote: {
                  ...existing.payload.quote,
                  ...(row.value.snapshot?.quote || {})
                },
                actualProvider:
                  row.value.snapshot?.actualProvider || existing.payload.actualProvider,
                updatedAt:
                  row.value.snapshot?.updatedAt || new Date().toISOString()
              }
            };
          });
          return next;
        });
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(refreshQuotes, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, signature]);

  useEffect(() => {
    const requestId = ++searchRequestId.current;
    window.clearTimeout(searchTimer.current);
    const normalized = query.trim();
    if (!normalized) {
      setRemoteCandidates([]);
      setSearching(false);
      return;
    }
    searchTimer.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const rows = await window.stockApi.search(normalized);
        if (requestId === searchRequestId.current) {
          setRemoteCandidates(
            uniqueSecurities(
              (Array.isArray(rows) ? rows : []).filter(
                (item: any) => !item?.assetType || item.assetType === "stock"
              )
            ).slice(0, 12)
          );
        }
      } catch {
        if (requestId === searchRequestId.current) setRemoteCandidates([]);
      } finally {
        if (requestId === searchRequestId.current) setSearching(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(searchTimer.current);
      if (requestId === searchRequestId.current) searchRequestId.current += 1;
    };
  }, [query]);

  const filteredCandidates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return candidateList.slice(0, 20);
    const local = candidateList.filter((item: any) =>
      [item.name, item.code, item.industry, item.marketName]
        .join(" ")
        .toLowerCase()
        .includes(normalized)
    );
    return uniqueSecurities([...local, ...remoteCandidates]).slice(0, 30);
  }, [candidateList, query, remoteCandidates]);

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
        const up = number(payload.quote?.changePct) >= 0;
        return (
          <div className="compare-primary-value">
            <b>{fmt(payload.quote?.latest)}</b>
            <span className={up ? "up" : "down"}>{pct(payload.quote?.changePct)}</span>
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
          <small>
            MA5 {fmt(payload.analysis?.ma5)} · MA10 {fmt(payload.analysis?.ma10)} ·
            MA20 {fmt(payload.analysis?.ma20)}
          </small>
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
          <small>
            关键位 {fmt(payload.analysis?.limitEvent?.low)} · AVWAP {fmt(payload.analysis?.avwap)}
          </small>
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
              平均 {pct(edge.average5, 2)} · 最差回撤 {pct(edge.worstMdd5, 1)}
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
      <div className="page-heading">
        <div>
          <span className="eyebrow">MULTI-STOCK MATRIX</span>
          <h1>多股同列</h1>
          <p>最多同时复核 6 只股票；添加和删除会自动记住，下次启动继续显示。</p>
        </div>
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
      </div>

      <section className="panel compare-selector-panel">
        <div className="compare-selector-head">
          <div>
            <BarChart3 size={18} />
            <span>对比标的</span>
            <em>{selected.length}/6</em>
          </div>
          <label>
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入名称/代码，或从候选池添加"
            />
            {searching && <LoaderCircle className="spin" size={14} />}
          </label>
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
        {(query || !selected.length) && (
          <div className="compare-candidate-list">
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
        <section className="panel compare-matrix" style={columnsStyle}>
          <div className="compare-header-row">
            <div className="compare-metric-label">指标</div>
            {selected.map((security) => {
              const result = resultFor(security);
              const quote = result?.payload?.quote;
              const up = number(quote?.changePct) >= 0;
              return (
                <div className="compare-stock-head" key={security.code}>
                  <button onClick={() => onOpen(result?.payload?.security || security)}>
                    <span>{security.name}<small>{security.code}</small></span>
                    {result?.loading ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : result?.error ? (
                      <CircleAlert size={17} />
                    ) : up ? (
                      <TrendingUp size={17} />
                    ) : (
                      <TrendingDown size={17} />
                    )}
                    <ChevronRight size={15} />
                  </button>
                  <small>
                    {providerLabel(result?.payload?.actualProvider)} ·{" "}
                    {result?.payload?.updatedAt
                      ? new Date(result.payload.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })
                      : "--"}
                  </small>
                </div>
              );
            })}
          </div>
          {rows.map((row) => (
            <div className="compare-metric-row" key={row.label}>
              <div className="compare-metric-label">{row.label}</div>
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
      )}

      <div className="compare-boundary-note">
        <Activity size={16} />
        同列结果来自各股票真实行情与独立策略分析；缺失历史样本显示为“--”，不会以 0 分代替。
      </div>
    </div>
  );
}
