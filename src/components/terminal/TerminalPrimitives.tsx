import { CircleAlert, Radar } from "lucide-react";
import { fmt } from "../../domain/formatters";

export function PageHeading({ eyebrow, title, description, actions }: any) {
  return (
    <div className="page-heading">
      <div className="page-heading-identity">
        <h1>{title}</h1>
        {(description || eyebrow) && <details className="page-heading-help"><summary>说明</summary><div>{eyebrow && <span>{eyebrow}</span>}{description && <p>{description}</p>}</div></details>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

export function PanelTitle({ title, subtitle, icon: Icon, badge }: any) {
  return (
    <div className="panel-title">
      <div className="panel-title-icon"><Icon size={17} /></div>
      <div><h3>{title}</h3><p>{subtitle}</p></div>
      {badge && <span>{badge}</span>}
    </div>
  );
}

export function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="fact"><span>{label}</span><b className={tone || ""}>{value}</b></div>;
}

export function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="metric"><span>{label}</span><b className={tone || ""}>{value}</b></div>;
}

export function ReturnBar({ label, value }: { label: string; value: number | null }) {
  if (value == null || !Number.isFinite(value)) {
    return <div className="return-bar"><span>{label}</span><i /><b>--</b></div>;
  }
  const positive = value >= 0;
  const width = Math.min(100, Math.abs(value) * 13 + 8);
  return <div className="return-bar"><span>{label}</span><i><em className={positive ? "up" : "down"} style={{ width: `${width}%` }} /></i><b className={Number(value) > 0 ? "red" : Number(value) < 0 ? "green" : ""}>{Number(value) > 0 ? "+" : ""}{fmt(value)}%</b></div>;
}

export function EmptyInline({ text }: { text: string }) {
  return <div className="empty-inline">{text}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: (() => void) | undefined }) {
  return (
    <div className="panel empty-state error" role="alert">
      <CircleAlert size={34} />
      <h3>查询失败</h3>
      <p>{message}</p>
      {onRetry && <button type="button" className="secondary-btn" onClick={onRetry}>重新尝试</button>}
    </div>
  );
}

export function LoadingState() {
  return <div className="loading-state" role="status" aria-live="polite"><Radar size={42} /><h2>正在构建主线画像</h2><p>同步实时行情、历史K线、板块与公告。</p></div>;
}
