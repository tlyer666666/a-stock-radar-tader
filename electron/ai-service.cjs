"use strict";

/**
 * AI 助手服务：把 AI 客户端、选股提示词和本机缓存串起来，供主进程 IPC 调用。
 * - 同一数据日、同一模型、同一批股票的点评/总结会缓存（本机 userData/ai-selection.json），
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
const { credentialFingerprint } = require("./bounded-cache.cjs");
const { isOpeningLimitUpEntry } = require("./price-limit-rules.cjs");
const { priceBasisIssueAt } = require("./quant-history-safety.cjs");

const MAX_CACHE_ENTRIES = 150;

function isAiStore(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.entries);
}

function createAiService({ getConfig, getRankProfiles = null, getInstructions = () => ({}), getFramework = () => null, store = null, loadMarket = async () => null, resolveStock = null, evaluateOutcomes = null, fetchImpl, now = () => Date.now() } = {}) {
  const controller = new AbortController();
  const runtime = createServiceRuntime({ controller, jobOptions: { maxActive: 2, maxQueued: 4 } });
  // Two admitted calls can each score up to eight configured models. Shared
  // cache work needs its own producer scope, outside either caller's lifetime.
  const sharedRuntime = createServiceRuntime({ controller, jobOptions: { maxActive: 16, maxQueued: 0 } });
  const clientOptions = { getSignal: () => runtime.signal(), track: factory => runtime.track(factory), ...(fetchImpl ? { fetchImpl } : {}) };
  const clientFor = config => createAiClient({ ...clientOptions, getConfig: () => config });
  const activeConfig = () => { try { return getConfig() || {}; } catch { return {}; } };
  const cloneConfig = config => (config && typeof config === "object" ? { ...config } : {});
  const profileMeta = config => ({
    ...(config?.id ? { profileId: String(config.id) } : {}),
    ...(config?.name ? { profileName: String(config.name) } : {}),
    ...(config?.baseUrl ? { baseUrl: String(config.baseUrl) } : {})
  });
  const ai = createAiClient({ ...clientOptions, getConfig: activeConfig });
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
  const captureSnapshot = () => ({
    config: cloneConfig(activeConfig()),
    profiles: rankProfiles().map(cloneConfig),
    instructions: { rank: instructionsFor("rank"), summary: instructionsFor("summary") },
    framework: currentFramework()
  });
  const snapInstruction = (snap, kind) => (
    kind === "summary"
      ? (snap?.instructions?.summary ?? instructionsFor("summary"))
      : (snap?.instructions?.rank ?? instructionsFor("rank"))
  );
  const snapFramework = snap => snap?.framework ?? currentFramework();
  const scoringIdentity = config => credentialFingerprint(config.id, config.apiKey);
  // 旧打分仍可回看；实时打分只复用能确认属于当前模型配置和账户的结果。
  const cacheKey = (kind, input, config, snap = {}) => {
    const codes = sanitizePicks(input?.picks || input?.profiles || (input?.profile ? [input.profile] : [])).map(item => item.code).sort().join(",");
    const parts = [codes, config.baseUrl || "", snapInstruction(snap, kind)];
    if (kind === "summary") parts.push("");
    else parts.push(frameworkSignature(snapFramework(snap)), scoringIdentity(config));
    const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
    return `${kind}:${String(input?.asOfDate || "")}:${String(config.model || "")}:${digest}`;
  };

  async function marketContext() {
    let timer;
    try {
      return await Promise.race([runtime.track(() => loadMarket({ signal: runtime.signal() })), new Promise(resolve => { timer = setTimeout(() => resolve(null), 8000); timer.unref?.(); })]);
    } catch { runtime.checkpoint(); return null; }
    finally { clearTimeout(timer); }
  }

  async function cached(kind, input, config, produce, snap = {}) {
    const key = cacheKey(kind, input, config, snap);
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
  const produceFor = (kind, client, input, snap = {}) => {
    const selectionForRun = createAiSelection({ ai: client });
    const instructions = snapInstruction(snap, "rank");
    const framework = snapFramework(snap);
    return async market => {
      const recentLessons = (kind === "rank" || kind === "custom")
        ? await recentMissLessons(String(input?.asOfDate || ""), 4)
        : [];
      // 策略候选也带了日线体检数据时（桌面版），同样按框架打分；没有体检数据时退回按规则指标打分。
      if (kind === "custom" || (kind === "rank" && Array.isArray(input?.profiles) && input.profiles.length)) {
        const profiles = withLimitReasons(input?.profiles, market);
        return selectionForRun.rankProfiles({ ...input, profiles, market, instructions, framework, ...(recentLessons.length ? { recentLessons } : {}) }).then(value => ({ ...value, profiles: compactProfiles(profiles) }));
      }
      if (kind === "review") {
        const [profile] = withLimitReasons([input?.profile], market);
        return selectionForRun.reviewStock({ profile, market, instructions, framework }).then(value => ({ ...value, profile }));
      }
      return selectionForRun.rankPicks({ ...input, picks: withLimitReasons(input?.picks, market), market, instructions, ...(recentLessons.length ? { recentLessons } : {}) });
    };
  };
  const scoreOne = (kind, config, input, snap = {}) => {
    const produce = produceFor(kind, clientFor(config), input, snap);
    return cached(kind, input, config, async market => ({ ...(await produce(market)), ...profileMeta(config) }), snap);
  };

  /*
   * 打分榜（rank = 策略候选，custom = 我的股票）按类型、数据日、模型配置、账户、要求和分析框架区分，
   * 按股票逐只累积：只给勾选的几只打分时，结果并进同一张榜，其他股票之前的分数保留。
   * 不是「重新打分」时只给榜上还没有的股票打分。展示时只取当前清单里的股票。
   */
  const BOARD_KINDS = new Set(["rank", "custom"]);
  const BOARD_MAX_ITEMS = 120;
  const boardKey = (kind, asOfDate, config, snap = {}) => {
    const parts = ["board", config.baseUrl || "", snapInstruction(snap, "rank"), frameworkSignature(snapFramework(snap)), scoringIdentity(config)];
    const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
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
  function readBoard(kind, asOfDate, config, snap = {}) {
    const hit = readEntries().find(entry => entry.key === boardKey(kind, asOfDate, config, snap));
    return hit ? hit.value : null;
  }
  function mergeBoard(kind, asOfDate, config, run, snap = {}) {
    const base = readBoard(kind, asOfDate, config, snap);
    const fresh = new Set((run.items || []).map(item => item.code));
    const items = [...(run.items || []), ...(base?.items || []).filter(item => !fresh.has(item.code))].slice(0, BOARD_MAX_ITEMS);
    const keep = new Set(items.map(item => item.code));
    const freshProfiles = new Set((run.profiles || []).map(item => item.code));
    const profiles = [...(run.profiles || []), ...(base?.profiles || []).filter(item => !freshProfiles.has(item.code))].filter(item => keep.has(item.code));
    const { missed: _missed, cached: _cached, ...rest } = { ...(base || {}), ...run };
    writeEntry(boardKey(kind, asOfDate, config, snap), kind, { ...rest, ...profileMeta(config), asOfDate, items, evaluated: items.length, ...(profiles.length ? { profiles } : {}) });
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
  function pendingFor(kind, config, input, snap = {}) {
    const { list } = scoringTargets(input);
    if (input?.force === true) return list;
    const board = readBoard(kind, String(input?.asOfDate || ""), config, snap);
    // 按基础分兜底的（那一批 AI 没返回）不算打过分，下次不强制也会重试。
    const have = new Set((board?.items || []).filter(item => !baseOnly(item)).map(item => item.code));
    return list.filter(item => !have.has(String(item.code)));
  }
  async function scoreBoard(kind, config, input, snap = {}) {
    const asOfDate = String(input?.asOfDate || "");
    const display = displayCodes(input);
    const { profiled } = scoringTargets(input);
    const todo = pendingFor(kind, config, input, snap);
    if (!todo.length) {
      const board = boardView(readBoard(kind, asOfDate, config, snap), display);
      return board ? { ...board, cached: true } : { asOfDate, model: String(config.model || ""), generatedAt: new Date(now()).toISOString(), items: [], evaluated: 0, cached: true };
    }
    const key = `${boardKey(kind, asOfDate, config, snap)}#${todo.map(item => String(item.code)).sort().join(",")}`;
    const subset = profiled ? { ...input, profiles: todo } : { ...input, picks: todo };
    const run = await shared(key, async () => {
      const market = await marketContext();
      runtime.checkpoint();
      const run = await produceFor(kind, clientFor(config), subset, snap)(market);
      mergeBoard(kind, asOfDate, config, run, snap);
      return run;
    });
    runtime.checkpoint();
    const board = boardView(readBoard(kind, asOfDate, config, snap), display) || run;
    return { ...board, cached: false, ...(Number.isInteger(run.missed) && run.missed > 0 ? { missed: run.missed } : {}) };
  }

  async function scoreWithModels(kind, input, snap = {}) {
    const profiles = Array.isArray(snap?.profiles) && snap.profiles.length ? snap.profiles : rankProfiles();
    const score = BOARD_KINDS.has(kind) ? config => scoreBoard(kind, config, input, snap) : config => scoreOne(kind, config, input, snap);
    const settled = await Promise.allSettled(profiles.map(score));
    runtime.checkpoint();
    const results = settled.map((outcome, index) => ({ profile: profiles[index], outcome }));
    if (results.every(item => item.outcome.status === "rejected")) throw results[0].outcome.reason;
    return combineRankings(results, input);
  }
  const rank = (input, snap) => scoreWithModels("rank", input, snap);
  /** 哪些股票至少有一个模型还没打分（主进程据此只给这几只读日线）。 */
  const pending = (kind, input) => {
    const codes = new Set();
    for (const config of rankProfiles()) for (const item of pendingFor(kind, config, input)) codes.add(String(item.code));
    return [...codes];
  };

  function cachedScores(kind, input) {
    const read = BOARD_KINDS.has(kind)
      ? profile => { const view = boardView(readBoard(kind, String(input?.asOfDate || ""), profile), displayCodes(input)); return view?.items?.length ? { ...view, cached: true } : null; }
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
      for (const entry of entries) {
        if (entry.kind !== kind || !entry.value?.model) continue;
        const identity = entry.value.profileId || `${entry.value.model}:${entry.value.baseUrl || ""}`;
        if (!latest.has(identity)) latest.set(identity, entry.value);
      }
      const results = [...latest.values()].map(value => ({
        profile: {
          id: value.profileId || `${value.model}:${value.baseUrl || ""}`,
          name: value.profileName || value.model,
          model: value.model
        },
        outcome: { status: "fulfilled", value: { ...value, cached: true } }
      }));
      return results.length ? combineRankings(results, { asOfDate: date }) : null;
    };
    const summary = entries.find(entry => entry.kind === "summary")?.value || null;
    return { asOfDate: date, rank: replay("rank"), custom: replay("custom"), summary: summary ? { ...summary, cached: true } : null };
  }

  /** 带后验收益统计的历史复盘（T+1 / T+3 / T+5 本地收盘价对比，不触发网络下载）。 */
  async function evaluateCodesForDate(asOfDate, codes) {
    if (typeof evaluateOutcomes !== "function" || !codes.length) return {};
    const merged = {};
    for (let i = 0; i < codes.length; i += 40) {
      try {
        const part = await evaluateOutcomes(asOfDate, codes.slice(i, i + 40));
        if (part && typeof part === "object") Object.assign(merged, part);
      } catch {
        // 单批行情读取失败不影响整体统计
      }
    }
    return merged;
  }

  async function historyDayWithOutcomes(asOfDate) {
    const day = historyDay(asOfDate);
    if (typeof evaluateOutcomes !== "function" || (!day.rank?.items?.length && !day.custom?.items?.length)) return day;
    const codes = [...new Set([...(day.rank?.items || []), ...(day.custom?.items || [])].map(item => String(item?.code || "")).filter(code => /^\d{6}$/.test(code)))];
    if (!codes.length) return day;
    const map = await evaluateCodesForDate(day.asOfDate, codes);
    const enrichBoard = board => {
      if (!board?.items?.length) return board;
      const items = board.items.map(item => map[item.code] ? { ...item, outcome: map[item.code] } : item);
      const outcomeSummary = summarizeOutcomes(items);
      return { ...board, items, ...(outcomeSummary ? { outcomeSummary } : {}) };
    };
    return { ...day, rank: enrichBoard(day.rank), custom: enrichBoard(day.custom) };
  }

  function isMissOutcome(item, outcome) {
    if (!outcome) return false;
    const score = Number(item?.score);
    if (!Number.isFinite(score) || score < 75) return false;
    if (outcome.stopHit === true) return true;
    if (Number.isFinite(outcome.t3)) return outcome.t3 < -3;
    if (Number.isFinite(outcome.t1)) return outcome.t1 < -4;
    return false;
  }

  async function collectOutcomeStats({ days = 30, beforeDate = "", maxDates = 60 } = {}) {
    const entries = readEntries();
    const cycleByDate = new Map();
    for (const entry of entries) {
      if (entry.kind !== "market") continue;
      const date = String(entry.value?.asOfDate || "");
      if (date && !cycleByDate.has(date)) cycleByDate.set(date, String(entry.value?.cycle?.phase || "未知"));
    }
    const selectionEntries = entries.filter(entry =>
      (entry.kind === "rank" || entry.kind === "custom")
      && /^\d{4}-\d{2}-\d{2}$/.test(String(entry.value?.asOfDate || ""))
      && (!beforeDate || String(entry.value.asOfDate) < beforeDate)
      && Array.isArray(entry.value?.items)
      && entry.value.items.length
    );
    const limitDays = Math.max(1, Math.min(maxDates, Number(days) || 30));
    const dates = [...new Set(selectionEntries.map(entry => String(entry.value.asOfDate)))].sort().reverse().slice(0, limitDays);
    const dateSet = new Set(dates);
    const targetEntries = selectionEntries.filter(entry => dateSet.has(String(entry.value.asOfDate)));

    const outcomesByDate = new Map();
    if (typeof evaluateOutcomes === "function") {
      await Promise.all(dates.map(async date => {
        const codes = [...new Set(targetEntries
          .filter(entry => entry.value.asOfDate === date)
          .flatMap(entry => (entry.value.items || []).map(item => String(item?.code || "")))
          .filter(code => /^\d{6}$/.test(code)))];
        if (!codes.length) return;
        outcomesByDate.set(date, await evaluateCodesForDate(date, codes));
      }));
    }

    const bucketMap = () => new Map();
    const byModel = bucketMap();
    const byFramework = bucketMap();
    const byCycle = bucketMap();
    const recordBucket = (map, key, label, sublabel, sample, miss, highScoreEvaluatedInc, totalInc) => {
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { key, label, sublabel, samples: [], totalScored: 0, highScoreEvaluated: 0, highScoreMisses: 0 };
        map.set(key, bucket);
      }
      bucket.totalScored += totalInc;
      bucket.highScoreEvaluated += highScoreEvaluatedInc;
      if (sample) bucket.samples.push(sample);
      if (miss) bucket.highScoreMisses += 1;
    };

    const missByKey = new Map();
    const seenScoredItems = new Set();
    let evaluatedSamples = 0;
    const orderedTargetEntries = [...targetEntries].sort((a, b) =>
      String(b.savedAt || "").localeCompare(String(a.savedAt || ""))
    );

    for (const entry of orderedTargetEntries) {
      const value = entry.value || {};
      const asOfDate = String(value.asOfDate || "");
      const outcomeMap = outcomesByDate.get(asOfDate) || {};
      const modelLabel = String(value.profileName || value.model || "未命名模型");
      const modelSub = value.profileName && value.model && value.profileName !== value.model ? String(value.model) : "";
      const frameworkLabel = String(value.framework?.name || "经典评分框架");
      const frameworkId = String(value.framework?.id || "default");
      const cycleLabel = cycleByDate.get(asOfDate) || "未市场复盘";

      for (const item of value.items || []) {
        if (!item || item.fallback) continue;
        const code = String(item.code || "");
        if (!/^\d{6}$/.test(code)) continue;
        const score = Number(item.score);
        if (!Number.isFinite(score)) continue;
        const itemDedupeKey = `${entry.kind}:${asOfDate}:${modelLabel}:${frameworkId}:${code}`;
        if (seenScoredItems.has(itemDedupeKey)) continue;
        seenScoredItems.add(itemDedupeKey);
        const isBullish = score >= 70 || item.rating === "重点关注" || item.rating === "关注";
        const outcome = outcomeMap[code] || null;
        const hasOutcome = Boolean(outcome && (outcome.t1 !== null || outcome.t3 !== null || outcome.t5 !== null));
        const highScoreEvaluatedInc = score >= 75 && hasOutcome ? 1 : 0;
        const miss = isMissOutcome(item, outcome);
        const sample = isBullish && hasOutcome ? { code, outcome } : null;
        if (sample) evaluatedSamples += 1;

        recordBucket(byModel, modelLabel, modelLabel, modelSub, sample, miss, highScoreEvaluatedInc, 1);
        recordBucket(byFramework, `${frameworkId}:${frameworkLabel}`, frameworkLabel, "", sample, miss, highScoreEvaluatedInc, 1);
        recordBucket(byCycle, cycleLabel, cycleLabel, "", sample, miss, highScoreEvaluatedInc, 1);

        if (miss) {
          const dedupeKey = `${asOfDate}:${code}`;
          const prev = missByKey.get(dedupeKey);
          if (!prev || score > prev.score) {
            const retText = Number.isFinite(outcome.t3) ? `T+3 ${outcome.t3 >= 0 ? "+" : ""}${outcome.t3}%` : `T+1 ${outcome.t1 >= 0 ? "+" : ""}${outcome.t1}%`;
            const ddText = Number.isFinite(outcome.maxDrawdownPct) ? ` / 最大回撤${outcome.maxDrawdownPct}%${outcome.stopHit ? "(触止损)" : ""}` : "";
            const hint = String(item.risks || item.highlights || "").replace(/\s+/g, " ").trim().slice(0, 34);
            const lesson = `${asOfDate} ${String(item.name || code)}(${code}) ${modelLabel}给出${Math.round(score)}分[${cycleLabel}]后${retText}${ddText}${hint ? ` · 当时提示：${hint}` : ""}`;
            missByKey.set(dedupeKey, {
              asOfDate,
              code,
              name: String(item.name || code),
              score: Math.round(score),
              rating: String(item.rating || ""),
              model: modelLabel,
              framework: frameworkLabel,
              cycle: cycleLabel,
              t1: outcome.t1 ?? null,
              t3: outcome.t3 ?? null,
              t5: outcome.t5 ?? null,
              maxDrawdownPct: Number.isFinite(outcome.maxDrawdownPct) ? outcome.maxDrawdownPct : null,
              stopHit: Boolean(outcome.stopHit),
              lesson
            });
          }
        }
      }
    }

    const finalizeBuckets = map => [...map.values()]
      .map(bucket => {
        const stats = summarizeOutcomes(bucket.samples);
        const evaluatedCount = bucket.samples.length;
        return {
          key: bucket.key,
          label: bucket.label,
          ...(bucket.sublabel ? { sublabel: bucket.sublabel } : {}),
          totalScored: bucket.totalScored,
          sampleCount: evaluatedCount,
          highScoreMisses: bucket.highScoreMisses,
          missRatePct:
            bucket.highScoreEvaluated > 0
              ? Math.round((bucket.highScoreMisses / bucket.highScoreEvaluated) * 100)
              : evaluatedCount > 0
                ? 0
                : null,
          avgDrawdownPct: stats?.avgDrawdownPct ?? null,
          stopHits: stats?.stopHits ?? 0,
          stopHitRatePct: stats?.stopHitRatePct ?? null,
          t1: stats?.t1 || null,
          t3: stats?.t3 || null,
          t5: stats?.t5 || null
        };
      })
      .sort((a, b) => (b.t3?.winRatePct ?? b.t1?.winRatePct ?? -1) - (a.t3?.winRatePct ?? a.t1?.winRatePct ?? -1) || b.sampleCount - a.sampleCount);

    const recentMisses = [...missByKey.values()]
      .sort((a, b) => b.asOfDate.localeCompare(a.asOfDate) || b.score - a.score)
      .slice(0, 6);
    const recentLessons = recentMisses.slice(0, 4).map(item => item.lesson);

    const lookbacks = entries.filter(entry => entry.kind === "lookback" && entry.value);
    const hitRates = lookbacks.map(entry => Number(entry.value.hitRatePct)).filter(Number.isFinite);
    const lookbackLessons = [...new Set(lookbacks.flatMap(entry => Array.isArray(entry.value.lessons) ? entry.value.lessons : []).map(item => String(item || "").trim()).filter(Boolean))].slice(0, 4);

    return {
      daysCovered: dates.length,
      evaluatedSamples,
      byModel: finalizeBuckets(byModel),
      byFramework: finalizeBuckets(byFramework),
      byCycle: finalizeBuckets(byCycle),
      recentMisses,
      recentLessons,
      lookbackStats: {
        count: lookbacks.length,
        avgHitRatePct: hitRates.length ? Math.round((hitRates.reduce((s, n) => s + n, 0) / hitRates.length) * 10) / 10 : null,
        recentLessons: lookbackLessons
      }
    };
  }

  async function recentMissLessons(beforeDate = "", limit = 4) {
    if (typeof evaluateOutcomes !== "function") return [];
    const hasHistory = readEntries().some(entry =>
      (entry.kind === "rank" || entry.kind === "custom")
      && /^\d{4}-\d{2}-\d{2}$/.test(String(entry.value?.asOfDate || ""))
      && (!beforeDate || String(entry.value.asOfDate) < beforeDate)
    );
    if (!hasHistory) return [];
    try {
      const board = await collectOutcomeStats({ days: 20, beforeDate });
      return board.recentLessons.slice(0, limit);
    } catch {
      return [];
    }
  }

  // AI 复盘（市场复盘、回看、页面解读）：用「总结用」的那套模型；按 类型 + 数据日 + 模型 + 要求 保存，同一天只保留最新一次。
  const reviewKey = (kind, asOfDate, config, extra = "", instructions = instructionsFor("summary")) => {
    const digest = createHash("sha256").update(JSON.stringify([config.baseUrl || "", instructions, extra])).digest("hex").slice(0, 12);
    return `${kind}:${asOfDate}:${String(config.model || "")}:${digest}`;
  };
  const keyedCacheKey = (kind, asOfDate, extra = "", snap = {}) => {
    const config = snap?.config || activeConfig();
    const instructions = snapInstruction(snap, "summary");
    return { config, instructions, key: reviewKey(kind, asOfDate, config, extra, instructions) };
  };
  async function keyedReview(kind, asOfDate, extra, force, produce, snap = {}) {
    const { config, instructions, key } = keyedCacheKey(kind, asOfDate, extra, snap);
    if (!force) { const hit = readEntries().find(entry => entry.key === key); if (hit) return { ...hit.value, cached: true }; }
    return shared(key, async () => {
      const value = await produce(createAiReview({ ai: clientFor(config) }), instructions);
      writeEntry(reviewKey(kind, value.asOfDate || asOfDate, config, extra, instructions), kind, value);
      return { ...value, cached: false };
    });
  }
  const cachedKeyed = (kind, asOfDate, extra = "", snap = {}) => {
    const { key } = keyedCacheKey(kind, asOfDate, extra, snap);
    const hit = readEntries().find(entry => entry.key === key);
    return hit ? { ...hit.value, cached: true } : null;
  };
  /** 最近一次（数据日早于 beforeDate）的 AI 市场复盘，任何模型都算；给「回看」用。 */
  const previousMarketReview = beforeDate => readEntries().filter(entry => entry.kind === "market" && String(entry.value?.asOfDate || "") < String(beforeDate || ""))
    .sort((a, b) => String(b.value.asOfDate).localeCompare(String(a.value.asOfDate)) || String(b.savedAt || "").localeCompare(String(a.savedAt || "")))[0]?.value || null;

  const latestLookbackForReview = (reviewDate) => readEntries()
    .filter(entry => entry.kind === "lookback" && String(entry.value?.previousDate || "") === String(reviewDate || ""))
    .sort((a, b) => String(b.value?.asOfDate || "").localeCompare(String(a.value?.asOfDate || "")) || String(b.savedAt || "").localeCompare(String(a.savedAt || "")))[0]?.value || null;

  const latestLookbackUpTo = (asOfDate) => readEntries()
    .filter(entry => entry.kind === "lookback" && String(entry.value?.asOfDate || "") <= String(asOfDate || "9999") && (entry.value?.lessons?.length || entry.value?.summary))
    .sort((a, b) => String(b.value?.asOfDate || "").localeCompare(String(a.value?.asOfDate || "")) || String(b.savedAt || "").localeCompare(String(a.savedAt || "")))[0]?.value || null;

  const service = {
    // skills：复盘技能（由主进程按当次数据源创建）；有技能时 AI 会自主调用技能再写复盘。
    marketReview: ({ snapshot, force, skills, onProgress } = {}, snap) => keyedReview("market", String(snapshot?.date || ""), "", force === true,
      async (review, instructions) => {
        const lb = snapshot && !snapshot.previousLookback ? latestLookbackUpTo(snapshot?.date) : null;
        const recentSelectionLessons = snapshot && !snapshot.recentSelectionLessons ? await recentMissLessons(String(snapshot?.date || ""), 4) : [];
        const enriched = snapshot && (lb || recentSelectionLessons.length) ? {
          ...snapshot,
          ...(lb ? { previousLookback: { date: lb.asOfDate, hitRatePct: lb.hitRatePct, summary: lb.summary, lessons: lb.lessons } } : {}),
          ...(recentSelectionLessons.length ? { recentSelectionLessons } : {})
        } : snapshot;
        return review.marketReview({ snapshot: enriched, instructions, skills, onProgress });
      }, snap),
    outcomesLeaderboard: ({ days = 30 } = {}) => collectOutcomeStats({ days }),
    analyzeNewsImpact: async (payload = {}, snap = {}) => {
      const config = snap?.config || activeConfig();
      const system = `你是A股投研与公告影响拆解助手。根据给定的资讯或公告原文摘要、关联行业、软件提取的持仓/自选交集与当前板块强度，输出客观、简明的结构化影响拆解。
要求：
- 只根据输入事实与行业逻辑推理，不要编造财务数据或未出现的消息。
- headline：一句话结论（≤50字）；impactLevel 只能是 高/中/低；direction 只能是 利好/利空/多空交织/中性。
- supplyChain：upstream 上游环节/概念，downstream 下游应用/客户，peers 中游同业对照（每组最多4条，每条≤28字）。
- portfolioExposure：明确指出与用户持仓/自选/关注板块的关联与传导风险（最多4条，每条≤45字）。
- actionWatch：次日盘面重点验证信号（最多3条，每条≤40字）。不给买卖指令或仓位。
只输出 JSON：{"headline":"…","impactLevel":"中","direction":"多空交织","supplyChain":{"upstream":["…"],"downstream":["…"],"peers":["…"]},"portfolioExposure":["…"],"actionWatch":["…"]}`;
      const result = await clientFor(config).chat({
        system,
        user: JSON.stringify(payload || {}),
        json: true,
        temperature: 0.25,
        maxTokens: 1200,
        signal: runtime.signal()
      });
      const cleanList = (arr, limit = 4, maxLen = 40) =>
        (Array.isArray(arr) ? arr : [])
          .map(v => String(v || "").replace(/\s+/g, " ").trim().slice(0, maxLen))
          .filter(Boolean)
          .slice(0, limit);
      const impactLevel = ["高", "中", "低"].includes(result?.impactLevel) ? result.impactLevel : "中";
      const direction = ["利好", "利空", "多空交织", "中性"].includes(result?.direction) ? result.direction : "中性";
      return {
        headline: String(result?.headline || "").replace(/\s+/g, " ").trim().slice(0, 60) || String(payload?.title || "").slice(0, 40),
        impactLevel,
        direction,
        supplyChain: {
          upstream: cleanList(result?.supplyChain?.upstream, 4, 28),
          downstream: cleanList(result?.supplyChain?.downstream, 4, 28),
          peers: cleanList(result?.supplyChain?.peers, 4, 28)
        },
        portfolioExposure: cleanList(result?.portfolioExposure, 4, 48),
        actionWatch: cleanList(result?.actionWatch, 3, 42),
        model: String(config.name || config.model || "")
      };
    },
    /** 数据日早于 beforeDate 的最近几次 AI 市场复盘（复盘技能「历次复盘」用，附带对应回看准确率与经验教训）。 */
    recentMarketReviews: (beforeDate, count = 3) => {
      const seen = new Set();
      return readEntries().filter(entry => entry.kind === "market" && String(entry.value?.asOfDate || "") < String(beforeDate || "9999"))
        .sort((a, b) => String(b.value.asOfDate).localeCompare(String(a.value.asOfDate)) || String(b.savedAt || "").localeCompare(String(a.savedAt || "")))
        .filter(entry => !seen.has(entry.value.asOfDate) && seen.add(entry.value.asOfDate)).slice(0, Math.max(1, Math.min(5, count))).map(entry => {
          const lb = latestLookbackForReview(entry.value.asOfDate);
          if (!lb) return entry.value;
          return {
            ...entry.value,
            ...(Number.isFinite(lb.hitRatePct) ? { lookbackHitRatePct: lb.hitRatePct } : {}),
            ...(Array.isArray(lb.lessons) && lb.lessons.length ? { lookbackLessons: lb.lessons.slice(0, 3) } : {})
          };
        });
    },
    cachedMarketReview: asOfDate => cachedKeyed("market", String(asOfDate || "")),
    lookback: ({ snapshot, force } = {}, snap) => {
      const date = String(snapshot?.date || "");
      const previous = previousMarketReview(date);
      return keyedReview("lookback", date, String(previous?.asOfDate || ""), force === true, review => review.lookback({ previous, snapshot }), snap);
    },
    cachedLookback: asOfDate => cachedKeyed("lookback", String(asOfDate || ""), String(previousMarketReview(asOfDate)?.asOfDate || "")),
    previousMarketReview,
    interpret: ({ kind, data, asOfDate, force, onProgress } = {}, snap) => keyedReview(`interpret-${kind}`, String(asOfDate || ""), "", force === true,
      (review, instructions) => review.interpret({ kind, data, asOfDate, instructions, onProgress }), snap),
    cachedInterpret: (kind, asOfDate) => cachedKeyed(`interpret-${kind}`, String(asOfDate || "")),
    history,
    historyDay,
    historyDayWithOutcomes,
    status: () => {
      const config = activeConfig();
      return { configured: ai.configured(), model: ai.model(), profile: String(config.name || ""), rankModels: rankProfiles().map(item => String(item.name || item.model || "")), framework: currentFramework().name };
    },
    rank,
    rankCustom: (input, snap) => scoreWithModels("custom", input, snap),
    pending,
    review: (input, snap) => scoreWithModels("review", input, snap),
    cachedCustom: codes => latestCached("custom", codes),
    cachedReview: code => latestCached("review", [code]),
    summary: (input, snap) => {
      const config = snap?.config || activeConfig();
      const instructions = snapInstruction(snap, "summary");
      const selectionForRun = createAiSelection({ ai: clientFor(config) });
      return cached("summary", input, config, market => selectionForRun.dailySummary({ ...input, picks: withLimitReasons(input?.picks, market), market, instructions }), snap);
    },
    cachedRank,
    cachedSummary: input => cachedOnly("summary", input, activeConfig()),
    draftStrategy: (input, snap) => createAiSelection({ ai: clientFor(snap?.config || activeConfig()) }).draftStrategy(input),
    parseNote: (input, snap) => createNoteParser({ ai: clientFor(snap?.config || activeConfig()), resolveStock }).parseNote(input),
    /** 设置页「测试 AI 连接」：用草稿里的地址、模型、Key 发一条极短的请求。 */
    async test(config) {
      const probe = clientFor(config);
      const started = now();
      const result = await probe.chat({ system: "只输出 JSON。", user: "返回 {\"ok\":true}", json: true, maxTokens: 20 });
      return { ok: result?.ok === true || Boolean(result), latency: Math.max(0, now() - started), model: probe.model() };
    }
  };
  for (const method of ["rank", "rankCustom", "review", "summary", "marketReview", "lookback", "interpret", "draftStrategy", "parseNote", "analyzeNewsImpact", "test"]) {
    const produce = service[method];
    service[method] = (input, request = {}) => {
      let snap, key;
      try {
        snap = captureSnapshot();
        key = semanticKey({ method, input, config: snap.config, profiles: snap.profiles,
          instructions: snap.instructions, framework: frameworkSignature(snap.framework) });
      } catch (error) { return Promise.reject(error); }
      const runtimeRequest = request && typeof request === "object"
        ? {
            ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
            ...(request.owner !== undefined ? { owner: request.owner } : {}),
            ...(request.signal !== undefined ? { signal: request.signal } : {}),
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
          }
        : {};
      return runtime.run("scan", key, runtimeRequest, async () => {
        runtime.checkpoint();
        const value = await produce(input, snap);
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

/** Calculate T+1/T+3/T+5 returns and 5-day max drawdown / -7% stop trigger from OHLC rows. */
function evaluateRowsOutcome(rows, asOfDate, code = "", name = "") {
  const date = String(asOfDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(rows) || !rows.length) return null;
  const idx = rows.findIndex(row => row?.date === date);
  if (idx < 0 || idx + 1 >= rows.length) return null;
  const base = rows[idx];
  const baseClose = Number(base?.close);
  if (!Number.isFinite(baseClose) || baseClose <= 0) return null;
  const entry = rows[idx + 1];
  if (isOpeningLimitUpEntry(base.close, entry, code, name)) return null;
  let maxValidOffset = 0;
  for (let offset = 1; offset <= 5 && idx + offset < rows.length; offset += 1) {
    if (priceBasisIssueAt(rows, idx + offset, code, name || code)) break;
    maxValidOffset = offset;
  }
  if (maxValidOffset < 1) return null;
  const pctAt = offset => {
    if (offset > maxValidOffset) return null;
    const target = rows[idx + offset];
    const close = Number(target?.close);
    return Number.isFinite(close) ? Math.round(((close / baseClose) - 1) * 10000) / 100 : null;
  };
  const t1 = pctAt(1), t3 = pctAt(3), t5 = pctAt(5);
  if (t1 === null && t3 === null && t5 === null) return null;
  const lowPcts = rows
    .slice(idx + 1, idx + 1 + maxValidOffset)
    .map(row => {
      const low = Number(row?.low);
      const ref = Number.isFinite(low) && low > 0 ? low : Number(row?.close);
      return Number.isFinite(ref) ? Math.round(((ref / baseClose) - 1) * 10000) / 100 : null;
    })
    .filter(Number.isFinite);
  const maxDrawdownPct = lowPcts.length ? Math.min(0, Math.min(...lowPcts)) : null;
  const stopHit = maxDrawdownPct !== null ? maxDrawdownPct <= -7 : false;
  return { t1, t3, t5, maxDrawdownPct, stopHit, baseClose, asOfDate: date, latestDate: String(rows.at(-1)?.date || "") };
}

function summarizeOutcomes(items) {
  const evaluated = (items || []).filter(item => item?.outcome && (item.outcome.t1 !== null || item.outcome.t3 !== null || item.outcome.t5 !== null));
  if (!evaluated.length) return null;
  const rate = key => {
    const rows = evaluated.filter(item => Number.isFinite(item.outcome[key]));
    if (!rows.length) return null;
    const wins = rows.filter(item => item.outcome[key] > 0).length;
    return {
      count: rows.length,
      wins,
      winRatePct: Math.round((wins / rows.length) * 100),
      avgPct: Math.round((rows.reduce((sum, item) => sum + item.outcome[key], 0) / rows.length) * 100) / 100
    };
  };
  const drawdownRows = evaluated.filter(item => Number.isFinite(item.outcome.maxDrawdownPct));
  const avgDrawdownPct = drawdownRows.length
    ? Math.round((drawdownRows.reduce((sum, item) => sum + item.outcome.maxDrawdownPct, 0) / drawdownRows.length) * 100) / 100
    : null;
  const stopRows = drawdownRows.length
    ? drawdownRows
    : evaluated.filter(item => typeof item.outcome.stopHit === "boolean");
  const stopHits = stopRows.filter(item => item.outcome.stopHit === true || (Number.isFinite(item.outcome.maxDrawdownPct) && item.outcome.maxDrawdownPct <= -7)).length;
  const stopHitRatePct = stopRows.length ? Math.round((stopHits / stopRows.length) * 100) : null;
  return { evaluatedCount: evaluated.length, t1: rate("t1"), t3: rate("t3"), t5: rate("t5"), avgDrawdownPct, stopHits, stopHitRatePct };
}

function buildDisagreementDetail(answered, spread) {
  if (spread < 20 || answered.length < 2) return undefined;
  const sorted = [...answered].sort((a, b) => b.item.score - a.item.score);
  const bull = sorted[0], bear = sorted[sorted.length - 1];
  const bullReason = String(bull.item.highlights || bull.item.reason || "暂无亮点").slice(0, 80);
  const bearReason = String(bear.item.risks || bear.item.reason || "暂无风险").slice(0, 80);
  const nextTriggerRaw = String(bull.item.nextDay || bear.item.nextDay || bear.item.keyLevels || bull.item.keyLevels || "").trim();
  const verificationPoint = nextTriggerRaw
    ? `次日核心验证点：${nextTriggerRaw.slice(0, 72)}（未确认前按关键位防守）`
    : `次日核心验证点：观察早盘量能与关键支撑承接，分歧 ${spread} 分未收敛前不盲目追高`;
  return {
    spread,
    highest: { model: bull.model.name, score: bull.item.score, rating: bull.item.rating, thesis: bullReason, highlights: bullReason },
    lowest: { model: bear.model.name, score: bear.item.score, rating: bear.item.rating, thesis: bearReason, risks: bearReason },
    verificationPoint,
    summary: `看多(${bull.model.name} ${bull.item.score}分)：${bullReason}；谨慎(${bear.model.name} ${bear.item.score}分)：${bearReason}`
  };
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
    const disagreementDetail = buildDisagreementDetail(answered, spread);
    const extras = Object.fromEntries(["trend", "volume", "keyLevels", "reason", "framework", "orchestration"]
      .filter(key => typeof primary[key] === "string").map(key => [key, primary[key]]));
    for (const key of ["plays", "situation"]) if (Array.isArray(primary[key])) extras[key] = primary[key];
    if (bases.length) Object.assign(extras, { base: Math.round(bases.reduce((sum, value) => sum + value, 0) / bases.length), dims: primary.dims || [] });
    return { code: primary.code, name: primary.name, score, rating: ratingFor(score),
      highlights: primary.highlights, risks: primary.risks, nextDay: primary.nextDay, ...extras, caps,
      ...(Number.isFinite(extras.base) ? { adjust: score - extras.base } : {}), ...(!answered.length ? { fallback: true } : {}),
      scores, spread, disagreement: spread >= 20, ...(disagreementDetail ? { disagreementDetail } : {}) };
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

module.exports = { createAiService, combineRankings, compactProfiles, marketFromEcology, isAiStore, evaluateRowsOutcome };
