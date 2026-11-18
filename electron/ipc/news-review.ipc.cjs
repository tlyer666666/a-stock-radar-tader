"use strict";

function registerNewsReviewIpc({
  handleTrustedIpc,
  aiPayload,
  readJson,
  normalizeHoldings,
  normalizeWatchlist,
  usableHoldings,
  usableWatchlist,
  settingsForService,
  getSectorStrengthBoard,
  getNewsFeed,
  resetNewsCache,
  buildNewsImpactPromptInput,
  aiService,
  getProfessionalReview,
  readExternalFactorStore,
  recordExternalFactorSnapshot,
  reviewWindows,
  searchSecurities,
  analyzeSecurity,
  getThemeMode
}) {
  handleTrustedIpc("review:get-market", async (_, options = {}) => {
    const review = await getProfessionalReview({
      ...options,
      settings: settingsForService()
    });
    if (typeof recordExternalFactorSnapshot === "function") recordExternalFactorSnapshot({ review });
    return review;
  });
  handleTrustedIpc("review:open-window", () => reviewWindows.open());
  for (const [channel, handler] of Object.entries({
    "review-window:search": (_, query) => searchSecurities(query),
    "review-window:analyze": (_, security, options = {}) =>
      analyzeSecurity(security, {
        ...settingsForService(),
        forceRefresh: options?.forceRefresh === true,
        externalFactorSnapshots: typeof readExternalFactorStore === "function"
          ? readExternalFactorStore().snapshots
          : undefined
      }),
    "review-window:market": async (_, options = {}) => {
      const review = await getProfessionalReview({ refresh: options?.refresh === true, settings: settingsForService() });
      if (typeof recordExternalFactorSnapshot === "function") recordExternalFactorSnapshot({ review });
      return review;
    },
    "review-window:theme": () => ({ theme: getThemeMode() })
  })) handleTrustedIpc(channel, handler, reviewWindows.getWebContents);

  const enrichNewsInput = input => {
    const raw = aiPayload(input);
    const holdings = Array.isArray(raw.holdings) ? raw.holdings : normalizeHoldings(readJson("holdings", [], usableHoldings));
    const watchlist = Array.isArray(raw.watchlist) ? raw.watchlist : normalizeWatchlist(readJson("watchlist", [], usableWatchlist));
    return { ...raw, holdings, watchlist };
  };
  const quickSectorStrength = () => Promise.race([
    getSectorStrengthBoard({ ...settingsForService(), forceRefresh: false }).catch(() => []),
    new Promise(resolve => setTimeout(() => resolve([]), 250))
  ]);
  const enrichNewsFeedContext = async input => {
    const base = enrichNewsInput(input);
    const sectorStrength = Array.isArray(base.sectorStrength) && base.sectorStrength.length
      ? base.sectorStrength
      : await quickSectorStrength();
    return { ...base, sectorStrength };
  };

  handleTrustedIpc("news:get-feed", async (_, input) =>
    getNewsFeed(await enrichNewsFeedContext(input), settingsForService())
  );
  handleTrustedIpc("news:refresh", async (_, input) => {
    resetNewsCache();
    return getNewsFeed(await enrichNewsFeedContext(input), settingsForService());
  });
  handleTrustedIpc("news:analyze-impact", async (_, input) => {
    const payload = aiPayload(input);
    if (!payload.item || typeof payload.item !== "object") {
      throw Object.assign(new TypeError("请提供要分析的资讯或公告条目"), { code: "INVALID_IPC_PAYLOAD" });
    }
    const base = enrichNewsInput(payload);
    const sectorStrength = Array.isArray(base.sectorStrength) && base.sectorStrength.length
      ? base.sectorStrength
      : await quickSectorStrength();
    const promptInput = buildNewsImpactPromptInput(payload.item, {
      holdings: base.holdings,
      watchlist: base.watchlist,
      favorites: base.favorites,
      sectorStrength
    });
    return aiService().analyzeNewsImpact(promptInput);
  });
}

module.exports = { registerNewsReviewIpc };
