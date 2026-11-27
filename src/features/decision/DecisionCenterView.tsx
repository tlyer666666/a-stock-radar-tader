import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PageHeading } from "../../components/terminal/TerminalPrimitives";
import { WorkspaceErrorBoundary } from "../../components/AppErrorBoundary";
import DecisionSignalsPanel from "../ai-agent/DecisionSignalsPanel";
import FeedsPanel from "../ai-agent/FeedsPanel";
import AlertRulesPanel from "../collections/AlertRulesPanel";
import EtfRotationPanel from "../etf/EtfRotationPanel";
import FactorScreenPanel from "../strategy-selection/FactorScreenPanel";
import { DECISION_TABS, rememberedDecisionTab, rememberDecisionTab, type DecisionTab } from "./decisionTabs";

/**
 * 决策中心：把「给结论、盯条件、选标的」的规则化工具收在一处——
 * AI 建议（可追踪、可事后验证）、指标预警、多因子选股、ETF 轮动，以及给 AI 用的自订资讯源。
 * 看过的页签保持挂载，切换页签不丢正在看的结果。
 */
export default function DecisionCenterView({ onOpenStock }: { onOpenStock?: ((security: Security) => void) | undefined }) {
  const [tab, setTabState] = useState<DecisionTab>(rememberedDecisionTab);
  const [visited, setVisited] = useState<Set<DecisionTab>>(() => new Set([rememberedDecisionTab()]));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const setTab = (next: DecisionTab) => { rememberDecisionTab(next); setTabState(next); setVisited(current => current.has(next) ? current : new Set([...current, next])); };
  const active = DECISION_TABS.find(item => item.id === tab)!;
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = DECISION_TABS.findIndex(item => item.id === tab);
    if (currentIndex < 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % DECISION_TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + DECISION_TABS.length) % DECISION_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = DECISION_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = DECISION_TABS[nextIndex]!;
    setTab(next.id);
    tabRefs.current[nextIndex]?.focus();
  };
  const panelContent = (id: DecisionTab): ReactNode => {
    switch (id) {
      case "signals": return <DecisionSignalsPanel onOpenStock={onOpenStock} />;
      case "alerts": return <AlertRulesPanel active={tab === "alerts"} />;
      case "factors": return <FactorScreenPanel onOpen={onOpenStock} />;
      case "rotation": return <EtfRotationPanel />;
      case "feeds": return <FeedsPanel />;
    }
  };
  return <div className="decision-center">
    <PageHeading eyebrow="DECISION CENTER" title="决策中心" description="规则化的决策工具集中在这里：AI 的建议会被记下来并在事后核对对错，指标预警替你盯技术信号，多因子和 ETF 轮动按固定规则选标的。都只给信号和记录，不下单。" />
    <div className="decision-tabs-bar">
      <div className="decision-tabs" role="tablist" aria-label="决策中心功能" onKeyDown={handleTabKeyDown}>
        {DECISION_TABS.map((item, index) => <button key={item.id} ref={node => { tabRefs.current[index] = node; }} type="button" role="tab" id={`decision-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`decision-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><item.icon size={15} />{item.label}</button>)}
      </div>
      <p className="decision-tab-hint">{active.hint}</p>
    </div>
    {DECISION_TABS.map(item => <div key={item.id} id={`decision-panel-${item.id}`} role="tabpanel" aria-labelledby={`decision-tab-${item.id}`} hidden={tab !== item.id}>
      {visited.has(item.id)
        ? <WorkspaceErrorBoundary key={item.id} compact label={`决策中心·${item.label}`}>{panelContent(item.id)}</WorkspaceErrorBoundary>
        : null}
    </div>)}
  </div>;
}
