import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bell, Plus, Trash2, X } from "lucide-react";
import {
  MAX_MONITOR_CONDITIONS,
  normalizeStockMonitorConfig,
  stockMonitorFields,
  type StockMonitorConfig,
  type StockMonitorField
} from "./stockMonitorRules";
import "./stock-monitor.css";

type DraftCondition = { id: string; field: StockMonitorField; operator: "gte" | "lte"; threshold: string };
const freshCondition = (): DraftCondition => ({ id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, field: "latest", operator: "gte", threshold: "" });

export default function StockMonitorEditor({ stock, config, onSave, onCancel }: {
  stock: { code: string; name: string };
  config?: StockMonitorConfig | undefined;
  onSave: (config: StockMonitorConfig) => boolean | Promise<boolean>;
  onCancel: () => void;
}) {
  const [conditions, setConditions] = useState<DraftCondition[]>(() => config?.conditions.map(condition => ({ id: condition.id, field: condition.field, operator: condition.operator, threshold: String(condition.value / (condition.field === "amount" ? 10000 : 1)) })) || [freshCondition()]);
  const [mode, setMode] = useState<"all" | "any">(config?.mode || "all");
  const [enabled, setEnabled] = useState(config?.enabled ?? true);
  const [cooldown, setCooldown] = useState(String(config?.cooldownMinutes ?? 5));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const firstInput = useRef<HTMLInputElement>(null);
  useEffect(() => { firstInput.current?.focus(); }, []);

  const updateCondition = (id: string, update: Partial<DraftCondition>) => setConditions(current => current.map(condition => condition.id === id ? { ...condition, ...update } : condition));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (conditions.some(condition => !condition.threshold.trim()) || !cooldown.trim()) { setError("请填写每条条件的阈值和提醒间隔。"); return; }
    const normalized = normalizeStockMonitorConfig({ enabled, mode, cooldownMinutes: Number(cooldown), conditions: conditions.map(condition => ({ id: condition.id, field: condition.field, operator: condition.operator, value: Number(condition.threshold) * (condition.field === "amount" ? 10000 : 1) })) });
    if (!normalized) { setError("请输入有效数值：价格、成交额须大于 0；换手率为 0–100%；涨跌幅不低于 -100%；提醒间隔为 1–1440 分钟。"); return; }
    setSaving(true);
    try {
      if (!await onSave(normalized)) setError("保存失败，原条件已保留，请重试。");
    } catch {
      setError("保存失败，原条件已保留，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return <section className="stock-monitor-editor" aria-labelledby={`stock-monitor-title-${stock.code}`}>
    <header className="stock-monitor-editor-heading">
      <div><Bell size={18} /><h3 id={`stock-monitor-title-${stock.code}`}>{stock.name} <small>{stock.code}</small> · 自定义监控</h3></div>
      <button type="button" className="stock-monitor-close" onClick={onCancel} aria-label="关闭条件编辑"><X size={18} /></button>
    </header>
    <form onSubmit={save} noValidate>
      <div className="stock-monitor-options">
        <label>组合方式<select aria-label="条件组合方式" value={mode} onChange={event => setMode(event.target.value as "all" | "any")}><option value="all">全部满足（且）</option><option value="any">任意满足（或）</option></select></label>
        <label>提醒间隔（分钟）<input aria-label="提醒间隔（分钟）" type="number" min="1" max="1440" step="1" value={cooldown} onChange={event => setCooldown(event.target.value)} /></label>
        <label className="stock-monitor-enable"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用该股条件监控</label>
      </div>
      <div className="stock-monitor-condition-list">
        {conditions.map((condition, index) => {
          const field = stockMonitorFields.find(entry => entry.value === condition.field)!;
          return <div className="stock-monitor-condition" key={condition.id}>
            <span className="stock-monitor-index">{index + 1}</span>
            <label><span>指标</span><select aria-label={`条件 ${index + 1} 指标`} value={condition.field} onChange={event => updateCondition(condition.id, { field: event.target.value as StockMonitorField, threshold: "" })}>{stockMonitorFields.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>
            <label><span>比较</span><select aria-label={`条件 ${index + 1} 比较`} value={condition.operator} onChange={event => updateCondition(condition.id, { operator: event.target.value as "gte" | "lte" })}><option value="gte">≥ 大于等于</option><option value="lte">≤ 小于等于</option></select></label>
            <label className="stock-monitor-threshold"><span>阈值（{field.unit}）</span><input ref={index === 0 ? firstInput : undefined} aria-label={`条件 ${index + 1} 阈值（${field.unit}）`} type="number" step="any" value={condition.threshold} onChange={event => updateCondition(condition.id, { threshold: event.target.value })} placeholder={condition.field === "changePct" ? "如 -3 或 5" : "输入阈值"} /></label>
            <button type="button" className="stock-monitor-delete" aria-label={`删除条件 ${index + 1}`} disabled={conditions.length === 1} onClick={() => setConditions(current => current.filter(entry => entry.id !== condition.id))}><Trash2 size={16} /></button>
          </div>;
        })}
      </div>
      <button type="button" className="secondary-btn stock-monitor-add" disabled={conditions.length >= MAX_MONITOR_CONDITIONS} onClick={() => setConditions(current => [...current, freshCondition()])}><Plus size={15} />添加条件 <small>{conditions.length}/{MAX_MONITOR_CONDITIONS}</small></button>
      <p className="stock-monitor-help">首次获取、修改条件或恢复实时刷新时仅建立基线；之后由未满足变为满足才提醒。持续满足不重复提醒，冷却期内再次触发也不补发。所有已选指标须有效，过期行情不触发。</p>
      <p className="stock-monitor-help">成交额以万元填写。监控在应用打开且“实时刷新”开启时运行，切换页面仍继续；暂停实时刷新会暂停全部个股监控。</p>
      {error && <div className="stock-monitor-error" role="alert">{error}</div>}
      <footer className="stock-monitor-editor-actions"><button type="button" className="secondary-btn" onClick={onCancel}>取消</button><button type="submit" className="primary-btn" disabled={saving}>{saving ? "正在保存…" : "保存条件"}</button></footer>
    </form>
  </section>;
}
