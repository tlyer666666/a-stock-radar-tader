import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowDownUp, CircleAlert, Eye, EyeOff, MessagesSquare, Plus, RefreshCw, Search, Trash2, Volume2, VolumeX, WalletCards, X } from "lucide-react";
import { fmt, fmtMoney } from "../../domain/formatters";
import { canOpenAgent, openAgentFor } from "../ai-agent/agentModel";
import { TIME_SHARE_SLOTS, timeShareSlot, type TimeShare } from "../market/timeShareModel";
import { paperRoundShares } from "../paper-simulation/paperTradingRules";
import { MAX_ROUNDS, STYLE_LABELS, actionSide, isActionable, type TAnalysis, type TConfig, type TMarker, type TStyle, type TTrade } from "./tEngine";
import { MAX_T_ITEMS, inTradingSession, secidForCode, shanghaiClock, type TItem } from "./tStore";
import type { TAssistantApi, TRuntime } from "./useTAssistant";

type Props = {
  api: TAssistantApi;
  holdings: HoldingItem[];
  live: boolean;
  onOpenStock: (security: Security) => void;
  onToast: (message: string) => void;
};

const signed = (value: number, digits = 2) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
const toneOf = (value: number | null | undefined) => !value ? "" : value > 0 ? "up" : "down";
const sideTone = (side: "buy" | "sell" | null) => side === "buy" ? "buy" : side === "sell" ? "sell" : "";
const clockOf = (ms: number | null) => ms ? new Date(ms + 8 * 3600_000).toISOString().slice(11, 19) : "--";

export default function TAssistantView({ api, holdings, live, onOpenStock, onToast }: Props) {
  const { store, runtimes } = api;
  const [selected, setSelected] = useState<string>(() => store.items[0]?.code || "");
  useEffect(() => {
    if (!store.items.some(item => item.code === selected)) setSelected(store.items[0]?.code || "");
  }, [store.items, selected]);
  const item = store.items.find(entry => entry.code === selected) || null;
  const runtime = item ? runtimes[item.code] : undefined;
  const session = inTradingSession();

  const add = (security: Security) => {
    const holding = holdings.find(entry => entry.code === security.code);
    const message = api.addStock(security, holding ? { baseShares: holding.shares, sellableShares: holding.shares, costPrice: holding.costPrice } : undefined);
    if (message) onToast(message);
    else setSelected(security.code);
  };
  const importHoldings = () => {
    const candidates = holdings.filter(entry => /^\d{6}$/.test(entry.code) && entry.shares > 0 && (!entry.assetType || entry.assetType === "stock"));
    if (!candidates.length) { onToast("持仓股里还没有填了股数的 A 股"); return; }
    let added = 0;
    for (const entry of candidates) {
      if (store.items.length + added >= MAX_T_ITEMS && !store.items.some(itemEntry => itemEntry.code === entry.code)) break;
      const message = api.addStock(entry, { baseShares: entry.shares, sellableShares: entry.shares, costPrice: entry.costPrice });
      if (!message) added += 1;
    }
    onToast(`已从持仓导入 ${added} 只，底仓和成本按持仓股填写，今日可卖股数请按实际核对`);
    if (!selected && candidates[0]) setSelected(candidates[0].code);
  };

  return <div className="t-assistant-view">
    <header className="panel t-assistant-head">
      <div className="t-assistant-title">
        <h2><ArrowDownUp size={18} />做T助手</h2>
        <p>用当天分时的均价线和波动带跟踪底仓股，冲高提示高抛、回落提示接回。只给提示，不会下单。</p>
      </div>
      <div className="t-assistant-actions">
        <StockAdder onAdd={add} />
        <button type="button" className="secondary-btn" onClick={importHoldings}><WalletCards size={15} />从持仓导入</button>
        <button type="button" className="secondary-btn" aria-pressed={store.voice} onClick={() => api.setVoice(!store.voice)}>{store.voice ? <Volume2 size={15} /> : <VolumeX size={15} />}{store.voice ? "语音提醒开" : "语音提醒关"}</button>
        <button type="button" className="secondary-btn" disabled={!store.items.length} onClick={() => void api.refresh()}><RefreshCw size={15} />刷新</button>
      </div>
      <div className="t-assistant-status" role="status">
        {!live ? "已暂停实时刷新（顶部「实时」开关）" : session ? "盘中：每 10 秒刷新分时，出现新信号会弹出提示" : "非交易时段：显示最近一个交易日的分时，可用来复盘参数"}
        {api.saveError && <span className="t-assistant-warn"><CircleAlert size={14} />本地保存失败，刚才的修改可能没存上</span>}
      </div>
    </header>

    {!store.items.length ? <div className="panel t-assistant-empty">
      <ArrowDownUp size={30} />
      <b>还没有跟踪的股票</b>
      <p>在上方搜索添加，或点「从持仓导入」。做T需要已有底仓（A 股 T+1，当天买的当天不能卖）。</p>
    </div> : <div className="t-assistant-layout">
      <aside className="panel t-assistant-list" aria-label="跟踪的股票">
        {store.items.map(entry => <StockRow key={entry.code} item={entry} runtime={runtimes[entry.code]} active={entry.code === selected} onSelect={() => setSelected(entry.code)} />)}
      </aside>
      {item && runtime && <StockDetail key={item.code} item={item} runtime={runtime} api={api} showReplay={store.showReplay} onOpenStock={onOpenStock} />}
    </div>}
  </div>;
}

function StockRow({ item, runtime, active, onSelect }: { item: TItem; runtime: TRuntime | undefined; active: boolean; onSelect: () => void }) {
  const analysis = runtime?.analysis;
  const signal = analysis?.signal;
  const side = signal && isActionable(signal) ? actionSide(signal.action) : null;
  const open = analysis?.open;
  return <button type="button" className={`t-assistant-row${active ? " active" : ""}`} onClick={onSelect} aria-current={active}>
    <span className="t-assistant-row-name"><b>{item.name}</b><small>{item.code}</small></span>
    <span className="t-assistant-row-price">
      {analysis ? <><em className={toneOf(analysis.changePct)}>{fmt(analysis.price)}</em><small className={toneOf(analysis.changePct)}>{signed(analysis.changePct)}%</small></> : <small>{runtime?.error ? "读取失败" : "读取中…"}</small>}
    </span>
    <span className="t-assistant-row-state">
      {signal && <span className={`t-assistant-badge ${side ? sideTone(side) : signal.strength === "normal" ? "watch" : "idle"}`}>{signal.title}</span>}
      {open && <small>{open.kind === "reverse" ? `倒T待接回 ${open.shares}` : `正T待卖出 ${open.shares}`}</small>}
    </span>
  </button>;
}

function StockDetail({ item, runtime, api, showReplay, onOpenStock }: { item: TItem; runtime: TRuntime; api: TAssistantApi; showReplay: boolean; onOpenStock: (security: Security) => void }) {
  const { analysis, share, replay } = runtime;
  const day = share?.date || "";
  const trades = day ? api.store.trades[day]?.[item.code] || [] : [];
  const [draft, setDraft] = useState<{ side: "buy" | "sell"; price: string; shares: string; time: string } | null>(null);
  const security: Security = { code: item.code, name: item.name, secid: item.secid || secidForCode(item.code), assetType: "stock" };

  const stale = staleNote(share?.date, analysis?.time);

  const startDraft = (fromSignal: boolean) => {
    const signal = analysis?.signal;
    const side = fromSignal && signal ? actionSide(signal.action) : null;
    const open = analysis?.open;
    const defaultSide = side || (open?.kind === "reverse" ? "buy" : open?.kind === "forward" ? "sell" : "sell");
    const shares = fromSignal && signal?.shares ? signal.shares : open?.shares || item.config.tShares;
    setDraft({
      side: defaultSide,
      price: analysis ? analysis.price.toFixed(2) : "",
      shares: String(shares || ""),
      time: inTradingSession() ? shanghaiClock() : analysis?.time || "10:00"
    });
  };
  const submitDraft = () => {
    if (!draft || !day) return;
    const price = Number(draft.price), shares = Math.floor(Number(draft.shares));
    if (!(price > 0) || !(shares > 0) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return;
    api.addTrade(day, item.code, { side: draft.side, price, shares, time: draft.time });
    setDraft(null);
  };

  return <section className="t-assistant-main" aria-label={`${item.name} 做T`}>
    <div className="panel t-assistant-stock-head">
      <div>
        <h3>{item.name} <small>{item.code}</small></h3>
        {analysis && <p>
          <b className={toneOf(analysis.changePct)}>{fmt(analysis.price)}</b>
          <span className={toneOf(analysis.changePct)}>{signed(analysis.changePct)}%</span>
          <span>均价 {fmt(analysis.levels.vwap)}</span>
          <span>{day} {analysis.time}</span>
          <span className={`t-assistant-regime ${analysis.regime}`}>{analysis.regime === "up" ? "单边上涨" : analysis.regime === "down" ? "单边下跌" : analysis.slot < 19 ? "方向未定" : "震荡"}</span>
        </p>}
      </div>
      <div className="t-assistant-stock-actions">
        <small>更新于 {clockOf(runtime.updatedAt)}{runtime.source ? ` · ${runtime.source}` : ""}</small>
        <button type="button" className="link-btn" onClick={() => void api.refresh(item.code)} disabled={runtime.loading}><RefreshCw size={14} />刷新</button>
        <button type="button" className="link-btn" onClick={() => onOpenStock(security)}>个股详情</button>
        {canOpenAgent() && <button type="button" className="link-btn" onClick={() => openAgentFor(security, "intraday")}><MessagesSquare size={14} />问 AI 做T思路</button>}
        <button type="button" className="link-btn danger" onClick={() => api.removeStock(item.code)}><X size={14} />不再跟踪</button>
      </div>
    </div>

    {stale && <div className="warning-banner" role="alert"><CircleAlert size={17} />{stale}</div>}
    {runtime.error && <div className="warning-banner" role="alert"><CircleAlert size={17} />分时读取失败：{runtime.error}{share ? "（显示上次成功读取的数据）" : ""}</div>}
    {!analysis ? <div className="panel t-assistant-loading">{runtime.loading ? "正在读取分时…" : "暂无分时数据"}</div> : <>
      <div className="t-assistant-grid">
        <SignalCard analysis={analysis} onRecord={() => startDraft(true)} />
        <LevelsCard analysis={analysis} />
      </div>
      <div className="panel t-assistant-chart-panel">
        <div className="t-assistant-chart-head">
          <b>分时与做T区间</b>
          <span className="t-assistant-legend"><i className="price" />价格<i className="vwap" />均价<i className="band" />上下轨<i className="trade" />我的成交{showReplay && <><i className="virtual" />信号回放</>}</span>
          <button type="button" className="link-btn" onClick={() => api.setShowReplay(!showReplay)}>{showReplay ? <EyeOff size={14} /> : <Eye size={14} />}{showReplay ? "隐藏回放" : "显示回放"}</button>
        </div>
        {share && <TChart share={share} analysis={analysis} trades={trades} markers={showReplay ? replay?.markers || [] : []} />}
        {replay && item.config.sellableShares > 0 && <p className="t-assistant-note">信号回放：如果今天从开盘起完全按提示做（每次 {item.config.tShares} 股），共完成 {replay.rounds} 次T，模拟盈亏 <b className={toneOf(replay.realized)}>{signed(replay.realized, 0)} 元</b>（已扣手续费）{replay.open ? `，还有${replay.open.kind === "reverse" ? "倒T未接回" : "正T未卖出"} ${replay.open.shares} 股` : ""}。回放只用来检验参数，不代表真实成交。</p>}
      </div>
      <div className="t-assistant-grid">
        <TradesCard analysis={analysis} trades={trades} day={day} item={item} draft={draft} setDraft={setDraft} startDraft={() => startDraft(false)} submitDraft={submitDraft} onRemove={id => api.removeTrade(day, item.code, id)} />
        <ConfigCard item={item} onChange={patch => api.updateConfig(item.code, patch)} />
      </div>
    </>}
    <p className="t-assistant-disclaimer">做T提示由分时均价线、波动带、量能和当日格局按固定规则算出，会有误判；单边行情里做T容易卖飞或越买越跌。软件不会下单，成交请在券商软件里自行完成后回来登记。</p>
  </section>;
}

/** 盘中分时没跟上（数据源延迟或还停在上一个交易日）时提醒，避免按旧信号操作。 */
function staleNote(date: string | undefined, time: string | undefined, now = new Date()): string {
  if (!date || !time || !inTradingSession(now)) return "";
  const clock = shanghaiClock(now);
  if (clock < "09:33") return "";
  const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  if (date !== today) return `还没读到今天的分时（现在显示的是 ${date}），下面的提示不是当前行情；若今天休市可忽略`;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const lag = minutes(clock) - minutes(time) - (clock >= "13:00" && time <= "11:30" ? 90 : 0);
  return lag > 3 ? `分时数据停在 ${time}，比现在慢了 ${lag} 分钟，提示可能已经过时，可以点「刷新」重试` : "";
}

function SignalCard({ analysis, onRecord }: { analysis: TAnalysis; onRecord: () => void }) {
  const { signal } = analysis;
  const actionable = isActionable(signal);
  const side = actionable ? actionSide(signal.action) : null;
  return <div className={`panel t-assistant-signal ${sideTone(side)} ${signal.strength}`} aria-live="polite">
    <div className="t-assistant-signal-top">
      <span className="t-assistant-signal-kicker">{actionable ? (signal.strength === "strong" ? "强提示" : "提示") : signal.strength === "normal" ? "留意" : "当前"}</span>
      <h3>{signal.title}</h3>
      {actionable && <p className="t-assistant-signal-order">{side === "sell" ? "卖出" : "买入"} <b>{signal.shares}</b> 股 · 参考价 <b>{fmt(signal.price)}</b></p>}
    </div>
    <ul>{signal.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    {actionable && <button type="button" className="primary-btn" onClick={onRecord}><Plus size={15} />我已成交，登记一笔</button>}
  </div>;
}

function LevelsCard({ analysis }: { analysis: TAnalysis }) {
  const { levels, open, stats } = analysis;
  const rows: Array<[string, number | null, string]> = [
    ["上轨（高抛区）", levels.upper, "sell"], ["均价线", levels.vwap, ""], ["下轨（低吸区）", levels.lower, "buy"],
    ...(open ? [[open.kind === "reverse" ? "接回价" : "卖出价", open.kind === "reverse" ? levels.buyTarget : levels.sellTarget, open.kind === "reverse" ? "buy" : "sell"], ["止损价", levels.stop, ""]] as Array<[string, number | null, string]> : [])
  ];
  return <div className="panel t-assistant-levels">
    <h4>关键价位</h4>
    <dl>
      {rows.filter(([, value]) => value !== null).map(([label, value, tone]) => <div key={label}><dt>{label}</dt><dd className={tone}>{fmt(value)}</dd></div>)}
      <div><dt>今日最高 / 最低</dt><dd>{fmt(levels.high)} / {fmt(levels.low)}</dd></div>
      {levels.limitUp !== null && <div><dt>涨停 / 跌停</dt><dd>{fmt(levels.limitUp)} / {fmt(levels.limitDown)}</dd></div>}
      <div><dt>波动带宽</dt><dd>±{analysis.bandPct.toFixed(2)}%</dd></div>
      <div><dt>近 5 分钟量能</dt><dd>{analysis.volumeRatio.toFixed(1)} 倍</dd></div>
    </dl>
    <h4>今日做T</h4>
    <dl>
      <div><dt>完成次数</dt><dd>{stats.rounds} 次</dd></div>
      <div><dt>{open ? "做T盈亏（含未完成那笔的手续费）" : "做T盈亏（扣费）"}</dt><dd className={toneOf(stats.realized)}>{signed(stats.realized, 2)} 元</dd></div>
      <div><dt>手续费</dt><dd>{fmt(stats.fees)} 元</dd></div>
      <div><dt>每股成本降低</dt><dd className={toneOf(stats.costReduction)}>{signed(stats.costReduction, 3)}</dd></div>
      {stats.newCost !== null && <div><dt>做T后成本</dt><dd>{fmt(stats.newCost, 3)}</dd></div>}
    </dl>
  </div>;
}

function TradesCard({ analysis, trades, day, item, draft, setDraft, startDraft, submitDraft, onRemove }: {
  analysis: TAnalysis; trades: TTrade[]; day: string; item: TItem;
  draft: { side: "buy" | "sell"; price: string; shares: string; time: string } | null;
  setDraft: (draft: { side: "buy" | "sell"; price: string; shares: string; time: string } | null) => void;
  startDraft: () => void; submitDraft: () => void; onRemove: (id: string) => void;
}) {
  const sorted = [...trades].sort((a, b) => a.time.localeCompare(b.time));
  const open = analysis.open;
  const valid = draft && Number(draft.price) > 0 && Math.floor(Number(draft.shares)) > 0 && /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time);
  return <div className="panel t-assistant-trades">
    <div className="t-assistant-card-head">
      <h4>{day} 成交登记</h4>
      {!draft && <button type="button" className="secondary-btn" onClick={startDraft}><Plus size={14} />登记成交</button>}
    </div>
    {open && <p className="t-assistant-open">{open.kind === "reverse" ? `倒T进行中：${open.time} 卖出 ${open.shares} 股，均价 ${fmt(open.price)}，等回落接回` : `正T进行中：${open.time} 买入 ${open.shares} 股，均价 ${fmt(open.price)}，等反弹卖出等量底仓`}</p>}
    {draft && <form className="t-assistant-form" onSubmit={event => { event.preventDefault(); submitDraft(); }}>
      <div className="t-assistant-side" role="radiogroup" aria-label="买卖方向">
        <button type="button" role="radio" aria-checked={draft.side === "sell"} className={draft.side === "sell" ? "active sell" : ""} onClick={() => setDraft({ ...draft, side: "sell" })}>卖出</button>
        <button type="button" role="radio" aria-checked={draft.side === "buy"} className={draft.side === "buy" ? "active buy" : ""} onClick={() => setDraft({ ...draft, side: "buy" })}>买入</button>
      </div>
      <label>价格<input inputMode="decimal" value={draft.price} onChange={event => setDraft({ ...draft, price: event.target.value })} /></label>
      <label>股数<input inputMode="numeric" value={draft.shares} onChange={event => setDraft({ ...draft, shares: event.target.value })} /></label>
      <label>时间<input value={draft.time} placeholder="10:05" maxLength={5} onChange={event => setDraft({ ...draft, time: event.target.value })} /></label>
      <button type="submit" className="primary-btn" disabled={!valid}>保存</button>
      <button type="button" className="secondary-btn" onClick={() => setDraft(null)}>取消</button>
    </form>}
    {sorted.length ? <table className="t-assistant-table">
      <thead><tr><th>时间</th><th>方向</th><th>价格</th><th>股数</th><th>金额</th><th aria-label="操作" /></tr></thead>
      <tbody>{sorted.map(trade => <tr key={trade.id}>
        <td>{trade.time}</td>
        <td className={trade.side}>{trade.side === "sell" ? "卖出" : "买入"}</td>
        <td>{fmt(trade.price)}</td>
        <td>{trade.shares}</td>
        <td>{fmtMoney(trade.price * trade.shares)}</td>
        <td><button type="button" className="icon-btn" aria-label={`删除 ${trade.time} 的成交`} onClick={() => onRemove(trade.id)}><Trash2 size={14} /></button></td>
      </tr>)}</tbody>
    </table> : !draft && <p className="t-assistant-muted">今天还没有登记成交。在券商软件里成交后，回来登记价格和股数，助手会跟踪这笔T什么时候该接回或卖出，并算出降低了多少成本。</p>}
    <p className="t-assistant-muted">每天最多提示 {MAX_ROUNDS[item.config.style]} 次T（{STYLE_LABELS[item.config.style]}）；14:45 以后只提示收尾，不再开新T。</p>
  </div>;
}

function ConfigCard({ item, onChange }: { item: TItem; onChange: (patch: Partial<TConfig>) => void }) {
  const { config } = item;
  const [text, setText] = useState(() => toText(config));
  useEffect(() => { setText(toText(config)); }, [config]);
  const commit = (key: keyof ReturnType<typeof toText>) => {
    const value = Number(text[key]);
    if (!Number.isFinite(value) || value < 0) { setText(toText(config)); return; }
    onChange({ [key]: value } as Partial<TConfig>);
  };
  const field = (key: keyof ReturnType<typeof toText>, label: string, hint: string) => <label>
    <span>{label}</span>
    <input inputMode="decimal" value={text[key]} onChange={event => setText({ ...text, [key]: event.target.value })} onBlur={() => commit(key)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
    <small>{hint}</small>
  </label>;
  const suggest = paperRoundShares(item.code, config.baseShares / 3);
  return <div className="panel t-assistant-config">
    <h4>持仓与参数</h4>
    <div className="t-assistant-fields">
      {field("baseShares", "底仓股数", "现在持有的总股数")}
      {field("sellableShares", "今日可卖", "昨天及以前买入的股数（T+1）")}
      {field("costPrice", "成本价", "用来算做T后的新成本，可不填")}
      {field("tShares", "每次做T股数", suggest > 0 ? `建议底仓的三分之一左右，约 ${suggest} 股` : "一般取底仓的三分之一")}
      {field("minSpreadPct", "最小价差 %", "一卖一买至少要差多少才做，含手续费余量")}
      <label>
        <span>风格</span>
        <select value={config.style} onChange={event => onChange({ style: event.target.value as TStyle })}>
          {(Object.keys(STYLE_LABELS) as TStyle[]).map(style => <option key={style} value={style}>{STYLE_LABELS[style]}</option>)}
        </select>
        <small>{config.style === "steady" ? "波动带更宽、信号更少，每天最多 2 次" : config.style === "active" ? "波动带更窄、信号更多，每天最多 4 次" : "默认，每天最多 3 次"}</small>
      </label>
    </div>
  </div>;
}

function toText(config: TConfig) {
  return {
    baseShares: String(config.baseShares || ""), sellableShares: String(config.sellableShares || ""), costPrice: config.costPrice ? String(config.costPrice) : "",
    tShares: String(config.tShares || ""), minSpreadPct: String(config.minSpreadPct)
  };
}

const W = 760, H = 280, PX = 46, PY = 14;
const TICKS: Array<[number, string]> = [[0, "09:30"], [60, "10:30"], [120, "11:30/13:00"], [180, "14:00"], [240, "15:00"]];

/** 分时 + 均价线 + 当前上下轨与目标价 + 成交标记。 */
function TChart({ share, analysis, trades, markers }: { share: TimeShare; analysis: TAnalysis; trades: TTrade[]; markers: TMarker[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const { points, preClose } = share;
  const { levels } = analysis;
  const lines = [levels.upper, levels.lower, levels.sellTarget, levels.buyTarget, levels.stop].filter((value): value is number => typeof value === "number" && value > 0);
  const values = [...points.map(point => point.price), ...points.map(point => point.average), preClose, ...lines];
  const minRaw = Math.min(...values), maxRaw = Math.max(...values);
  const pad = Math.max((maxRaw - minRaw) * 0.08, preClose * 0.002);
  const min = minRaw - pad, max = maxRaw + pad;
  const x = (slot: number) => PX + (slot / (TIME_SHARE_SLOTS - 1)) * (W - PX * 2);
  const y = (price: number) => PY + ((max - price) / Math.max(1e-9, max - min)) * (H - PY * 2);
  const priceLine = points.map(point => `${x(point.slot).toFixed(1)},${y(point.price).toFixed(1)}`).join(" ");
  const averageLine = points.map(point => `${x(point.slot).toFixed(1)},${y(point.average).toFixed(1)}`).join(" ");
  const lastSlot = points.at(-1)!.slot;
  const ticks = Array.from({ length: 5 }, (_, index) => min + ((max - min) * index) / 4);
  const selected = hover === null ? null : points.reduce((best, point) => Math.abs(point.slot - hover) < Math.abs(best.slot - hover) ? point : best, points[0]!);
  const move = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const slot = Math.round((((event.clientX - rect.left) / rect.width) * W - PX) / (W - PX * 2) * (TIME_SHARE_SLOTS - 1));
    setHover(Math.max(0, Math.min(lastSlot, slot)));
  };
  const userMarks = trades.map(trade => ({ trade, slot: timeShareSlot(trade.time) })).filter((entry): entry is { trade: TTrade; slot: number } => entry.slot !== null);
  const level = (value: number | null, className: string, label: string) => value && value > 0 ? <g className={`t-chart-level ${className}`}>
    <line x1={PX} x2={W - PX} y1={y(value)} y2={y(value)} />
    <text x={W - PX + 4} y={y(value) + 4}>{label}</text>
  </g> : null;
  return <div className="t-chart">
    <div className="t-chart-strip">
      {selected ? <>
        <b>{selected.time}</b><span>价格 <em className={toneOf(selected.price - preClose)}>{fmt(selected.price)}</em></span>
        <span>均价 <em>{fmt(selected.average)}</em></span><span>偏离 <em>{signed((selected.price / selected.average - 1) * 100)}%</em></span><span>量 <em>{fmtMoney(selected.volume)}手</em></span>
      </> : <><b>{analysis.time}</b><span>现价 <em className={toneOf(analysis.changePct)}>{fmt(analysis.price)}</em></span><span>偏离均价 <em>{signed(analysis.deviationPct)}%</em></span><span>昨收 <em>{fmt(preClose)}</em></span></>}
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="分时走势与做T区间" onMouseMove={move} onMouseLeave={() => setHover(null)}>
      <rect x={PX} y={y(levels.upper)} width={W - PX * 2} height={Math.max(0, y(levels.lower) - y(levels.upper))} className="t-chart-band" />
      {ticks.map((value, index) => <g key={index}>
        <line x1={PX} x2={W - PX} y1={y(value)} y2={y(value)} className="t-chart-grid" />
        <text x={PX - 4} y={y(value) + 4} textAnchor="end" className={`chart-axis-text ${toneOf(value - preClose)}`}>{fmt(value)}</text>
      </g>)}
      {TICKS.slice(1, -1).map(([slot]) => <line key={slot} x1={x(slot)} x2={x(slot)} y1={PY} y2={H - PY} className="t-chart-grid" />)}
      <line x1={PX} x2={W - PX} y1={y(preClose)} y2={y(preClose)} className="t-chart-preclose" />
      {level(levels.upper, "upper", "上轨")}
      {level(levels.lower, "lower", "下轨")}
      {analysis.open && level(analysis.open.kind === "reverse" ? levels.buyTarget : levels.sellTarget, analysis.open.kind === "reverse" ? "target-buy" : "target-sell", analysis.open.kind === "reverse" ? "接回" : "卖出")}
      {analysis.open && level(levels.stop, "stop", "止损")}
      <polyline points={averageLine} className="t-chart-vwap" />
      <polyline points={priceLine} className="t-chart-price" />
      {markers.map(marker => <circle key={`v${marker.slot}`} cx={x(marker.slot)} cy={y(marker.price)} r="4" className={`t-chart-virtual ${marker.side}`}><title>{`${marker.time} 回放：${marker.label} ${fmt(marker.price)}`}</title></circle>)}
      {userMarks.map(({ trade, slot }) => {
        const cx = x(slot), cy = y(trade.price);
        const path = trade.side === "buy" ? `M${cx},${cy + 2} l-6,10 h12 z` : `M${cx},${cy - 2} l-6,-10 h12 z`;
        return <g key={trade.id} className={`t-chart-trade ${trade.side}`}>
          <path d={path} /><text x={cx} y={trade.side === "buy" ? cy + 23 : cy - 15} textAnchor="middle">{trade.side === "buy" ? "B" : "S"}</text>
          <title>{`${trade.time} ${trade.side === "buy" ? "买入" : "卖出"} ${trade.shares} 股 @ ${fmt(trade.price)}`}</title>
        </g>;
      })}
      <circle cx={x(lastSlot)} cy={y(analysis.price)} r="3.5" className="t-chart-now" />
      {selected && <line x1={x(selected.slot)} x2={x(selected.slot)} y1={PY} y2={H - PY} className="chart-crosshair" />}
    </svg>
    <div className="t-chart-labels">{TICKS.map(([slot, label]) => <span key={slot} style={{ left: `${(x(slot) / W) * 100}%` }}>{label}</span>)}</div>
  </div>;
}

/** 搜索添加：代码 / 名称 / 拼音，只列 A 股。 */
function StockAdder({ onAdd }: { onAdd: (security: Security) => void }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Security[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const search = typeof window === "undefined" ? undefined : window.stockApi?.search;
  useEffect(() => {
    const text = query.trim();
    if (!text || !search) { setOptions([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void search(text).then(rows => { if (!cancelled) { setOptions((rows || []).filter(row => /^\d{6}$/.test(row.code) && (!row.assetType || row.assetType === "stock")).slice(0, 8)); setActive(0); } }).catch(() => { if (!cancelled) setOptions([]); });
    }, 220);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, search]);
  const choose = (security: Security | undefined) => {
    if (!security) return;
    onAdd(security); setQuery(""); setOptions([]); setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(options[active] || options[0]); }
    else if (event.key === "Escape") setOpen(false);
  };
  return <div className="t-assistant-search" role="combobox" aria-expanded={open && options.length > 0} aria-haspopup="listbox">
    <Search size={15} />
    <input value={query} aria-label="添加做T股票" placeholder="添加股票：代码 / 名称 / 拼音" onChange={event => { setQuery(event.target.value); setOpen(true); }}
      onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} onKeyDown={onKeyDown} />
    {open && options.length > 0 && <ul role="listbox" className="t-assistant-options">{options.map((option, index) => <li key={option.code} role="option" aria-selected={index === active}>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}><b>{option.name}</b><small>{option.code}{option.marketName ? ` · ${option.marketName}` : ""}</small></button>
    </li>)}</ul>}
  </div>;
}
