import { useEffect, useRef, useState } from "react";
import { CircleAlert, Database, Gauge, LoaderCircle, ShieldAlert, ShieldCheck, SlidersHorizontal, Target, Wifi } from "lucide-react";
import { PageHeading, PanelTitle } from "../../components/terminal/TerminalPrimitives";
import { AiSettingsCard } from "./AiSettingsCard";
import { BackupSettingsCard } from "../backup/BackupSettingsCard";
import { quickStrategyPresets as strategyPresets } from "../../quickStrategyPresets";
import { clampNumber, normalizeRiskProfile, riskProfilePresets, sameStrategySet, strategyOptions } from "../../domain/settings";
import { sourceStatusLabel } from "../market/marketSourceHealth";
import { whenVisible } from "../../visiblePolling";
/* B-04 / B-11：行情来源的「最近成功时间」统一按北京时间显示，非法时间戳兜底 “--”。 */
import { formatShanghaiTime } from "../../dateUtils";

export function SettingsView({ value, loadState, onSave }: { value: Settings; loadState: "loading" | "ready" | "failed"; onSave: (next: Partial<Settings>) => Promise<Settings> }) {
  const [draft, setDraft] = useState<Settings>({ ...value, provider: "ths" });
  const [category, setCategory] = useState("sources");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [sourceHealth, setSourceHealth] = useState<MarketSourceHealth | null>(null);
  useEffect(() => {
    if (category !== "sources" || typeof window.stockApi?.getMarketSourceHealth !== "function") return;
    let active = true;
    const read = async () => {
      try {
        const next = await window.stockApi.getMarketSourceHealth!();
        if (active) setSourceHealth(next);
      } catch { /* 状态读取失败时保留上次结果 */ }
    };
    const readWhenVisible = whenVisible(read);
    readWhenVisible();
    const timer = window.setInterval(readWhenVisible, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [category, testResult]);
  const healthById = new Map((sourceHealth?.quotes || []).map((entry) => [entry.id, entry]));
  const laneDetail = (id: string, fallback: string) => {
    const entry = healthById.get(id);
    if (!entry || entry.status === "idle") return fallback;
    const latency = Number.isFinite(entry.lastLatencyMs) ? ` · ${entry.lastLatencyMs}ms` : "";
    if (entry.status === "ok") return `${sourceStatusLabel(entry)} · ${formatShanghaiTime(entry.lastOkAt)}${latency}`;
    return `${sourceStatusLabel(entry)}${entry.lastError ? ` · ${entry.lastError.slice(0, 40)}` : ""}`;
  };
  const laneState = (id: string) => healthById.get(id)?.status || "idle";
  // Credentials participate only in this in-memory comparison; never log or persist it.
  const connectionSignature = JSON.stringify([
    draft.provider, draft.refreshToken, draft.tushareToken, draft.fuyaoApiKey,
    draft.multiSourceEnabled, draft.fallbackEnabled
  ]);
  const connectionSignatureRef = useRef(connectionSignature);
  connectionSignatureRef.current = connectionSignature;
  const testGeneration = useRef(0);
  const activeTest = useRef<number | null>(null);
  const settingsMounted = useRef(true);
  useEffect(() => {
    testGeneration.current += 1;
    activeTest.current = null;
    setTesting(false);
    setTestResult(null);
  }, [connectionSignature]);
  useEffect(() => {
    settingsMounted.current = true;
    return () => { settingsMounted.current = false; testGeneration.current += 1; activeTest.current = null; };
  }, []);
  const previousSettings = useRef(value);
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = value;
    setDraft(current => {
      const next = { ...current };
      for (const key of Object.keys(value) as Array<keyof Settings>) {
        if (JSON.stringify(current[key]) === JSON.stringify(previous[key])) {
          Object.assign(next, { [key]: value[key] });
        }
      }
      return next;
    });
  }, [value]);
  const test = async () => {
    if (activeTest.current !== null || loadState !== "ready") return;
    const generation = ++testGeneration.current;
    const testedSignature = connectionSignature;
    const testedDraft = { ...draft };
    activeTest.current = generation;
    const isCurrent = () => settingsMounted.current &&
      generation === testGeneration.current &&
      testedSignature === connectionSignatureRef.current;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.stockApi.testProvider(testedDraft);
      if (isCurrent()) setTestResult({ ...result, signature: testedSignature });
    } catch (error) {
      if (isCurrent()) {
        setTestResult({
          signature: testedSignature,
          ok: false,
          message: error instanceof Error ? error.message : "连接测试失败，请检查网络或数据源设置"
        });
      }
    } finally {
      if (activeTest.current === generation) activeTest.current = null;
      if (isCurrent()) setTesting(false);
    }
  };
  const toggleStrategy = (id: string) => {
    if (id === "riskVeto") return;
    const current = draft.selectedStrategies || [];
    setDraft({
      ...draft,
      selectedStrategies: current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    });
  };
  const applyRiskProfile = (profile: Settings["riskProfile"]) => {
    const preset = riskProfilePresets.find((item) => item.id === profile);
    if (!preset) {
      setDraft((current) => ({ ...current, riskProfile: "balanced" }));
      return;
    }
    setDraft((current) => ({
      ...current,
      riskProfile: preset.id,
      ...preset.settings
    }));
  };
  const activeRiskProfile = riskProfilePresets.find((item) => item.id === draft.riskProfile) || riskProfilePresets[0]!;
  const saveDraft = async () => {
    if (saving || loadState !== "ready") return;
    const normalizedDraft: Settings = {
      ...draft,
    provider: "ths",
    riskProfile: normalizeRiskProfile(draft.riskProfile),
    maxDailyRiskPercent: clampNumber(draft.maxDailyRiskPercent, 0.3, 12, 3.2),
    maxPortfolioRiskPercent: clampNumber(draft.maxPortfolioRiskPercent, 10, 100, 70),
    maxSectorExposurePercent: clampNumber(draft.maxSectorExposurePercent, 10, 100, 45),
    minExecutionRatePercent: clampNumber(draft.minExecutionRatePercent, 40, 100, 90),
    trailingStopPercent: clampNumber(draft.trailingStopPercent, 0, 25, 3),
    minProjectedNetEdgePercent: clampNumber(draft.minProjectedNetEdgePercent, -2, 10, 0.2),
    minExpectancyPoints: clampNumber(draft.minExpectancyPoints, -2, 5, 0.2),
    maxConsecutiveLossesForStop: Math.round(clampNumber(draft.maxConsecutiveLossesForStop, 2, 12, 4)),
    lossStreakStepPercent: clampNumber(draft.lossStreakStepPercent, 2, 60, 18),
    lossStreakFloorPercent: clampNumber(draft.lossStreakFloorPercent, 10, 80, 30),
    commissionBps: clampNumber(draft.commissionBps, 0, 40, 7),
    slippageBps: clampNumber(draft.slippageBps, 0, 40, 2),
    minTurnoverPercent: clampNumber(draft.minTurnoverPercent, 0, 20, 0.4),
    minQuoteAmount: clampNumber(draft.minQuoteAmount, 0, 1_000_000_000, 1200000),
    maxQuoteAgeSeconds: clampNumber(draft.maxQuoteAgeSeconds, 30, 1800, 480),
    maxDailyTrades: Math.round(clampNumber(draft.maxDailyTrades, 1, 200, 12)),
    timeDecayPerBarPercent: clampNumber(draft.timeDecayPerBarPercent, 0, 1, 0.11),
    maxOpenPositions: Math.round(clampNumber(draft.maxOpenPositions, 1, 10, 2)),
    strictGate: Boolean(draft.strictGate),
    enabledPaperSim: Boolean(draft.enabledPaperSim),
    minMarketCap: clampNumber(draft.minMarketCap, 0, 100000, 0),
    minPaperWinRatePercent: clampNumber(draft.minPaperWinRatePercent, 40, 90, 52),
    minPaperRiskRewardRatio: clampNumber(draft.minPaperRiskRewardRatio, 1, 3, 1.15),
    maxPositionPercent: clampNumber(draft.maxPositionPercent, 5, 90, 28),
    maxRiskPerTradePercent: clampNumber(draft.maxRiskPerTradePercent, 0.2, 5, 1),
    stopLossATRMultiple: Math.max(clampNumber(draft.stopLossATRMultiple, 0.8, 5, 1.8), 0.6),
    takeProfitATRMultiple: Math.max(
      clampNumber(draft.takeProfitATRMultiple, 0.8, 10, 3.2),
      clampNumber(draft.stopLossATRMultiple, 0.8, 5, 1.8) + 0.2
    ),
    maxHoldingBars: Math.round(clampNumber(draft.maxHoldingBars, 3, 120, 30)),
    alertScore: clampNumber(draft.alertScore, 50, 95, 75),
    quoteRefreshSeconds: clampNumber(draft.quoteRefreshSeconds, 3, 20, 5),
    refreshSeconds: clampNumber(draft.refreshSeconds, 30, 300, 90),
    newsRefreshSeconds: clampNumber(draft.newsRefreshSeconds, 5, 45, 6),
      selectedStrategies: [...new Set([...(draft.selectedStrategies || []), "riskVeto"])]
    };
    setSaving(true);
    setSaveError("");
    try {
      // Omit untouched fields so earlier queued changes remain intact. Explicit
      // clears (including empty tokens) are still represented by the patch.
      const patch: Partial<Settings> = {};
      for (const key of Object.keys(draft) as Array<keyof Settings>) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(value[key])) Object.assign(patch, { [key]: normalizedDraft[key] });
      }
      const saved = await onSave(patch);
      if (settingsMounted.current) setDraft(current => {
        const next = { ...current };
        for (const key of Object.keys(saved) as Array<keyof Settings>) {
          if (JSON.stringify(current[key]) === JSON.stringify(draft[key])) Object.assign(next, { [key]: saved[key] });
        }
        return next;
      });
    } catch (error) {
      if (settingsMounted.current) {
        setSaveError(`${error instanceof Error ? error.message : "设置保存失败"}；当前运行仍使用上次成功保存的设置，草稿已保留，可重试。`);
      }
    } finally {
      if (settingsMounted.current) setSaving(false);
    }
  };
  return (
    <div className="settings-workspace">
      <PageHeading eyebrow="THREE-LINE MARKET DATA" title="数据源设置" description="同花顺免费行情为主源，无需 Token；东方财富与腾讯并行校验和故障接力。QuantAPI Refresh Token 为可选项，只加密保存在本机。" />
      {loadState !== "ready" && <div role="alert" className="test-result fail">{loadState === "loading" ? "正在读取本地设置，完成前暂不可保存。" : "本地设置读取失败，已禁止保存以保护原配置。请重新加载软件后重试。"}</div>}
      <nav className="settings-category-tabs" aria-label="设置分类">{[{ id: "sources", label: "行情连接" }, { id: "monitoring", label: "监控与提醒" }, { id: "execution", label: "执行参数" }, { id: "strategies", label: "策略组合" }, { id: "ai", label: "AI 助手" }, { id: "backup", label: "数据备份" }].map(item => <button type="button" key={item.id} aria-pressed={category === item.id} aria-controls={`settings-${item.id}`} onClick={() => setCategory(item.id)}>{item.label}</button>)}</nav>
      <div className="settings-grid">
        <div className="panel settings-card" id="settings-sources" hidden={category !== "sources"}>
          <PanelTitle title="行情主数据源" subtitle="同花顺免费行情为主，三线并存" icon={Database} />
          <div className="provider-options">
            <label className="selected">
              <input type="radio" checked readOnly />
              <span className="provider-icon ths">同</span>
              <span><b>同花顺免费行情 · 主源</b><small>同花顺个股页自身的公开行情接口，无需 Token；用于实时报价，并作为日K线接力</small></span>
              <i />
            </label>
            <label>
              <input type="radio" checked={false} disabled />
              <span className="provider-icon free"><Wifi size={19} /></span>
              <span><b>东方财富 · 腾讯 · 接力</b><small>同花顺超时、限流或盘中陈旧时自动接力，恢复后自动切回</small></span>
              <i />
            </label>
          </div>
          <div className="three-source-topology" aria-label="三线行情结构">
            {draft.fuyaoApiKey && <div className={`source-lane source-lane-primary is-${laneState("fuyao")}`}>
              <b>⓪ 同花顺扶摇行情</b>
              <small>{laneDetail("fuyao", "实时报价首选 · 沪深A股 · 批量快照")}</small>
            </div>}
            <div className={`source-lane ${draft.fuyaoApiKey ? "" : "source-lane-primary "}is-${laneState("ths_free")}`}>
              <b>① 同花顺免费行情</b>
              <small>{laneDetail("ths_free", draft.refreshToken ? "主源 · QuantAPI 已配置，优先 QuantAPI" : draft.fuyaoApiKey ? "扶摇接力 · 分时与分钟K线主源" : "主源 · 无需 Token")}</small>
            </div>
            <div className={`source-lane is-${laneState("eastmoney")}`}>
              <b>② 东方财富</b>
              <small>{laneDetail("eastmoney", "实时交叉校验 · 首个接力")}</small>
            </div>
            <div className={`source-lane is-${laneState("tencent")}`}>
              <b>③ 腾讯</b>
              <small>{laneDetail("tencent", "实时交叉校验 · 第二接力")}</small>
            </div>
          </div>
          <p className="source-health-note">某一路连续失败 2 次会暂停 30 秒（再失败则逐步延长，最长 4 分钟），期间直接走下一路；到期自动重试，成功即恢复。</p>
          <label className="field">
            <span>同花顺扶摇 API Key <b>推荐</b></span>
            <input type="password" value={draft.fuyaoApiKey || ""} onChange={(e) => setDraft({ ...draft, fuyaoApiKey: e.target.value })} placeholder="sk-fuyao-…（在 fuyao.aicubes.cn 用同花顺账号免费创建）" autoComplete="off" />
            <small>同花顺官方数据接口：填写后沪深A股实时报价和日K线（含中证全指等指数）优先走扶摇，失败、限流或盘中陈旧时自动回到同花顺免费网页接口；分时和分钟K线扶摇不提供，仍走同花顺免费接口。{laneDetail("fuyao_history", draft.fuyaoApiKey ? "已配置" : "未配置")}。仅加密保存在本机。</small>
          </label>
          {(draft.provider === "ths" || draft.multiSourceEnabled) && (
            <label className="field">
              <span>同花顺 QuantAPI Refresh Token <b>可选</b></span>
              <input type="password" value={draft.refreshToken} onChange={(e) => setDraft({ ...draft, refreshToken: e.target.value })} placeholder="付费 QuantAPI 账号才需要；不填也能用同花顺免费行情" />
              <small>填写后优先使用 QuantAPI（字段更全）；失败时自动回到同花顺免费行情。凭据仅加密保存在本机，不会上传或显示明文。</small>
            </label>
          )}
          <label className="switch-row">
            <span><b>三线并行校验</b><small>同花顺免费行情为主源；东方财富与腾讯同时校验。任一路失败会保留状态并由可用通道接力。</small></span>
            <input type="checkbox" checked={draft.multiSourceEnabled} onChange={(e) => setDraft({ ...draft, multiSourceEnabled: e.target.checked })} />
            <i />
          </label>
          {draft.multiSourceEnabled && (
            <label className="field">
              <span>Tushare Token <b>可选</b></span>
              <input type="password" value={draft.tushareToken} onChange={(e) => setDraft({ ...draft, tushareToken: e.target.value })} placeholder="用于盘后日线与历史数据复核" />
              <small>Tushare实时/特色接口可能需要积分或单独权限；未配置不会影响免费模式。</small>
            </label>
          )}
          <label className="switch-row">
            <span><b>自动降级</b><small>同花顺 QuantAPI 权限不足或超时，自动切到同花顺免费行情，再不行切东方财富/腾讯。</small></span>
            <input type="checkbox" checked={draft.fallbackEnabled} onChange={(e) => setDraft({ ...draft, fallbackEnabled: e.target.checked })} />
            <i />
          </label>
          <div className="settings-actions">
            <button className="secondary-btn" onClick={() => void test()} disabled={testing || loadState !== "ready"} aria-busy={testing}>{testing ? <LoaderCircle className="spin" size={17} /> : <Wifi size={17} />}测试连接</button>
            <button className="primary-btn" onClick={() => void saveDraft()} disabled={saving || loadState !== "ready"}>{saving ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}{saving ? "正在保存" : "保存设置"}</button>
          </div>
          {saveError && <div className="test-result fail" role="alert"><span />{saveError}</div>}
          {testResult?.signature === connectionSignature && <div className={`test-result ${testResult.ok ? "ok" : "fail"}`} role={testResult.ok ? "status" : "alert"}><span />{testResult.message}{Number.isFinite(testResult.latency) && <small>{testResult.latency} ms</small>}</div>}
          {testResult?.signature === connectionSignature && Array.isArray(testResult.lanes) && (
            <ul className="source-test-lanes" aria-label="各线路测试结果">
              {testResult.lanes.map((lane: any) => <li key={lane.id} className={lane.ok ? "ok" : "fail"}><b>{lane.label}</b><span>{lane.ok ? `可用 · ${lane.latency}ms · ${lane.name || ""} ${lane.latest ?? ""}` : `不可用 · ${lane.message || ""}`}</span></li>)}
            </ul>
          )}
        </div>

        <div className="panel settings-card" id="settings-monitoring" hidden={category !== "monitoring"}>
          <PanelTitle title="监控策略" subtitle="额度与提醒" icon={Gauge} />
          <label className="field">
            <span>当前个股报价 <b>{draft.quoteRefreshSeconds} 秒</b></span>
            <input type="range" min="3" max="20" step="1" value={draft.quoteRefreshSeconds} onChange={(e) => setDraft({ ...draft, quoteRefreshSeconds: Number(e.target.value) })} />
            <small>只拉最新价、高低价、成交额和换手；不会重复运行完整策略。</small>
          </label>
          <label className="field">
            <span>完整策略重算 <b>{draft.refreshSeconds} 秒</b></span>
            <input type="range" min="60" max="300" step="30" value={draft.refreshSeconds} onChange={(e) => setDraft({ ...draft, refreshSeconds: Number(e.target.value) })} />
            <small>重算板块、资讯、历史统计和风险项；默认90秒。</small>
          </label>
          <label className="field">
            <span>资讯页面轮询 <b>{draft.newsRefreshSeconds} 秒</b></span>
            <input type="range" min="5" max="30" step="1" value={draft.newsRefreshSeconds} onChange={(e) => setDraft({ ...draft, newsRefreshSeconds: Number(e.target.value) })} />
            <small>财联社与财经快讯10秒缓存，公告15秒复核；源平台发布时间延迟另计。</small>
          </label>
          <label className="switch-row">
            <span><b>重大资讯自动语音播报</b><small>只播报新出现的高重要性、重大风险或高可信事项，普通资讯保持静默。</small></span>
            <input type="checkbox" checked={draft.newsVoiceEnabled !== false} onChange={(e) => setDraft({ ...draft, newsVoiceEnabled: e.target.checked })} />
            <i />
          </label>
          <label className="field">
            <span>提醒分数线 <b>{draft.alertScore} 分</b></span>
            <input type="range" min="50" max="90" step="5" value={draft.alertScore} onChange={(e) => setDraft({ ...draft, alertScore: Number(e.target.value) })} />
            <small>MRS 达到该阈值时进入重点关注。</small>
          </label>
          <label className="switch-row">
            <span><b>只提醒精确节点</b><small>仅在 T+3 / T+5 / T+7 / T+9 触发。</small></span>
            <input type="checkbox" checked={draft.exactNodesOnly} onChange={(e) => setDraft({ ...draft, exactNodesOnly: e.target.checked })} />
            <i />
          </label>
          <div className="api-note">
            <CircleAlert size={18} />
            <p><b>免费模式边界</b>不抓客户端隐藏接口，不提供 Level-2、逐笔委托或自动交易。所有信号用于研究与监控。</p>
          </div>
          <div className="settings-actions"><button className="primary-btn" onClick={() => void saveDraft()} disabled={saving || loadState !== "ready"}><ShieldCheck size={17} />{saving ? "正在保存" : "保存设置"}</button></div>
          {saveError && <div className="test-result fail" role="alert"><span />{saveError}</div>}
        </div>

        <div className="panel settings-card" id="settings-execution" hidden={category !== "execution"}>
          <PanelTitle title="交易执行参数" subtitle="定义仓位、成本与风控边界后才进入实盘执行评估" icon={Target} />
          <div className="provider-options">
            {riskProfilePresets.map((profile) => {
              const isSelected = draft.riskProfile === profile.id;
              return (
                <label key={profile.id} className={isSelected ? "selected" : ""}>
                  <input
                    type="radio"
                    checked={isSelected}
                    onChange={() => applyRiskProfile(profile.id)}
                  />
                  <span className="provider-icon free"><ShieldAlert size={16} /></span>
                  <span><b>{profile.name}</b><small>{profile.detail}</small></span>
                  <i />
                </label>
              );
            })}
          </div>
          <div className="api-note">
            <ShieldAlert size={18} />
            <p>
              <b>{activeRiskProfile.name}</b>：切换后会一次性覆盖以上执行参数。你可在下方继续手动微调，避免与个人风格偏差。
            </p>
          </div>
          <label className="field">
            <span>最大仓位 <b>{draft.maxPositionPercent}%</b></span>
            <input type="range" min="5" max="90" step="1" value={draft.maxPositionPercent} onChange={(e) => setDraft({ ...draft, maxPositionPercent: Number(e.target.value) })} />
            <small>单笔标的建议的上限仓位，超过后仅按上限比例下单。</small>
          </label>
          <label className="field">
            <span>日内最大交易 <b>{draft.maxDailyTrades ?? 12}</b></span>
            <input type="range" min="1" max="200" step="1" value={draft.maxDailyTrades ?? 12} onChange={(e) => setDraft({ ...draft, maxDailyTrades: Number(e.target.value) })} />
            <small>今日达到上限后拒绝新开仓，限制高频交易失控。</small>
          </label>
          <label className="field">
            <span>单笔风险上限 <b>{draft.maxRiskPerTradePercent}%</b></span>
            <input type="range" min="0.2" max="5" step="0.1" value={draft.maxRiskPerTradePercent} onChange={(e) => setDraft({ ...draft, maxRiskPerTradePercent: Number(e.target.value) })} />
            <small>按仓位和止损距离折算，超过该比例即拒绝该交易。</small>
          </label>
          <label className="field">
            <span>止损 ATR 倍数 <b>{draft.stopLossATRMultiple}</b></span>
            <input type="range" min="0.8" max="5" step="0.1" value={draft.stopLossATRMultiple} onChange={(e) => setDraft({ ...draft, stopLossATRMultiple: Number(e.target.value) })} />
            <small>越大越保守，建议 1.8 ~ 3.2。</small>
          </label>
          <label className="field">
            <span>止盈 ATR 倍数 <b>{draft.takeProfitATRMultiple}</b></span>
            <input type="range" min="1.0" max="10" step="0.1" value={draft.takeProfitATRMultiple} onChange={(e) => setDraft({ ...draft, takeProfitATRMultiple: Number(e.target.value) })} />
            <small>建议保持高于止损 0.2 倍及以上，且不低于 2.5。</small>
          </label>
          <label className="field">
            <span>最大持仓窗口 <b>{draft.maxHoldingBars}</b></span>
            <input type="range" min="3" max="120" step="1" value={draft.maxHoldingBars} onChange={(e) => setDraft({ ...draft, maxHoldingBars: Number(e.target.value) })} />
            <small>超过后触发时间退出逻辑，避免资金长期被套。</small>
          </label>
          <label className="field">
            <span>最小成交率 <b>{draft.minExecutionRatePercent ?? 90}%</b></span>
            <input type="range" min="40" max="100" step="1" value={draft.minExecutionRatePercent ?? 90} onChange={(e) => setDraft({ ...draft, minExecutionRatePercent: Number(e.target.value) })} />
            <small>低于该成交率时拒绝开仓，降低滑点与未成交风险。</small>
          </label>
          <label className="field">
            <span>追踪止损 <b>{draft.trailingStopPercent ?? 3}%</b></span>
            <input type="range" min="0" max="25" step="0.5" value={draft.trailingStopPercent ?? 3} onChange={(e) => setDraft({ ...draft, trailingStopPercent: Number(e.target.value) })} />
            <small>持仓后价格从高点回撤该比例时触发止损退出。</small>
          </label>
          <label className="field">
            <span>最大持仓数 <b>{draft.maxOpenPositions}</b></span>
            <input type="range" min="1" max="10" step="1" value={draft.maxOpenPositions ?? 2} onChange={(e) => setDraft({ ...draft, maxOpenPositions: Number(e.target.value) })} />
            <small>限制同时持有标的数量，降低系统性交易风险。</small>
          </label>
          <label className="field">
            <span>最小预期净收益 <b>{draft.minProjectedNetEdgePercent ?? 0.2}%</b></span>
            <input type="range" min="-2" max="3" step="0.05" value={draft.minProjectedNetEdgePercent ?? 0.2} onChange={(e) => setDraft({ ...draft, minProjectedNetEdgePercent: Number(e.target.value) })} />
            <small>低于该净收益的信号会在执行前自动挂起。</small>
          </label>
          <label className="field">
            <span>最小期望值 <b>{draft.minExpectancyPoints ?? 0.2}</b></span>
            <input type="range" min="-2" max="5" step="0.05" value={draft.minExpectancyPoints ?? 0.2} onChange={(e) => setDraft({ ...draft, minExpectancyPoints: Number(e.target.value) })} />
            <small>期望值越低说明该信号对组合贡献不足。</small>
          </label>
          <label className="field">
            <span>单日连续亏损停手 <b>{draft.maxConsecutiveLossesForStop ?? 4}</b></span>
            <input type="range" min="2" max="10" step="1" value={draft.maxConsecutiveLossesForStop ?? 4} onChange={(e) => setDraft({ ...draft, maxConsecutiveLossesForStop: Number(e.target.value) })} />
            <small>连续亏损达到上限后，今日禁止新开仓。</small>
          </label>
          <label className="field">
            <span>减仓步幅 % <b>{draft.lossStreakStepPercent ?? 18}%</b></span>
            <input type="range" min="2" max="30" step="1" value={draft.lossStreakStepPercent ?? 18} onChange={(e) => setDraft({ ...draft, lossStreakStepPercent: Number(e.target.value) })} />
            <small>每多一笔连续亏损，仓位将按步幅下调。</small>
          </label>
          <label className="field">
            <span>减仓下限 % <b>{draft.lossStreakFloorPercent ?? 30}%</b></span>
            <input type="range" min="10" max="80" step="1" value={draft.lossStreakFloorPercent ?? 30} onChange={(e) => setDraft({ ...draft, lossStreakFloorPercent: Number(e.target.value) })} />
            <small>连续亏损严重时，单笔仓位不低于该比例。</small>
          </label>
          <label className="field">
            <span>日内最大风险 <b>{draft.maxDailyRiskPercent} %</b></span>
            <input type="range" min="0.3" max="12" step="0.1" value={draft.maxDailyRiskPercent ?? 3.2} onChange={(e) => setDraft({ ...draft, maxDailyRiskPercent: Number(e.target.value) })} />
            <small>超过阈值时触发 Kill Switch，停止新交易。</small>
          </label>
          <label className="field">
            <span>最低日内胜率 <b>{draft.minPaperWinRatePercent ?? 52}%</b></span>
            <input type="range" min="40" max="90" step="1" value={draft.minPaperWinRatePercent ?? 52} onChange={(e) => setDraft({ ...draft, minPaperWinRatePercent: Number(e.target.value) })} />
            <small>当日胜率不足将进入复核提示，不建议直接下单。</small>
          </label>
          <label className="field">
            <span>最低风险收益比 <b>{draft.minPaperRiskRewardRatio ?? 1.15}x</b></span>
            <input type="range" min="1" max="3" step="0.05" value={draft.minPaperRiskRewardRatio ?? 1.15} onChange={(e) => setDraft({ ...draft, minPaperRiskRewardRatio: Number(e.target.value) })} />
            <small>风险收益比低于阈值后仅在复核后允许开仓。</small>
          </label>
          <label className="field">
            <span>组合持仓上限 <b>{draft.maxPortfolioRiskPercent}%</b></span>
            <input type="range" min="10" max="100" step="1" value={draft.maxPortfolioRiskPercent ?? 70} onChange={(e) => setDraft({ ...draft, maxPortfolioRiskPercent: Number(e.target.value) })} />
            <small>当持仓估值超过该占比时触发熔断，避免单日仓位过度集中。</small>
          </label>
          <label className="field">
            <span>行业集中度上限 <b>{draft.maxSectorExposurePercent ?? 45}%</b></span>
            <input type="range" min="10" max="100" step="1" value={draft.maxSectorExposurePercent ?? 45} onChange={(e) => setDraft({ ...draft, maxSectorExposurePercent: Number(e.target.value) })} />
            <small>单一行业持仓超该占比时触发降仓/拒单，控制行业集中风险。</small>
          </label>
          <label className="field">
            <span>佣金 BPS <b>{draft.commissionBps}</b></span>
            <input type="range" min="0" max="40" step="0.1" value={draft.commissionBps ?? 7} onChange={(e) => setDraft({ ...draft, commissionBps: Number(e.target.value) })} />
            <small>交易成本评估时使用的固定佣金，单位：BPS。</small>
          </label>
          <label className="field">
            <span>滑点 BPS <b>{draft.slippageBps}</b></span>
            <input type="range" min="0" max="40" step="0.1" value={draft.slippageBps ?? 2} onChange={(e) => setDraft({ ...draft, slippageBps: Number(e.target.value) })} />
            <small>每次成交的隐含滑点估计，单位：BPS。</small>
          </label>
          <label className="field">
            <span>时间衰减/Bar <b>{draft.timeDecayPerBarPercent ?? 0.11}%</b></span>
            <input type="range" min="0" max="1" step="0.01" value={draft.timeDecayPerBarPercent ?? 0.11} onChange={(e) => setDraft({ ...draft, timeDecayPerBarPercent: Number(e.target.value) })} />
            <small>时间越久，信号有效性折损越快。</small>
          </label>
          <label className="field">
            <span>最小市值过滤 <b>{draft.minMarketCap} 亿</b></span>
            <input type="range" min="0" max="100000" step="100" value={draft.minMarketCap ?? 0} onChange={(e) => setDraft({ ...draft, minMarketCap: Number(e.target.value) })} />
            <small>低于阈值可直接过滤，0 表示不限制。</small>
          </label>
          <label className="field">
            <span>最低成交额 <b>{draft.minQuoteAmount ?? 1200000}</b></span>
            <input type="range" min="0" max="8000000" step="100000" value={draft.minQuoteAmount ?? 1200000} onChange={(e) => setDraft({ ...draft, minQuoteAmount: Number(e.target.value) })} />
            <small>成交额低于阈值视为流动性不足，默认按「元」计。</small>
          </label>
          <label className="field">
            <span>最低换手率 <b>{draft.minTurnoverPercent ?? 0.4}%</b></span>
            <input type="range" min="0" max="10" step="0.05" value={draft.minTurnoverPercent ?? 0.4} onChange={(e) => setDraft({ ...draft, minTurnoverPercent: Number(e.target.value) })} />
            <small>换手率低于阈值时不允许快速放量开仓。</small>
          </label>
          <label className="field">
            <span>行情新鲜度阈值 <b>{draft.maxQuoteAgeSeconds ?? 480}s</b></span>
            <input type="range" min="30" max="1800" step="15" value={draft.maxQuoteAgeSeconds ?? 480} onChange={(e) => setDraft({ ...draft, maxQuoteAgeSeconds: Number(e.target.value) })} />
            <small>最新快照超过该秒数不参与执行打分。</small>
          </label>
          <label className="switch-row">
            <span><b>严格闸门</b><small>开启后需同时满足历史/策略拟合与市值通过条件才出信号。</small></span>
            <input type="checkbox" checked={draft.strictGate !== false} onChange={(e) => setDraft({ ...draft, strictGate: e.target.checked })} />
            <i />
          </label>
          <label className="switch-row">
            <span><b>仅纸面模拟</b><small>避免真实下单，仅保留执行评估和日志，不触发实盘委托。</small></span>
            <input type="checkbox" checked={draft.enabledPaperSim !== false} onChange={(e) => setDraft({ ...draft, enabledPaperSim: e.target.checked })} />
            <i />
          </label>
          <div className="settings-actions">
            <button className="secondary-btn" onClick={() => void saveDraft()} disabled={saving || loadState !== "ready"}><ShieldCheck size={17} />{saving ? "正在保存" : "保存执行参数"}</button>
          </div>
          {saveError && <div className="test-result fail" role="alert"><span />{saveError}</div>}
        </div>

        <div className="panel settings-card strategy-config-card" id="settings-strategies" hidden={category !== "strategies"}>
          <PanelTitle title="自主策略组合" subtitle="用于个股分析匹配和预警的因子组合；选择命名快捷组合时，其核心条件必须满足。要用它批量选股，请到「策略选股 → 我的策略」新建，或在新建时“从设置的自主组合导入”。" icon={SlidersHorizontal} badge={`${draft.selectedStrategies?.length || 0} 项已启用`} />
          <div className="strategy-option-grid">
            {strategyOptions.map((item) => {
              const selected = draft.selectedStrategies?.includes(item.id);
              return (
                <button key={item.id} disabled={item.id === "riskVeto"} className={`${selected ? "selected" : ""} ${item.id === "riskVeto" ? "locked" : ""}`} onClick={() => toggleStrategy(item.id)}>
                  <span>{selected ? "✓" : "+"}</span>
                  <div><b>{item.name}{item.id === "riskVeto" ? " · 始终启用" : ""}</b><small>{item.detail}</small></div>
                </button>
              );
            })}
          </div>
          <div className="strategy-presets">
            <span>快捷组合 · {strategyPresets.length} 套</span>
            {strategyPresets.map((preset) => (
              <button key={preset.id} aria-pressed={sameStrategySet(draft.selectedStrategies || [], preset.strategies)} onClick={() => setDraft({ ...draft, selectedStrategies: preset.strategies })}><b>{preset.name}</b><small>{preset.detail}</small></button>
            ))}
            <button onClick={() => setDraft({ ...draft, selectedStrategies: strategyOptions.map((item) => item.id) })}>全部条件</button>
          </div>
          <div className="settings-actions">
            <button className="primary-btn" onClick={() => void saveDraft()} disabled={saving || loadState !== "ready"}><ShieldCheck size={17} />{saving ? "正在保存" : "保存策略组合"}</button>
          </div>
          {saveError && <div className="test-result fail" role="alert"><span />{saveError}</div>}
        </div>

        <BackupSettingsCard hidden={category !== "backup"} />
        <AiSettingsCard hidden={category !== "ai"} draft={draft} setDraft={setDraft} onSave={() => void saveDraft()} saving={saving} saveError={saveError} loadState={loadState} />
      </div>
    </div>
  );
}
