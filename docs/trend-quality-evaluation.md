# 趋势质量策略：离线样本对照

本工具对照冻结的 `classic-v1` 和所选策略（默认 `quality-v2`），回答“相同历史输入下产生了哪些信号、按同一执行假设哪些可以完成、闭合交易有什么差异”。它评估**独立信号交易样本**，没有共享资金、组合仓位或资金复利，也不报告组合年化、Sharpe、最大回撤。每次信号独立使用相同名义本金；同股信号允许重叠，因此样本数不是独立统计观测数。

当前真实收益优越性未验证。`returnSuperiorityVerified` 恒为 `false`。合成报告只证明软件路径可以运行，不能支持选股有效或收益更高的结论；真实输入也只产生 `REAL_DIAGNOSTIC` 报告。

## 运行

不需要联网，不安装额外依赖。

```sh
node qa/create-trend-evaluation-fixture.cjs --output artifacts/trend-evaluation/synthetic-input.json
node qa/evaluate-trend-strategies.cjs \
  --input artifacts/trend-evaluation/synthetic-input.json \
  --from 2026-01-13 --to 2026-03-10 --split-date 2026-01-13 \
  --output artifacts/trend-evaluation/synthetic-report.json
node --test electron/trend-strategy-evaluator.test.cjs
```

生成器输出确定性的 310 个工作日、一个虚构代码和构造行情，包括真实交易所休市的日期，因此只能标 `synthetic`。输出 JSON 中的 `suggestedEvaluation` 给出与生成数据匹配的日期。示例将开发区设为空，测试区使用固定规则；这不是一次训练。

可选 `--advanced-strategy macd-zero-cross-v1` 选择新增独立策略；也支持 BOLL、DMI、OBV、KDJ 和均线策略，ID 见 `config/trend-strategy-library.json`。API 对应 `advancedStrategyId`，省略时保留原 quality-v2 默认。新增策略要求80日市场日历对齐，配置仅允许版本内固定默认值。

可选 `--advanced-config config.json`。选择 quality-v2 时，文件包含 v2 参数，例如：

```json
{"maxExtensionAtr":2.5,"minCloseLocation":0.65,"maxVolumeRatio":3.5}
```

可选 `--execution-config execution.json`。未指定时采用下表的**建模假设**，不是对各时期实际费率的认定。未知参数、负值、非数值会报错。

| 参数 | 默认值 | 含义 |
| --- | ---: | --- |
| `notional` | 100000 | 每次独立信号的名义买入本金上限，费用另计 |
| `commissionBps` | 3 | 每侧佣金，1 bps = 0.01% |
| `minCommission` | 5 | 每侧最低佣金，人民币元 |
| `sellTaxBps` | 5 | 仅卖侧税费假设 |
| `transferFeeBps` | 0 | 每侧其他/过户费假设；须按导入时期修正 |
| `slippageBps` | 5 | 每侧不利滑点，买价向上、卖价向下取分 |

费用采用逐笔成交金额计算，各费用项取到分。净收益分母为含买入费用的初始成本，分子为扣卖出费用后的收入与初始成本之差。工具没有跨日期费率表；跨越费率制度变更时应分段评估并披露，不能把一个当前费率倒用于所有历史。可另跑双倍费率/滑点的压力情景，但不能只选择最好情景展示。

## API 与输入合同

```js
const { evaluateTrendStrategies } = require("./electron/trend-strategy-evaluator.cjs");
const report = evaluateTrendStrategies({
  dataset, from: "2021-01-01", to: "2025-12-31", splitDate: "2024-01-01",
  advancedConfig: { maxExtensionAtr: 2, minCloseLocation: 0.7, maxVolumeRatio: 3 },
  execution: { slippageBps: 5 }
});
```

下列为结构说明，单根数据不满足运行所需的 250 根预热历史；完整可运行 JSON 由上述生成器生成。

```json
{
  "schemaVersion": 1,
  "sourceClass": "real",
  "source": "实际数据提供方、版本及取得方式",
  "universeMode": "point-in-time",
  "historicalStatusComplete": true,
  "priceLimitEvidence": "official",
  "calendar": ["2025-01-02"],
  "benchmarkRows": [
    {"date":"2025-01-02","open":100,"high":102,"low":99,"close":101,"volume":1,"amount":1}
  ],
  "securities": [{
    "security": {"code":"600001","secid":"1.600001","name":"数据中的证券名称","assetType":"stock"},
    "statusHistory": [{
      "date":"2025-01-02","name":"当时名称","isST":false,"listed":true,
      "minimumBuyQuantity":100,"quantityStep":100
    }],
    "rawRows": [{
      "date":"2025-01-02","open":10,"high":10.2,"low":9.9,"close":10.1,
      "volume":1000000,"amount":10100000,"isST":false,
      "upperLimit":11,"lowerLimit":9,"noPriceLimit":false,"suspended":false
    }],
    "adjustedRows": [{
      "date":"2025-01-02","open":10,"high":10.2,"low":9.9,"close":10.1,
      "volume":1000000,"amount":10100000
    }]
  }]
}
```

- `sourceClass` 只能为 `synthetic` 或 `real`；`universeMode` 只能为 `point-in-time`、`current-survivors`、`selected`。当前存续名单或当前涨停候选的历史不属于历史全 A 股成分，报告保留选择/幸存者偏差警告。
- `priceLimitEvidence` 为 `official`、`synthetic`、`calculated` 或 `unknown`。真实输入只有明确声明 `official` 才允许模拟成交，其他值或缺失均产生 `unverified_price_limit_source`；声明本身不构成工具对供应商的认证。
- `calendar` 必须是完整市场日历，包含预热日期；不能用缺日个股 K 线推断。重复、无效日期、日期不在日历内、非法 OHLCV/金额会使输入报错。基准缺失会令策略窗口无法评估，而不是假设市场门槛通过。
- 行情金额使用人民币元；成交量须前后一致。`rawRows` 是不复权价格，`adjustedRows` 用于指标，日期必须匹配。预热至少 250 根；筛选器检查近期市场日与个股日线一致。
- `statusHistory` 是**状态生效日期**的完整快照，按当时生效值读取，未来 ST/退市名称不回溯改变过去。`name/isST/listed` 必填；历史 ST 也覆盖原始行的事件窗口，恢复普通名称后不能利用之前的 ST 涨停生成信号。不能把公告未来生效日期之前的信息提前使用。
- 日期化 `minimumBuyQuantity/quantityStep` 用于数量取整。缺失时按板块常规规则作诊断假设（主板/创业板 100 与 100；科创板 200 与 1；北交所 100 与 1）。历史完整性声明缺失时披露限制；历史制度变化须由导入者提供，默认规则不证明历史真实性。
- 每个拟成交日须有明确上下限，或经来源核验的 `noPriceLimit:true`。原始 OHLC 任意价格越过提供的上下限（超过 0.005 元半分容差）会使整个输入报错，不能用越限低价、收盘价生成虚假止损收益；明确无涨跌幅限制的行除外。推算 10%/20%/30% 不能覆盖历史特殊状态。真实日期规则和无价格限制状态由导入者负责核验。
- 停牌可以保留零量零额行或显式 `suspended:true`。完全没有一行表示未知缺数；不要自动补成正常交易。退市不能从证券池删除；`listed:false` 出现在持有期且没有结算账本时标未解决。

## 时间与成交

每个信号日收盘仅向策略传入截至当日的价格、指数、历史身份。原版和质量版各冻结策略版本、配置哈希、S、Pmax；质量版同时冻结 `minEntry`。前者无 `minEntry` 时要求至少 S+0.01。

下一市场交易日开盘只在冻结入场区间内买入。开盘涨停直接拒绝，即使后来开板也不反推开盘成交；停牌拒绝当次入场；不会挪到下一根存在的个股 K 线。缺入场行、未知上下限或不明公司行为列 `unresolved`。本模型不使用下一日全天最低价来填充限价买单。

买入日算第 1 个持有市场交易日。收盘低于冻结 S、两个连续持仓交易日各自收盘低于 MA20，或第 29 日收盘，安排下一可交易日开盘退出。因此止损不是按 S 保证成交，次日可能跳空亏损。买入当日不能卖出。开盘跌停或停牌持续占用该独立样本并延迟退出；停牌打断“两日连续”判断，最长持有计数仍按市场日历推进。

原始/复权 OHLC 比率必须一致。持有期比率变化，或原始与复权缺行，列 `corporate_action_unresolved`/`missing_held_bar`。本工具没有公司行为现金/股份账本，不会偷偷按原价平仓、删除交易或将因子变化当作真实盈利。

复权输入须保留足够精度，并由同一因子一致换算 OHLC。当前评估器用相对误差 `1e-6` 核验同一日四价比例及入场前后比例；普通行情源仅保留两位小数的前复权四价，即使实际因子从未变化，也可能因各价格分别舍入而列 `corporate_action_unresolved`。这是有意保守的“价格口径无法核验”，**不能证明发生了公司行为**；样本 `reasonText` 同时说明舍入、精度与公司行为的不确定性。应提供供应商的高精度同口径价格或可靠因子重新构建输入，而非放宽阈值后宣称这些交易已经核验。

单笔 MAE 是入场后到退出开盘之前已观察到的最低价相对含滑点入场价的最差变化，并包括实际退出成交价；不包含退出以后当天的最低价，也不扣费用。未闭合样本可以保留已观察 MAE，但不进入闭合样本 MAE 均值。

## 切分、删失与报告

必须满足 `from <= splitDate <= to`。分界由使用者在查看结果前选择，双方相同；不是按各策略信号数分别分组。预热行情允许来自 `from` 前，但不提前发出信号。

- 开发区信号为 `[from, splitDate)`，成交观察也截止到 `splitDate` 前最后一个市场日；跨界持仓保留为删失，不能借测试区退出收益调参。
- 测试区信号为 `[splitDate, to]`，不继承开发持仓。`baseline/advanced.metrics` **只汇总测试区**；开发结果在各自 `.development` 中独立列示。
- `to` 后行情不会改变信号或成交；最后一天信号是 `pending`，已进场未退出是 `censored`，缺数据/公司行为/限价无法解决是 `unresolved`。不会仅挑选未来已经齐全的 30 日样本。
- 未运行任何参数拟合。修改参数后反复看同一测试区，意味着已经把它用于开发，不能再称未见过的留出区。

每笔样本只处于 `closed/pending/censored/rejected/unresolved` 之一，所有类别都计入总信号数。闭合交易才有 `netReturnPercent`；其他类别为 `null`。空交易的均值、胜率为 `null`，不是零，也不是通过验证。

报告提供信号数、入场数、闭合数、各未完成类别、闭合交易净/毛收益均值、胜率、单笔 MAE 均值、平均持有日、建模费用、不同信号日及证券数。`coverage` 另计每天的排除、观察、数据不可用与原因。比较中的均值差是不同选股样本的描述统计，不是配对因果效应，更不是组合超额收益。

`performance` 记录耗时、评估日期数、证券数、当前进程峰值 RSS、Node 版本和平台；峰值包含进程其他工作，不应当作该函数精确增量内存。数据哈希、冻结配置和完整样本便于复现；耗时和内存本身可能变化。

## 可继续开展的真实验证

需要历史时点全市场名单（包括已退市证券）、日期化 ST/交易规则、官方日历与限价、公司行为及更完整成交数据。先冻结方案与成本假设，再进行真实留出区和连续年度子区间对照，报告全部尝试、未解决样本和失败结果。重叠信号相关，不能将它们当独立试验套用普通逐笔置信区间。这个版本不自动给“通过”“更赚钱”或投资概率评级。

交易规则也有生效日期：[上交所 2026 年规则公告](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/c_20260424_10816482.shtml)明确新版本自 2026-07-06 生效，不能套用到所有历史时期。反复选择回测优胜配置带来的过拟合风险参见 [Bailey 等原论文](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)。
