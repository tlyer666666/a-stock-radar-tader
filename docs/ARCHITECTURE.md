# 项目架构与维护边界

本项目是 Electron 桌面应用。渲染层只负责界面和交互，主进程负责本地安全、IPC 与窗口生命周期，数据服务负责行情、公告、策略和回测。

## 当前边界

- `src/domain/`：不依赖 React 的前端领域规则，例如设置默认值、规范化和风险预设。
- `src/dateUtils.ts`：统一使用 `Asia/Shanghai` 计算交易日期，禁止用 UTC 日期代替中国自然日。
- `electron/http-client.cjs`：公共数据请求调度、按来源限速、超时、退避和 `Retry-After` 处理。
- `electron/ths-token-manager.cjs`：同花顺令牌的唯一缓存、并发刷新与鉴权失败重试入口。
- `electron/news-service.cjs`：资讯和 A 股公告聚合。
- `electron/services.cjs`：现有行情与回测编排；后续拆分时应保持公开导出契约不变。
- `qa/`：桌面端到端、发布产物和工作流契约验证。

## 数据源规则

行情与历史数据固定以同花顺为主源，东方财富为次源；公开节点只在允许回退时继续接力。请求必须经过共享 HTTP 客户端，不能在新模块中另写无限重试或无超时的 `fetch`。

## 发布规则

正式 Release 必须先通过类型检查、单元测试、双入口构建和打包桌面端到端测试。Windows、macOS 和 Linux 分别在原生 runner 构建；同一版本的资产不可覆盖。发布先创建草稿，资产完整并核验后才转为正式版本。

本地重新打包会先清理旧的 `release/win-unpacked`；跨平台发布会先清理 `release-builder`。不要手工把历史构建复制回正式目录。

## 下一阶段拆分顺序

1. 将 `electron/services.cjs` 的 providers、cache、backtest 和 strategy 编排逐块迁到独立模块。
2. 将 `src/App.tsx` 的纸面交易领域逻辑和各页面迁入 feature 目录。
3. 建立 renderer/preload/main 共用的 IPC 契约与边界解码器，逐步消除 `any`。

每次迁移都先搬纯函数、补契约测试，再替换调用方；不要在结构迁移中同时修改交易算法。
