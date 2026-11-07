import { useEffect, useState } from "react";
import { Rows3 } from "lucide-react";
import { loadSafeLocalJson, saveSafeLocalJson } from "../../safeStorage";

type Density = "compact" | "comfortable";
const key = "astock:display-density:v1";
const valid = (value: unknown) => value === "compact" || value === "comfortable";

/** Local display preference; independent of market/execution settings. */
export default function DisplayDensityControl() {
  const [density, setDensity] = useState<Density>(() => loadSafeLocalJson<Density>(key, "compact", valid));
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => { document.documentElement.dataset.density = density; }, [density]);
  const comfortable = density === "comfortable";
  const label = `界面密度：${comfortable ? "舒适" : "紧凑"}，切换为${comfortable ? "紧凑" : "舒适"}`;
  return <div className="display-density-control">
    <button type="button" className="secondary-btn display-density-toggle" aria-label={label} title={label} aria-pressed={comfortable} onClick={() => {
      const next: Density = comfortable ? "compact" : "comfortable";
      setSaveFailed(!saveSafeLocalJson(key, next, valid));
      setDensity(next);
    }}><Rows3 size={15} /><span>{comfortable ? "舒适" : "紧凑"}</span></button>
    {saveFailed && <small role="status">密度仅在本次会话生效，偏好未能保存</small>}
  </div>;
}
