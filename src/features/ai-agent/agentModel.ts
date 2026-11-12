/** AI 问股页面的纯逻辑：快捷问题、立场配色、步骤摘要、跨页面带股票过来。 */

export type QuickTask = { id: string; label: string; hint: string; needsStock: boolean; send: boolean; prompt: (focus: AgentFocus | null) => string };

const nameOf = (focus: AgentFocus | null) => focus ? focus.name || focus.code : "这只股票";

/** 快捷问题：需要先选股票的在没选时不能点；「持仓诊断」只填进输入框，让用户补上成本价再发。 */
export const QUICK_TASKS: QuickTask[] = [
  { id: "full", label: "全面分析", hint: "走势、量能、消息、板块、关键价位和操作思路", needsStock: true, send: true,
    prompt: focus => `全面分析一下${nameOf(focus)}：走势与技术面、量能与短线情绪、消息与公告、板块与市场，给出关键价位和操作思路。` },
  { id: "plan", label: "明天怎么做", hint: "分已持有、未持有给出触发价位", needsStock: true, send: true,
    prompt: focus => `${nameOf(focus)}下一个交易日应该怎么操作？分已持有和未持有两种情况，写清楚触发条件和对应价位。` },
  { id: "technical", label: "技术面", hint: "均线、MACD、RSI、K线形态、支撑压力", needsStock: true, send: true,
    prompt: focus => `看看${nameOf(focus)}的技术面：均线排列、MACD、RSI、量能和最近的K线形态，支撑位和压力位在哪？` },
  { id: "emotion", label: "短线地位", hint: "涨停、龙虎榜、热榜、异动", needsStock: true, send: true,
    prompt: focus => `${nameOf(focus)}在短线资金里是什么地位？涨停、炸板、龙虎榜、热榜排名和异动原因分别怎样？` },
  { id: "news", label: "消息面", hint: "公告与资讯的利好利空", needsStock: true, send: true,
    prompt: focus => `${nameOf(focus)}最近有哪些公告和资讯？分别对股价是利好还是利空，影响大不大？` },
  { id: "sector", label: "板块地位", hint: "板块强弱、个股排名、龙头", needsStock: true, send: true,
    prompt: focus => `${nameOf(focus)}所在板块今天强不强？它在板块里排第几，板块龙头是谁，和龙头比怎么样？` },
  { id: "signals", label: "策略信号", hint: "软件策略库与打分框架怎么看", needsStock: true, send: true,
    prompt: focus => `软件的选股策略和打分框架对${nameOf(focus)}怎么看？命中了哪些策略，理由和失效价是多少，基础分多少？` },
  { id: "holding", label: "持仓诊断", hint: "填上成本价再发送", needsStock: true, send: false,
    prompt: focus => `我持有${nameOf(focus)}，成本价 元，帮我诊断一下现在该怎么办：继续持有、减仓还是止损，依据是什么？` },
  { id: "intraday", label: "做T思路", hint: "结合分时给出高抛低吸价位", needsStock: true, send: true,
    prompt: focus => `我持有${nameOf(focus)}的底仓，想今天做T。结合今天的分时走势、均价线、量能和关键价位，告诉我今天更适合倒T（先卖后买）还是正T（先买后卖），高抛和低吸的参考价位，以及什么情况下今天不要做T。` },
  { id: "market", label: "今日市场", hint: "情绪、主线、强弱板块", needsStock: false, send: true,
    prompt: () => "今天A股短线情绪怎么样？主线题材是什么，最强的板块和龙头是谁，接下来要注意什么？" }
];

export function stanceTone(stance: AgentStance | undefined): "up" | "down" | "flat" | "warn" | "" {
  if (stance === "偏多") return "up";
  if (stance === "偏空") return "down";
  if (stance === "回避") return "warn";
  if (stance === "中性") return "flat";
  return "";
}

/** 「查了 N 项数据：实时行情、日线体检…」 */
export function stepsSummary(steps: AgentStep[] | undefined): string {
  const calls = (steps || []).flatMap(step => step.calls);
  if (!calls.length) return "";
  const names = [...new Set(calls.map(call => call.name || call.tool))];
  const failed = calls.filter(call => call.status === "failed").length;
  return `查了 ${calls.length} 项数据：${names.slice(0, 6).join("、")}${names.length > 6 ? " 等" : ""}${failed ? `（${failed} 项没取到）` : ""}`;
}

export function formatDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms) || (ms as number) < 0) return "";
  const seconds = Math.round((ms as number) / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** 对话列表里的时间：今天显示时分，今年显示月日，否则显示日期。 */
export function shortTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const day = (value: Date) => new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const text = new Date(date.getTime() + 8 * 3600000).toISOString();
  if (day(date) === day(now)) return text.slice(11, 16);
  if (text.slice(0, 4) === day(now).slice(0, 4)) return `${Number(text.slice(5, 7))}月${Number(text.slice(8, 10))}日`;
  return text.slice(0, 10);
}

/** 只认 6 位代码的 A 股。 */
export function focusFromSecurity(security: { code?: string; name?: string; assetType?: string | undefined } | null | undefined): AgentFocus | null {
  const code = String(security?.code || "");
  if (!/^\d{6}$/.test(code) || (security?.assetType && security.assetType !== "stock")) return null;
  return { code, name: String(security?.name || code).replace(/\s+/g, "").slice(0, 12) || code };
}

/** 失败那条回答对应的提问（「重试」用）。 */
export function questionBefore(messages: AgentMessage[], answerId: string): AgentMessage | null {
  const index = messages.findIndex(item => item.id === answerId);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) if (messages[cursor]?.role === "user") return messages[cursor] ?? null;
  return null;
}

// 从个股页「AI 问股深入分析」带股票过来：App 注册打开方法，个股页只在有打开方法时显示按钮。
type Handoff = { focus: AgentFocus; task: string };
let pending: Handoff | null = null;
let opener: (() => void) | null = null;
export function registerAgentOpener(open: (() => void) | null) { opener = open; }
export function canOpenAgent() { return Boolean(opener); }
/** 只切到 AI 问股页（要打开哪段对话由调用方事先记好）。 */
export function openAgentPage() { if (!opener) return false; opener(); return true; }
export function openAgentFor(security: { code: string; name: string }, task = "full") {
  const focus = focusFromSecurity({ ...security, assetType: "stock" });
  if (!focus || !opener) return false;
  pending = { focus, task };
  opener();
  return true;
}
export function takeAgentHandoff(): Handoff | null {
  const value = pending;
  pending = null;
  return value;
}

/** 选或取消一种打法；已满时不再加。 */
export function toggleSkill(selected: string[], id: string, max = 3): string[] {
  if (selected.includes(id)) return selected.filter(item => item !== id);
  return selected.length >= max ? selected : [...selected, id];
}

/** 打法结论的配色：符合 / 接近 / 不符合 / 不适用。 */
export function verdictTone(verdict: string): "yes" | "near" | "no" | "na" {
  return verdict === "符合" ? "yes" : verdict === "接近" ? "near" : verdict === "不符合" ? "no" : "na";
}

/** 自定义打法保存前的检查（主进程会再校验一遍）。 */
export function skillDraftProblem(draft: { name: string; method: string; tools: string[] }): string {
  if (!draft.name.trim()) return "请给打法起个名字";
  if ([...draft.method.trim()].length < 6) return "请写下这套打法的判断要点（至少 6 个字）";
  if (draft.tools.length > 6) return "要看的数据最多选 6 项";
  return "";
}
