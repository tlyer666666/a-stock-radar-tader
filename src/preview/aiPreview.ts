import type { StockApi } from "../shared/ipc-contract";
import { applyCustomListMutation } from "../features/ai-picks/aiCustomModel";
import { defaultPreviewSettings, previewSecurities, previewState } from "./shared";

export type PreviewAiAndWorkspaceApi = Pick<
  StockApi,
  | "getNewsFeed"
  | "refreshNewsFeed"
  | "ai"
  | "getWatchlist"
  | "saveWatchlist"
  | "getHoldings"
  | "saveHoldings"
  | "getSettings"
  | "saveSettings"
  | "testProvider"
  | "setTheme"
  | "controlWindow"
  | "notify"
  | "openExternal"
  | "getPlatform"
  | "getVersion"
>;

type PreviewNewsEntry = { code?: string };

const buildPreviewNews = (input: {
  scope?: string;
  limitUps?: PreviewNewsEntry[];
  watchlist?: PreviewNewsEntry[];
  holdings?: PreviewNewsEntry[];
  contentType?: string;
  currentStock?: PreviewNewsEntry | null;
  [key: string]: unknown;
} = {}) => {
  const now = new Date().toISOString();
  const items = previewSecurities.map((security, index) => {
    const isFlash = index === 1;
    const eventType = isFlash ? "快讯" : index === 0 ? "业绩" : "监管风险";
    const direction = index === 0 ? "positive" : index === 2 ? "negative" : "neutral";
    return {
      id: `preview-news-${security.code}`,
      type: isFlash ? "flash" : "announcement",
      eventType,
      title: isFlash ? `${security.name} 浏览器预览快讯` : `${security.name} 浏览器预览公告`,
      summary: isFlash ? "该内容仅用于检查资讯雷达界面。" : "该内容仅用于检查A股公告模块。",
      direction,
      riskSeverity: index === 2 ? 2 : 0,
      importanceScore: index === 2 ? 86 : 75 - index * 5,
      credibilityScore: index === 0 ? 96 : 76,
      sourceLevel: index === 0 ? "A" : "B",
      freshnessScore: 100,
      ageMinutes: 0,
      impactHorizon: "短期",
      marketConfirmation: "待行情确认",
      marketConfirmed: false,
      firstSeenAt: now,
      publishedAt: now,
      fetchedAt: now,
      source: isFlash ? "预览财经快讯" : "预览公司公告",
      transportProvider: "浏览器预览",
      originAuthority: index === 0 ? "官方披露原文" : "待原始披露平台核验",
      sourceUrl: "https://example.invalid/preview",
      relatedStocks: [security],
      relatedSectors: [],
      status: index === 2 ? "corrected" : "active",
      duplicateCount: 1,
      reasons: ["浏览器预览数据"],
      autoBroadcast: index === 2
    };
  });
  const collectionForScope =
    input.scope === "limitUp" ? input.limitUps :
      input.scope === "watchlist" ? input.watchlist :
        input.scope === "holdings" ? input.holdings : null;
  const filtered = items.filter((item) => {
    if (input.contentType && input.contentType !== "all" && item.type !== input.contentType) return false;
    if (Array.isArray(collectionForScope)) {
      const codes = new Set(collectionForScope.map((entry) => String(entry?.code || "")));
      if (!item.relatedStocks.some((stock) => codes.has(stock.code))) return false;
    }
    if (input.scope === "stock") {
      const code = String(input.currentStock?.code || "");
      if (!code || !item.relatedStocks.some((stock) => stock.code === code)) return false;
    }
    return true;
  });
  return {
    source: "preview",
    updatedAt: now,
    mode: "浏览器预览",
    collectionPolicy: "预览数据不会连接真实公告源",
    refreshAfterSeconds: 30,
    total: filtered.length,
    unfilteredTotal: items.length,
    sourceStatus: [
      { id: "fast", name: "预览财经快讯", ok: true, level: "B", message: "1条", pollSeconds: 30 },
      { id: "cls", name: "预览电报", ok: true, level: "B", message: "0条", pollSeconds: 30 },
      { id: "announcement", name: "预览公司公告", ok: true, level: "B", message: "2条", pollSeconds: 30 },
      { id: "ths", name: "预览官方公告", ok: true, level: "A", message: "1条", pollSeconds: 30 }
    ],
    items: filtered
  };
};

export function createPreviewAiAndWorkspaceMethods(): PreviewAiAndWorkspaceApi {
  return {
    async getNewsFeed(input = {}) {
      return buildPreviewNews(input);
    },
    async refreshNewsFeed(input = {}) {
      return buildPreviewNews(input);
    },
    ai: (() => {
      const profiles: AiProfileList = { activeId: "demo-a", rankIds: ["demo-a", "demo-b"], max: 8, profiles: [
        { id: "demo-a", name: "演示 DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", hasKey: true },
        { id: "demo-b", name: "演示 通义", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", hasKey: true }] };
      const ratings = ["重点关注", "关注", "观望", "回避"] as const;
      const ratingOf = (score: number) => ratings[score >= 75 ? 0 : score >= 60 ? 1 : score >= 40 ? 2 : 3]!;
      const saved = new Map<string, { rank: AiRanking | null; summary: AiSummary | null; savedAt: string }>();
      const remember = (asOfDate: string, patch: { rank?: AiRanking; summary?: AiSummary }) => {
        const previous = saved.get(asOfDate) || { rank: null, summary: null, savedAt: "" };
        saved.set(asOfDate, { ...previous, ...patch, savedAt: new Date().toISOString() });
      };
      const demoRank = (input: AiSelectionInput): AiRanking => {
        const chosen = profiles.profiles.filter(item => profiles.rankIds?.includes(item.id));
        return { asOfDate: input.asOfDate, model: chosen.map(item => item.name).join(" + "), generatedAt: new Date().toISOString(), evaluated: input.picks.length,
          models: chosen.map(item => ({ id: item.id, name: item.name, model: item.model, ok: true, evaluated: input.picks.length })),
          items: input.picks.map((pick, index) => {
            const scores = chosen.map((item, modelIndex) => { const score = Math.max(20, 88 - index * 9 - modelIndex * (index === 1 ? 24 : 4)); return { id: item.id, name: item.name, score, rating: ratingOf(score) }; });
            const score = Math.round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length);
            const spread = Math.max(...scores.map(item => item.score)) - Math.min(...scores.map(item => item.score));
            return { code: pick.code, name: pick.name, score, rating: ratingOf(score), highlights: "演示：命中多套策略，量价配合", risks: "演示：短线涨幅较大", nextDay: "演示：观察竞价强弱与能否站稳均价", scores, spread, disagreement: spread >= 20 };
          }) };
      };
      // 和桌面版一样按股票累积：只给勾选的几只打分时并进同一张榜。
      const mergeBoard = (base: AiRanking | null, run: AiRanking): AiRanking => {
        const fresh = new Set(run.items.map(item => item.code));
        const items = [...run.items, ...(base?.items || []).filter(item => !fresh.has(item.code))].sort((a, b) => b.score - a.score);
        const profileList = [...(run.profiles || []), ...(base?.profiles || []).filter(item => !fresh.has(item.code))];
        return { ...run, items, evaluated: items.length, ...(profileList.length ? { profiles: profileList } : {}) };
      };
      const onlyCodes = (board: AiRanking, codes: string[]): AiRanking => {
        const wanted = new Set(codes);
        const items = board.items.filter(item => wanted.has(item.code));
        return { ...board, items, evaluated: items.length, ...(board.profiles ? { profiles: board.profiles.filter(item => wanted.has(item.code)) } : {}) };
      };
      const demoDims: Record<string, { label: string; detail: string }> = {
        limit: { label: "涨停强度", detail: "连板高度、近 20 日涨停次数、距最近涨停的天数" }, trend: { label: "均线趋势", detail: "均线排列、站上几条均线" },
        macd: { label: "MACD", detail: "金叉/死叉、红绿柱" }, rsi: { label: "RSI", detail: "RSI(14) 强弱与超买超卖" }, volume: { label: "量能", detail: "量比与涨跌配合" },
        position: { label: "位置乖离", detail: "5日线乖离率、近 20 日涨幅" }, levels: { label: "支撑压力", detail: "离支撑/压力距离、缺口" },
        theme: { label: "题材情绪", detail: "涨停原因、市场情绪" }, news: { label: "消息公告", detail: "近 30 天公司公告：利好/利空、重大风险" }, risk: { label: "风险控制", detail: "炸板、超买、高乖离" } };
      const demoCaps = [{ id: "overbought", label: "RSI14 超过 80 不给关注" }, { id: "chase", label: "高于 5 日线 5% 以上不追高" }, { id: "downtrend", label: "均线空头排列不给关注" }, { id: "broken", label: "近 20 日炸板 2 次以上且未连板不给关注" }, { id: "riskNotice", label: "近 30 天有重大风险公告不给关注" }];
      const builtin: Record<string, { name: string; description: string; weights: Record<string, number>; caps: string[] }> = { auto: { name: "AI 自动编排", description: "软件先识别情境、给各策略算适配度和基础分，AI 按情境自主挑 1–3 套策略组合使用。", weights: {}, caps: ["riskNotice"] },
        shortline: { name: "短线涨停", description: "看涨停强度、量能和题材情绪，适合打板、接力和涨停后低吸。", weights: { limit: 25, volume: 20, theme: 15, risk: 15, news: 10, position: 10, trend: 5 }, caps: ["broken", "riskNotice"] },
        technical: { name: "技术面综合", description: "看均线排列、MACD、RSI、量能、位置乖离和支撑压力，适合趋势和波段。", weights: { trend: 25, macd: 20, rsi: 15, volume: 10, position: 10, levels: 10, news: 10 }, caps: ["overbought", "chase", "riskNotice"] },
        breakout: { name: "突破", description: "逼近或站上近 20/60 日高点的股票，看突破是否放量。", weights: { trend: 30, volume: 30, risk: 20, news: 20 }, caps: ["overbought", "riskNotice"] },
        limit_pullback: { name: "涨停后低吸", description: "近 10 日涨停过、之后回调的股票，看回踩位置和缩量。", weights: { levels: 30, volume: 25, limit: 25, news: 20 }, caps: ["broken", "riskNotice"] } };
      let frameworkState: { active: AiFrameworkInfo["id"]; custom: AiCustomFramework } = { active: "auto", custom: { name: "自定义", weights: { ...builtin.technical!.weights }, caps: ["overbought", "chase"], note: "" } };
      const describe = (id: AiFrameworkInfo["id"], item: { name: string; description: string; weights: Record<string, number>; caps: string[] }, guidance = ""): AiFrameworkInfo => ({ id, name: item.name, description: item.description, guidance,
        dimensions: Object.entries(item.weights).map(([dim, weight]) => ({ id: dim, label: demoDims[dim]!.label, detail: demoDims[dim]!.detail, weight })), caps: demoCaps.filter(cap => item.caps.includes(cap.id)) });
      const catalog = (): AiFrameworkCatalog => ({ active: frameworkState.active, custom: structuredClone(frameworkState.custom),
        frameworks: [...Object.entries(builtin).map(([id, item]) => describe(id, item)), describe("custom", { ...frameworkState.custom, description: "你自己设定的维度权重和硬规则。" }, frameworkState.custom.note)],
        dimensions: Object.entries(demoDims).map(([id, item]) => ({ id, ...item })), caps: demoCaps });
      const currentWeights = () => frameworkState.active === "custom" ? frameworkState.custom.weights : frameworkState.active === "auto" ? builtin.breakout!.weights : builtin[frameworkState.active]?.weights || builtin.technical!.weights;
      const withFramework = (item: AiRankItem, index: number): AiRankItem => {
        const dims = Object.entries(currentWeights()).map(([id, weight], dimIndex) => ({ id, label: demoDims[id]!.label, weight, score: Math.max(15, 88 - index * 8 - dimIndex * 4), note: "演示：按体检数据计算" }));
        const total = dims.reduce((sum, dim) => sum + dim.weight, 0) || 1;
        const base = Math.round(dims.reduce((sum, dim) => sum + dim.score * dim.weight, 0) / total);
        const score = Math.max(0, Math.min(100, base + (index % 2 ? -4 : 6)));
        const auto = frameworkState.active === "auto";
        const plays = auto ? (index % 2 ? [{ id: "limit_pullback", name: "涨停后低吸", weight: 100, base, fit: 80 }] : [{ id: "breakout", name: "突破", weight: 60, base, fit: 85 }, { id: "technical", name: "技术面综合", weight: 40, base, fit: 55 }]) : undefined;
        return { ...item, score, rating: ratingOf(score), base, adjust: score - base, reason: index % 2 ? "演示：上方压力较近，略减分" : "演示：题材与量能配合，略加分",
          framework: auto ? `AI 编排：${plays!.map(play => `${play.name}${plays!.length > 1 ? ` ${play.weight}%` : ""}`).join(" + ")}` : catalog().frameworks.find(entry => entry.id === frameworkState.active)!.name, dims, caps: [],
          ...(auto ? { plays, situation: index % 2 ? ["涨停后回调", "回踩均线"] : ["逼近20日新高", "多头趋势", "有涨停题材"], orchestration: index % 2 ? "演示：涨停后缩量回踩，低吸为主" : "演示：放量突破叠加趋势" } : {}) };
      };
      let customList: AiCustomStock[] = [];
      let customRanking: AiRanking | null = null;
      const reviews = new Map<string, AiRanking>();
      const demoProfile = (code: string, name: string, index: number): AiStockProfile => ({
        code, name, industry: "演示行业", asOfDate: new Date().toISOString().slice(0, 10), latest: 20 + index, changePct: 2.1 - index, return5: 6.5 - index * 2,
        return20: 15 - index * 4, volumeRatio: 1.4, trend: index % 2 ? "站上5/10日线，20/60日线下方" : "站上全部均线", limitUps20: index % 3, consecutiveBoards: 0, daysSinceLimit: 3 + index,
        support: [{ label: "10日线", price: 19 + index }, { label: "20日线", price: 18 + index }], resistance: [{ label: "近20日最高", price: 23 + index }],
        announcements: index % 2 ? [] : [{ date: new Date().toISOString().slice(0, 10), title: "演示：关于签订日常经营重大合同的公告", direction: "利好", risk: 0 }]
      });
      const stampNow = (asOfDate: string) => ({ asOfDate, model: "演示 DeepSeek", generatedAt: new Date().toISOString() });
      const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      let marketSaved: AiMarketReview | null = null;
      let lookbackSaved: AiLookback | null = null;
      const interpretSaved = new Map<string, AiInterpretation>();
      return {
        async marketReview() {
          marketSaved = { ...stampNow(today()), headline: "演示：分歧中主线仍在，情绪未退潮", market: "浏览器预览不调用 AI，这里是演示文字。桌面版会引用复盘页的涨跌家数、涨停、炸板和连板数字。",
            cycle: { phase: "分歧", reason: "演示：涨停家数回落、炸板率升高，但最高连板仍在" }, mainlines: [{ name: "演示板块", comment: "演示：前排仍有涨停，后排分化" }],
            ladder: "演示：高度板分歧，2 板晋级率一般。", indices: "演示：指数站上 20 日线，量能略缩。",
            nextDay: { posture: "演示：低吸前排，不追后排", focus: ["演示：主线前排的分歧转一致"], avoid: ["演示：无板块的孤立涨停"] }, risks: ["演示：高位股补跌"], confidence: "中", softwareRegime: "高位分歧",
            mode: "skills", steps: [
              { thought: "演示：先确认主线和梯队", calls: [{ skill: "limit_reasons", name: "涨停原因", ok: true, summary: "演示：涨停 48 家，前列原因：固态电池6、业绩增长4", args: "{}" },
                { skill: "sector_strength", name: "板块强度", ok: true, summary: "演示：概念按涨停家数前列：固态电池、机器人", args: "{\"kind\":\"concept\",\"sortBy\":\"limitUps\"}" }] },
              { thought: "演示：核对风险", calls: [{ skill: "broken_boards", name: "炸板与跌停", ok: true, summary: "演示：炸板 20 家，跌停 17 家，封板率 59%", args: "{}" }] },
              { thought: "演示：信息足够", calls: [] }] };
          return marketSaved;
        },
        async lookback() {
          lookbackSaved = { ...stampNow(today()), previousDate: "2026-10-30", previousHeadline: "演示：情绪回暖", summary: "演示：方向判断基本兑现，高度判断偏乐观。",
            verdicts: [{ claim: "演示：主线延续", result: "兑现", evidence: "演示：板块涨停 6 家" }, { claim: "演示：高度突破 5 板", result: "未兑现", evidence: "演示：最高 4 板" }, { claim: "演示：回避后排", result: "部分兑现", evidence: "演示：后排跌多涨少" }],
            lessons: ["演示：高度判断要看晋级率"], hitRatePct: 50, judged: 3 };
          return lookbackSaved;
        },
        async cachedMarketReview() { return { review: marketSaved, lookback: lookbackSaved, previousDate: "2026-10-30" }; },
        async interpret(input: { kind: AiInterpretKind }) {
          const value: AiInterpretation = { ...stampNow(today()), kind: input.kind, title: input.kind === "ecology" ? "涨停生态" : input.kind === "sectors" ? "板块强度" : "炸板观察",
            headline: "演示：这里是 AI 解读的结论", points: ["演示：要点一", "演示：要点二"], risks: ["演示：风险一"], watch: ["演示：明天看前排能否回封"] };
          interpretSaved.set(input.kind, value);
          return value;
        },
        async cachedInterpret(input: { kind: AiInterpretKind }) { return interpretSaved.get(input.kind) || null; },
        async frameworks() { return catalog(); },
        async saveFramework(input: { active?: AiFrameworkInfo["id"]; custom?: AiCustomFramework }) {
          frameworkState = { active: input.active || frameworkState.active, custom: input.custom ? structuredClone(input.custom) : frameworkState.custom };
          customRanking = null; reviews.clear();
          return catalog();
        },
        async customList() { return structuredClone(customList); },
        async saveCustomList(items: AiCustomStock[]) { customList = items.slice(0, 40).map(item => ({ code: item.code, name: item.name })); return structuredClone(customList); },
        async mutateCustomList(input: AiCustomListMutation) {
          const result = applyCustomListMutation(customList, input);
          customList = result.list;
          return structuredClone(result);
        },
        async cachedCustom() { return customRanking ? { ...onlyCodes(customRanking, customList.map(item => item.code)), cached: true } : null; },
        async rankCustom(input?: { force?: boolean; codes?: string[] | undefined }) {
          const targets = input?.codes ? customList.filter(item => input.codes!.includes(item.code)) : customList;
          const have = new Set((customRanking?.items || []).map(item => item.code));
          const todo = input?.force || input?.codes ? targets : targets.filter(item => !have.has(item.code));
          const profiles = todo.map(item => demoProfile(item.code, item.name, customList.indexOf(item)));
          const ranking = demoRank({ asOfDate: profiles[0]?.asOfDate || "", picks: profiles.map(item => ({ code: item.code, name: item.name, strategies: [] })) as AiPick[], strategyCounts: [] });
          customRanking = mergeBoard(customRanking, { ...ranking, items: ranking.items.map(item => withFramework(item, Math.max(0, customList.findIndex(row => row.code === item.code)))), profiles });
          return { ...onlyCodes(customRanking, customList.map(item => item.code)), failed: [] };
        },
        async cachedReview(code: string) { return reviews.get(code) || null; },
        async review(input: { security: { code: string; name: string } }) {
          const profile = demoProfile(input.security.code, input.security.name, 0);
          const ranking = demoRank({ asOfDate: profile.asOfDate, picks: [{ code: profile.code, name: profile.name, strategies: [] }] as unknown as AiPick[], strategyCounts: [] });
          const item = { ...withFramework(ranking.items[0]!, 0), trend: "演示：站上全部均线，处于近20日区间上部", volume: "演示：量比 1.4，温和放量", keyLevels: "演示：回踩 10日线 19.00 不破可继续观察，上方 23.00 是近20日高点" };
          const value = { ...ranking, items: [item], profile, evaluated: 1 };
          reviews.set(profile.code, value);
          return value;
        },
        async status() { return { configured: true, model: "演示（浏览器预览）", profile: "演示 DeepSeek", rankModels: profiles.profiles.filter(item => profiles.rankIds?.includes(item.id)).map(item => item.name) }; },
        async cached(input: AiSelectionInput) { const hit = saved.get(input.asOfDate); const rank = hit?.rank ? onlyCodes(hit.rank, input.picks.map(pick => pick.code)) : null; return { rank: rank?.items.length ? { ...rank, cached: true } : null, summary: hit?.summary ? { ...hit.summary, cached: true } : null }; },
        async history() { return [...saved.entries()].map(([asOfDate, value]) => ({ asOfDate, rankModels: value.rank ? value.rank.models?.map(item => item.model) || [] : [], hasSummary: Boolean(value.summary), savedAt: value.savedAt })).sort((a, b) => b.asOfDate.localeCompare(a.asOfDate)); },
        async historyDay(asOfDate: string) { const hit = saved.get(asOfDate); return { asOfDate, rank: hit?.rank || null, summary: hit?.summary || null }; },
        async rank(input: AiSelectionInput): Promise<AiRanking> {
          const previous = saved.get(input.asOfDate)?.rank || null;
          const have = new Set((previous?.items || []).map(item => item.code));
          const todo = input.picks.filter(pick => input.only ? input.only.includes(pick.code) : input.force || !have.has(pick.code));
          const ranked = demoRank({ ...input, picks: todo });
          const board = mergeBoard(previous, { ...ranked, items: ranked.items.map(item => withFramework(item, Math.max(0, input.picks.findIndex(pick => pick.code === item.code)))) });
          remember(input.asOfDate, { rank: board });
          return onlyCodes(board, input.picks.map(pick => pick.code));
        },
        async summary(input: AiSelectionInput) {
          const result: AiSummary = { asOfDate: input.asOfDate, model: "演示 DeepSeek", generatedAt: new Date().toISOString(), headline: "演示：情绪回暖，主线集中",
            market: "浏览器预览不调用 AI，这里是演示文字。桌面版会根据当日涨停生态和选股结果生成总结。", themes: [{ name: "演示方向", stocks: input.picks.slice(0, 2).map(pick => pick.name) }],
            focus: input.picks.slice(0, 2).map(pick => ({ code: pick.code, name: pick.name, reason: "演示：命中策略最多" })), risks: ["演示：高位股分歧风险"] };
          remember(input.asOfDate, { summary: result }); return result;
        },
        async draftStrategy(): Promise<never> { throw new Error("浏览器预览不调用 AI，请在桌面版使用"); },
        async test(): Promise<never> { throw new Error("浏览器预览不调用 AI，请在桌面版测试"); },
        async profiles() { return structuredClone(profiles); },
        async saveProfile(): Promise<never> { throw new Error("浏览器预览不保存模型配置，请在桌面版设置"); },
        async deleteProfile(): Promise<never> { throw new Error("浏览器预览不保存模型配置，请在桌面版设置"); },
        async activateProfile(id: string) { profiles.activeId = id; return structuredClone(profiles); },
        async setRankModels(ids: string[]) { if (!ids.length) throw new Error("至少选择一套模型参与打分"); profiles.rankIds = ids; return structuredClone(profiles); }
      };
    })(),
    async getWatchlist() {
      return [...previewState.watchlist];
    },
    async saveWatchlist(items) {
      previewState.watchlist = Array.isArray(items) ? [...items] : [];
      return [...previewState.watchlist];
    },
    async getHoldings() {
      return [...previewState.holdings];
    },
    async saveHoldings(items) {
      previewState.holdings = Array.isArray(items) ? [...items] : [];
      return [...previewState.holdings];
    },
    async getSettings() {
      return { ...previewState.settings, selectedStrategies: [...previewState.settings.selectedStrategies] };
    },
    async saveSettings(settings) {
      previewState.settings = {
        ...defaultPreviewSettings,
        ...settings,
        selectedStrategies: [...new Set([...(settings.selectedStrategies || []), "riskVeto"])]
      };
      return { ...previewState.settings, selectedStrategies: [...previewState.settings.selectedStrategies] };
    },
    async testProvider(settings) {
      return {
        ok: true,
        provider: settings.provider,
        latency: 0,
        message: "浏览器预览连接正常；该结果不代表真实行情源可用。"
      };
    },
    async setTheme(theme) {
      previewState.settings = { ...previewState.settings, theme };
    },
    async controlWindow() {
      return { ok: true, maximized: false };
    },
    async notify() {
      return { shown: false };
    },
    async openExternal() {
      // External navigation is disabled in browser preview mode.
    },
    getPlatform() {
      return "browser";
    },
    async getVersion() {
      return `${__APP_VERSION__}-preview`;
    }
  };
}
