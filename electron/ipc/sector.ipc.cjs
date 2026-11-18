"use strict";

function registerSectorIpc({
  handleTrustedIpc,
  settingsForService,
  recordExternalFactorSnapshot,
  getSectorClassifications,
  getSectorCatalog,
  getSectorQuotes,
  getSectorDetail,
  cancelSectorRequest,
  getLimitUpSectorBoard,
  getSectorStrengthBoard,
  getSectorLimitUpCount,
  searchSectors,
  getConceptChain,
  analyzeSector
}) {
  handleTrustedIpc("sector:classifications", (_, options = {}) => getSectorClassifications(options));
  handleTrustedIpc("sector:catalog", (_, options = {}) => getSectorCatalog(options));
  handleTrustedIpc("sector:quotes", (_, options = {}) => getSectorQuotes(options));
  handleTrustedIpc("sector:detail", (_, options = {}) => getSectorDetail(options));
  handleTrustedIpc("sector:cancel", (_, requestId) => cancelSectorRequest(requestId));
  handleTrustedIpc("market:limit-up-sectors", (_, options = {}) =>
    getLimitUpSectorBoard({
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true
    })
  );
  handleTrustedIpc("market:sector-strength", async (_, options = {}) => {
    const board = await getSectorStrengthBoard({ ...settingsForService(), forceRefresh: options?.forceRefresh === true });
    if (Array.isArray(board) && board.length && typeof recordExternalFactorSnapshot === "function") {
      recordExternalFactorSnapshot({ sectorBoard: board });
    }
    return board;
  });
  handleTrustedIpc("market:sector-limit-count", (_, input, options = {}) =>
    getSectorLimitUpCount(input, { forceRefresh: options?.forceRefresh === true })
  );
  handleTrustedIpc("market:search-sectors", (_, query) => searchSectors(query));
  handleTrustedIpc("market:concept-chain", (_, query) =>
    getConceptChain(query, settingsForService())
  );
  handleTrustedIpc("market:analyze-sector", (_, sector) =>
    analyzeSector(sector, settingsForService())
  );
}

module.exports = { registerSectorIpc };
