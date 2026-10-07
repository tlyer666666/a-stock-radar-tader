# 趋势指标库：来源核对与实现边界

核对日期：2026-09-30。本文是研究记录和实现建议，尚不是已经实现的策略清单。

六类指标均能在通达信或同花顺的一手产品资料、官方域名教学资料中找到依据。教学文章证明指标及其解释存在，不证明本项目策略获平台推荐，也不证明可成交收益。本文没有按营销胜率、历史收益截图或用户投稿挑选指标。后文的入场条件、参数、初始化和风控组合属于项目自行设计，必须独立验证。

## 1. 来源与可访问性

同花顺旧目录 [技术指标分析](https://school.10jqka.com.cn/gmxxzbfx_list/) 可用于发现名称；其中部分 2014 年详细链接已返回“页面不存在”。以下采用仍能被搜索工具读取正文的同花顺股民学校详细页。该站的直接打开偶有超时或内部错误，因此应区分“搜索索引中读到正文”与“成功访问实时页面”；本次六类学校条目主要按前者核对。官方域名刊载的教学内容也可能是编辑或转载文章，不能等同于终端内置公式的运行规范。

| 指标 | 官方域名详细页 | 本次核对的基础原理及证据边界 |
| --- | --- | --- |
| MACD | [同花顺：MACD 指标](https://search.10jqka.com.cn/school/article-detail/id/3435) | 快慢指数均线差与该差的平滑线；页中列出 12、26、9 和递推计算。它将 OSC 写作 DIF 减 DEM。 |
| BOLL | [同花顺：布林线指标](https://search.10jqka.com.cn/school/article-detail/id/3417) | 用均值附近的标准差通道表示波动范围；文章也提到不同历史软件形态及周期。没有据此确认所有终端的标准差分母和默认参数一致。 |
| DMI | [同花顺：DMI 指标](https://search.10jqka.com.cn/school/article-detail/id/1303) | 比较相邻最高、最低、收盘及方向变化，用于描述趋势方向与强弱。抓取正文公式部分不完整，不作为精确平滑实现的唯一依据。 |
| OBV | [同花顺：OBV 指标](https://search.10jqka.com.cn/school/article-detail/id/1317) | 按收盘上涨或下跌累加或扣减成交量；其绝对起点不代表资金净流入金额。 |
| KDJ | [同花顺：KDJ 是什么意思](https://search.10jqka.com.cn/school/article-detail/id/3475) | 利用高低收价格关系并平滑，J 比 K、D 更敏感且可越出 0～100；该页也解释单边行情钝化与无效交叉。没有取得该页完整递推公式。 |
| MA | [同花顺：移动平均线的计算](https://search.10jqka.com.cn/school/article-detail/id/5768)；[移动平均线说明](https://search.10jqka.com.cn/school/article-detail/id/1297) | 连续 N 期收盘算术平均，体现平滑与滞后；周期和价格口径仍须明确。 |

通达信提供了更适合作为程序实现依据的资料：

- [公式系统首页](https://help.tdx.com.cn/gspt/)区分技术指标、条件选股、专家系统等公式类别；指标名称本身不等于完整交易规则。
- [函数表](https://help.tdx.com.cn/gspt/docs/markdown/redword/functionlist.html)定义 MA、EMA、SMA、REF、HHV、LLV、SUM 等运算，区分 STD 与 STDP，并标注多种未来函数。这是基础运算依据，不是六个终端内置指标完整源代码。
- [获取公式信息](https://help.tdx.com.cn/quant/docs/markdown/mindoc-1h3hrvkp4sc0g/mindoc-1hce356csmgmo.html)以系统 MACD 为例列出默认 12、26、9 和 DIF、DEA、MACD 三条输出。
- [调用指标公式](https://help.tdx.com.cn/quant/docs/markdown/mindoc-1h3hrvkp4sc0g/mindoc-1h3huq37005ro.html)给出 MACD 数值样例，并说明精度和历史 K 线数量会影响与客户端结果的一致性。
- [官方 MACD 交叉筛选示例](https://help.tdx.com.cn/quant/docs/markdown/gzh0122inweixinwenz/gzh20260302wzlz.html)展示已收盘两期 DIF/DEA 的比较。示例的前期严格小于、当期大于等于边界，与另一种常见交叉定义有一根 K 线的潜在差别。
- [公式输入数据设置](https://help.tdx.com.cn/quant/docs/markdown/mindoc-1h3hrvkp4sc0g/mindoc-1h3hsvcct5sdc.html)明确不复权、前复权、后复权选项，可供未来客户端对照导出使用。

失效链接保留作溯源，不作为已读详细内容的证据：[旧 BOLL](http://school.10jqka.com.cn/20140821/c567044341.shtml)、[旧 MA](http://school.10jqka.com.cn/20140821/c567044216.shtml)、[旧 DMI](http://school.10jqka.com.cn/20140821/c567044084.shtml)。

## 2. 不能忽略的同名差异

1. **MACD 柱值尺度。** 同花顺学校 3435 的 OSC 是 DIF−DEM；通达信接口数值示例近似为 2×(DIF−DEA)，此处“两倍”是从返回样例作出的推断，样例有显示舍入误差。符号判断不受正倍数缩放影响，绝对值阈值受影响。3435 页尾 DEA 递推中出现“前一日 DIF”的写法，与该页将 DEA 定义为 DIF 的指数平均不一致；实现应按明确递推式计算，并用数值夹具检查，不能照抄疑似笔误。
2. **OBV 在同一平台的产品间也不一致。** 学校 1317 描述累计涨跌量；[同花顺 SuperMind 因子研究](https://quant.10jqka.com.cn/view/help/8)技术因子表的 `obv` 却列出 `((C−L)−(H−C))/(H−L)×V`。后者是按收盘位置加权的量，不能直接替代累计 OBV。这里只陈述两份资料的差异，没有据此断言所有同花顺终端采用其中任一种。
3. **BOLL、DMI 的精确运行式尚未对齐。** 标准差用 N 还是 N−1、DMI 用滚动求和还是 Wilder 递推、ADX 平滑周期如何设定，都会改变输出。公开基础教学不足以证明两个平台的当前内置默认值相同。下节明确选择一种本地定义，避免冒称逐点复刻。
4. **KDJ 初始化、平价窗口与 MA 价格口径。** 初始 K/D 取 50 或首个 RSV、最高价等于最低价时的处理、显示舍入及复权方式均可能影响交叉。J 不应被人为限制到 0～100。MA 的算术平均与 EMA、递推 SMA 也不能混称。
5. **交叉等号边界。** 本项目建议统一 `A[t] > B[t] && A[t−1] <= B[t−1]`，并在策略版本记录它。它不宣称等于所有平台样例的交叉边界。显示四舍五入后“相等”也不等于内部数值相等。

## 3. 可实现且只依赖当日及过去的本地定义

以下是拟采用的数学规范，不是从某个页面完整复制的官方交易策略。`t` 表示已收盘市场日，`C/H/L` 为同一口径的复权价，`V` 为同一单位的当日成交量。只接纳足够精度且日期完整的输入；成交与限价继续使用原始价。停牌、缺日、公司行为和复权精度沿用现有评估器的显式处理。

### 共同运算与初始化

```text
MA_N(X,t) = sum(X[t−N+1..t]) / N
EMA_N(X,t) = 2/(N+1) × X[t] + (1−2/(N+1)) × EMA_N(X,t−1)
HHV_N(t) = max(H[t−N+1..t])
LLV_N(t) = min(L[t−N+1..t])
CROSS(A,B,t) = A[t] > B[t] and A[t−1] <= B[t−1]
```

滚动窗口不足 N 期时返回不可用，不自动缩短窗口。EMA 在固定输入起点以首个有效 X 初始化；每次计算使用同一历史起点，只消费截至 t 的前缀。至少保留现有 250 根历史门槛，但“250 根”是项目预热选择，不保证与任意客户端无限历史递推完全相同。缺值不能通过压缩交易日掩盖；复权价格不得中途换口径。计算保留浮点精度，只在展示时舍入。

### MACD 12/26/9

```text
DIF[t] = EMA_12(C,t) − EMA_26(C,t)
DEA[t] = EMA_9(DIF,t)
HIST[t] = 2 × (DIF[t] − DEA[t])
```

本地选择两倍柱值，标签中明确 `histogramScale=2`。拟议过滤示例：`DIF > DEA && DIF > 0`，或另建明确交叉版本；不能把“已经多头”和“当日金叉”混为同一策略。

### BOLL 20/2（总体标准差版本）

```text
MID[t] = MA_20(C,t)
SIGMA[t] = sqrt(sum((C[i]−MID[t])² for i=t−19..t) / 20)
UPPER[t] = MID[t] + 2 × SIGMA[t]
LOWER[t] = MID[t] − 2 × SIGMA[t]
```

本地显式采用分母 N 的总体标准差；不声称这是任一终端 BOLL 的默认式。拟议过滤示例：收盘高于 UPPER，且 MID 高于前一日 MID。若使用昨日上轨突破，则应另写 `C[t] > UPPER[t−1]` 并单独记录版本，两者结果不同。

### DMI（滚动 14 期，ADX 算术平均 6 期）

```text
UP[t] = H[t] − H[t−1]
DOWN[t] = L[t−1] − L[t]
PLUS_DM[t] = UP[t] if UP[t] > 0 and UP[t] > DOWN[t] else 0
MINUS_DM[t] = DOWN[t] if DOWN[t] > 0 and DOWN[t] > UP[t] else 0
TR[t] = max(H[t]−L[t], abs(H[t]−C[t−1]), abs(L[t]−C[t−1]))
PDI[t] = 100 × SUM_14(PLUS_DM,t) / SUM_14(TR,t)
MDI[t] = 100 × SUM_14(MINUS_DM,t) / SUM_14(TR,t)
DX[t] = 100 × abs(PDI[t]−MDI[t]) / (PDI[t]+MDI[t])
ADX[t] = MA_6(DX,t)
ADXR[t] = (ADX[t] + ADX[t−6]) / 2
```

第一根缺前收不计算 DM/TR；方向差相等时双方 DM 为 0。TR 和为 0 或 DI 和为 0 时该项返回不可用，不能生成 signal。滚动 SUM/MA 是本地确定选择，不能把其结果标成已经核验的 Wilder 递推版。拟议过滤示例：`PDI > MDI && ADX >= 20 && ADX[t] > ADX[t−1]`，20 是待检验的项目阈值。

### OBV（累计涨跌量版本）

```text
OBV[0] = 0
DELTA[t] = V[t] if C[t] > C[t−1]
           −V[t] if C[t] < C[t−1]
           0 otherwise
OBV[t] = OBV[t−1] + DELTA[t]
```

首期和收平时增量 0 是本地约定。拟议过滤示例：`OBV[t] > max(OBV[t−20..t−1])`，明确排除当日，避免“严格大于包含自身的最高值”永远不成立。成交量手/股必须一致；它不是净资金流。累计起点改变会平移 OBV，局部突破比较不应依赖其绝对正负。

### KDJ 9/3/3

```text
RSV[t] = 100 × (C[t]−LLV_9(t)) / (HHV_9(t)−LLV_9(t))
K[t] = (2×K[t−1] + RSV[t]) / 3
D[t] = (2×D[t−1] + K[t]) / 3
J[t] = 3×K[t] − 2×D[t]
```

本地以第一个完整九期窗口之前的 K、D 为 50；高低区间为 0 时不出信号、不偷偷改成 0，后续恢复规则应固定为保留上个有效 K/D 状态。拟议过滤示例：当日 K 上穿 D 且 K < 80，并与原趋势门槛合取。此组合与 80 阈值是项目选择；不能宣称 KDJ 低位金叉可独立证明收益。

### MA 排列

```text
MA5[t] = MA_5(C,t)
MA10[t] = MA_10(C,t)
MA20[t] = MA_20(C,t)
MA60[t] = MA_60(C,t)
```

拟议过滤示例：`MA5 > MA10 > MA20 > MA60 && MA20[t] > MA20[t−5]`。这只是趋势排列确认；若基础策略已有相近条件，新增策略须呈现实际增量条件及样本变化，不能把重复条件包装成独立优势。

### 禁止未来信息及一致性检查

本地实现只需以上有限运算，不需要任意公式解释器。禁止回填过去信号、未来确认后倒标峰谷、居中平均、向未来 REF、全样本标准化或按测试收益寻找最佳阈值。通达信函数表明确标注的 `BACKSET`、`REFX/REFXV`、`XMA`、`ZIG`、`PEAK/TROUGH` 等不得加入历史信号计算；`CONST` 的末值广播或其他从后向前运算也应按因果性拒绝，不能仅凭有没有“未来函数”文字判断。

应测试任意截止日 t：完整数据计算的 t 前输出必须等于截断到 t 后重算的输出。极端修改 t 后价格、追加股票未来状态与行情，都不能改变 t 的指标、信号和冻结交易计划。跨周/月运算只能使用已完成周期，不能把最终周线结果回填到本周早期日线。

## 4. 现有评估器如何支持指定策略（只读建议）

当前 `electron/trend-strategy-evaluator.cjs` 的 `evaluatePeriod(..., options, ...)` 已把 options 原样传给策略入口；硬编码主要位于 `evaluateTrendStrategies` 的 `quality-v2` 构造位置。执行、日期切分与逐信号统计无需为六类指标复制。

建议新增可选字段：

```js
evaluateTrendStrategies({
  dataset, from, to, splitDate,
  advancedStrategy: { strategyId: "<registered-id>", config: {} },
  execution
});
```

兼容规则：

- 两个新旧选项都缺省：完全保持 `classic-v1` 对 `quality-v2` 当前默认行为。
- 只有旧 `advancedConfig`：仍仅解释为 `quality-v2` 配置，不改变旧含义。
- 只有 `advancedStrategy`：由同一个策略注册/校验入口规范化 ID 和 config；baseline 永远固定 `classic-v1`。
- 同时提供 `advancedStrategy` 和 `advancedConfig`：抛出明确 TypeError，避免静默覆盖。未知 ID、无效参数在开始昂贵评估前拒绝。
- 输出仍保留 `baseline`、`advanced` 兼容字段；`advanced.strategy` 的 id、version、config、hash 是实际身份，文案不能硬写“质量 v2”。该字段名表示对照组，不表示质量或收益优越。

CLI 可增加 `--strategy-id`、`--strategy-config`，保留 `--advanced-config`，冲突时拒绝。每次命令仅选择一个对照策略，不自动从六个结果里挑收益最高者。登记所有尝试、固定开发/测试边界；反复试验后测试集不能继续称为留出验证。

各策略须保留 candidate/plan 契约：signal 后冻结 `S/minEntry/Pmax`，统一次日开盘与相同退出规则。这样评估比较的是进入过滤条件，不能标为某个平台完整的 MACD/BOLL 官方交易系统。若某策略采用自有退出，应另建明确方法版本，不能暗改共用执行器。

保留所有现有不完整样本计数、历史证券状态与官方限价校验、最近 65 个市场日三序列完整性、T+1、费用、滑点、开发区独立截止、`to` 后数据隔离及复权因子不确定处理。新增指标若要求更长的连续窗口，应把市场日完整性门槛提升为策略所需长度，不能仅检查股票与指数互相对齐。

必要回归包括默认/旧配置结果兼容、新 ID 的策略快照、配置冲突与未知 ID、共同缺日、未来数据不变性、期末删失、开盘限价和成交费用。可用通达信公式导出同一证券、起点、周期、复权方式的数值逐点校验；未取得导出前只能称“本地明确公式实现”，不能称“与平台完全一致”。合成数据只验证机制，真实 PIT 数据上的样本量、缺数及选择偏差仍要单独报告；此扩展不产生年化、Sharpe 或组合回撤。
