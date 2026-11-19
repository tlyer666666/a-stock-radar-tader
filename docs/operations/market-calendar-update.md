# 交易日历更新手册（A股休市安排）

**适用文件**：`config/a-share-market-calendar.json`（构建输入，改动后必须重新打包）

## 1. 什么时候要更新

- 交易所通常在**每年 12 月**公布次年休市安排；本项目内置日历当前覆盖 `2025-01-01` 至 `2027-12-31`（2027 年按国务院办公厅 2026-11-05 发布的《关于2027年部分节假日安排的通知》录入；上交所 12 月公告发布后再核对一次）。
- 应用内会在**剩余 60 天**时开始提示（`trend-trading-calendar.cjs` 的 `coverageNotice()`）。
- 单测守卫 `qa/audit-guards.test.cjs`（TEST-8）校验结构合法且未过期（剩余 `< 60` 天发诊断预警、已过期 `< 0` 天则直接失败拦阻交付）。

## 2. 文件结构

```json
{
  "version": "SSE-closures-2025-2027-v2",
  "coveredFrom": "2025-01-01",
  "coveredTo": "2027-12-31",
  "timezone": "Asia/Shanghai",
  "sources": ["https://www.sse.com.cn/..."],
  "closedRanges": [["2025-01-01", "2025-01-01"], ["2025-01-28", "2025-02-04"]]
}
```

- `closedRanges` 是**休市区间**（含首尾），只需写法定节假日的休市段；周末由代码按星期判断，**不要**写进 `closedRanges`。
- 2026 年实测形态可作参照：元旦 1 段、春节 1 段、清明 1 段、劳动节 1 段、端午 1 段、中秋+国庆（含调休）1–2 段。

## 3. 更新步骤

1. 打开 `sources` 中对应的上交所公告（或当年最新的「关于 XX 年休市安排的通知」），**逐段抄录**休市起止日期。
2. 更新 `coveredTo`（例如扩到 `2028-12-31`）、`version`（改成 `SSE-closures-2025-2028-v3` 之类）与 `sources`（追加本年公告 URL）。
3. 保证 `closedRanges`：**按时间升序、互不重叠、全部落在 `coveredFrom`..`coveredTo` 内**。
4. 本地校验：
   ```bash
   node --test qa/audit-guards.test.cjs electron/trend-trading-calendar.test.cjs
   ```
5. 重新打包并替换应用（`config/` 属构建输入，只改源码不重打包会导致构建回执不一致、部署被拒）。

## 4. 为什么不能"只改 coveredTo"

运行期 `createTradingCalendar()` 对覆盖范围内的法定假日只认 `closedRanges`。
如果只把 `coveredTo` 往后推却不补休市区间，春节等假日会被当成交易日 —— 直接产出错误的"完整收盘日"，比报错更危险。

## 5. 超出覆盖范围时系统怎么表现（fail-closed）

| 场景 | 行为 |
|---|---|
| 查询日期 > `coveredTo` | `isSession()` 返回 `null`（未知，**不**默认是交易日） |
| 需要"最近完整收盘日"但超出覆盖 | `expectedCloseDate()` 返回 `state: "unknown"`，`reason` 明确提示更新日历 |
| 有实盘指数日线可参考 | 允许用**观测到的**交易日推断，但仅限 `coveredTo` 之后、且序列陈旧不超过 10 天（`MAX_INFERRED_STALENESS_DAYS`） |

因此到期不会静默产出错误结论；风险是"功能降级为未知"，由应用内提示与 TEST-8 守卫兜住。

## 6. 不要做的事

- **不要猜测**次年的春节、调休日期：这类安排由国务院办公厅年度通知确定，猜错会污染所有跨期计算。
- 不要在 `closedRanges` 里写单个周末。
- 不要跳过第 4 步的校验直接打包。
