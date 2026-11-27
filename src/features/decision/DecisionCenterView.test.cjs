"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const { createHookHarness, find, walk } = require("../../../qa/research-hook-harness.cjs");

let restoreTypeScript;
let view;
let tabs;
let Navigation;
before(() => {
  restoreTypeScript = registerTypeScript();
  view = require("./DecisionCenterView.tsx");
  tabs = require("./decisionTabs.ts");
  Navigation = require("../../components/WorkspaceNavigation.tsx").default;
});
after(() => restoreTypeScript?.());

test("the decision centre gathers the five rule-based tools behind tabs and remembers the last tab", () => {
  assert.deepEqual(tabs.DECISION_TABS.map(item => item.label), ["AI 建议", "指标预警", "多因子选股", "ETF 轮动", "资讯源"]);
  tabs.openDecisionTab("signals");
  const html = renderToStaticMarkup(React.createElement(view.default, {}));
  assert.match(html, /决策中心/);
  for (const label of ["AI 建议", "指标预警", "多因子选股", "ETF 轮动", "资讯源"]) assert.ok(html.includes(label), label);
  assert.match(html, /id="decision-tab-signals"[^>]*aria-selected="true"/);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 5, "all five tabpanels exist so every aria-controls resolves");
  for (const id of ["signals", "alerts", "factors", "rotation", "feeds"]) {
    assert.ok(html.includes(`aria-controls="decision-panel-${id}"`), id);
    assert.ok(html.includes(`id="decision-panel-${id}"`), id);
  }
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1, "roving tabindex exposes only the active tab");
  assert.equal((html.match(/tabindex="-1"/g) || []).length, 4, "inactive tabs use tabindex=-1");
  const tablistSegment = html.match(/role="tablist"[\s\S]*?<\/div>/)?.[0] || "";
  assert.doesNotMatch(tablistSegment, /AI 问股给出的每条建议/, "tab hint sits outside role=tablist");
  assert.match(html, /class="decision-tab-hint">AI 问股给出的每条建议/);
  tabs.openDecisionTab("factors");
  assert.equal(tabs.rememberedDecisionTab(), "factors");
  const factors = renderToStaticMarkup(React.createElement(view.default, {}));
  assert.match(factors, /id="decision-tab-factors"[^>]*aria-selected="true"/);
  tabs.openDecisionTab("signals");
});

test("DecisionCenterView supports Arrow/Home/End keyboard navigation, lazy mounts panels and passes active flag to AlertRulesPanel", () => {
  tabs.openDecisionTab("signals");
  const focused = [];
  const harness = createHookHarness(view.default, {
    props: {},
    bindRefs(tree) {
      for (const node of walk(tree)) {
        if (node.type === "button" && node.props?.role === "tab" && typeof node.props?.ref === "function") {
          node.props.ref({ focus: () => focused.push(node.props.id) });
        }
      }
    }
  });
  harness.render();
  const panels = () => walk(harness.tree).filter(node => node.props?.role === "tabpanel");
  assert.equal(panels().length, 5);
  assert.equal(panels().filter(node => node.props.children).length, 1, "only visited signals tab mounts inner content initially");

  const press = key => {
    let prevented = false;
    const tablist = find(harness.tree, node => node.props?.role === "tablist");
    tablist.props.onKeyDown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, `${key} should preventDefault`);
    harness.render();
  };

  press("ArrowRight");
  assert.equal(tabs.rememberedDecisionTab(), "alerts");
  assert.equal(focused.at(-1), "decision-tab-alerts");
  const alertsPanel = () => walk(harness.tree).find(node => node.type?.name === "AlertRulesPanel");
  assert.equal(alertsPanel()?.props.active, true, "AlertRulesPanel receives active=true on alerts tab");

  press("End");
  assert.equal(tabs.rememberedDecisionTab(), "feeds");
  assert.equal(focused.at(-1), "decision-tab-feeds");
  assert.equal(alertsPanel()?.props.active, false, "AlertRulesPanel stays mounted but receives active=false when hidden");

  press("ArrowLeft");
  assert.equal(tabs.rememberedDecisionTab(), "rotation");
  assert.equal(focused.at(-1), "decision-tab-rotation");

  press("Home");
  assert.equal(tabs.rememberedDecisionTab(), "signals");
  assert.equal(focused.at(-1), "decision-tab-signals");
  assert.equal(panels().filter(node => node.props.children).length, 4, "unvisited factors panel stays unmounted");

  harness.dispose();
  tabs.openDecisionTab("signals");
});

test("the sidebar has three groups, lists 决策中心, and no longer lists 观察池 (it highlights 自选监控 instead)", () => {
  const icon = () => null;
  const ids = ["cockpit", "dashboard", "t-assistant", "previous-limit-up-failed", "favorites", "holdings", "watchlist", "sectors", "beijing", "bonds", "etf", "hsgt", "news", "notes", "signals", "ai-picks", "ai-agent", "decision", "compare", "review", "backtest"];
  const labels = { decision: "决策中心", watchlist: "观察池", favorites: "自选监控" };
  const items = ids.map(id => ({ id, label: labels[id] || id, icon }));
  const render = (active, coreOnly = false) => renderToStaticMarkup(React.createElement(Navigation, { items, active, counts: {}, collapsed: false, coreOnly, onToggleCoreOnly() {}, onCollapse() {}, onNavigate() {} }));
  const html = render("decision");
  assert.equal((html.match(/class="workspace-nav-group"/g) || []).length, 3);
  for (const label of ["盯盘", "选股决策", "复盘与品种"]) assert.ok(html.includes(label), label);
  assert.match(html, /aria-label="决策中心" aria-current="page"/);
  assert.ok(!html.includes('aria-label="观察池"'), "观察池 is reached from the 自选监控 page tabs");
  assert.equal((html.match(/class="nav-item/g) || []).length, 21, "20 entries + settings");
  assert.match(render("watchlist"), /aria-label="自选监控" aria-current="page"/);
  const core = render("cockpit", true);
  assert.ok(core.includes('aria-label="决策中心"'), "决策中心 stays visible in the compact sidebar");
  assert.ok((core.match(/class="nav-item/g) || []).length >= 10);
  assert.match(core, /全部 \(20\)/);
});
