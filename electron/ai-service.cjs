"use strict";

/**
 * AI 助手服务：把 AI 客户端、选股提示词和本机缓存串起来，供主进程 IPC 调用。
 * - 同一数据日、同一模型、同一批股票的点评/总结会缓存（本机 userData/ai-selection.json，最多 20 条），
 *   重新打开软件也不会重复花钱；点「重新生成」才再调用模型。
 * - 同一时刻同一请求只发一次。
 */
const { createHash } = require("node:crypto");
const { createAiClient } = require("./ai-client.cjs");
const { createAiSelection, sanitizePicks } = require("./ai-selection.cjs");

const sanitizeCodes = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value || "").trim()).filter(code => /^\d{6}$/.test(code)))];
const { resolveFramework, frameworkSignature, CAP_SCORE } = require("./ai-frameworks.cjs");
const { createAiReview } = require("./ai-review.cjs");
const { createNoteParser } = require("./ai-notes.cjs");
const { createServiceRuntime, semanticKey } = require("./service-runtime.cjs");
const { producerContext } = require("./service-context.cjs");

const MAX_CACHE_ENTRIES = 150;

function isAiStore(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.entries);
}

function createAiService({ getConfig, getRankProfiles = null, getInstructions = () => ({}), getFramework = () => null, store = null, loadMarket = async () => null, fetchImpl, now = () => Date.now() } = {}) {
  const controller = new AbortController();
  const runtime = createServiceRuntime({ controller, jobOptions: { maxActive: 2, maxQueued: 4 } });
  // Two admitted calls can each score up to eight configured models. Shared
  // cache work needs its own producer scope, outside either caller's lifetime.
  const sharedRuntime = createServiceRuntime({ controller, jobOptions: { maxActive: 16, maxQueued: 0 } });
  const clientOptions = { getSignal: () => runtime.signal(), track: factory => runtime.track(factory), ...(fetchImpl ? { fetchImpl } : {}) };
  const clientFor = config => createAiClient({ ...clientOptions, getConfig: () => config });
  const activeConfig = () => { try { return getConfig() || {}; } catch { return {}; } };
  const ai = createAiClient({ ...clientOptions, getConfig: activeConfig });
  const selection = createAiSelection({ ai });
  const noteParser = createNoteParser({ ai });
  const shared = (key, produce) => {
    const signal = runtime.signal();
    return runtime.track(() => producerContext.run(undefined, () => sharedRuntime.run("scan", key, { signal }, async () => {
      runtime.checkpoint();
      const value = await produce();
      runtime.checkpoint();
      return value;
    })));
  };

  // 本机缓存文件只由本服务读写：读一次后留在内存里，写入时同步更新（打开个股页、切换历史时不必反复解析整个文件）。
  let memo = null;
  const readEntries = () => {
    if (memo) return memo;
    try { const value = store?.read?.(); memo = isAiStore(value) ? value.entries.filter(entry => entry && typeof entry.key === "string") : []; }
    catch { memo = []; }
    return memo;
  };
  const writeEntry = (key, kind, value) => {
    runtime.checkpoint();
    const entries = [{ key, kind, savedAt: new Date(now()).toISOString(), value }, ...readEntries().filter(entry => entry.key !== key)].slice(0, MAX_CACHE_ENTRIES);
    memo = entries;
    try { store?.write?.({ version: 1, entries }); } catch { /* 缓存写失败不影响本次结果 */ }
  };
  // 当前分析框架（短线涨停 / 技术面综合 / 自定义）；打分、点评都按它先算基础分。
  const currentFramework = () => { try { return resolveFramework(getFramework()); } catch { return resolveFramework(null); } };
  const instructionsFor = kind => {
    // 打分、自选打分、单股点评都用「打分与点评要求」；只有每日总结用「每日总结要求」。
    try { const value = getInstructions() || {}; return String((kind === "summary" ? value.summary : value.rank) || "").trim(); } catch { return ""; }
  };
  // 缓存按 数据日 + 模型配置 + 股票清单 + 自定义要求 区分：换了模型或改了要求就重新生成。
  const cacheKey = (kind, input, config) => {
    const codes = sanitizePicks(input?.picks || input?.profiles || (input?.profile ? [input.profile] : [])).map(item => item.code).sort().join(",");
    const scored = kind !== "summary";
    const digest = createHash("sha256").update(JSON.stringify([codes, config.baseUrl || "", instructionsFor(kind), scored ? frameworkSignature(currentFramework()) : ""])).digest("hex").slice(0, 16);
    return `${kind}:${String(input?.asOfDate || "")}:${String(config.model || "")}:${digest}`;
  };

  async function marketContext() {
    let timer;
    try {
      return await Promise.race([runtime.track(() => loadMarket({ signal: runtime.signal() })), new Promise(resolve => { timer = setTimeout(() => resolve(null), 8000); timer.unref?.(); })]);
    } catch { runtime.checkpoint(); return null; }
    finally { clearTimeout(timer); }
  }

  async function cached(kind, input, config, produce) {
    const key = cacheKey(kind, input, config);
    if (input?.force !== true) {
      const hit = readEntries().find(entry => entry.key === key);
      if (hit) return { ...hit.value, cached: true };
    }
    return shared(key, async () => {
      const market = await marketContext();
      runtime.checkpoint();
      const value = await produce(market);
      writeEntry(key, kind, value);
      return { ...value, cached: false };
    });
  }
  const cachedOnly = (kind, input, config) => {
    const hit = readEntries().find(entry => entry.key === cacheKey(kind, input, config));
    return hit ? { ...hit.value, cached: true } : null;
  };

  /** 参与打分的模型：设置里勾选的几套；没有多套配置时就是当前使用的那一套。 */
  const rankProfiles = () => {
    const list = typeof getRankProfiles === "function" ? (() => { try { return getRankProfiles() || []; } catch { return []; } })() : [];
    const usable = list.filter(item => item && item.model);
    return usable.length ? usable : [{ ...activeConfig(), id: activeConfig().id || "active" }];
  };
  // 三种打分都走「勾选的几个模型一起打分」：rank = 规则选出的股票，custom = 用户自己挑的股票，review = 单只股票详细点评。
  // 打分要求（设置里的「打分与点评要求」）三种都适用。
  const produceFor = (kind, client, input) => market => {
    const selection = createAiSelection({ ai: client });
    const instructions = instructionsFor("rank");
    const framework = currentFramework();
    // 策略候选也带了日线体检数据时（桌面版），同样按框架打分；没有体检数据时退回按规则指标打分。
    if (kind === "custom" || (kind === "rank" && Array.isArray(input?.profiles) && input.profiles.length)) {
      const profiles = withLimitReasons(input?.profiles, market);
      return selection.rankProfiles({ ...input, profiles, market, instructions, framework }).then(value => ({ ...value, profiles: compactProfiles(profiles) }));
    }
    if (kind === "review") {
      const [profile] = withLimitReasons([input?.profile], market);
      return selection.reviewStock({ profile, market, instructions, framework }).then(value => ({ ...value, profile }));
    }
    return selection.rankPicks({ ...input, picks: withLimitReasons(input?.picks, market), market, instructions });
  };
  const scoreOne = (kind, config, input) => cached(kind, input, config, produceFor(kind, clientFor(config), input));

  /*
   * 打分榜（rank = 策略候选，custom = 我的股票）按「类型 + 数据日 + 模型 + 要求 + 分析框架」各存一份，
   * 按股票逐只累积：只给勾选的几只打分时，结果并进同一张榜，其他股票之前的分数保留。
   * 不是「重新打分」时只给榜上还没有的股票打分。展示时只取当前清单里的股票。
   */
  const BOARD_KINDS = new Set(["rank", "custom"]);
  const BOARD_MAX_ITEMS = 120;
  const boardKey = (kind, asOfDate, config) => {
    const digest = createHash("sha256").update(JSON.stringify(["board", config.baseUrl || "", instructionsFor("rank"), frameworkSignature(currentFramework())])).digest("hex").slice(0, 16);
    return `${kind}:${asOfDate}:${String(config.model || "")}:b${digest}`;
  };
  const codesOf = list => sanitizeCodes((Array.isArray(list) ? list : []).map(item => typeof item === "string" ? item : item?.code));
  // 展示范围：页面传来的整张清单（display），没有时取 picks / profiles。
  const displayCodes = input => Array.isArray(input?.display) ? codesOf(input.display) : codesOf(input?.picks?.length ? input.picks : input?.profiles);
  // 这次要打分的股票：有体检数据时用体检数据，否则用规则指标；带 only 时只取这几只。
  const scoringTargets = input => {
    const profiled = Array.isArray(input?.profiles) && input.profiles.length > 0;
    const source = (profiled ? input.profiles : input?.picks || []).filter(item => item && /^\d{6}$/.test(String(item.code || "")));
    const only = Array.isArray(input?.only) ? new Set(codesOf(input.only)) : null;
    return { profiled, list: only ? source.filter(item => only.has(String(item.code))) : source };
  };
  function readBoard(kind, asOfDate, config, legacyCodes) {
    const hit = readEntries().find(entry => entry.key === boardKey(kind, asOfDate, config));
    if (hit) return hit.value;
    // 1.6.42 及以前按「整批股票」保存：同一批股票时沿用那份结果。
    if (!legacyCodes?.length) return null;
    const legacy = readEntries().find(entry => entry.key === cacheKey(kind, { asOfDate, picks: legacyCodes.map(code => ({ code })) }, config));
    return legacy ? legacy.value : null;
  }
  function mergeBoard(kind, asOfDate, config, legacyCodes, run) {
    const base = readBoard(kind, asOfDate, config, legacyCodes);
    const fresh = new Set((run.items || []).map(item => item.code));
    const items = [...(run.items || []), ...(base?.items || []).filter(item => !fresh.has(item.code))].slice(0, BOARD_MAX_ITEMS);
    const keep = new Set(items.map(item => item.code));
    const freshProfiles = new Set((run.profiles || []).map(item => item.code));
    const profiles = [...(run.profiles || []), ...(base?.profiles || []).filter(item => !freshProfiles.has(item.code))].filter(item => keep.has(item.code));
    const { missed: _missed, cached: _cached, ...rest } = { ...(base || {}), ...run };
    writeEntry(boardKey(kind, asOfDate, config), kind, { ...rest, asOfDate, items, evaluated: items.length, ...(profiles.length ? { profiles } : {}) });
  }
  function boardView(board, codes) {
    if (!board) return null;
    if (!codes?.length) return board;
    const wanted = new Set(codes);
    const items = (board.items || []).filter(item => wanted.has(item.code));
    const profiles = Array.isArray(board.profiles) ? board.profiles.filter(item => wanted.has(item.code)) : undefined;
    return { ...board, items, evaluated: items.length, ...(profiles ? { profiles } : {}) };
  }
  /** 每个模型还需要打分的股票（重新打分时就是全部目标股票）。 */
  function pendingFor(kind, config, input) {
    const { list } = scoringTargets(input);
    if (input?.force === true) return list;
    const board = readBoard(kind, String(input?.asOfDate || ""), config, displayCodes(input));
    // 按基础分兜底的（那一批 AI 没返回）不算打过分，下次不强制也会重试。
    const have = new Set((board?.items || []).filter(item => !baseOnly(item)).map(item => item.code));
    return list.filter(item => !have.has(String(item.code)));
  }
  async function scoreBoard(kind, config, input) {
    const asOfDate = String(input?.asOfDate || "");
    const display = displayCodes(input);
    const { profiled } = scoringTargets(input);
    const todo = pendingFor(kind, config, input);
    if (!todo.length) {
      const board = boardView(readBoard(kind, asOfDate, config, display), display);
      return board ? { ...board, cached: true } : { asOfDate, model: String(config.model || ""), generatedAt: new Date(now()).toISOString(), items: [], evaluated: 0, cached: true };
    }
    const key = `${boardKey(kind, asOfDate, config)}#${todo.map(item => String(item.code)).sort().join(",")}`;
    const subset = profiled ? { ...input, profiles: todo } : { ...input, picks: todo };
    const run = await shared(key, async () => {
      const market = await marketContext();
      runtime.checkpoint();
      const run = await produceFor(kind, clientFor(config), subset)(market);
      mergeBoard(kind, asOfDate, config, display, run);
      return run;
    });
    runtime.checkpoint();
    const board = boardView(readBoard(kind, asOfDate, config, display), display) || run;
    return { ...board, cached: false, ...(Number.isInteger(run.missed) && run.missed > 0 ? { missed: run.missed } : {}) };
  }

  async function scoreWithModels(kind, input) {
    const profiles = rankProfiles();
    const score = BOARD_KINDS.has(kind) ? config => scoreBoard(kind, config, input) : config => scoreOne(kind, config, input);
    const settled = await Promise.allSettled(profiles.map(score));
    runtime.checkpoint();
    const results = settled.map((outcome, index) => ({ profile: profiles[index], outcome }));
    if (results.every(item => item.outcome.status === "rejected")) throw results[0].outcome.reason;
    return combineRankings(results, input);
  }
  const rank = input => scoreWithModels("rank", input);
  /** 哪些股票至少有一个模型还没打分（主进程据此只给这几只读日线）。 */
  const pending = (kind, input) => {
    const codes = new Set();
    for (const config of rankProfiles()) for (const item of pendingFor(kind, config, input)) codes.add(String(item.code));
    return [...codes];
  };

  function cachedScores(kind, input) {
    const read = BOARD_KINDS.has(kind)
      ? profile => { const view = boardView(readBoard(kind, String(input?.asOfDate || ""), profile, displayCodes(input)), displayCodes(input)); return view?.items?.length ? { ...view, cached: true } : null; }
      : profile => cachedOnly(kind, input, profile);
    const results = rankProfiles().map(profile => ({ profile, value: read(profile) })).filter(item => item.value)
      .map(item => ({ profile: item.profile, outcome: { status: "fulfilled", value: item.value } }));
    return results.length ? combineRankings(results, input) : null;
  }
  const cachedRank = input => cachedScores("rank", input);

  /**
   * 不知道数据日时（打开个股页、打开「我的股票」）取本机最近一次结果：按保存过的数据日从新到旧，
   * 用当前模型和要求逐日找，找到就返回（换了模型或要求则视为没有）。
   */
  function latestCached(kind, codes) {
    const wanted = [...new Set((codes || []).map(String))].sort().join(",");
    const dates = [...new Set(readEntries().filter(entry => entry.kind === kind).map(entry => String(entry.value?.asOfDate || "")).filter(Boolean))].sort().reverse();
    for (const asOfDate of dates) {
      const input = { asOfDate, picks: wanted.split(",").filter(Boolean).map(code => ({ code })) };
      const hit = cachedScores(kind, input);
      if (hit) return hit;
    }
    return null;
  }

  /** 历史记录：按数据日列出已生成过的打分（哪些模型）和总结。 */
  function history() {
    const days = new Map();
    for (const entry of readEntries()) {
      const asOfDate = String(entry.value?.asOfDate || entry.key.split(":")[1] || "");
      if (!asOfDate) continue;
      if (!["rank", "custom", "summary"].includes(entry.kind)) continue;
      const day = days.get(asOfDate) || { asOfDate, rankModels: [], customModels: [], hasSummary: false, savedAt: "" };
      if (entry.kind === "rank" && entry.value?.model && !day.rankModels.includes(entry.value.model)) day.rankModels.push(entry.value.model);
      if (entry.kind === "custom" && entry.value?.model && !day.customModels.includes(entry.value.model)) day.customModels.push(entry.value.model);
      if (entry.kind === "summary") day.hasSummary = true;
      if (String(entry.savedAt || "") > day.savedAt) day.savedAt = String(entry.savedAt || "");
      days.set(asOfDate, day);
    }
    return [...days.values()].sort((a, b) => b.asOfDate.localeCompare(a.asOfDate));
  }

  /** 某个数据日的历史结果：每个模型取最近一次打分合并展示，总结取最近一次。 */
  function historyDay(asOfDate) {
    const date = String(asOfDate || "");
    const entries = readEntries().filter(entry => String(entry.value?.asOfDate || "") === date);
    const replay = kind => {
      const latest = new Map();
      for (const entry of entries) if (entry.kind === kind && entry.value?.model && !latest.has(entry.value.model)) latest.set(entry.value.model, entry.value);
      const results = [...latest.values()].map(value => ({ profile: { id: value.model, name: value.model, model: value.model }, outcome: { status: "fulfilled", value: { ...value, cached: true } } }));
      return results.length ? combineRankings(results, { asOfDate: date }) : null;
    };
    const summary = entries.find(entry => entry.kind === "summary")?.value || null;
    return { asOfDate: date, rank: replay("rank"), custom: replay("custom"), summary: summary ? { ...summary, cached: true } : null };
  }

  // AI 复盘（市场复盘、回看、页面解读）：用「总结用」的那套模型；按 类型 + 数据日 + 模型 + 要求 保存，同一天只保留最新一次。
  const reviewKey = (kind, asOfDate, config, extra = "") => {
    const digest = createHash("sha256").update(JSON.stringify([config.baseUrl || "", instructionsFor("summary"), extra])).digest("hex").slice(0, 12);
    return `${kind}:${asOfDate}:${String(config.model || "")}:${digest}`;
  };
  async function keyedReview(kind, asOfDate, extra, force, produce) {
    const config = activeConfig();
    const key = reviewKey(kind, asOfDate, config, extra);
    if (!force) { const hit = readEntries().find(entry => entry.key === key); if (hit) return { ...hit.value, cached: true }; }
    return shared(key, async () => {
      const value = await produce(createAiReview({ ai: clientFor(config) }));
      writeEntry(reviewKey(kind, value.asOfDate || asOfDate, config, extra), kind, value);
      return { ...value, cached: false };
    });
  }
  const cachedKeyed = (kind, asOfDate, extra = "") => {
    const hit = readEntries().find(entry => entry.key === reviewKey(kind, asOfDate, activeConfig(), extra));
    return hit ? { ...hit.value, cached: true } : null;
  };
  /** 最近一次（数据日早于 beforeDate）的 AI 市场复盘，任何模型都算；给「回看」用。 */
  const previousMarketReview = beforeDate => readEntries().filter(entry => entry.kind === "market" && String(entry.value?.asOfDate || "") < String(beforeDate || ""))
    .sort((a, b) => String(b.value.asOfDate).localeCompare(String(a.value.asOfDate)) || String(b.savedAt || "").localeCompare(String(a.savedAt || "")))[0]?.value || null;
  const reviewInstructions = () => instructionsFor("summary");

  const service = {
    // skills：复盘技能（由主进程按当次数据源创建）；有技能时 AI 会自主调用技能再写复盘。
    marketReview: ({ snapshot, force, skills } = {}) => keyedReview("market", String(snapshot?.date || ""), "", force === true,
      review => review.marketReview({ snapshot, instructions: reviewInstructions(), skills })),
    /** 数据日早于 beforeDate 的最近几次 AI 市场复盘（复盘技能「历次复盘」用）。 */
    recentMarketReviews: (beforeDate, count = 3) => {
      const seen = new Set();
      return readEntries().filter(entry => entry.kind === "market" && String(entry.value?.asOfDate || "") < String(beforeDate || "9999"))
        .sort((a, b) => String(b.value.asOfDate).localeCompare(String(a.value.asOfDate)) || String(b.savedAt || "").localeCompare(String(a.savedAt || "")))
        .filter(entry => !seen.has(entry.value.asOfDate) && seen.add(entry.value.asOfDate)).slice(0, Math.max(1, Math.min(5, count))).map(entry => entry.value);
    },
    cachedMarketReview: asOfDate => cachedKeyed("market", String(asOfDate || "")),
    lookback: ({ snapshot, force } = {}) => {
      const date = String(snapshot?.date || "");
      const previous = previousMarketReview(date);
      return keyedReview("lookback", date, String(previous?.asOfDate || ""), force === true, review => review.lookback({ previous, snapshot }));
    },
    cachedLookback: asOfDate => cachedKeyed("lookback", String(asOfDate || ""), String(previousMarketReview(asOfDate)?.asOfDate || "")),
    previousMarketReview,
    interpret: ({ kind, data, asOfDate, force } = {}) => keyedReview(`interpret-${kind}`, String(asOfDate || ""), "", force === true,
      review => review.interpret({ kind, data, asOfDate, instructions: reviewInstructions() })),
    cachedInterpret: (kind, asOfDate) => cachedKeyed(`interpret-${kind}`, String(asOfDate || "")),
    history,
    historyDay,
    status: () => {
      const config = activeConfig();
      return { configured: ai.configured(), model: ai.model(), profile: String(config.name || ""), rankModels: rankProfiles().map(item => String(item.name || item.model || "")), framework: currentFramework().name };
    },
    rank,
    rankCustom: input => scoreWithModels("custom", input),
    pending,
    review: input => scoreWithModels("review", input),
    cachedCustom: codes => latestCached("custom", codes),
    cachedReview: code => latestCached("review", [code]),
    summary: input => cached("summary", input, activeConfig(), market => selection.dailySummary({ ...input, picks: withLimitReasons(input?.picks, market), market, instructions: instructionsFor("summary") })),
    cachedRank,
    cachedSummary: input => cachedOnly("summary", input, activeConfig()),
    draftStrategy: input => selection.draftStrategy(input),
    parseNote: input => noteParser.parseNote(input),
    /** 设置页「测试 AI 连接」：用草稿里的地址、模型、Key 发一条极短的请求。 */
    async test(config) {
      const probe = clientFor(config);
      const started = now();
      const result = await probe.chat({ system: "只输出 JSON。", user: "返回 {\"ok\":true}", json: true, maxTokens: 20 });
      return { ok: result?.ok === true || Boolean(result), latency: Math.max(0, now() - started), model: probe.model() };
    }
  };
  for (const method of ["rank", "rankCustom", "review", "summary", "marketReview", "lookback", "interpret", "draftStrategy", "parseNote", "test"]) {
    const produce = service[method];
    service[method] = (input, request = {}) => {
      let key;
      try {
        key = semanticKey({ method, input, config: activeConfig(), profiles: rankProfiles(),
          instructions: { rank: instructionsFor("rank"), summary: instructionsFor("summary") }, framework: frameworkSignature(currentFramework()) });
      } catch (error) { return Promise.reject(error); }
      return runtime.run("scan", key, { ...input, ...request }, async () => {
        runtime.checkpoint();
        const value = await produce(input);
        runtime.checkpoint();
        return value;
      });
    };
  }
  service.shutdown = reason => Promise.allSettled([runtime.shutdown(reason), sharedRuntime.shutdown(reason)]).then(() => undefined);
  return service;
}

const ratingFor = score => score >= 75 ? "重点关注" : score >= 60 ? "关注" : score >= 40 ? "观望" : "回避";

/**
 * 几个模型的打分合在一起：综合分 = 各模型分数平均（四舍五入）；评级按综合分；
 * 文字点评取排在最前面的模型（当前使用的那套优先）；分差 ≥ 20 标为「模型分歧」。
 * 单模型时结构相同，models 只有一项。
 */
// Older saved boards used only a fixed reason to identify omitted rows.
function baseOnly(item) {
  return item.fallback === true || item.reason === "AI 没有评估这只，按基础分";
}

function combineRankings(results, input) {
  const models = results.map(({ profile, outcome }) => ({
    id: String(profile.id || ""), name: String(profile.name || profile.model || "模型"), model: String(profile.model || ""),
    ok: outcome.status === "fulfilled",
    ...(outcome.status === "fulfilled" ? { cached: outcome.value.cached === true, generatedAt: outcome.value.generatedAt, evaluated: outcome.value.evaluated,
      ...(Number.isInteger(outcome.value.missed) && outcome.value.missed > 0 ? { missed: outcome.value.missed } : {}) }
      : { error: String(outcome.reason?.message || outcome.reason || "失败").slice(0, 160) })
  }));
  const byCode = new Map();
  results.forEach(({ outcome }, index) => {
    if (outcome.status !== "fulfilled") return;
    for (const item of outcome.value.items || []) {
      const rows = byCode.get(item.code) || [];
      rows.push({ item, model: models[index] });
      byCode.set(item.code, rows);
    }
  });
  const items = [...byCode.values()].map(rows => {
    const answered = rows.filter(({ item }) => !baseOnly(item));
    const effective = answered.length ? answered : rows;
    const primary = effective[0].item;
    const scores = answered.map(({ item, model }) => ({ id: model.id, name: model.name, score: item.score, rating: item.rating }));
    const values = effective.map(({ item }) => item.score);
    const bases = effective.map(({ item }) => item.base).filter(Number.isFinite);
    // 本地硬规则仍适用，即使该模型没有返回点评。
    const caps = [...new Map(rows.flatMap(({ item }) => Array.isArray(item.caps) ? item.caps : [])
      .map(cap => [JSON.stringify(cap), cap])).values()];
    let score = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    if (caps.length) score = Math.min(score, CAP_SCORE);
    const spread = scores.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
    const extras = Object.fromEntries(["trend", "volume", "keyLevels", "reason", "framework", "orchestration"]
      .filter(key => typeof primary[key] === "string").map(key => [key, primary[key]]));
    for (const key of ["plays", "situation"]) if (Array.isArray(primary[key])) extras[key] = primary[key];
    if (bases.length) Object.assign(extras, { base: Math.round(bases.reduce((sum, value) => sum + value, 0) / bases.length), dims: primary.dims || [] });
    return { code: primary.code, name: primary.name, score, rating: ratingFor(score),
      highlights: primary.highlights, risks: primary.risks, nextDay: primary.nextDay, ...extras, caps,
      ...(Number.isFinite(extras.base) ? { adjust: score - extras.base } : {}), ...(!answered.length ? { fallback: true } : {}),
      scores, spread, disagreement: spread >= 20 };
  }).sort((a, b) => Number(Boolean(a.fallback)) - Number(Boolean(b.fallback)) ||
    b.score - a.score || b.scores.length - a.scores.length || a.code.localeCompare(b.code));
  const ok = models.filter(item => item.ok);
  const firstValue = results.find(item => item.outcome.status === "fulfilled")?.outcome.value || {};
  return {
    ...(Array.isArray(firstValue.profiles) ? { profiles: firstValue.profiles } : {}),
    ...(firstValue.profile ? { profile: firstValue.profile } : {}),
    ...(typeof firstValue.framework === "string" ? { framework: firstValue.framework } : {}),
    asOfDate: String(input?.asOfDate || firstValue.asOfDate || ""), model: ok.map(item => item.name).join(" + "),
    generatedAt: ok.map(item => item.generatedAt).filter(Boolean).sort().at(-1) || new Date().toISOString(),
    evaluated: items.filter(item => !item.fallback).length, cached: ok.every(item => item.cached),
    models, items
  };
}

/** 「我的股票」打分结果里保存的体检数据（表格显示用，只留几项，控制本机缓存大小）。 */
function compactProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).filter(item => item && /^\d{6}$/.test(String(item.code || ""))).slice(0, 40).map(item => ({
    code: String(item.code), name: String(item.name || "").slice(0, 12), industry: String(item.industry || "").slice(0, 12), asOfDate: String(item.asOfDate || ""),
    latest: item.latest ?? null, changePct: item.changePct ?? null, return5: item.return5 ?? null, return20: item.return20 ?? null,
    volumeRatio: item.volumeRatio ?? null, trend: String(item.trend || "").slice(0, 30), limitUps20: item.limitUps20 ?? null,
    consecutiveBoards: item.consecutiveBoards ?? null, daysSinceLimit: item.daysSinceLimit ?? null, limitReason: String(item.limitReason || "").slice(0, 40),
    rsi14: item.rsi14 ?? null, bias5: item.bias5 ?? null, alignment: String(item.alignment || "").slice(0, 8), macdCross: String(item.macd?.cross || "").slice(0, 4),
    ...(item.announcementsAvailable === false ? { announcementsAvailable: false } : {}),
    noticeCount: Array.isArray(item.announcements) && item.announcementsAvailable !== false ? item.announcements.length : null,
    noticeNegative: Array.isArray(item.announcements) ? item.announcements.filter(row => row?.direction === "利空" || row?.direction === "多空交织").length : null,
    noticeRisk: Array.isArray(item.announcements) && item.announcements.some(row => (row?.risk ?? 0) >= 3)
  }));
}

/** 同花顺涨停原因按代码补到股票上（只用于给 AI 的输入）。 */
function withLimitReasons(picks, market) {
  const byCode = market?.byCode || {};
  return (Array.isArray(picks) ? picks : []).map(item => byCode[item?.code]?.reason ? { ...item, limitReason: byCode[item.code].reason } : item);
}

/** 把涨停生态（扶摇）整理成 AI 需要的市场背景。 */
function marketFromEcology(data) {
  if (!data?.available) return null;
  const limitUp = data.limitUp || {};
  return {
    limitUpCount: Number.isInteger(limitUp.count) ? limitUp.count : null,
    maxBoards: Number.isInteger(limitUp.maxBoards) ? limitUp.maxBoards : null,
    sealRatePct: Number.isFinite(data.sealRate) ? data.sealRate * 100 : null,
    limitBreakCount: Number.isInteger(data.limitBreak?.count) ? data.limitBreak.count : null,
    limitDownCount: Number.isInteger(data.limitDown?.count) ? data.limitDown.count : null,
    topReasons: (Array.isArray(limitUp.reasons) ? limitUp.reasons : []).slice(0, 8).map(item => `${item.reason}(${item.count})`),
    hotStocks: (data.hotLists?.day?.hot || data.hot || []).slice(0, 10).map(item => item.name),
    byCode: limitUp.byCode && typeof limitUp.byCode === "object" ? limitUp.byCode : {}
  };
}

module.exports = { createAiService, combineRankings, compactProfiles, marketFromEcology, isAiStore };
