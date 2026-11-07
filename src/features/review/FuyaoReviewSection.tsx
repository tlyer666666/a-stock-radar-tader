import { ChevronDown, ChevronUp, Flame, Layers3, Landmark, Radar, ScrollText } from "lucide-react";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import { fmtMoney } from "../../domain/formatters";
import { formatShanghaiDateTime } from "../../dateUtils";

/**
 * 复盘页「同花顺扶摇」数据：连板天梯、涨停原因、封板率、热股榜/飙升榜、龙虎榜、异动解读。
 * 数据由主进程 getFuyaoReviewData 汇总（每一块独立失败）；没有 Key 时只显示一行说明。
 */
type Stock = { code: string; name: string; thscode?: string };
type HotRow = Stock & { rank: number | null; heat: number | null; heatText?: string; rankChange: number | null; latest?: number | null; changePct?: number | null };
type HotPeriod = { hot: HotRow[] | null; skyrocket: HotRow[] | null };
type FuyaoReview = {
  available: boolean;
  reason?: string;
  source?: string;
  fetchedAt?: string;
  sealRate?: number | null;
  limitUp?: { count: number; maxBoards: number; boardCounts: { level: number; label: string; count: number }[]; reasons: { reason: string; count: number; stocks: (Stock & { boards: number | null })[] }[];
    leaders: (Stock & { boards: number | null; boardsText: string; reason: string; sealMoney: number | null; limitUpTime: string })[] } | null;
  limitBreak?: { count: number; top: (Stock & { changePct: number | null; openTimes: number | null })[] } | null;
  limitDown?: { count: number; top: (Stock & { changePct: number | null })[] } | null;
  ladder?: { days: { date: string; tiers: { level: number; label: string; stocks: (Stock & { boards: number | null; nextDay: string | null })[] }[] }[] } | null;
  hot?: HotRow[] | null;
  skyrocket?: HotRow[] | null;
  hotLists?: { hour: HotPeriod | null; day: HotPeriod | null; quotedAt?: string | null } | null;
  dragonTiger?: { date: string; count: number | null; topNet: (Stock & { changePct: number | null; net: number | null; orgNet: number | null; hotMoneyNet: number | null; reason: string })[];
    desks: { name: string; buying: number | null; stocks: (Stock & { net: number | null })[] }[] } | null;
  anomalies?: (Stock & { tag: string; content: string; keywords: string[] })[] | null;
  warnings?: string[];
};

const pctText = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const tone = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) || value === 0 ? "" : value > 0 ? "fy-up" : "fy-down";
const toSecurity = (stock: Stock) => ({ code: stock.code, name: stock.name, secid: `${/^6/.test(stock.code) ? 1 : 0}.${stock.code}`,
  thscode: stock.thscode || `${stock.code}.${/^6/.test(stock.code) ? "SH" : /^(?:[48]|920)/.test(stock.code) ? "BJ" : "SZ"}`, assetType: "stock" });

function Card({ icon: Icon, title, subtitle, children, wide = false }: { icon: any; title: string; subtitle?: string; children: ReactNode; wide?: boolean }) {
  return <section className={`review-panel fy-card${wide ? " fy-wide" : ""}`}>
    <div className="fy-card-title"><Icon size={16} /><b>{title}</b>{subtitle && <small>{subtitle}</small>}</div>
    {children}
  </section>;
}

function StockChip({ stock, extra, onOpen }: { stock: Stock; extra?: ReactNode; onOpen: (stock: any) => void }) {
  return <button type="button" className="fy-chip" onClick={() => onOpen(toSecurity(stock))} title={`${stock.name} ${stock.code}，打开个股复盘`}>
    <b>{stock.name}</b>{extra}
  </button>;
}

let rememberedHotPeriod: "hour" | "day" = "hour";
let rememberedHotKind: "hot" | "skyrocket" = "hot";
const heatText = (row: HotRow) => row.heatText || (row.heat === null || !Number.isFinite(row.heat) ? "--" : row.heat >= 1e4 ? `${(row.heat / 1e4).toFixed(1)}万` : String(row.heat));
const rankChangeText = (value: number | null) => value === null || !Number.isFinite(value) || value === 0 ? "—" : value > 0 ? `↑${value}` : `↓${-value}`;

/** 同花顺热榜：与同花顺App一致分「1小时」「24小时」两个页签，每个页签可看热股榜或飙升榜（各最多30只）。 */
export function HotListCard({ data, onOpenStock }: { data: FuyaoReview; onOpenStock: (stock: any) => void }) {
  const lists = data.hotLists || (data.hot?.length || data.skyrocket?.length ? { hour: null, day: { hot: data.hot || null, skyrocket: data.skyrocket || null } } : null);
  const [period, setPeriod] = useState<"hour" | "day">(() => lists?.[rememberedHotPeriod] ? rememberedHotPeriod : lists?.hour ? "hour" : "day");
  const [kind, setKind] = useState<"hot" | "skyrocket">(rememberedHotKind);
  if (!lists || (!lists.hour && !lists.day)) return null;
  const active = lists[period] || lists[period === "hour" ? "day" : "hour"];
  const shownPeriod = lists[period] ? period : period === "hour" ? "day" : "hour";
  const rows = (kind === "hot" ? active?.hot : active?.skyrocket) || [];
  const choosePeriod = (value: "hour" | "day") => { rememberedHotPeriod = value; setPeriod(value); };
  const chooseKind = (value: "hot" | "skyrocket") => { rememberedHotKind = value; setKind(value); };
  return <Card wide icon={Flame} title="同花顺热榜" subtitle={`${shownPeriod === "hour" ? "1小时" : "24小时"}${kind === "hot" ? "热股榜" : "飙升榜"} · 排名与热度为同花顺原始数据`}>
    <div className="fy-tabs" role="group" aria-label="热榜周期与榜单">
      <span role="tablist" aria-label="热榜周期">{(["hour", "day"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={shownPeriod === value}
        disabled={!lists[value]} className={shownPeriod === value ? "is-active" : ""} onClick={() => choosePeriod(value)}>{value === "hour" ? "1小时" : "24小时"}</button>)}</span>
      <span role="tablist" aria-label="榜单类型">{(["hot", "skyrocket"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={kind === value}
        className={kind === value ? "is-active" : ""} onClick={() => chooseKind(value)}>{value === "hot" ? "热股榜" : "飙升榜"}</button>)}</span>
    </div>
    {rows.length ? <div className="fy-hot-scroll"><table className="fy-table fy-hot-table">
      <thead><tr><th scope="col">排名</th><th scope="col">股票</th><th scope="col">现价</th><th scope="col">涨跌幅</th><th scope="col">热度</th><th scope="col">排名变化</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${row.code}-${index}`}>
        <td className="fy-hot-rank">{row.rank ?? index + 1}</td>
        <th scope="row"><button type="button" onClick={() => onOpenStock(toSecurity(row))} title={`${row.name} ${row.code}`}>{row.name}</button><small>{row.code}</small></th>
        <td className={tone(row.changePct)}>{row.latest === null || row.latest === undefined || !Number.isFinite(row.latest) ? "--" : row.latest.toFixed(2)}</td>
        <td className={tone(row.changePct)}>{pctText(row.changePct)}</td>
        <td>{heatText(row)}</td>
        <td className={tone(row.rankChange)}>{rankChangeText(row.rankChange)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="fy-empty">同花顺暂未返回{shownPeriod === "hour" ? "1小时" : "24小时"}{kind === "hot" ? "热股榜" : "飙升榜"}。</p>}
  </Card>;
}

type Section = { id: string; label: string; badge?: string | undefined; node: ReactNode };
let rememberedEcologyTab: string | null = null;

/**
 * layout="grid"：各块卡片平铺（默认）。
 * layout="tabs"：涨停监控页顶部用——各块名称一字排开，点一下展开该块，再点一下收起，一次只展开一块。
 */
export default function FuyaoReviewSection({ data, onOpenStock, actions, extra, layout = "grid" }: { data: FuyaoReview | null | undefined; onOpenStock: (stock: any) => void; actions?: ReactNode; extra?: ReactNode; layout?: "grid" | "tabs" }) {
  const [open, setOpen] = useState<string | null>(rememberedEcologyTab);
  if (!data) return null;
  if (!data.available) return <p className="fy-unavailable">同花顺扶摇数据（连板天梯、涨停原因、热股榜、龙虎榜、异动解读）：{data.reason || "暂不可用"}</p>;
  const latestLadder = data.ladder?.days.at(-1);
  const priorLadder = data.ladder?.days.slice(0, -1).reverse() || [];
  const hasHot = Boolean(data.hotLists?.hour || data.hotLists?.day || data.hot?.length || data.skyrocket?.length);
  const sections: Section[] = [];
  if (data.limitUp) sections.push({ id: "structure", label: "涨停结构", badge: `涨停 ${data.limitUp.count}`, node: <Card icon={Layers3} title="涨停结构" subtitle={`涨停 ${data.limitUp.count} · 炸板 ${data.limitBreak?.count ?? "--"} · 跌停 ${data.limitDown?.count ?? "--"}`}>
        <div className="fy-stats">
          <div><span>封板率</span><b>{data.sealRate == null ? "--" : `${(data.sealRate * 100).toFixed(1)}%`}</b></div>
          <div><span>最高板</span><b className="fy-up">{data.limitUp.maxBoards ? `${data.limitUp.maxBoards}板` : "--"}</b></div>
          {data.limitUp.boardCounts.map((item) => <div key={item.level}><span>{item.label}</span><b>{item.count}</b></div>)}
        </div>
        {!!data.limitUp.leaders.length && <div className="fy-chips">{data.limitUp.leaders.map((row) =>
          <StockChip key={row.code} stock={row} onOpen={onOpenStock} extra={<em className="fy-up">{row.boardsText || `${row.boards}板`}</em>} />)}</div>}
      </Card> });
  if (latestLadder) sections.push({ id: "ladder", label: "连板天梯", badge: data.limitUp?.maxBoards ? `最高 ${data.limitUp.maxBoards} 板` : undefined, node: <Card icon={Radar} title="连板天梯" subtitle={`${latestLadder.date} · 2 板以上，每档最多 4 只`}>
        <div className="fy-ladder">{latestLadder.tiers.filter((tier) => tier.stocks.length).map((tier) => <div key={tier.level}>
          <span>{tier.label}</span>
          <div className="fy-chips">{tier.stocks.map((row) => <StockChip key={row.code} stock={row} onOpen={onOpenStock} />)}</div>
        </div>)}
        {!latestLadder.tiers.some((tier) => tier.stocks.length) && <p className="fy-empty">当日没有 2 板以上的股票。</p>}</div>
        {!!priorLadder.length && <details className="fy-more"><summary>前 {priorLadder.length} 个交易日（括号内为次日封板情况）</summary>
          {priorLadder.map((day) => <div className="fy-ladder-day" key={day.date}><b>{day.date}</b>{day.tiers.filter((tier) => tier.stocks.length).map((tier) =>
            <span key={tier.level}>{tier.label}：{tier.stocks.map((row) => `${row.name}${row.nextDay ? `（${row.nextDay}）` : ""}`).join("、")}</span>)}</div>)}
        </details>}
      </Card> });
  if (data.limitUp?.reasons.length) sections.push({ id: "reasons", label: "涨停原因", badge: `${data.limitUp.reasons.length} 个`, node: <Card icon={ScrollText} title="涨停原因" subtitle="按同花顺涨停原因拆分计数">
        <ol className="fy-reasons">{data.limitUp.reasons.map((group) => <li key={group.reason}>
          <b>{group.reason}</b><em>{group.count} 只</em>
          <span>{group.stocks.map((row) => row.name).join("、")}</span>
        </li>)}</ol>
      </Card> });
  if (hasHot) sections.push({ id: "hot", label: "同花顺热榜", node: <HotListCard data={data} onOpenStock={onOpenStock} /> });
  if (data.dragonTiger && data.dragonTiger.topNet.length) sections.push({ id: "dragon", label: "龙虎榜", badge: data.dragonTiger.count == null ? undefined : `${data.dragonTiger.count} 条`, node: <Card icon={Landmark} title="龙虎榜净买入" subtitle={`${data.dragonTiger.date || "最近交易日"} · 共 ${data.dragonTiger.count ?? "--"} 条`}>
        <table className="fy-table"><thead><tr><th scope="col">股票</th><th scope="col">涨跌幅</th><th scope="col">净买入</th><th scope="col">机构</th><th scope="col">游资</th></tr></thead>
          <tbody>{data.dragonTiger.topNet.map((row) => <tr key={row.code}>
            <th scope="row"><button type="button" onClick={() => onOpenStock(toSecurity(row))}>{row.name}</button></th>
            <td className={tone(row.changePct)}>{pctText(row.changePct)}</td>
            <td className={tone(row.net)}>{fmtMoney(row.net)}</td>
            <td className={tone(row.orgNet)}>{fmtMoney(row.orgNet)}</td>
            <td className={tone(row.hotMoneyNet)}>{fmtMoney(row.hotMoneyNet)}</td>
          </tr>)}</tbody></table>
        {!!data.dragonTiger.desks.length && <p className="fy-note">活跃游资：{data.dragonTiger.desks.map((desk) => `${desk.name}（${desk.stocks.map((row) => row.name).join("、") || "--"}）`).join("；")}</p>}
      </Card> });
  if (data.anomalies?.length) sections.push({ id: "anomalies", label: "异动解读", badge: `${data.anomalies.length} 条`, node: <Card icon={ScrollText} title="异动解读" subtitle="同花顺当日异动原因（涨停、急涨、跌停等）" wide>
        <ul className="fy-anomalies">{data.anomalies.map((row, index) => <li key={`${row.thscode}-${index}`}>
          <div><button type="button" onClick={() => onOpenStock(toSecurity(row))}>{row.name}</button><em>{row.tag}</em>{row.keywords.slice(0, 4).map((word) => <small key={word}>{word}</small>)}</div>
          <p>{row.content}</p>
        </li>)}</ul>
      </Card> });
  const meta = <small>{data.source} · 更新 {data.fetchedAt ? formatShanghaiDateTime(data.fetchedAt) : "--"}</small>;
  const warnings = !!data.warnings?.length && <p className="fy-warning">{data.warnings.join("；")}</p>;

  if (layout === "tabs") {
    const all = extra ? [...sections, { id: "ai", label: "AI 解读", node: extra }] : sections;
    const current = all.find((section) => section.id === open);
    const toggle = (id: string) => { const next = open === id ? null : id; rememberedEcologyTab = next; setOpen(next); };
    return <div className="fy-review fy-review-tabs" aria-label="涨停生态 · 题材 · 资金">
      <div className="fy-tabbar">
        <b>涨停生态</b>
        <div className="fy-tabbar-list" role="tablist" aria-label="涨停生态分区">{all.map((section) => {
          const active = current?.id === section.id;
          return <button key={section.id} type="button" role="tab" id={`fy-tab-${section.id}`} aria-selected={active} aria-expanded={active} aria-controls={active ? "fy-tabpanel" : undefined}
            className={active ? "is-active" : ""} title={active ? `收起${section.label}` : `展开${section.label}`} onClick={() => toggle(section.id)}>
            <span>{section.label}</span>{section.badge && <small>{section.badge}</small>}{active ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>;
        })}</div>
        {meta}
        {actions && <span className="fy-head-actions">{actions}</span>}
      </div>
      {warnings}
      {current && <div className="fy-tabpanel" id="fy-tabpanel" role="tabpanel" aria-labelledby={`fy-tab-${current.id}`}>{current.node}</div>}
    </div>;
  }

  return <div className="fy-review" aria-label="涨停生态 · 题材 · 资金">
    <div className="fy-head">
      <b>涨停生态 · 题材 · 资金</b>
      {meta}
      {actions && <span className="fy-head-actions">{actions}</span>}
    </div>
    {warnings}
    {extra}
    <div className="fy-grid">{sections.map((section) => <Fragment key={section.id}>{section.node}</Fragment>)}</div>
  </div>;
}
