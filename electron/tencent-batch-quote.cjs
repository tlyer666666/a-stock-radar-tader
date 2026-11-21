"use strict";

/**
 * 腾讯批量行情 —— https://qt.gtimg.cn/q=sh603030,sz300059,bj920006 一次最多读约 200 个代码。
 * 响应是 GB18030 文本，每个代码一行 `v_<市场><代码>="f0~f1~..."`（~ 分隔）。
 * 只用于可转债、北交所这类大名单的逐只快照替代；个股分析、预警、止损仍走同花顺主链。
 *
 * 关键字段（0 基）：[1] 名称，[2] 代码，[3] 现价，[4] 昨收，[5] 今开，
 * [30] 北京时间 YYYYMMDDHHMMSS，[31] 涨跌额，[32] 涨跌幅%，[33] 最高，[34] 最低，
 * [35] 现价/量/成交额(元)，[36] 成交量(手)，[37] 成交额(万元)，[38] 换手%，
 * [40] 交易状态（"" 正常 / S 停牌 / D 退市摘牌 / U 未上市），[43] 振幅%，
 * [44] 流通市值(亿)，[45] 总市值(亿)，[47] 涨停价，[48] 跌停价。
 * 查不到的代码只回一行 v_pv_none_match="1";。
 */

const { fetchArrayBufferWithPolicy } = require("./http-client.cjs");
const { marketPrefix, formatTencentTime, optionalNumber, scaledNumber } = require("./data-federation.cjs");

const BATCH_URL = "https://qt.gtimg.cn/q=";
const REQUEST_HEADERS = Object.freeze({ Referer: "https://gu.qq.com/" });
const REQUEST_POLICY = Object.freeze({ timeoutMs: 5000, retries: 1, minimumGapMs: 50, queueTimeoutMs: 8000, maxResponseBytes: 1024 * 1024 });
const ENTRY_PATTERN = /v_([a-z]{2})(\d{6})="([^"]*)"/g;
const TRADE_STATUS = { S: "suspended", D: "delisted", U: "unlisted" };

const positiveOrNull = (value) => {
  const parsed = optionalNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

function decodeResponse(bytes) {
  try {
    return new TextDecoder("gb18030").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function parseTencentBatch(text) {
  const quotes = new Map();
  if (typeof text !== "string") return quotes;
  for (const match of text.matchAll(ENTRY_PATTERN)) {
    const code = match[2];
    const fields = match[3].split("~");
    const latest = optionalNumber(fields[3]);
    const timeText = formatTencentTime(fields[30]);
    if (fields[2] !== code || latest === null || latest <= 0 || !timeText) continue;
    const preClose = optionalNumber(fields[4]);
    const rawChangePct = optionalNumber(fields[32]);
    const changePct = rawChangePct !== null
      ? rawChangePct
      : (preClose !== null && preClose > 0 ? Number((((latest - preClose) / preClose) * 100).toFixed(2)) : null);
    const volumeLots = optionalNumber(fields[36]);
    const summaryAmount = optionalNumber(String(fields[35] || "").split("/")[2]);
    const scaledAmount = scaledNumber(fields[37], 10000);
    const amount = volumeLots !== null && volumeLots > 0
      ? (summaryAmount !== null && summaryAmount > 0 ? summaryAmount : scaledAmount)
      : (scaledAmount !== null ? scaledAmount : (volumeLots === 0 ? 0 : null));
    quotes.set(code, {
      code,
      name: String(fields[1] || "").trim(),
      latest,
      preClose,
      open: positiveOrNull(fields[5]),
      high: positiveOrNull(fields[33]),
      low: positiveOrNull(fields[34]),
      change: optionalNumber(fields[31]),
      changePct,
      volumeLots,
      amount,
      turnover: optionalNumber(fields[38]),
      amplitude: optionalNumber(fields[43]),
      floatMarketCap: scaledNumber(fields[44], 1e8),
      totalMarketCap: scaledNumber(fields[45], 1e8),
      limitUp: positiveOrNull(fields[47]),
      limitDown: positiveOrNull(fields[48]),
      quoteAt: new Date(timeText).toISOString(),
      quoteDate: timeText.slice(0, 10),
      tradeStatus: TRADE_STATUS[fields[40]] || "trading",
      source: "腾讯行情"
    });
  }
  return quotes;
}

function createTencentBatchQuotes({ fetchBytes = fetchArrayBufferWithPolicy, chunkSize = 200, maxCodes = 1200, now = () => Date.now() } = {}) {
  const read = async (securities, { signal } = {}) => {
    const quotes = new Map();
    const missing = [];
    const seen = new Set();
    const accepted = [];
    for (const security of Array.isArray(securities) ? securities : []) {
      const code = String(security?.code || "");
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
      seen.add(code);
      accepted.push(security);
    }
    const overflow = accepted.splice(maxCodes);
    let chunks = 0;
    let failedChunks = 0;
    let firstError = null;
    if (accepted.length) {
      const groups = [];
      for (let index = 0; index < accepted.length; index += chunkSize) groups.push(accepted.slice(index, index + chunkSize));
      chunks = groups.length;
      const results = await Promise.all(groups.map(async (group) => {
        const url = `${BATCH_URL}${group.map((security) => `${marketPrefix(security)}${security.code}`).join(",")}`;
        try {
          const bytes = await fetchBytes(url, { signal, headers: REQUEST_HEADERS }, { ...REQUEST_POLICY });
          return { group, quotes: parseTencentBatch(decodeResponse(bytes)) };
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          return { group, error };
        }
      }));
      if (signal?.aborted) signal.throwIfAborted();
      for (const result of results) {
        if (result.error) {
          failedChunks += 1;
          firstError = firstError || result.error;
          for (const security of result.group) missing.push(security.code);
          continue;
        }
        for (const security of result.group) {
          const quote = result.quotes.get(security.code);
          if (quote) quotes.set(security.code, quote);
          else missing.push(security.code);
        }
      }
    }
    for (const security of overflow) missing.push(security.code);
    if (chunks > 0 && failedChunks === chunks) throw firstError;
    return { quotes, missing, chunks, failedChunks, fetchedAt: new Date(now()).toISOString(), source: "腾讯行情" };
  };
  return { read };
}

const defaultBatch = createTencentBatchQuotes();
const readTencentBatchQuotes = (securities, options) => defaultBatch.read(securities, options);

module.exports = { parseTencentBatch, createTencentBatchQuotes, readTencentBatchQuotes };
