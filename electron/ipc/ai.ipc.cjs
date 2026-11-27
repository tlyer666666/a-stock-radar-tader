"use strict";

function registerAiIpc({
  handleTrustedIpc,
  aiPayload,
  aiService,
  aiProfiles,
  stockAgent,
  decisionSignals = null,
  rssFeeds = null,
  AI_CUSTOM_MAX,
  loadAiStockProfiles,
  latestDate,
  readAiCustomList,
  normalizeAiCustomItem,
  normalizeAiCustomItems,
  isAiCustomList,
  readAiFramework,
  normalizeFrameworkState,
  normalizeCustom,
  frameworkCatalog,
  isAiFrameworkState,
  writeJson,
  settingsForService,
  resolveTestSecret,
  sameOrigin,
  getProfessionalReview,
  recordExternalFactorSnapshot,
  createReviewSkills,
  getFuyaoReviewData,
  getSectorStrengthBoard,
  analyzeSector,
  situationOf,
  emitAiStream,
  setWorkspaceAgentSnapshot,
  serviceRequestRuntime = () => ({}),
  trackAbortableRequest = null
}) {
  const shanghaiToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const withAbortableRuntime = async (event, payload, fn) => {
    const baseRuntime = serviceRequestRuntime(event, payload) || {};
    if (baseRuntime.signal) return fn(baseRuntime);
    if (typeof trackAbortableRequest === "function") {
      const tracked = trackAbortableRequest(baseRuntime);
      const runtime = { ...baseRuntime, signal: tracked.signal };
      try {
        return await fn(runtime);
      } finally {
        tracked.cleanup();
      }
    }
    return fn(baseRuntime);
  };
  const reviewSnapshot = async () => {
    const review = await getProfessionalReview({ settings: settingsForService() });
    if (typeof recordExternalFactorSnapshot === "function") recordExternalFactorSnapshot({ review });
    return review;
  };
  const reviewSkillsFor = snapshot => createReviewSkills({
    loadFuyao: () => getFuyaoReviewData(),
    loadSectorBoard: () => getSectorStrengthBoard(settingsForService()),
    analyzeSector: name => analyzeSector({ name }, settingsForService()),
    loadProfiles: list => loadAiStockProfiles(list),
    previousReviews: count => aiService().recentMarketReviews(String(snapshot?.date || ""), count),
    situationOf
  });
  const interpretKind = kind => ["ecology", "failed-boards", "sectors"].includes(kind) ? kind : null;
  const interpretDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : shanghaiToday();

  handleTrustedIpc("ai:status", () => aiService().status());
  handleTrustedIpc("ai:rank", async (event, input) => {
    const raw = aiPayload(input);
    return withAbortableRuntime(event, raw, async (runtime) => {
      const picks = Array.isArray(raw.picks) ? raw.picks.slice(0, AI_CUSTOM_MAX) : [];
      const only = Array.isArray(raw.only) ? raw.only.map(String).filter(code => /^\d{6}$/.test(code)).slice(0, AI_CUSTOM_MAX) : null;
      const payload = { ...raw, picks, display: picks.map(item => String(item?.code || "")), ...(only ? { only } : {}) };
      const todo = new Set(aiService().pending("rank", payload));
      if (!todo.size) return aiService().cachedRank(payload) || aiService().rank(payload, runtime);
      const targets = picks.filter(item => todo.has(String(item?.code || "")));
      const { profiles } = await loadAiStockProfiles(targets, { signal: runtime?.signal }).catch(error => {
        if (error?.name === "AbortError" || runtime?.signal?.aborted) throw error;
        return { profiles: [] };
      });
      runtime?.signal?.throwIfAborted?.();
      const byCode = new Map(targets.map(item => [String(item?.code || ""), item]));
      const merged = profiles.map(profile => ({ ...profile, strategies: byCode.get(profile.code)?.strategies || [], notes: byCode.get(profile.code)?.notes || [] }));
      const profiled = new Set(merged.map(item => String(item.code)));
      const failed = merged.length ? targets.filter(item => !profiled.has(String(item?.code || ""))).map(item => String(item?.name || item?.code || "")) : [];
      const ranking = await aiService().rank({ ...payload, only: merged.length ? [...profiled] : [...todo], ...(merged.length ? { profiles: merged } : {}) }, runtime);
      return failed.length ? { ...ranking, failed } : ranking;
    });
  });

  handleTrustedIpc("ai:market-review", async (_, input) => {
    const snapshot = await reviewSnapshot();
    return aiService().marketReview({ snapshot, force: aiPayload(input).force === true, skills: reviewSkillsFor(snapshot), onProgress: emitAiStream });
  });
  handleTrustedIpc("ai:lookback", async (_, input) => aiService().lookback({ snapshot: await reviewSnapshot(), force: aiPayload(input).force === true }));
  handleTrustedIpc("ai:market-review-cached", (_, asOfDate) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || "")) ? String(asOfDate) : shanghaiToday();
    const previous = aiService().previousMarketReview(date);
    return { review: aiService().cachedMarketReview(date), lookback: aiService().cachedLookback(date), previousDate: previous?.asOfDate || "" };
  });
  handleTrustedIpc("ai:interpret", (_, input) => {
    const payload = aiPayload(input);
    const kind = interpretKind(payload.kind);
    if (!kind) throw Object.assign(new TypeError("不支持的解读类型"), { code: "INVALID_IPC_PAYLOAD" });
    return aiService().interpret({ kind, data: payload.data, asOfDate: interpretDate(payload.asOfDate), force: payload.force === true, onProgress: emitAiStream });
  });
  handleTrustedIpc("ai:interpret-cached", (_, input) => {
    const payload = aiPayload(input);
    const kind = interpretKind(payload.kind);
    return kind ? aiService().cachedInterpret(kind, interpretDate(payload.asOfDate)) : null;
  });
  handleTrustedIpc("ai:frameworks", () => frameworkCatalog(readAiFramework()));
  handleTrustedIpc("ai:framework-save", (_, input) => {
    const payload = aiPayload(input);
    const current = readAiFramework();
    const next = normalizeFrameworkState({
      v: 2,
      active: typeof payload.active === "string" ? payload.active : current.active,
      custom: payload.custom ? normalizeCustom(payload.custom) : current.custom
    });
    writeJson("ai-framework", next, isAiFrameworkState);
    return frameworkCatalog(next);
  });
  handleTrustedIpc("ai:summary", (_, input) => aiService().summary(aiPayload(input)));
  handleTrustedIpc("ai:cached", (_, input) => { const payload = aiPayload(input); return { rank: aiService().cachedRank(payload), summary: aiService().cachedSummary(payload) }; });
  handleTrustedIpc("ai:history", () => aiService().history());
  handleTrustedIpc("ai:outcomes-leaderboard", (_, input) => aiService().outcomesLeaderboard({ days: Number(aiPayload(input).days) || 30 }));
  handleTrustedIpc("ai:review", async (event, input) => {
    const payload = aiPayload(input);
    return withAbortableRuntime(event, payload, async (runtime) => {
      const { profiles, failed } = await loadAiStockProfiles([payload.security], { signal: runtime?.signal });
      runtime?.signal?.throwIfAborted?.();
      if (!profiles.length) throw new Error(failed.length ? `读取${failed[0]}日线失败，暂时无法点评，请稍后重试` : "请选择一只 A 股股票");
      const context = (Array.isArray(payload.context) ? payload.context : []).map(item => String(item || "").slice(0, 60)).filter(Boolean).slice(0, 8);
      return aiService().review({ asOfDate: profiles[0].asOfDate, profile: context.length ? { ...profiles[0], context } : profiles[0], force: payload.force === true }, runtime);
    });
  });
  handleTrustedIpc("ai:review-cached", (_, code) => /^\d{6}$/.test(String(code || "")) ? aiService().cachedReview(String(code)) : null);
  handleTrustedIpc("ai:custom-list", () => readAiCustomList());
  handleTrustedIpc("ai:custom-save", (_, items) => {
    const list = normalizeAiCustomItems(items);
    writeJson("ai-custom-stocks", { items: list }, isAiCustomList);
    return list;
  });
  handleTrustedIpc("ai:custom-mutate", (_, input) => {
    const payload = aiPayload(input);
    const adding = payload.kind === "add" && Array.isArray(payload.items);
    const removing = payload.kind === "remove" && Array.isArray(payload.codes);
    if (!adding && !removing) throw Object.assign(new TypeError("股票清单操作无效"), { code: "INVALID_IPC_PAYLOAD" });
    const list = readAiCustomList();
    const result = { list, added: 0, duplicate: 0, overflow: 0, removed: [] };
    if (adding) {
      const present = new Set(list.map(item => item.code));
      for (const raw of payload.items) {
        const item = normalizeAiCustomItem(raw);
        if (!item) continue;
        if (present.has(item.code)) { result.duplicate++; continue; }
        if (list.length >= AI_CUSTOM_MAX) { result.overflow++; continue; }
        present.add(item.code);
        list.push(item);
        result.added++;
      }
    } else {
      const codes = new Set(payload.codes.filter(code => typeof code === "string" && /^\d{6}$/.test(code)));
      result.removed = list.filter(item => codes.has(item.code));
      result.list = list.filter(item => !codes.has(item.code));
    }
    if (result.added || result.removed.length) writeJson("ai-custom-stocks", { items: result.list }, isAiCustomList);
    return result;
  });
  handleTrustedIpc("ai:custom-rank", async (event, input) => {
    const payload = aiPayload(input);
    return withAbortableRuntime(event, payload, async (runtime) => {
      const list = readAiCustomList();
      if (!list.length) throw new Error("先添加要打分的股票");
      const only = Array.isArray(payload.codes) ? new Set(payload.codes.map(String)) : null;
      const targets = only ? list.filter(item => only.has(item.code)) : list;
      if (!targets.length) throw new Error("勾选的股票不在清单里，请刷新后重试");
      const { profiles, failed } = await loadAiStockProfiles(targets, { signal: runtime?.signal });
      runtime?.signal?.throwIfAborted?.();
      if (!profiles.length) throw new Error(targets.length === 1 ? `${targets[0].name} 的日线没读到，请稍后重试` : "这些股票的日线都没读到，请稍后重试");
      const ranking = await aiService().rankCustom({ asOfDate: latestDate(profiles), profiles, display: list.map(item => item.code), force: payload.force === true }, runtime);
      return { ...ranking, failed };
    });
  });
  handleTrustedIpc("ai:custom-cached", () => aiService().cachedCustom(readAiCustomList().map(item => item.code)));
  handleTrustedIpc("ai:history-day", (_, asOfDate) => aiService().historyDayWithOutcomes(String(asOfDate || "").slice(0, 10)));
  handleTrustedIpc("ai:strategy-draft", (_, input) => aiService().draftStrategy(aiPayload(input)));
  handleTrustedIpc("ai:note-parse", (_, input) => {
    const payload = aiPayload(input);
    return aiService().parseNote({
      text: String(payload.text ?? "").slice(0, 600),
      now: String(payload.now ?? "").slice(0, 40),
      tradingDays: Array.isArray(payload.tradingDays) ? payload.tradingDays.slice(0, 15).map(day => String(day).slice(0, 10)) : []
    });
  });
  handleTrustedIpc("ai:profiles", () => aiProfiles().list());
  handleTrustedIpc("ai:profile-save", (_, input) => aiProfiles().save(aiPayload(input)));
  handleTrustedIpc("ai:profile-delete", (_, id) => aiProfiles().remove(String(id || "")));
  handleTrustedIpc("ai:profile-activate", (_, id) => aiProfiles().activate(String(id || "")));
  handleTrustedIpc("ai:rank-models", (_, ids) => aiProfiles().setRankIds(Array.isArray(ids) ? ids.slice(0, 8) : []));
  handleTrustedIpc("ai:test", (_, input) => {
    const payload = aiPayload(input);
    const saved = typeof payload.id === "string" && payload.id ? aiProfiles().resolve(payload.id) : null;
    return aiService().test({
      baseUrl: String(payload.baseUrl || ""),
      model: String(payload.model || ""),
      apiKey: resolveTestSecret(payload.apiKey, saved?.apiKey && sameOrigin(saved.baseUrl, payload.baseUrl) ? saved.apiKey : "")
    });
  });

  // AI 建议池：列表 + 统计；evaluate=true 时先补做事后验证（读日线，最多 60 只）。
  const signalList = async (input = {}, runtime = {}) => {
    const hub = decisionSignals?.();
    if (!hub) return { signals: [], stats: null, evaluation: null };
    let evaluation = null;
    if (input.evaluate === true) {
      try {
        evaluation = await hub.evaluatePending({ signal: runtime?.signal });
      } catch (error) {
        if (error?.name === "AbortError" || runtime?.signal?.aborted) throw error;
        evaluation = { evaluated: 0, failed: -1 };
      }
    }
    const status = ["active", "expired", "invalidated", "closed"].includes(input.status) ? input.status : "";
    const code = /^\d{6}$/.test(String(input.code || "")) ? String(input.code) : "";
    return { signals: hub.list({ status, code, limit: 300 }), stats: hub.stats(), evaluation };
  };
  // 自订资讯源（RSS / Atom）：list / save / remove / test。
  handleTrustedIpc("agent:feeds", async (_, input) => {
    const payload = aiPayload(input);
    const hub = rssFeeds?.();
    if (!hub) throw new Error("自订资讯源暂不可用");
    const op = String(payload.op || "list");
    if (op === "save") return hub.save({ id: payload.id, name: payload.name, url: payload.url, enabled: payload.enabled !== false });
    if (op === "remove") return hub.remove(String(payload.id || "").slice(0, 40));
    if (op === "test") return { ...hub.list(), test: await hub.test(String(payload.url || "")) };
    return hub.list();
  });
  handleTrustedIpc("agent:signals", (event, input) => {
    const payload = aiPayload(input);
    if (payload.evaluate === true) {
      return withAbortableRuntime(event, payload, runtime => signalList(payload, runtime));
    }
    return signalList(payload);
  });
  handleTrustedIpc("agent:signal-update", (_, input) => {
    const payload = aiPayload(input);
    const hub = decisionSignals?.();
    if (!hub) throw new Error("AI 建议池暂不可用");
    const id = String(payload.id || "").slice(0, 60);
    if (payload.remove === true) hub.remove(id);
    else hub.update(id, { ...(payload.status !== undefined ? { status: payload.status } : {}), ...(Object.hasOwn(payload, "feedback") ? { feedback: payload.feedback } : {}) });
    return signalList({});
  });
  handleTrustedIpc("agent:state", () => stockAgent().state());
  handleTrustedIpc("agent:conversation", (_, id) => stockAgent().conversation(String(id || "").slice(0, 80)));
  handleTrustedIpc("agent:start", (_, input) => {
    const payload = aiPayload(input);
    return stockAgent().start({
      message: typeof payload.message === "string" ? payload.message : "",
      title: typeof payload.title === "string" ? payload.title.slice(0, 16) : "",
      conversationId: typeof payload.conversationId === "string" ? payload.conversationId.slice(0, 80) : "",
      ...(Object.hasOwn(payload, "focus") ? { focus: payload.focus && typeof payload.focus === "object" ? { code: String(payload.focus.code || ""), name: String(payload.focus.name || ""), ...(["etf", "sector", "market"].includes(payload.focus.kind) ? { kind: payload.focus.kind } : {}) } : null } : {}),
      ...(Array.isArray(payload.skillIds) ? { skillIds: payload.skillIds.slice(0, 6).map(item => String(item).slice(0, 40)) } : {}),
      ...(payload.userContext && typeof payload.userContext === "object" && !Array.isArray(payload.userContext) ? { userContext: payload.userContext } : {}),
      allowPersonalContext: payload.allowPersonalContext !== false
    });
  });
  handleTrustedIpc("agent:poll", (_, runId) => stockAgent().poll(String(runId || "").slice(0, 80)));
  handleTrustedIpc("agent:cancel", (_, runId) => stockAgent().cancel(String(runId || "").slice(0, 80)));
  handleTrustedIpc("agent:delete", (_, id) => stockAgent().remove(String(id || "").slice(0, 80)));
  handleTrustedIpc("agent:settings", (_, input) => {
    const payload = aiPayload(input);
    return stockAgent().settings({
      ...(typeof payload.memory === "string" ? { memory: payload.memory } : {}),
      ...(typeof payload.profileId === "string" ? { profileId: payload.profileId.slice(0, 80) } : {}),
      ...(Array.isArray(payload.skillIds) ? { skillIds: payload.skillIds.slice(0, 6).map(item => String(item).slice(0, 40)) } : {})
    });
  });
  handleTrustedIpc("agent:skill-save", (_, input) => {
    const payload = aiPayload(input);
    return stockAgent().saveSkill({
      id: typeof payload.id === "string" ? payload.id.slice(0, 40) : "",
      name: String(payload.name ?? "").slice(0, 40),
      method: String(payload.method ?? "").slice(0, 2000),
      tools: Array.isArray(payload.tools) ? payload.tools.slice(0, 20).map(item => String(item).slice(0, 30)) : []
    });
  });
  handleTrustedIpc("agent:skill-delete", (_, id) => stockAgent().removeSkill(String(id || "").slice(0, 40)));
  handleTrustedIpc("agent:sync-workspace", (_, input) => {
    const payload = aiPayload(input);
    const clipList = (value, max = 20) => Array.isArray(value) ? value.slice(0, max).filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
    const snapshot = {
      tItems: clipList(payload.tItems, 12),
      plans: clipList(payload.plans, 20),
      paperPositions: clipList(payload.paperPositions, 16),
      notes: clipList(payload.notes, 20),
      updatedAt: new Date().toISOString()
    };
    setWorkspaceAgentSnapshot(snapshot);
    return { ok: true, updatedAt: snapshot.updatedAt };
  });
}

module.exports = { registerAiIpc };
