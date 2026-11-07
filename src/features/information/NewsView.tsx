import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, CircleAlert, ExternalLink, FileText, Filter, Gauge, Newspaper, RefreshCw, Search, ShieldAlert, ShieldCheck, Wifi, Zap } from "lucide-react";
import { PageHeading, PanelTitle, LoadingState } from "../../components/terminal/TerminalPrimitives";
import { whenVisible } from "../../visiblePolling";
import { formatShanghaiTime, formatShanghaiDateTime, newsTimeText } from "../../dateUtils";
import { informationTabs, type InformationTab } from "./informationModel";
import type { AnalysisPayload } from "../market/analysisTypes";

export function NewsView({
  payload,
  watchlist,
  holdings,
  limitUps,
  settings,
  contentType = "all",
  onContentTypeChange,
  onOpenStock
}: {
  payload: AnalysisPayload | null;
  watchlist: WatchItem[];
  holdings: HoldingItem[];
  limitUps: any[];
  settings: Settings;
  contentType?: InformationTab;
  onContentTypeChange: (type: InformationTab) => void;
  onOpenStock: (stock: Security) => void;
}) {
  const announcementOnly = contentType === "announcement";
  const scopes = [
    { id: "all", label: "全市场" },
    { id: "limitUp", label: "涨停池", count: limitUps.length },
    { id: "watchlist", label: "观察池", count: watchlist.length },
    { id: "holdings", label: "持仓股", count: holdings.length },
    { id: "stock", label: "当前个股", disabled: !payload },
    { id: "sector", label: "当前板块", disabled: !payload?.sector }
  ];
  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("all");
  const [importance, setImportance] = useState("all");
  const [eventType, setEventType] = useState("all");
  const [feed, setFeed] = useState<any>({ items: [], sourceStatus: [] });
  const [loading, setLoading] = useState(true);
  const [hasLoadedFeed, setHasLoadedFeed] = useState(false);
  const [error, setError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const feedRequestId = useRef(0);
  const [refreshCycle, setRefreshCycle] = useState({ requestId: 0, failures: 0 });

  useEffect(() => () => {
    feedRequestId.current += 1;
  }, []);

  const feedInput = useMemo(() => ({
    scope,
    limit: 160,
    limitUps,
    watchlist,
    holdings,
    contentType,
    currentStock: payload?.security || null,
    currentSector: payload?.sector?.name || payload?.quote?.industry || ""
  }), [scope, limitUps, watchlist, holdings, contentType, payload?.security?.code, payload?.sector?.name, payload?.quote?.industry]);

  const loadFeed = useCallback(async (force = false) => {
    const requestId = ++feedRequestId.current;
    let failed = false;
    setLoading(true);
    setError("");
    try {
      const next = force
        ? await window.stockApi.refreshNewsFeed(feedInput)
        : await window.stockApi.getNewsFeed(feedInput);
      if (requestId === feedRequestId.current) {
        setFeed(next);
        setHasLoadedFeed(true);
      }
    } catch (reason) {
      failed = true;
      if (requestId === feedRequestId.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestId === feedRequestId.current) {
        setLoading(false);
        setRefreshCycle(current => ({ requestId, failures: failed ? Math.min(5, current.failures + 1) : 0 }));
      }
    }
  }, [feedInput]);

  useEffect(() => {
    setFeed({ items: [], sourceStatus: [] });
    setHasLoadedFeed(false);
    loadFeed(false);
    return () => { feedRequestId.current += 1; };
  }, [loadFeed]);

  useEffect(() => {
    if (!autoRefresh || loading) return;
    const baseSeconds = Math.max(
      5,
      Number(feed.refreshAfterSeconds || settings.newsRefreshSeconds || 6)
    );
    const retrySeconds = Math.min(60, baseSeconds * 2 ** Math.max(0, refreshCycle.failures - 1));
    let timer: number | undefined;
    const refreshWhenVisible = whenVisible(() => void loadFeed(false));
    const schedule = () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (document.hidden) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        refreshWhenVisible();
      }, retrySeconds * 1000);
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        window.clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined) {
        refreshWhenVisible();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [autoRefresh, loading, refreshCycle, settings.newsRefreshSeconds, feed.refreshAfterSeconds, feed.updatedAt, loadFeed]);

  const visibleItems = (feed.items || []).filter((item: any) => {
    const text = [
      item.title,
      item.summary,
      item.source,
      item.eventType,
      ...(item.relatedSectors || []),
      ...(item.relatedStocks || []).flatMap((stock: any) => [stock.code, stock.name])
    ].join(" ").toLowerCase();
    const matchesImportance = importance === "all" ||
      (importance === "major" && Number(item.importanceScore || 0) >= 75) ||
      (importance === "risk" && (Number(item.riskSeverity || 0) >= 1 || item.direction === "negative")) ||
      (importance === "corrected" && item.status === "corrected");
    return (contentType === "all" || item.type === contentType) &&
      (!query.trim() || text.includes(query.trim().toLowerCase())) &&
      (direction === "all" || item.direction === direction) &&
      (!announcementOnly || eventType === "all" || item.eventType === eventType) &&
      (!announcementOnly || matchesImportance);
  });
  const sourceStatus = announcementOnly
    ? (feed.sourceStatus || []).filter((source: any) => ["announcement", "ths"].includes(source.id))
    : contentType === "flash"
      ? (feed.sourceStatus || []).filter((source: any) => !["announcement", "ths"].includes(source.id))
      : (feed.sourceStatus || []);
  const staleSources = sourceStatus.filter((source: any) => source.stale);
  const enabledSources = sourceStatus.filter((source: any) => !source.disabled && (source.ok === true || source.ok === false));
  const failedSources = enabledSources.filter((source: any) => source.ok === false);
  const sourceFailureNames = failedSources.map((source: any) => source.name).join("；");
  const hasRelevantItems = (feed.items || []).some((item: any) => contentType === "all" || item.type === contentType);
  const sourceLoadError = !hasRelevantItems && enabledSources.length > 0 && failedSources.length === enabledSources.length
    ? `当前${announcementOnly ? "公告" : "资讯"}来源加载失败：${sourceFailureNames}，请重试。`
    : "";
  const feedError = error || sourceLoadError;
  const countsAvailable = hasLoadedFeed && !sourceLoadError;
  const levelACount = visibleItems.filter((item: any) => item.sourceLevel === "A").length;
  const freshCount = visibleItems.filter((item: any) => item.ageMinutes <= 30).length;
  const riskCount = visibleItems.filter((item: any) => item.riskSeverity >= 2).length;
  const directionName: Record<string, string> = {
    positive: "正向",
    negative: "风险",
    mixed: "多空混合",
    neutral: "中性"
  };
  const ageText = (minutes: number) =>
    minutes < 1 ? "刚刚" :
      minutes < 60 ? `${minutes}分钟前` :
        minutes < 1440 ? `${Math.floor(minutes / 60)}小时前` : `${Math.floor(minutes / 1440)}天前`;

  return (
    <div className="information-workspace">
      <PageHeading
        eyebrow="INFORMATION CENTER"
        title="资讯中心"
        description={announcementOnly
          ? "集中查看沪深北A股公司公告，按持仓、自选、事件类型、重要性与风险快速筛选。"
          : contentType === "flash"
            ? "查看 7×24 市场快讯，按股票、板块与关键词筛选；可信度、方向和影响强度分别呈现。"
            : "准实时聚合 7×24 快讯与公司公告；可信度、方向和影响强度分别计算。"}
        actions={
          <>
            <button className={`secondary-btn news-live-switch ${autoRefresh ? "active" : ""}`} onClick={() => setAutoRefresh((value) => !value)}>
              <span className="live-dot" />{autoRefresh ? "自动刷新中" : "自动刷新已停"}
            </button>
            <button className="primary-btn" onClick={() => loadFeed(true)}>
              <RefreshCw size={17} className={loading ? "spin" : ""} />立即刷新
            </button>
          </>
        }
      />

      <div className="news-scope-tabs information-type-tabs" role="tablist" aria-label="资讯类型">
        {informationTabs.map(tab => (
          <button key={tab.id} type="button" role="tab" aria-selected={contentType === tab.id}
            className={contentType === tab.id ? "active" : ""}
            onClick={() => {
              if (tab.id === contentType) return;
              feedRequestId.current += 1;
              setFeed({ items: [], sourceStatus: [] });
              setHasLoadedFeed(false);
              setError("");
              setLoading(true);
              onContentTypeChange(tab.id);
            }}>{tab.label}</button>
        ))}
      </div>


      <div className="information-layout"><aside className="information-filter-rail">      <div className="panel news-control-panel">
        <div className="news-scope-tabs">
          {scopes.map((item) => (
            <button
              key={item.id}
              disabled={item.disabled}
              className={scope === item.id ? "active" : ""}
              aria-pressed={scope === item.id}
              onClick={() => setScope(item.id)}
            >
              <span className="news-scope-label">{item.label}</span>{item.count !== undefined && <b className="news-scope-count">{item.count}</b>}
            </button>
          ))}
        </div>
        <div className="news-filters">
          <label><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={announcementOnly ? "搜索股票、公告标题、事件关键词" : "搜索股票、板块、事件关键词"} /></label>
          <div><Filter size={15} />
            {[
              { id: "all", label: "全部方向" },
              { id: "positive", label: "正向" },
              { id: "negative", label: "风险" },
              { id: "mixed", label: "多空混合" },
              { id: "neutral", label: "中性" }
            ].map((item) => <button key={item.id} className={direction === item.id ? "active" : ""} onClick={() => setDirection(item.id)}>{item.label}</button>)}
          </div>
          {announcementOnly && <div><Gauge size={15} />
            {[
              { id: "all", label: "全部重要性" },
              { id: "major", label: "重大" },
              { id: "risk", label: "风险" },
              { id: "corrected", label: "更正/修订" }
            ].map((item) => <button key={item.id} className={importance === item.id ? "active" : ""} onClick={() => setImportance(item.id)}>{item.label}</button>)}
          </div>}
          {announcementOnly && <div><FileText size={15} />
            {["all", "业绩", "股东行为", "并购重组", "监管风险", "经营订单", "公司公告"].map((item) => (
              <button key={item} className={eventType === item ? "active" : ""} onClick={() => setEventType(item)}>
                {item === "all" ? "全部类型" : item}
              </button>
            ))}
          </div>}
        </div>
      </div>


        <details className="information-disclosure"><summary>来源状态</summary>      <div
        className="news-mode-banner"
        data-announcement-module={announcementOnly ? true : undefined}
        data-content-type={contentType}
      >
        <Wifi size={17} />
        <b>{feed.mode || "准实时"}</b>
        <span>最后更新 {formatShanghaiTime(feed.updatedAt)}</span>
        <small>{announcementOnly ? "公司公告15秒复核；同花顺增强源30秒复核" : (feed.collectionPolicy || "快讯10秒轮询；公告低频复核")}。源平台发布时间延迟另计，“待行情确认”不会被伪装成已确认。</small>
      </div>

      <div className="news-source-strip">
        {sourceStatus.map((source: any) => (
          <div className={source.ok === false ? "failed" : source.ok === null ? "idle" : "online"} key={source.id}>
            <span /><b>{source.name}</b><em>{source.level}级</em><small>{source.message}{source.pollSeconds ? ` · ${source.pollSeconds}秒轮询` : ""}</small>
          </div>
        ))}
      </div>

</details>
        <details className="information-disclosure"><summary>{announcementOnly ? "公告判定规则" : "信息判定规则"}</summary>        <aside className="panel news-method-panel">
          <PanelTitle title={announcementOnly ? "公告判定规则" : "信息判定规则"} subtitle="不把“重要利空”误判为低价值" icon={Gauge} />
          {announcementOnly ? <>
            <div><b>官方原文优先</b><p>A级表示链接可核验至交易所或巨潮等官方披露平台；聚合页面明确标记为B级。</p></div>
            <div><b>公告分类</b><p>业绩、股东行为、并购重组、监管风险和经营订单按标题关键词分类。</p></div>
            <div><b>重大与风险分开</b><p>重要性衡量潜在影响，风险等级衡量负面强度；重大利空不会被隐藏。</p></div>
            <div><b>更正与修订</b><p>标题包含“更正”或“修订”的公告可单独筛选，避免沿用旧版本结论。</p></div>
            <div><b>行情确认</b><p>公告事实与市场反应分开呈现，初始保持“待行情确认”。</p></div>
          </> : <>
            <div><b>A级来源</b><p>公司公告和官方披露，用于确认事实。</p></div>
            <div><b>B级来源</b><p>7×24市场快讯，用于快速发现，仍需公告或行情验证。</p></div>
            <div><b>方向与重要性分开</b><p>重大利空会显示“高重要性、高风险”，不会因为方向为负而被隐藏。</p></div>
            <div><b>旧闻与重复</b><p>按原始发布时间判断新鲜度；标题相同且时间接近的转载会合并。</p></div>
            <div><b>市场确认</b><p>只有后续量价与板块扩散满足条件才会改为“已确认”，初始一律待确认。</p></div>
          </>}
        </aside></details>
      </aside><div className="information-feed">      <div className="news-overview-grid">
        <div className="panel">{announcementOnly ? <FileText size={19} /> : <Newspaper size={19} />}<span>当前范围</span><b>{countsAvailable ? visibleItems.length : "--"}</b><small>{announcementOnly ? "去重后的公司公告" : "去重后的资讯事件"}</small></div>
        <div className="panel"><ShieldCheck size={19} /><span>A级原始源</span><b>{countsAvailable ? levelACount : "--"}</b><small>官方披露或官方接口</small></div>
        <div className="panel"><Zap size={19} /><span>30分钟内</span><b>{countsAvailable ? freshCount : "--"}</b><small>按原始发布时间</small></div>
        <div className={`panel ${riskCount ? "risk" : ""}`}><ShieldAlert size={19} /><span>重要风险</span><b>{countsAvailable ? riskCount : "--"}</b><small>风险等级高</small></div>
      </div>

      {error && feed.items?.length > 0 && <div className="warning-banner" role="alert"><CircleAlert size={17} />刷新失败，已保留上次成功加载的资讯{feed.updatedAt ? `（${formatShanghaiDateTime(feed.updatedAt)}）` : ""}：{error}</div>}
      {!error && staleSources.length > 0 && <div className="warning-banner" role="alert"><CircleAlert size={17} />部分来源更新失败，暂用缓存：{staleSources.map((source: any) => `${source.name}${source.fetchedAt ? `（${formatShanghaiDateTime(source.fetchedAt)}）` : ""}`).join("；")}。可立即刷新重试。</div>}
      {!feedError && failedSources.length > 0 && <div className="warning-banner" role="alert"><CircleAlert size={17} />资讯来源加载失败：{sourceFailureNames}。当前仅展示可用内容，可立即刷新重试。</div>}


        <div className="panel realtime-news-list">
          <PanelTitle
            title={`${informationTabs.find(tab => tab.id === contentType)?.label} · ${scopes.find((item) => item.id === scope)?.label || "全市场"}`}
            subtitle={announcementOnly ? "按披露时间倒序；同一公告的聚合转载自动合并" : "按原始发布时间倒序；重复转载自动合并"}
            icon={announcementOnly ? FileText : Activity}
            badge={`${countsAvailable ? visibleItems.length : "--"} 条`}
          />
          {loading && !visibleItems.length ? <LoadingState /> : visibleItems.map((item: any) => (
            <article className={`realtime-news-card ${item.direction} ${item.riskSeverity >= 2 ? "major-risk" : ""}`} key={item.id}>
              <div className="news-card-rail">
                <span className={`source-level level-${item.sourceLevel}`}>{item.sourceLevel}</span>
                <i />
              </div>
              <div className="news-card-body">
                <div className="news-card-meta">
                  <time>{newsTimeText(item.publishedAt)} · {ageText(item.ageMinutes || 0)}</time>
                  <span>{item.source}</span>
                  <em className={`direction ${item.direction}`}>{directionName[item.direction] || item.direction}</em>
                  <em>{item.eventType}</em>
                  {item.duplicateCount > 1 && <em>合并 {item.duplicateCount} 条</em>}
                </div>
                <h3>{item.title}</h3>
                {item.summary && <p>{item.summary}</p>}
                <div className="news-score-row">
                  <span>可信度 <b>{item.credibilityScore}</b></span>
                  <span>重要性 <b>{item.importanceScore}</b></span>
                  <span>新鲜度 <b>{item.freshnessScore}</b></span>
                  <span>影响周期 <b>{item.impactHorizon}</b></span>
                  <span className="pending">行情确认 <b>{item.marketConfirmation}</b></span>
                </div>
                <div className="news-relations">
                  {(item.relatedSectors || []).map((sector: string) => <span key={sector}>板块 · {sector}</span>)}
                  {(item.relatedStocks || []).slice(0, 8).map((stock: any) => (
                    <button key={`${item.id}-${stock.code}`} onClick={() => onOpenStock(stock)}>
                      {stock.name || stock.code}<small>{stock.code}</small>
                    </button>
                  ))}
                  {!item.relatedSectors?.length && !item.relatedStocks?.length && <small>尚未建立A股直接映射</small>}
                </div>
                <div className="news-card-footer">
                  <span>首次发现 {formatShanghaiTime(item.firstSeenAt)}</span>
                  <span>{item.reasons?.[0]}</span>
                  <button onClick={() => window.stockApi.openExternal(item.sourceUrl)}>查看原文 <ExternalLink size={14} /></button>
                </div>
              </div>
            </article>
          ))}
          {!loading && !visibleItems.length && (feedError && (!feed.items?.length || sourceLoadError) ? (
            <div className="empty-state error" role="alert"><CircleAlert size={32} /><h3>{announcementOnly ? "公告" : "资讯"}加载失败</h3><p>{feedError}</p><button type="button" className="secondary-btn" onClick={() => void loadFeed(true)}>重新加载{announcementOnly ? "公告" : "资讯"}</button></div>
          ) : (
            <div className="empty-state">{announcementOnly ? <FileText size={32} /> : <Newspaper size={32} />}<h3>{feed.items?.length ? "当前筛选暂无匹配" : "当前范围暂无"}{announcementOnly ? "公告" : "资讯"}</h3><p>{feed.items?.length ? "可清除关键词或切换筛选条件。" : "当前范围暂未返回内容，可稍后刷新或切换到全市场。"}</p></div>
          ))}
        </div>


      </div></div>
    </div>
  );
}
