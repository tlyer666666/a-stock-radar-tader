const assert = require("node:assert/strict");
const {
  analyzeSector,
  discoverLimitUps,
  getDataFederation,
  getLimitUpSectorBoard
} = require("../electron/services.cjs");

async function main() {
  const options = {
    provider: "ths",
    fallbackEnabled: true,
    multiSourceEnabled: true,
    forceRefresh: true
  };
  const poolResult = await discoverLimitUps(options);
  const pool = poolResult?.rows;
  const poolMeta = poolResult?.meta;
  assert.ok(Array.isArray(pool), "limit-up pool must be an array");
  assert.ok(poolMeta && typeof poolMeta === "object", "pool metadata must be present even when rows are empty");
  assert.match(String(poolMeta.dataDate || ""), /^\d{4}-\d{2}-\d{2}$/, "pool must expose a confirmed trading date");
  assert.ok(Number.isFinite(Date.parse(poolMeta.fetchedAt)), "pool fetch time must be valid");
  assert.ok(Array.isArray(poolMeta.providers), "pool providers must be explicit");
  assert.ok(poolMeta.providers.includes("ths_public_limit_up"), "THS must remain the primary pool source");
  assert.ok(poolMeta.providers.includes("eastmoney_topic_pool"), "Eastmoney must visibly cross-check the pool");
  assert.equal(new Set(pool.map((item) => item.code)).size, pool.length, "pool codes must be unique");
  assert.ok(pool.every((item) => /^\d{6}$/.test(String(item.code || ""))), "every pool row must contain a valid code");

  const populated = pool.filter((item) =>
    Number(item.amount) > 0 &&
    Number(item.floatMarketCap) > 0 &&
    item.industry &&
    item.industry !== "未分类"
  );
  let sectorRows = [];
  let sector = null;
  if (pool.length > 0) {
    assert.ok(populated.length >= Math.ceil(pool.length * 0.8), "cross-source enrichment must cover most rows");
    sectorRows = await getLimitUpSectorBoard(options);
    assert.ok(Array.isArray(sectorRows) && sectorRows.length > 0, "a non-empty pool must produce sector rows");
    assert.ok(
      sectorRows.every((item) => item.state !== "实时详情降级"),
      "the obsolete one-source degradation state must never return"
    );
    assert.ok(
      sectorRows.every((item) => item.providerPriority?.[0] === "同花顺 QuantAPI"),
      "THS must be declared as the sector primary source"
    );
    for (const item of sectorRows.filter((row) => row.state === "详情源暂不可用")) {
      assert.equal(item.score, null, "all-source failure must pause scoring instead of inventing a score");
      assert.deepEqual(item.returns, { r1: null, r3: null, r5: null }, "missing returns must stay unknown");
    }
    const sectorName = sectorRows[0]?.name || populated[0]?.industry;
    sector = await analyzeSector(sectorName, options);
    assert.ok(sector?.name, "sector analysis must resolve without a ReferenceError");
    assert.ok(Array.isArray(sector.constituents), "sector analysis must contain constituents");
  }

  const federationTarget = pool[0] || {
    code: "600519",
    name: "贵州茅台",
    secid: "1.600519",
    thscode: "600519.SH",
    assetType: "stock"
  };
  const federation = await getDataFederation(federationTarget, options);
  const healthyQuotes = (federation?.sources || []).filter((source) =>
    source.ok && source.realtime && ["ths", "eastmoney", "tencent"].includes(source.id)
  );
  assert.ok(healthyQuotes.length >= 2, "individual quote federation must have at least two healthy quote lines");

  console.log(JSON.stringify({
    dataDate: poolMeta.dataDate,
    poolCount: pool.length,
    poolState: pool.length > 0 ? "populated" : "confirmed-empty",
    providers: poolMeta.providers,
    enrichedRows: populated.length,
    sectorRows: sectorRows.length,
    sectorSources: [...new Set(sectorRows.map((item) => item.dataSource || item.sourceState || "unknown"))],
    analyzedSector: sector?.name || null,
    sectorMembers: sector?.constituents?.length || 0,
    quoteSources: (federation?.sources || []).map((source) => ({
      id: source.id,
      ok: source.ok,
      role: source.role
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
