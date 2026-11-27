import { BellRing, Filter, Repeat, Rss, Target, type LucideIcon } from "lucide-react";

export type DecisionTab = "signals" | "alerts" | "factors" | "rotation" | "feeds";

export const DECISION_TABS: Array<{ id: DecisionTab; label: string; hint: string; icon: LucideIcon }> = [
  { id: "signals", label: "AI 建议", hint: "AI 问股给出的每条建议和事后对错", icon: Target },
  { id: "alerts", label: "指标预警", hint: "均线、MACD、KDJ、RSI、CCI 和大盘红绿灯", icon: BellRing },
  { id: "factors", label: "多因子选股", hint: "按业绩、估值和量价给全市场打分", icon: Filter },
  { id: "rotation", label: "ETF 轮动", hint: "双动量规则的最新信号与回测", icon: Repeat },
  { id: "feeds", label: "资讯源", hint: "给 AI 问股添加 RSS 资讯", icon: Rss }
];

// 记住上次停在哪个页签：从这里点开个股再返回，或从 AI 问股跳过来时，不用重新找。
let remembered: DecisionTab = "signals";
export const rememberedDecisionTab = (): DecisionTab => remembered;
export function rememberDecisionTab(tab: DecisionTab) { remembered = tab; }
/** 其他页面跳到决策中心前调用，指定要打开的页签。 */
export function openDecisionTab(tab: DecisionTab) { remembered = tab; }
